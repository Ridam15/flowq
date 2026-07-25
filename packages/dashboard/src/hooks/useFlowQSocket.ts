/**
 * React hook: persistent WebSocket connection to the FlowQ API.
 *
 * Responsibilities:
 *   1. Open a WS to ws://api/ws on mount, close on unmount.
 *   2. Authenticate via `?token=…` query param. Browsers can't set
 *      Authorization headers on the WS handshake, so query-string is the
 *      idiomatic alternative — and the API server explicitly accepts it
 *      (see packages/api/src/websocket/auth.ts).
 *   3. Parse the three frame shapes (`init`, `event`, `stats`) and
 *      maintain three pieces of derived state:
 *        • jobs       — bounded list keyed by job.id, latest first
 *        • queueStats — latest snapshot per queue, keyed by name
 *        • lastEvent  — most recent JobEvent (lets components react)
 *   4. Reconnect on close/error with capped exponential backoff +
 *      ±25% jitter (avoids thundering-herd reconnect storms on
 *      multi-tab dashboards after a server restart).
 *   5. Surface connection state so the UI can show a status indicator.
 *
 * State shape contract (deliberately stable):
 *   { jobs, queueStats, lastEvent, lastStatsAt, connectionStatus, reconnectAttempts }
 *
 * Why React state and not a store (zustand/redux)?
 *
 *   The dashboard has exactly one consumer of this stream — the App
 *   component tree. A hook that wraps useReducer keeps it self-contained
 *   and makes server-pushed updates flow through React's normal scheduler.
 *   No global store is justified at this size.
 */
import { useEffect, useReducer, useRef } from 'react';

import { API_KEY, WS_URL } from '../config';
import type {
  Job,
  JobEvent,
  QueueStats,
  WSFrame,
} from '../api/types';

export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface FlowQSocketState {
  jobs: Job[];
  queueStats: Record<string, QueueStats>;
  lastEvent: JobEvent | null;
  /** Wall-clock ms when the most recent `stats` frame arrived. */
  lastStatsAt: number | null;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  connectedClients: number;
}

const INITIAL_STATE: FlowQSocketState = {
  jobs: [],
  queueStats: {},
  lastEvent: null,
  lastStatsAt: null,
  connectionStatus: 'connecting',
  reconnectAttempts: 0,
  connectedClients: 0,
};

/**
 * We cap the in-memory job list. The Live Feed only ever shows the last
 * page anyway, and this protects long-running tabs from unbounded heap
 * growth on busy queues.
 */
const MAX_JOBS_KEPT = 1000;

type Action =
  | { type: 'status'; status: ConnectionStatus; attempts?: number }
  | { type: 'init'; jobs: Job[]; connectedClients: number }
  | { type: 'event'; event: JobEvent }
  | { type: 'stats'; queues: QueueStats[]; receivedAt: number };

function reducer(state: FlowQSocketState, action: Action): FlowQSocketState {
  switch (action.type) {
    case 'status':
      return {
        ...state,
        connectionStatus: action.status,
        reconnectAttempts: action.attempts ?? state.reconnectAttempts,
      };

    case 'init':
      // Replace, don't merge. `init` is the authoritative snapshot when
      // (re)connecting. Anything we had before is stale.
      return {
        ...state,
        jobs: dedupeAndCap(action.jobs),
        connectedClients: action.connectedClients,
      };

    case 'event': {
      // Upsert the event's job into the list, newest first. We ALSO
      // surface the event itself via `lastEvent` so components that
      // care about transitions (live feed flashes, toast notifications,
      // sound alerts, etc) can react without diff-ing the jobs array.
      const updated = upsertJob(state.jobs, action.event.job);
      return {
        ...state,
        jobs: updated,
        lastEvent: action.event,
      };
    }

    case 'stats': {
      // Merge by queueName. Keeping a record (not an array) makes
      // per-queue lookups O(1) for the Queues tab.
      const next: Record<string, QueueStats> = { ...state.queueStats };
      for (const q of action.queues) {
        next[q.queueName] = q;
      }
      return { ...state, queueStats: next, lastStatsAt: action.receivedAt };
    }

    default:
      return state;
  }
}

function upsertJob(jobs: Job[], incoming: Job): Job[] {
  const idx = jobs.findIndex((j) => j.id === incoming.id);
  if (idx === -1) {
    const next = [incoming, ...jobs];
    return next.length > MAX_JOBS_KEPT ? next.slice(0, MAX_JOBS_KEPT) : next;
  }
  // Replace in place but move to head — easiest for the live feed UI.
  const next = jobs.slice();
  next.splice(idx, 1);
  next.unshift(incoming);
  return next;
}

function dedupeAndCap(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
    if (out.length >= MAX_JOBS_KEPT) break;
  }
  return out;
}

/* ============================================================================
 * Reconnect schedule
 *
 * Doubling delay starting at 1s, capped at 30s. ±25% jitter de-syncs
 * multiple dashboards when the API restarts.
 *
 *   attempt: 0 → ~1s
 *   attempt: 1 → ~2s
 *   attempt: 2 → ~4s
 *   ...
 *   attempt: 5 → ~30s   (cap)
 * ============================================================================ */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.max(250, Math.floor(base + jitter));
}

export function useFlowQSocket(): FlowQSocketState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // We park the live socket / timers in refs so React re-renders never
  // re-create the connection. The effect below is intentionally
  // dependency-free (`[]`) — the socket lives for the lifetime of the
  // mounted hook.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const connect = (): void => {
      if (cancelledRef.current) return;

      const url = `${WS_URL}?token=${encodeURIComponent(API_KEY)}`;
      dispatch({
        type: 'status',
        status: attemptRef.current === 0 ? 'connecting' : 'reconnecting',
        attempts: attemptRef.current,
      });

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        // URL malformed or browser blocked it — schedule a retry.
        // eslint-disable-next-line no-console
        console.error('[flowq-ws] constructor threw', err);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        attemptRef.current = 0;
        dispatch({ type: 'status', status: 'open', attempts: 0 });
      });

      ws.addEventListener('message', (ev) => {
        // The server only ever sends text frames; ignore anything else.
        if (typeof ev.data !== 'string') return;
        let frame: WSFrame;
        try {
          frame = JSON.parse(ev.data) as WSFrame;
        } catch {
          // eslint-disable-next-line no-console
          console.warn('[flowq-ws] non-JSON frame, dropping');
          return;
        }
        switch (frame.type) {
          case 'init':
            dispatch({
              type: 'init',
              jobs: frame.jobs,
              connectedClients: frame.connectedClients,
            });
            break;
          case 'event':
            dispatch({ type: 'event', event: frame.event });
            break;
          case 'stats':
            dispatch({
              type: 'stats',
              queues: frame.queues,
              receivedAt: Date.now(),
            });
            break;
          default:
            // Unknown frame type — forward-compatible no-op. Logging
            // helps detect server/client version skew during deploys.
            // eslint-disable-next-line no-console
            console.debug('[flowq-ws] unknown frame', frame);
        }
      });

      ws.addEventListener('close', (ev) => {
        // A 1008 (policy violation) is the API's "bad token" close
        // code. Reconnecting with the same token is futile, so we
        // surface the closed state and stop retrying — the user has
        // to fix the token and reload.
        if (ev.code === 1008) {
          // eslint-disable-next-line no-console
          console.error('[flowq-ws] auth rejected by server, not retrying');
          dispatch({ type: 'status', status: 'closed' });
          return;
        }
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // We rely on `close` to actually trigger the reconnect — the
        // browser fires `close` after `error` in every spec-compliant
        // implementation. Doing it in both would double-schedule.
      });
    };

    const scheduleReconnect = (): void => {
      if (cancelledRef.current) return;
      const delay = backoffDelayMs(attemptRef.current);
      attemptRef.current += 1;
      dispatch({
        type: 'status',
        status: 'reconnecting',
        attempts: attemptRef.current,
      });
      reconnectTimer.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws !== null) {
        try {
          // 1000 = normal closure; tells the server we left on purpose.
          ws.close(1000, 'unmount');
        } catch {
          /* nothing more we can do */
        }
        wsRef.current = null;
      }
    };
  }, []);

  return state;
}
