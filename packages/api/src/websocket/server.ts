import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { onJobEvent } from '../events/jobEvents';

import { extractAuthToken, tokensEqual } from './auth';
import { fetchInitialJobs } from './initialState';

/* ============================================================================
 * WebSocket server for real-time dashboard updates
 * ============================================================================
 *
 * Lifecycle:
 *
 *   attach(httpServer, path)
 *     • Constructs a `ws.WebSocketServer` riding on the SAME http.Server
 *       Express is using. We do NOT spin up a second TCP listener — the
 *       dashboard speaks one origin to one port; clients use ws://host:3000/ws.
 *     • Subscribes to the local `jobEvents` bus and broadcasts every
 *       event to every open client as `{ type:'event', event }`.
 *     • Starts the heartbeat scheduler.
 *
 *   on connection
 *     • Authenticates via Bearer token (header or `?token=` query, see
 *       extractAuthToken). Auth failure → close 1008 (policy violation).
 *     • Sends an `init` frame with the current snapshot (active jobs +
 *       last 50 terminal jobs from PG) so the client can render
 *       immediately without REST round-trips.
 *     • Tracks the socket in `clients` for broadcast.
 *
 *   heartbeat (every 30s)
 *     • For each client: mark `isAlive=false` and send a ping. Schedule
 *       a 10s timeout that, if `isAlive` is still false, terminates the
 *       socket. The client's pong handler flips `isAlive=true` and
 *       cancels the kill — so a healthy connection keeps living.
 *     • This is the only reliable way to detect zombie TCP connections
 *       (e.g. NAT timeout dropped the conn but neither side noticed).
 *       Without this we'd accumulate dead sockets and leak event
 *       broadcast work onto them.
 *
 *   close()
 *     • Stops heartbeat, unsubscribes from the bus, closes every socket
 *       cleanly, then closes the WebSocketServer. Idempotent.
 *
 * Concurrency: ws is single-threaded under Node — no locking needed.
 * Send queue back-pressure: ws.send is non-blocking; if a client falls
 * behind we let ws buffer briefly, then heartbeat will reap it.
 *
 * We deliberately DO NOT process any inbound messages from clients —
 * this is a one-way push channel. If a future protocol needs client
 * commands, add a discriminated `{ type: 'cmd:...' }` handler here.
 */

interface TrackedClient {
  socket: WebSocket;
  /** Set false on each ping tick, true on each pong. */
  isAlive: boolean;
  /** ID for logging. */
  remote: string;
}

export interface WebSocketServerOptions {
  /** API key — clients must present this via Authorization or ?token=. */
  apiKey: string;
  /** Mount path on the http server. Defaults to '/ws'. */
  path?: string;
  /** Heartbeat ping cadence. Defaults to 30s per spec. */
  pingIntervalMs?: number;
  /** Time after a ping before we terminate a non-responsive client. Defaults to 10s. */
  pingTimeoutMs?: number;
  /** For tests: skip auth altogether (NEVER use in production). */
  disableAuth?: boolean;
}

export class FlowQWebSocketServer {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<TrackedClient>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private offJobEvent: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly redis: Redis,
    private readonly pool: Pool,
    private readonly opts: WebSocketServerOptions,
  ) {}

  attach(httpServer: HttpServer): void {
    if (this.wss !== null) return; // idempotent
    const path = this.opts.path ?? '/ws';

    this.wss = new WebSocketServer({
      server: httpServer,
      path,
      // Cap a single frame at 1 MiB — we only ever push small JSON
      // messages; anything larger is a bug or an attack.
      maxPayload: 1024 * 1024,
    });

    this.wss.on('connection', (socket, req) => {
      void this.onConnect(socket, req);
    });

    this.offJobEvent = onJobEvent((event) => {
      // Stringify ONCE then ws.send to N clients. Cheaper than
      // re-serialising per client and keeps ordering identical.
      const msg = JSON.stringify({ type: 'event', event });
      this.broadcast(msg);
    });

    this.startHeartbeat();
  }

  /** Send an arbitrary pre-serialised message to every open client. */
  broadcast(msg: string): void {
    for (const tc of this.clients) {
      if (tc.socket.readyState !== WebSocket.OPEN) continue;
      try {
        tc.socket.send(msg);
      } catch {
        // socket likely just dropped; heartbeat will sweep it.
      }
    }
  }

  clientCount(): number {
    let n = 0;
    for (const tc of this.clients) {
      if (tc.socket.readyState === WebSocket.OPEN) n++;
    }
    return n;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.offJobEvent) {
      this.offJobEvent();
      this.offJobEvent = null;
    }

    for (const tc of this.clients) {
      try {
        // 1001 = "going away" — the standard close code for a clean
        // server shutdown, distinguishable on the client from policy /
        // protocol errors.
        tc.socket.close(1001, 'server_shutdown');
      } catch {
        try { tc.socket.terminate(); } catch { /* nothing else to do */ }
      }
    }
    this.clients.clear();

    const wss = this.wss;
    if (wss !== null) {
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  // -------------------------------------------------------------------------

  private async onConnect(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const remote =
      `${req.socket.remoteAddress ?? 'unknown'}:${req.socket.remotePort ?? '0'}`;

    // ---- auth ------------------------------------------------------------
    if (!this.opts.disableAuth) {
      const tok = extractAuthToken(req);
      if (tok === null || !tokensEqual(tok, this.opts.apiKey)) {
        try {
          // 1008 = policy violation. Clients should treat this as
          // "won't be fixed by reconnecting".
          socket.close(1008, 'unauthorized');
        } catch { /* socket might already be dead */ }
        return;
      }
    }

    const tc: TrackedClient = { socket, isAlive: true, remote };
    this.clients.add(tc);

    socket.on('pong', () => { tc.isAlive = true; });
    socket.on('close', () => { this.clients.delete(tc); });
    socket.on('error', () => {
      this.clients.delete(tc);
      try { socket.terminate(); } catch { /* nothing else to do */ }
    });

    // ---- initial snapshot -----------------------------------------------
    // We send this BEFORE we let any broadcast events fan out to the
    // socket. Order matters for the dashboard: it expects to receive
    // `init` first, then a stream of `event` / `stats` frames.
    try {
      const jobs = await fetchInitialJobs(this.redis, this.pool);
      const initFrame = JSON.stringify({
        type: 'init',
        jobs,
        connectedClients: this.clientCount(),
      });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(initFrame);
      }
    } catch (err) {
      // Init failure is recoverable — connection stays open, the client
      // can still receive live events. Log and move on.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'warn',
        msg: 'ws_init_snapshot_failed',
        remote,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  /**
   * Schedules a ping every `pingIntervalMs`. For each ping we set
   * isAlive=false and arm a `pingTimeoutMs` timer that terminates the
   * socket if no pong arrived in that window. The pong handler installed
   * in onConnect flips isAlive back to true, which makes the timer's
   * check fall through.
   */
  private startHeartbeat(): void {
    const intervalMs = this.opts.pingIntervalMs ?? 30_000;
    const timeoutMs = this.opts.pingTimeoutMs ?? 10_000;

    this.heartbeatInterval = setInterval(() => {
      for (const tc of this.clients) {
        if (tc.socket.readyState !== WebSocket.OPEN) {
          this.clients.delete(tc);
          continue;
        }
        tc.isAlive = false;
        try { tc.socket.ping(); } catch { /* will be reaped below */ }

        // Per-ping kill timer. Captures `tc` by reference so a flipped
        // isAlive (from a pong arriving before the timer fires) cancels
        // the kill effectively.
        setTimeout(() => {
          if (!tc.isAlive && tc.socket.readyState !== WebSocket.CLOSED) {
            try { tc.socket.terminate(); } catch { /* nothing more we can do */ }
            this.clients.delete(tc);
          }
        }, timeoutMs).unref?.();
      }
    }, intervalMs);
    this.heartbeatInterval.unref?.();
  }
}
