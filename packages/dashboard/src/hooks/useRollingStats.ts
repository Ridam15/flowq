/**
 * Rolling 10-minute window of queue throughput, derived from `stats`
 * frames coming over the WebSocket.
 *
 * The server pushes a snapshot every 5 seconds (`StatsBroadcaster`).
 * Each snapshot includes the cumulative `enqueued` and `completed`
 * counters plus point-in-time depth gauges. To produce a "jobs/minute"
 * line chart we need to:
 *
 *   1. Diff successive samples to compute the per-tick rate.
 *   2. Drop samples older than the window (default 10 minutes).
 *   3. Bucket-keep enough datapoints that Recharts has something smooth
 *      to render — at one sample per 5s × 10 min that's 120 datapoints,
 *      which is fine for a 600 px wide chart.
 *
 * The hook owns the window state (per queue) and exposes:
 *   { series: Record<queueName, Datapoint[]> }
 *
 * A Datapoint is `{ ts, pending, active, enqueuedRate, completedRate }`.
 *
 * Why compute rates client-side instead of having the server send them?
 *   • The server already sends raw counters that the dashboard needs
 *     for the Overview tab anyway. Sending derived values too would
 *     duplicate state.
 *   • Different dashboards may want different window sizes / smoothing.
 *     The raw counter stream is the most general thing the server can
 *     emit.
 */
import { useEffect, useRef, useState } from 'react';
import type { QueueStats } from '../api/types';

export interface RollingDatapoint {
  /** Unix epoch ms — sample arrival time. */
  ts: number;
  pending: number;
  active: number;
  /** Jobs enqueued per minute, computed from counter delta. */
  enqueuedRate: number;
  /** Jobs completed per minute, computed from counter delta. */
  completedRate: number;
}

export interface RollingStatsState {
  series: Record<string, RollingDatapoint[]>;
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export function useRollingStats(
  queueStats: Record<string, QueueStats>,
  lastStatsAt: number | null,
  windowMs: number = DEFAULT_WINDOW_MS,
): RollingStatsState {
  const [series, setSeries] = useState<Record<string, RollingDatapoint[]>>({});

  // The previous counter values per queue, used to compute deltas. We
  // park them in a ref so updating them doesn't trigger a re-render —
  // only the `setSeries` call below does.
  const prevRef = useRef<Record<string, { ts: number; enqueued: number; completed: number }>>({});

  useEffect(() => {
    if (lastStatsAt === null) return;
    const now = lastStatsAt;
    const cutoff = now - windowMs;

    setSeries((current) => {
      const next: Record<string, RollingDatapoint[]> = { ...current };

      for (const [name, snap] of Object.entries(queueStats)) {
        const prev = prevRef.current[name];
        let enqueuedRate = 0;
        let completedRate = 0;

        if (prev !== undefined) {
          const dtSec = Math.max(1, (now - prev.ts) / 1000);
          // Rates are clamped at 0. A negative delta would only happen
          // if the counter resets — treat it as "no information for
          // this tick" rather than an outlier spike.
          enqueuedRate = Math.max(0, ((snap.enqueued - prev.enqueued) / dtSec) * 60);
          completedRate = Math.max(0, ((snap.completed - prev.completed) / dtSec) * 60);
        }

        prevRef.current[name] = {
          ts: now,
          enqueued: snap.enqueued,
          completed: snap.completed,
        };

        const point: RollingDatapoint = {
          ts: now,
          pending: snap.currentPending,
          active: snap.currentActive,
          enqueuedRate,
          completedRate,
        };

        const existing = next[name] ?? [];
        // Drop anything older than the window, then push.
        const trimmed = existing.filter((p) => p.ts >= cutoff);
        trimmed.push(point);
        next[name] = trimmed;
      }

      // GC: remove series for queues that no longer report. (Edge case:
      // the registry SREM is a future feature; for now this is dead
      // code, but cheap to keep correct.)
      for (const k of Object.keys(next)) {
        if (!(k in queueStats) && (next[k]?.length ?? 0) === 0) {
          delete next[k];
        }
      }
      return next;
    });
    // We intentionally key the effect on `lastStatsAt` only. A new
    // `queueStats` reference WITHOUT a new sample timestamp means the
    // server didn't push — most likely a render churn from elsewhere —
    // and we should NOT add a duplicate datapoint. queueStats is read
    // inside the effect via closure; that's the desired semantics.
  }, [lastStatsAt, windowMs]);

  return { series };
}
