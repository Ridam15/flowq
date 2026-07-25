import { Router, type Request, type Response } from 'express';

import { onJobEvent } from '../events/jobEvents';
import { extractAuthToken, tokensEqual } from '../websocket/auth';

/* ============================================================================
 * GET /events/stream — Server-Sent Events fallback for WebSockets
 * ============================================================================
 *
 * Why offer SSE at all when we already have WebSockets?
 *
 *   • SSE is plain HTTP — works through corporate proxies and CDNs that
 *     strip the WebSocket Upgrade header.
 *   • Native browser API (`EventSource`) handles auto-reconnect + last
 *     event id for free; with WS the client has to roll that itself.
 *   • One-way push from server to client is the only thing the
 *     dashboard actually needs from this channel, and SSE is purpose-
 *     built for exactly that — strictly less than WebSockets.
 *
 * Drawbacks vs WebSockets we accept:
 *   • Each SSE connection holds a long-lived HTTP/1.1 keep-alive
 *     socket. Browsers cap parallel connections per origin (~6) — many
 *     SSE tabs from the same origin can saturate that. WS has no such
 *     limit. SSE is a fallback, not the default.
 *   • No native ping/pong. We synthesise keep-alive by writing comment
 *     lines (`: ka\n\n`) every 25s — comments are valid SSE syntax that
 *     browsers ignore, but they keep intermediate proxies (nginx, ELB,
 *     etc.) from idle-timing the connection at 30-60s.
 *
 * Auth: same Bearer scheme as WebSockets — header OR `?token=` query.
 * EventSource cannot set custom headers, so the token query param is
 * mandatory for browser clients.
 *
 * Lifecycle:
 *   1. Validate token. Bad → 401 JSON (NOT 401 + SSE preamble; we want
 *      the EventSource client to fail fast in `onerror`, not pretend
 *      to be connected and never receive any events).
 *   2. Send the SSE preamble headers + flushHeaders so intermediate
 *      proxies don't buffer until the first byte.
 *   3. Subscribe to the local jobEvent bus; for each event, write
 *      `data: <json>\n\n`.
 *   4. On `req.close`: unsubscribe, clear the keep-alive interval, end
 *      the response.
 *
 * We deliberately DO NOT send an init snapshot here — keeping the SSE
 * route stateless makes reconnects cheap. Clients that need the
 * snapshot should hit the REST endpoints (or use the WS channel).
 */
export function createEventsRouter(apiKey: string): Router {
  const router = Router();

  router.get('/events/stream', (req: Request, res: Response) => {
    // ---- auth (handled here, NOT by global bearerAuth, because we
    //          need to support `?token=` for browsers) ------------------
    const tok = extractAuthToken(req);
    if (tok === null || !tokensEqual(tok, apiKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // ---- SSE handshake ------------------------------------------------
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable nginx response buffering. Without this, nginx defaults
    // hold the response until 4-8KB has accumulated, defeating the
    // real-time-ness of the stream entirely.
    res.setHeader('X-Accel-Buffering', 'no');
    // Without `flushHeaders`, Express buffers headers until the first
    // body write; some clients (and proxies) wait for the headers
    // before considering the response "open".
    res.flushHeaders();

    // Initial comment line — primes the connection and signals "open"
    // to clients/proxies that wait for first byte.
    try {
      res.write(': connected\n\n');
    } catch {
      // Connection already gone — bail out.
      return;
    }

    const off = onJobEvent((event) => {
      try {
        // SSE wire format: each frame is `data: <line>\n\n`. JSON.stringify
        // produces no newlines so a single `data:` line suffices.
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Write after end — handled by the close handler below.
      }
    });

    // 25s keep-alive — short enough to beat the 30s idle timeout on
    // typical reverse proxies, long enough to be invisible noise.
    const keepalive = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* will be cleaned up */ }
    }, 25_000);
    keepalive.unref?.();

    const cleanup = (): void => {
      clearInterval(keepalive);
      off();
      try { res.end(); } catch { /* already ended */ }
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
  });

  return router;
}
