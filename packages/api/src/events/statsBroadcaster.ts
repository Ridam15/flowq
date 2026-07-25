import type { Redis } from 'ioredis';
import { redisKeys, QUEUE_STATS_FIELDS } from '@flowq/sdk';

/* ============================================================================
 * Periodic queue-stats broadcaster
 * ============================================================================
 *
 * Pushes a `{ type:'stats', queues:[…] }` frame to every WS client every
 * `intervalMs` (default 5s). Powers the depth/throughput charts on the
 * dashboard without forcing the dashboard to poll.
 *
 * Why server-pushed instead of client-polled?
 *
 *   • One pipeline batch per queue per tick, regardless of how many
 *     dashboards are connected — O(queues), not O(queues × clients).
 *     A polling dashboard would multiply Redis traffic by every open
 *     tab.
 *   • Atomic snapshot per tick: every connected client sees the EXACT
 *     same numbers at the EXACT same instant. Polling clients drift
 *     and disagree.
 *
 * Why 5 seconds?
 *
 *   • Fast enough to look "live" on a dashboard (depth changes are
 *     visible within one chart frame).
 *   • Slow enough that the per-tick Redis cost (4 reads × N queues)
 *     is irrelevant even with hundreds of queues.
 *   • Independent of the WebSocket heartbeat (30s) so the two systems
 *     don't synchronise their workloads.
 *
 * Failure model: a tick error is logged and swallowed. We never want a
 * transient Redis blip to cascade into broadcasting stale or partial
 * stats — we just skip that tick. Next tick will retry from scratch.
 */
export interface StatsBroadcasterOptions {
  intervalMs?: number;
  /** Send sink — pre-stringified message gets pushed here. */
  send: (msg: string) => void;
}

export interface QueueStatsSnapshot {
  queueName: string;
  enqueued: number;
  completed: number;
  failed: number;
  dead: number;
  currentPending: number;
  currentActive: number;
  paused: boolean;
}

export class StatsBroadcaster {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly intervalMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: StatsBroadcasterOptions,
  ) {
    this.intervalMs = opts.intervalMs ?? 5_000;
  }

  start(): void {
    if (this.timer !== null) return;
    // Run an immediate tick so newly-attached clients see fresh data
    // within ~the first round-trip rather than waiting up to intervalMs.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests. */
  async tick(): Promise<void> {
    // Coalesce ticks: if the previous tick is still running (slow Redis)
    // we drop this one rather than queueing them up. Latest > complete.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const queues = await this.redis.smembers(redisKeys.queuesRegistry());
      if (queues.length === 0) {
        // Don't broadcast empty stats frames forever — if no queue has
        // ever been enqueued to, there's nothing to chart and nothing to
        // wake clients up over.
        return;
      }

      // ONE pipeline for ALL queues, four commands each. Keeps the
      // round-trip fixed at 1 regardless of queue count.
      const pipe = this.redis.pipeline();
      for (const q of queues) {
        pipe.hgetall(redisKeys.queueStats(q));
        pipe.zcard(redisKeys.queuePending(q));
        pipe.zcard(redisKeys.queueActive(q));
        pipe.exists(redisKeys.queuePaused(q));
      }
      const res = (await pipe.exec()) ?? [];

      const snapshots: QueueStatsSnapshot[] = [];
      for (let i = 0; i < queues.length; i++) {
        const base = i * 4;
        const stats = (res[base]?.[1] ?? {}) as Record<string, string>;
        const pending = (res[base + 1]?.[1] as number | undefined) ?? 0;
        const active = (res[base + 2]?.[1] as number | undefined) ?? 0;
        const paused = ((res[base + 3]?.[1] as number | undefined) ?? 0) === 1;

        snapshots.push({
          queueName: queues[i],
          enqueued: toNum(stats[QUEUE_STATS_FIELDS.enqueued]),
          completed: toNum(stats[QUEUE_STATS_FIELDS.completed]),
          failed: toNum(stats[QUEUE_STATS_FIELDS.failed]),
          dead: toNum(stats[QUEUE_STATS_FIELDS.dead]),
          currentPending: pending,
          currentActive: active,
          paused,
        });
      }

      const msg = JSON.stringify({ type: 'stats', queues: snapshots });
      this.opts.send(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'warn',
        msg: 'stats_broadcast_tick_failed',
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      this.inFlight = false;
    }
  }
}

function toNum(s: string | undefined): number {
  if (s === undefined || s === null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
