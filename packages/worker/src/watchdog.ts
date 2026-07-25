import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  redisKeys,
  WORKER_HASH_FIELDS,
  JOB_HASH_FIELDS,
  QUEUE_STATS_FIELDS,
  JobStatus,
  redisHashToJob,
} from '@flowq/sdk';

import { logger } from './logger';
import { deregisterWorker } from './registry';
import { publishJobEvent } from './events';

/* ============================================================================
 * Watchdog
 * ============================================================================
 *
 * Failure model the watchdog defends against:
 *
 *   A worker claims a job (Lua: ZREM pending → ZADD active → HSET status
 *   ACTIVE) and then DIES before completing it. The "death" can be:
 *
 *     • OOM-killed by the kernel
 *     • SIGKILL by k8s on a stuck pod
 *     • Network partition that severs Redis (heartbeat stops)
 *     • Bare-metal box loses power
 *
 *   In every case the job sits in `flowq:queue:{q}:active` with status
 *   ACTIVE forever. No one will ever execute it. The watchdog notices,
 *   transitions it back to PENDING, and lets a healthy worker pick it up.
 *
 * Two complementary detection paths run on every check tick:
 *
 *   PATH A — Worker-driven scan
 *     SMEMBERS workers:registry; HGETALL each one; if lastHeartbeat is
 *     older than `heartbeatTimeoutMs`, the worker is dead. Recover its
 *     `currentJobId` (if any), then deregister.
 *
 *   PATH B — Queue-driven scan ("belt and suspenders")
 *     For each queue in `queues:registry`: ZRANGEBYSCORE active -inf
 *     (now - heartbeatTimeoutMs). Any job that has been "active" longer
 *     than the timeout window without being settled is recovered.
 *
 *   Why both?
 *     A misses jobs orphaned by a worker that crashed BEFORE writing
 *     its first heartbeat — the worker hash might have a fresh start
 *     timestamp but no claim record on the job side. B catches it via
 *     the `:active` zset score (which IS set atomically by the Lua
 *     claim script, so it's always present). A also misses jobs from
 *     workers that crashed and were already deregistered out-of-band.
 *
 *     Conversely B alone could miss workers whose heartbeat stopped
 *     but whose currently-running job hasn't yet exceeded the timeout —
 *     PATH A catches those by checking the worker hash directly.
 *
 *     Order matters: we run A first, then B. A path's deregister
 *     pre-cleans the worker hash, so B sees only truly-orphaned jobs.
 *
 * Concurrency safety:
 *   Even though leader election makes the watchdog *normally* singleton,
 *   we still defend recoverJob with WATCH/MULTI/EXEC against the rare
 *   case where a returning worker (briefly partitioned, now back) and
 *   the watchdog race on the same job hash. See `recoverJob` for the
 *   detailed comment. The cost is one round-trip per recovery attempt;
 *   the benefit is "at-most-once recovery" instead of "approximately-
 *   at-most-once recovery".
 *
 * ========================================================================= */

export interface WatchdogConfig {
  redis: Redis;
  pool: Pool;
  /** How often the check loop runs. Default 10s. */
  checkIntervalMs?: number;
  /** A worker is considered dead if its lastHeartbeat is older than this. */
  heartbeatTimeoutMs?: number;
}

/**
 * Outcome of a single recoverJob() invocation. Returned for tests &
 * potential future metrics — the caller normally ignores it.
 */
export type RecoveryOutcome =
  | { recovered: true; previousWorkerId: string | null }
  | {
      recovered: false;
      reason: 'not_active' | 'job_missing' | 'lock_lost' | 'reclaimed_by_other';
    };

export class Watchdog {
  private readonly redis: Redis;
  private readonly pool: Pool;
  private readonly checkIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Tracks a check that is currently in-flight so stop() can await it. */
  private inFlight: Promise<void> | null = null;

  constructor(config: WatchdogConfig) {
    this.redis = config.redis;
    this.pool = config.pool;
    this.checkIntervalMs = config.checkIntervalMs ?? 10_000;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 15_000;

    if (this.heartbeatTimeoutMs <= this.checkIntervalMs) {
      // A timeout shorter than the check tick guarantees false positives
      // — the watchdog would mark a worker dead before that worker had a
      // chance to write its first heartbeat in the new tick window.
      logger.warn('watchdog_config_suspicious', {
        checkIntervalMs: this.checkIntervalMs,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        hint: 'heartbeatTimeoutMs should be >> checkIntervalMs',
      });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('watchdog_started', {
      checkIntervalMs: this.checkIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });

    // Run an immediate check so a freshly-promoted leader doesn't wait
    // up to checkIntervalMs to clean up jobs the previous leader's
    // departure might have left behind.
    //
    // BUG WE PREVIOUSLY HAD: we stored the immediate check in
    // `this.inFlight` and awaited it, but never cleared the field. The
    // setInterval below then saw `if (this.inFlight) return` on EVERY
    // tick and the watchdog silently never ran again. Lesson: an
    // "in-flight" sentinel must be cleared by the same code path that
    // sets it. We use a local promise for the initial check and only
    // start using `this.inFlight` for the periodic ones.
    const initial = this.safeCheck();
    await initial;

    this.timer = setInterval(() => {
      // If the previous check is still running, skip this tick. We never
      // want overlapping checks racing each other on Redis traffic.
      // Explicit null comparison: ESLint dislikes Promise-as-boolean.
      if (this.inFlight !== null) return;
      this.inFlight = this.safeCheck().finally(() => {
        this.inFlight = null;
      });
    }, this.checkIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain any in-flight check before returning so the caller can
    // safely close the redis/pg pools afterwards.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* logged inside safeCheck */
      }
      this.inFlight = null;
    }
    logger.info('watchdog_stopped', {});
  }

  /**
   * One check pass. Public for tests.
   *
   * NOTE: this method itself never throws — it logs and continues. The
   * watchdog must NEVER take down its host worker process; it is a
   * supervisor, and supervisor failures are logged and observed, not
   * fatal.
   */
  async check(): Promise<void> {
    const nowMs = Date.now();
    const cutoffMs = nowMs - this.heartbeatTimeoutMs;

    // ----- PATH A: dead-worker scan ----------------------------------------
    let workerIds: string[] = [];
    try {
      workerIds = await this.redis.smembers(redisKeys.workersRegistry());
    } catch (err) {
      logger.error('watchdog_smembers_workers_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    for (const workerId of workerIds) {
      try {
        const hash = await this.redis.hgetall(redisKeys.worker(workerId));
        // HGETALL on a missing key returns {}. If the registry has a stale
        // entry pointing at a deleted hash, just SREM it and move on — no
        // job can be orphaned to a worker whose hash we don't even have.
        if (!hash?.[WORKER_HASH_FIELDS.id]) {
          await this.redis.srem(redisKeys.workersRegistry(), workerId);
          logger.warn('watchdog_stale_registry_entry_pruned', { workerId });
          continue;
        }

        const lastHeartbeat = Number(hash[WORKER_HASH_FIELDS.lastHeartbeat] ?? '0');
        if (!Number.isFinite(lastHeartbeat) || lastHeartbeat > cutoffMs) {
          continue; // alive (or hash unparsable — be conservative, skip)
        }

        const currentJobId = hash[WORKER_HASH_FIELDS.currentJobId] || null;
        logger.warn('watchdog_dead_worker_detected', {
          workerId,
          lastHeartbeat,
          ageMs: nowMs - lastHeartbeat,
          currentJobId,
        });

        if (currentJobId) {
          await this.recoverJob(currentJobId, workerId);
        }

        // Deregister AFTER recovering so we don't lose the currentJobId
        // pointer in the unlikely event recoverJob throws.
        try {
          await deregisterWorker(workerId, this.redis);
        } catch (err) {
          logger.error('watchdog_deregister_failed', {
            workerId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        logger.error('watchdog_worker_scan_failed', {
          workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ----- PATH B: orphan-active scan --------------------------------------
    let queueNames: string[] = [];
    try {
      queueNames = await this.redis.smembers(redisKeys.queuesRegistry());
    } catch (err) {
      logger.error('watchdog_smembers_queues_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    for (const queueName of queueNames) {
      try {
        // Score in the active zset is the claim timestamp (set by the Lua
        // claim script). Anything older than cutoffMs has been claimed
        // longer than the heartbeat timeout window — orphan.
        const stuck: string[] = await this.redis.zrangebyscore(
          redisKeys.queueActive(queueName),
          '-inf',
          cutoffMs,
        );
        for (const jobId of stuck) {
          await this.recoverJob(jobId, null);
        }
      } catch (err) {
        logger.error('watchdog_active_scan_failed', {
          queueName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Atomic recovery of a single stuck job.
   *
   *   OPTIMISTIC LOCKING (WATCH / MULTI / EXEC)
   *   ----------------------------------------
   *   Two scenarios this protects against:
   *
   *     1. Two watchdog instances briefly racing during a leader handoff.
   *        Both see the same dead worker, both try to recover the same
   *        job. Without the lock, both would ZREM active (only one wins,
   *        the other becomes a no-op) BUT both would ZADD pending and
   *        both would HINCRBY enqueued — so the job ends up in pending
   *        once but the stat counter double-counts. Bad.
   *
   *     2. A "dead" worker that is in fact just network-partitioned and
   *        comes back online while the watchdog is mid-recovery. The
   *        worker would try to write completeJob (HSET status COMPLETED)
   *        on a job we have just transitioned to PENDING and re-enqueued
   *        — leading to a "completed" job that is also sitting in the
   *        pending zset. Worse than bad.
   *
   *   The defense is to WATCH `flowq:job:{id}` BEFORE checking its
   *   status, then run all our writes inside MULTI/EXEC. Redis aborts
   *   EXEC (returns null) if anything modified the WATCHed key between
   *   our WATCH and our EXEC. On abort we just log and return — the
   *   other actor's write stands.
   *
   *   We also re-read status inside the WATCH window: if the job is
   *   already in any non-ACTIVE state (it could have completed before
   *   we got to it, or some other process moved it back to PENDING
   *   already), there is nothing to do.
   *
   *   COST: at most one MULTI per job per check, plus one HGET. Cheap.
   *
   *   ATTEMPTS COUNT NOTE: spec says recoverJob does NOT increment
   *   attempts — the worker dying is treated as a system fault, not a
   *   user-code fault. The trade-off is that a poison-pill job that
   *   reliably crashes its worker will be recovered indefinitely. A
   *   future module should add a separate `recoveries` counter on the
   *   job hash with its own cap so we can DLQ chronic crashers.
   */
  async recoverJob(jobId: string, deadWorkerId: string | null): Promise<RecoveryOutcome> {
    const jobKey = redisKeys.job(jobId);
    let queueName: string | null = null;

    try {
      // WATCH must be on the SAME connection that runs MULTI/EXEC.
      // ioredis pipes MULTI/EXEC over the connection that owns the
      // pending transaction state, so this works as long as we don't
      // call into a different ioredis instance between WATCH and EXEC.
      await this.redis.watch(jobKey);

      // Read the fields we need to make the decision.
      const [statusField, queueField, workerField] = await this.redis.hmget(
        jobKey,
        JOB_HASH_FIELDS.status,
        JOB_HASH_FIELDS.queueName,
        JOB_HASH_FIELDS.workerId,
      );

      if (!statusField || !queueField) {
        await this.redis.unwatch();
        logger.warn('watchdog_recover_skipped_job_missing', { jobId, deadWorkerId });
        return { recovered: false, reason: 'job_missing' };
      }

      if (statusField !== JobStatus.ACTIVE) {
        await this.redis.unwatch();
        logger.info('watchdog_recover_skipped_not_active', {
          jobId,
          deadWorkerId,
          status: statusField,
        });
        return { recovered: false, reason: 'not_active' };
      }

      // OWNERSHIP GUARD (fixes double-recovery across PATH A / PATH B).
      //
      // PATH B (active-scan) recovers a stale job by id WITHOUT clearing the
      // dead worker's `currentJobId` pointer. So after PATH B recovers a job
      // and a LIVE worker re-claims it (status ACTIVE again, workerId = the
      // live worker), PATH A can later detect the still-registered dead
      // worker and try to recover the SAME job a second time — stealing it
      // from the healthy worker and causing a duplicate execution.
      //
      // When we're reaping a specific dead worker (deadWorkerId != null),
      // only recover if the job is STILL owned by that worker. If the hash's
      // workerId now names a different worker, the job has been legitimately
      // re-claimed and is not ours to touch. (PATH B passes deadWorkerId=null
      // and is instead guarded by the heartbeat lease renewal, so a live
      // worker's job never ages into the stale window in the first place.)
      const currentOwner = workerField || null;
      if (deadWorkerId !== null && currentOwner !== null && currentOwner !== deadWorkerId) {
        await this.redis.unwatch();
        logger.info('watchdog_recover_skipped_reclaimed', {
          jobId,
          deadWorkerId,
          currentOwner,
        });
        return { recovered: false, reason: 'reclaimed_by_other' };
      }

      queueName = queueField;
      const previousWorkerId = workerField || deadWorkerId;
      const nowMs = Date.now();

      const tx = this.redis.multi();
      tx.zrem(redisKeys.queueActive(queueName), jobId);
      // Score = nowMs (no priority boost). Recovery is a safety
      // operation; we want the job re-claimable IMMEDIATELY at neutral
      // priority. Re-applying the original priority bias here would
      // shift the recovered job ahead of jobs the producer enqueued
      // *while* the original holder was stuck — surprising behavior.
      tx.zadd(redisKeys.queuePending(queueName), nowMs, jobId);
      tx.hset(jobKey, {
        [JOB_HASH_FIELDS.status]: JobStatus.PENDING,
        // Update scheduledAt so the Lua claim script's re-check (which
        // gates on scheduledAt <= now) sees this job as immediately
        // eligible. Without this update, a job whose original
        // scheduledAt was in the future could remain stuck.
        [JOB_HASH_FIELDS.scheduledAt]: String(nowMs),
      });
      // workerId and startedAt no longer apply — HDEL them so a
      // subsequent HGETALL doesn't return stale data the next worker
      // could trip on.
      tx.hdel(jobKey, JOB_HASH_FIELDS.workerId, JOB_HASH_FIELDS.startedAt);
      tx.hincrby(redisKeys.queueStats(queueName), QUEUE_STATS_FIELDS.enqueued, 1);

      const execResult = await tx.exec();
      if (execResult === null) {
        // Someone modified the job hash between our WATCH and our EXEC.
        // Could be: (a) the original worker came back and is writing
        // completeJob/failJob, or (b) a sibling watchdog beat us to it.
        // Either way, our work is moot — abandon.
        logger.info('watchdog_recover_lock_lost', { jobId, deadWorkerId });
        return { recovered: false, reason: 'lock_lost' };
      }
      // ioredis returns null for transaction errors at the array level
      // (handled above) and per-command errors as the first tuple slot.
      for (const [err] of execResult) {
        if (err) throw err;
      }

      logger.info('job_recovered', {
        jobId,
        previousWorkerId,
        queueName,
        recoveredAt: nowMs,
      });

      // Best-effort Postgres audit. Same convention as completeJob /
      // failJob: Postgres is the audit log, never a gate on Redis truth.
      try {
        await this.pool.query(
          `INSERT INTO job_events (job_id, from_status, to_status, worker_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            jobId,
            JobStatus.ACTIVE,
            'RECOVERED',
            previousWorkerId,
            { source: 'watchdog', recoveredAt: nowMs },
          ],
        );
        // Also flip jobs.status back to PENDING so dashboards relying on
        // the SQL view see the same truth Redis has.
        await this.pool.query(
          `UPDATE jobs
              SET status = $1,
                  worker_id = NULL,
                  started_at = NULL,
                  scheduled_at = to_timestamp($2 / 1000.0)
            WHERE id = $3`,
          [JobStatus.PENDING, nowMs, jobId],
        );
      } catch (err) {
        logger.warn('watchdog_pg_event_failed', {
          jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Notify the dashboard. We re-read the hash so the published Job
      // reflects every post-recovery field (status PENDING, workerId
      // null, fresh scheduledAt). This is one extra round-trip per
      // recovery — recoveries are rare and observability matters more
      // than shaving a millisecond off the supervisor path here.
      try {
        const hash = await this.redis.hgetall(jobKey);
        if (hash && hash.id) {
          void publishJobEvent(this.redis, 'job:recovered', redisHashToJob(hash));
        }
      } catch {
        // event publish failure is non-fatal; recovery itself succeeded
      }

      return { recovered: true, previousWorkerId };
    } catch (err) {
      // Make sure we don't leave a WATCH dangling on this connection.
      try {
        await this.redis.unwatch();
      } catch {
        /* connection probably gone — let caller's next op surface it */
      }
      logger.error('watchdog_recover_failed', {
        jobId,
        deadWorkerId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  private async safeCheck(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      logger.error('watchdog_check_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
