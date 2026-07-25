import express from 'express';
import cors from 'cors';

import { initDB, getPool, closeDB } from './db/init';
import { initRedis, getRedis, closeRedis } from './redis/client';

import { bearerAuth } from './middleware/auth';
import { requestLog } from './middleware/requestLog';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

import { createJobsRouter } from './routes/jobs';
import { createQueuesRouter } from './routes/queues';
import { createWorkersRouter } from './routes/workers';
import { createHealthRouter } from './routes/health';
import { createMetricsRouter } from './routes/metrics';
import { createDocsRouter } from './routes/docs';
import { createEventsRouter } from './routes/events';

import {
  startEventSubscriber,
  makeProcessSourceId,
} from './events/redisBridge';
import { FlowQWebSocketServer } from './websocket/server';
import { StatsBroadcaster } from './events/statsBroadcaster';

const PORT = Number(process.env.API_PORT ?? 3000);
const API_KEY = process.env.API_KEY ?? 'dev-api-key-change-me';
const SERVICE = '@flowq/api';
const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

/**
 * Boot order, deliberate:
 *   1. Open data layer (Redis, Postgres). If either fails, we want
 *      to crash NOW — before binding the HTTP port — so the orchestrator
 *      restarts us instead of routing traffic to a half-open process.
 *   2. Build the express app and mount middleware in the correct order:
 *      a) request logging (must wrap everything to time real latency)
 *      b) CORS (must run before route handlers but after logging so
 *         OPTIONS preflights are observable)
 *      c) JSON body parser (1mb cap)
 *      d) Unauthenticated routes (/health, /metrics, /docs)
 *      e) Authenticated routes (everything else, behind bearerAuth)
 *      f) 404 catch-all (only reached if nothing matched)
 *      g) Error handler (must be LAST, must be 4-arg)
 *   3. Set up signal handlers for graceful shutdown.
 *
 * Why CORS is wide-open: this is the control-plane API; the dashboard
 * lives on a separate origin (vite dev server, prod bucket, etc.).
 * Tightening this is a per-deployment policy decision and belongs in
 * env-driven config, not the source of the API.
 */
async function main(): Promise<void> {
  initRedis();
  await initDB();

  if (API_KEY === 'dev-api-key-change-me') {
    console.warn(
      `[${SERVICE}] WARNING: API_KEY is the default dev value — do not run in production`,
    );
  }

  const bootedAt = Date.now();
  const app = express();

  // -- order matters: see the docblock above ---------------------------
  app.use(requestLog());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // -- unauthenticated ops endpoints -----------------------------------
  app.use(createHealthRouter(getRedis(), getPool(), bootedAt));
  app.use(createMetricsRouter(getRedis()));
  app.use(createDocsRouter());

  // SSE auth happens INSIDE the route (not via bearerAuth middleware)
  // because browsers can't set Authorization on EventSource — we must
  // accept `?token=<key>` too. Mounted before the authed router so the
  // mount path doesn't pick up the global bearerAuth.
  app.use(createEventsRouter(API_KEY));

  // -- root / banner ---------------------------------------------------
  app.get('/', (_req, res) => {
    res.status(200).json({
      service: SERVICE,
      message: 'FlowQ API',
      docs: '/docs',
      health: '/health',
      metrics: '/metrics',
    });
  });

  // -- authenticated routes --------------------------------------------
  // We attach bearerAuth as a router-level middleware on a sub-mount
  // rather than per-route. That way a future "GET /jobs" or "PUT
  // /queues/x" automatically inherits auth without us having to
  // remember on every new endpoint. Forgetting auth on a single route
  // is a high-cost mistake; making it impossible by construction is
  // worth the small structural complexity.
  const authed = express.Router();
  authed.use(bearerAuth(API_KEY));
  authed.use(createJobsRouter(getRedis(), getPool()));
  authed.use(createQueuesRouter(getRedis(), getPool()));
  authed.use(createWorkersRouter(getRedis()));
  app.use(authed);

  // -- terminal handlers (must be last) --------------------------------
  app.use(notFoundHandler());
  app.use(errorHandler());

  // -- real-time layer --------------------------------------------------
  // Source id MUST be created BEFORE we wire the WS / publishers. The
  // subscribe-side dedup compares against this exact value to avoid
  // double-broadcasting events this replica itself produced.
  const sourceId = makeProcessSourceId('api');
  const stopSubscriber = await startEventSubscriber(
    REDIS_HOST,
    REDIS_PORT,
    sourceId,
    REDIS_PASSWORD,
  );

  // Bind the http server so we can attach the WebSocket upgrader to
  // the SAME listener Express is using. Single port, single origin —
  // dashboards open ws://host:PORT/ws on the same authority as the
  // REST endpoints, no CORS-for-WS dance required.
  const server = app.listen(PORT, () => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'http_listening',
        service: SERVICE,
        port: PORT,
      })}\n`,
    );
  });

  const wss = new FlowQWebSocketServer(getRedis(), getPool(), {
    apiKey: API_KEY,
    path: '/ws',
  });
  wss.attach(server);

  // Stats broadcaster pushes via the WS broadcast sink — SSE clients
  // do NOT receive stats frames. That's deliberate: stats are a
  // dashboard-rendering convenience, and SSE consumers are pluggable
  // event-stream subscribers (cron alerters, audit pipelines) that
  // would consider periodic stats noise.
  const stats = new StatsBroadcaster(getRedis(), {
    send: (msg) => wss.broadcast(msg),
  });
  stats.start();

  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'realtime_layer_ready',
      sourceId,
      ws: `/ws`,
      sse: `/events/stream`,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'shutdown_signal',
        signal,
      })}\n`,
    );

    // Stop pushers FIRST so we don't broadcast events into sockets
    // that we're about to close mid-frame.
    stats.stop();
    try { await wss.close(); } catch (err) { console.error(`[${SERVICE}] ws close error`, err); }
    try { await stopSubscriber(); } catch (err) { console.error(`[${SERVICE}] subscriber close error`, err); }

    server.close((err) => {
      if (err) console.error(`[${SERVICE}] http close error`, err);
    });

    // Give in-flight requests a chance to drain, but don't hang
    // forever — orchestrators usually SIGKILL after a fixed grace
    // period. 5s is generous for a control-plane API.
    await Promise.race([
      Promise.allSettled([closeRedis(), closeDB()]),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[${SERVICE}] fatal during boot`, err);
  process.exit(1);
});
