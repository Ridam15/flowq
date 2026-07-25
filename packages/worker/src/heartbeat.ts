import type { Redis } from 'ioredis';
import { redisKeys, WORKER_HASH_FIELDS } from '@flowq/sdk';
import { logger } from './logger';

/**
 * Heartbeat interval (ms). Must be COMFORTABLY less than the watchdog
 * timeout (we plan 15s for the watchdog), so a single missed beat
 * doesn't trip the reaper. Two-or-three-beats safety margin is the
 * industry rule of thumb.
 *
 * Overridable via WORKER_HEARTBEAT_MS so integration tests can run with
 * tight timing without rebuilding. In production, leave it alone.
 */
export const HEARTBEAT_INTERVAL_MS: number = (() => {
  const v = Number(process.env.WORKER_HEARTBEAT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5_000;
})();

/**
 * Start emitting heartbeats for the worker while it holds a job.
 *
 * Returns a cleanup function. ALWAYS call it — once on success, once on
 * failure, once on timeout. The simplest pattern at the call site is:
 *
 *     const stop = startHeartbeat(...);
 *     try { await executeJob(job); }
 *     finally { stop(); }
 *
 * What we write each tick:
 *   • lastHeartbeat = Date.now()  → freshness signal for the watchdog
 *   • currentJobId  = jobId       → which job is being processed (handy
 *                                    for the dashboard, also lets a
 *                                    crashed-worker reaper requeue the
 *                                    exact id without scanning)
 *   • ZADD active XX GT now jobId → LEASE RENEWAL. The `:active` zset is
 *     scored by claim time, and the watchdog's PATH B reclaims any entry
 *     older than `heartbeatTimeoutMs`. Without renewal, ANY job that runs
 *     longer than that timeout would be reclaimed and re-executed on a
 *     LIVE worker — a duplicate-execution bug. By bumping the score to
 *     `now` on every beat (the classic visibility-timeout heartbeat), a
 *     healthy worker keeps its lease; a dead worker stops renewing and
 *     the entry ages out for legitimate recovery.
 *
 *     `XX GT` is load-bearing: `XX` = only update a member that still
 *     exists, so if completeJob/failJob already ZREM'd the job, the
 *     renewal is a no-op and can NEVER resurrect a settled job into the
 *     active set (closing the tick-vs-completion race). `GT` = only move
 *     the score forward, never backward.
 *
 * We do NOT touch `status` here — that's `markBusy`/`markIdle`'s job.
 *
 * Failure handling: a failing write (e.g. transient Redis blip) is
 * logged but NOT propagated. The heartbeat is best-effort; one missed
 * write is harmless because the next tick will overwrite it. If Redis
 * is down for >>15s the watchdog will reclaim the job — which is the
 * correct behavior, not something to fight.
 */
export function startHeartbeat(
  workerId: string,
  jobId: string,
  queueName: string,
  redis: Redis,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const tick = (): void => {
    const now = String(Date.now());
    redis
      .pipeline()
      .hset(redisKeys.worker(workerId), {
        [WORKER_HASH_FIELDS.lastHeartbeat]: now,
        [WORKER_HASH_FIELDS.currentJobId]: jobId,
      })
      // Renew the active-set lease. XX GT: only if the member still exists
      // and only to push the score forward. See the doc comment above.
      .zadd(redisKeys.queueActive(queueName), 'XX', 'GT', now, jobId)
      .exec()
      .catch((err: Error) => {
        logger.warn('heartbeat_write_failed', {
          workerId,
          jobId,
          message: err.message,
        });
      });
  };

  // Fire immediately — don't make the watchdog wait one full interval
  // for the first signal of life on a freshly-claimed job.
  tick();
  const handle = setInterval(tick, intervalMs);

  return (): void => {
    clearInterval(handle);
  };
}
