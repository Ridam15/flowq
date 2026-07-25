/**
 * Runtime configuration for the dashboard.
 *
 * Resolution order (first match wins):
 *
 *   1. window.__FLOWQ_CONFIG__   — written by /config.js at container start.
 *                                  This is how the production nginx image
 *                                  picks up env vars without a rebuild.
 *   2. import.meta.env.VITE_*    — baked in at `vite build` time. Useful
 *                                  for local `pnpm dev` and for CI builds
 *                                  that ship a single immutable bundle.
 *   3. Hardcoded defaults        — assume local docker-compose.
 *
 * Required (in production):
 *   apiKey — Bearer token presented to every REST + WS request.
 *
 * Optional (sensible defaults for local docker-compose):
 *   apiUrl — http(s) base URL for REST.            default http://localhost:3000
 *   wsUrl  — ws(s) URL for the WebSocket endpoint. derived from apiUrl
 */

interface RawViteEnv {
  VITE_API_URL?: string;
  VITE_WS_URL?: string;
  VITE_API_KEY?: string;
}

interface RuntimeConfig {
  apiUrl?: string;
  wsUrl?: string;
  apiKey?: string;
}

declare global {
  interface Window {
    __FLOWQ_CONFIG__?: RuntimeConfig;
  }
  // eslint-disable-next-line no-var
  var __FLOWQ_CONFIG__: RuntimeConfig | undefined;
}

const viteEnv = (import.meta.env ?? {}) as RawViteEnv;
const runtime: RuntimeConfig =
  (typeof globalThis !== 'undefined' && globalThis.__FLOWQ_CONFIG__) || {};

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

const rawApiUrl = runtime.apiUrl ?? viteEnv.VITE_API_URL ?? 'http://localhost:3000';
export const API_URL: string = trimTrailingSlash(rawApiUrl);

export const WS_URL: string = (() => {
  const explicit = runtime.wsUrl ?? viteEnv.VITE_WS_URL;
  if (explicit) return explicit;
  // Derive ws:// from http:// (or wss:// from https://) so a single
  // apiUrl covers both in the common case.
  const protocol = API_URL.startsWith('https://') ? 'wss://' : 'ws://';
  return protocol + API_URL.replace(/^https?:\/\//, '') + '/ws';
})();

/**
 * The dashboard ships with a non-secret default key purely so a fresh
 * `pnpm dev` against the docker-compose stack works out of the box.
 * Anything beyond local dev MUST inject an apiKey via runtime config or
 * VITE_API_KEY at build time.
 */
export const API_KEY: string =
  runtime.apiKey ?? viteEnv.VITE_API_KEY ?? 'dev-api-key-change-me';
