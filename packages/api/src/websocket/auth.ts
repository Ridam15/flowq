import type { IncomingMessage } from 'node:http';

/**
 * Extract a bearer token from a WebSocket upgrade request OR an SSE
 * GET. Browsers can't set arbitrary `Authorization` headers on WebSocket
 * connections (the standard JS `WebSocket` constructor takes only the
 * URL + subprotocols) and `EventSource` is similarly constrained, so we
 * accept the token via either mechanism:
 *
 *   1. `Authorization: Bearer <token>` header  — preferred for server-
 *      to-server callers (curl, Node clients).
 *   2. `?token=<token>` query parameter         — required for browsers.
 *
 * Returns the raw token string on success, null if absent / malformed.
 */
export function extractAuthToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) {
    const tok = header.slice('Bearer '.length).trim();
    if (tok.length > 0) return tok;
  }

  // req.url contains the path + query string starting with '/'. Use a
  // dummy base so URL() can parse it without us caring about the host.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const tok = url.searchParams.get('token');
  if (tok && tok.length > 0) return tok;

  return null;
}

/** Constant-time-ish equality. Lengths are small; we just want both
 * branches taken regardless of mismatch position. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
