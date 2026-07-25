import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { redisKeys, WORKER_HASH_FIELDS } from '@flowq/sdk';

import { logger } from './logger';
import { initRedis, getRedis, closeRedis } from './redis';
import { initDB, getPool, closeDB } from './db';
import { makeWorkerId } from './identity';
import { registerWorker, deregisterWorker, markBusy, markIdle } from './registry';
import { claimJob } from './dequeue';
import { executeJob, JobTimeoutError } from './executor';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat';
import { completeJob, failJob, recordJobActive } from './complete';
import { LeaderElector } from './leader';
import { Watchdog } from './watchdog';
import { initEventPublisher } from './events';

/**
 * Cancellable sleep. Returns a promise that resolves either after `ms`
 * or as soon as `signal` flips to `true`.
 *
 * Why we don't just `await new Promise(r => setTimeout(r, ms))`:
 *   On graceful shutdown we want the poll loop to wake up immediately
 *   and exit, not finish a 5-second sleep first. A controller-pattern
 *   sleep makes shutdown bounded by the in-flight job duration only.
 */
function cancellableSleep(ms: number, isStopping: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isStopping()) {
      resolve();
      return;
    }
    let cleared = false;
    const handle = setTimeout(() => {
      cleared = true;
      resolve();
    }, ms);
    // Poll the stop flag every 100ms so we can shortcut out.
    // The interval is small enough to feel snappy, large enough to not
    // burn CPU on idle workers.
    const poll = setInterval(() => {
      if (isStopping() && !cleared) {
        clearTimeout(handle);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    // Also clear the poll on natural timer expiry.
    setTimeout(() => clearInterval(poll), ms + 50);
  });
}

export interface WorkerConfig {
  queueName: string;
  pollIntervalMs?: number;
  workerId?: string;
  /** Set false to skip leader election + watchdog (used by tests). Default true. */
  enableWatchdog?: boolean;
  /** Forwarded to Watchdog. */
  watchdogCheckIntervalMs?: number;
  /** Forwarded to Watchdog. */
  watchdogHeartbeatTimeoutMs?: number;
}

/**
 * The worker process — one queue, one instance per Node process.
 *
 * Lifecycle:
 *   start() → registerWorker → loop {
 *               check pause → sleep|continue
 *               claimJob    → sleep|continue
 *               markBusy → startHeartbeat → executeJob
 *                                          ↓
 *                                  success → completeJob
 *                                  error   → failJob (retry|DLQ)
 *                                          ↓
 *                                  stopHeartbeat → markIdle
 *             }
 *   stop()  → flag → wait current job → deregisterWorker → close conns
 *
 * Concurrency model: ONE job at a time per worker process. To run more
 * concurrency, run more processes. This is the unix philosophy applied
 * to queue workers — each process is dumb and safe; the orchestrator
 * (k8s, pm2, systemd) handles parallelism. It also means failure
 * isolation is process-level: a memory leak in one job's handler
 * doesn't poison sibling jobs.
 */
export class WorkerProcess {
  private readonly queueName: string;
  private readonly pollIntervalMs: number;
  private readonly workerId: string;
  private readonly enableWatchdog: boolean;
  private readonly watchdogCheckIntervalMs: number | undefined;
  private readonly watchdogHeartbeatTimeoutMs: number | undefined;

  private redis: Redis | null = null;
  private pool: Pool | null = null;

  private leader: LeaderElector | null = null;
  private watchdog: Watchdog | null = null;

  /**
   * Worker-lifetime heartbeat. Distinct from the per-job heartbeat in
   * heartbeat.ts: this one runs from `start()` to `stop()` regardless of
   * whether a job is in flight, so an IDLE worker still proves liveness
   * to the watchdog. Without it, the watchdog (correctly) reaps any
   * worker that hasn't claimed a job in `heartbeatTimeoutMs` — it has
   * no way to tell "process is dead" from "process is healthy but the
   * queue happens to be empty right now".
   */
  private lifetimeHeartbeatHandle: NodeJS.Timeout | null = null;

  private stopping = false;
  /** Resolves when the loop has exited (used by stop() to await drain). */
  private loopExited: Promise<void> | null = null;
  /** True while a single job is in flight; stop() waits for this to clear. */
  private inFlight = false;
  private signalsBound = false;
  private boundSigint: (() => void) | null = null;
  private boundSigterm: (() => void) | null = null;

  constructor(config: WorkerConfig) {
    this.queueName = config.queueName;
    this.pollIntervalMs = config.pollIntervalMs ?? 1_000;
    this.workerId = config.workerId ?? makeWorkerId();
    this.enableWatchdog = config.enableWatchdog ?? true;
    this.watchdogCheckIntervalMs = config.watchdogCheckIntervalMs;
    this.watchdogHeartbeatTimeoutMs = config.watchdogHeartbeatTimeoutMs;
  }

  /** Public for tests & dashboards. */
  getWorkerId(): string {
    return this.workerId;
  }

  async start(): Promise<void> {
    this.redis = initRedis();
    this.pool = await initDB();

    await registerWorker(this.workerId, this.queueName, this.redis);
    // Tag every event this worker publishes with our workerId so API
    // subscribers can dedup against their own publishes.
    initEventPublisher(this.workerId);
    this.startLifetimeHeartbeat(this.redis);

    logger.info('worker_started', {
      workerId: this.workerId,
      queueName: this.queueName,
      pollIntervalMs: this.pollIntervalMs,
      pid: process.pid,
    });

    this.bindSignalHandlers();

    // Try to win the watchdog leadership lease. If we win, spin up the
    // Watchdog; if we don't, we stay a pure worker for this lifetime.
    // See leader.ts for the full rationale on one-shot acquisition and
    // why we don't poll for re-acquisition.
    if (this.enableWatchdog) {
      this.leader = new LeaderElector(this.redis, this.workerId, {
        onAcquired: async () => {
          this.watchdog = new Watchdog({
            redis: this.redis as Redis,
            pool: this.pool as Pool,
            checkIntervalMs: this.watchdogCheckIntervalMs,
            heartbeatTimeoutMs: this.watchdogHeartbeatTimeoutMs,
          });
          await this.watchdog.start();
        },
        onLost: async () => {
          // Lost the lease mid-flight. Tear the watchdog down so we
          // don't have two of them once a new leader takes over.
          if (this.watchdog) {
            const wd = this.watchdog;
            this.watchdog = null;
            await wd.stop();
          }
        },
      });
      try {
        await this.leader.start();
      } catch (err) {
        // A failed leader bid must NOT take the worker down. Log loud,
        // continue as a pure worker; another instance will run the
        // watchdog.
        logger.error('watchdog_leader_bid_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.loopExited = this.runLoop().catch((err) => {
      logger.error('worker_loop_crashed', {
        workerId: this.workerId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Graceful shutdown. Idempotent.
   *
   * Order:
   *   1. Set stopping flag → poll loop + cancellableSleep wake up.
   *   2. Await loopExited → if a job was in-flight, this is where we
   *      block until completeJob / failJob has finished. NEVER kill
   *      a job mid-execution.
   *   3. deregisterWorker → remove from registry so the watchdog won't
   *      try to reclaim a job we've already settled.
   *   4. Close Redis + Postgres connections.
   *
   * Bounded by: time of the currently-executing job (capped by its
   * `timeout` seconds — see executor.ts). For real-world `timeout=30`
   * jobs that means worst-case 30s shutdown, well within k8s defaults.
   */
  async stop(): Promise<void> {
    if (this.stopping) {
      // Concurrent stop calls (e.g. SIGINT then SIGTERM) — wait for the
      // first one to complete rather than racing on connection close.
      if (this.loopExited) await this.loopExited;
      return;
    }
    this.stopping = true;

    logger.info('worker_stopping', {
      workerId: this.workerId,
      inFlight: this.inFlight,
    });

    if (this.loopExited) {
      await this.loopExited;
    }

    // Stop the watchdog BEFORE deregistering this worker — otherwise
    // the watchdog could observe its own host worker as "missing from
    // the registry" mid-shutdown and emit confusing log lines.
    if (this.watchdog) {
      try {
        await this.watchdog.stop();
      } catch (err) {
        logger.warn('watchdog_stop_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      this.watchdog = null;
    }
    if (this.leader) {
      try {
        await this.leader.stop();
      } catch (err) {
        logger.warn('watchdog_leader_stop_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      this.leader = null;
    }

    this.stopLifetimeHeartbeat();

    if (this.redis) {
      try {
        await deregisterWorker(this.workerId, this.redis);
      } catch (err) {
        logger.error('deregister_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.unbindSignalHandlers();
    await Promise.allSettled([closeRedis(), closeDB()]);

    logger.info('worker_shutdown_complete', { workerId: this.workerId });
  }

  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    const redis = getRedis();
    const pool = getPool();
    const pausedKey = redisKeys.queuePaused(this.queueName);

    while (!this.stopping) {
      // ---- Pause check ----------------------------------------------------
      // EXISTS is O(1). We re-check every tick rather than subscribing to
      // a key-space notification because that requires keyspace events
      // turned on in redis.conf — not always the case in shared infra.
      try {
        const paused = await redis.exists(pausedKey);
        if (paused === 1) {
          await cancellableSleep(this.pollIntervalMs, () => this.stopping);
          continue;
        }
      } catch (err) {
        logger.error('pause_check_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
        await cancellableSleep(this.pollIntervalMs, () => this.stopping);
        continue;
      }

      // ---- Claim ----------------------------------------------------------
      let job;
      try {
        job = await claimJob(this.queueName, this.workerId, redis);
      } catch (err) {
        logger.error('claim_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
        await cancellableSleep(this.pollIntervalMs, () => this.stopping);
        continue;
      }

      if (!job) {
        await cancellableSleep(this.pollIntervalMs, () => this.stopping);
        continue;
      }

      // ---- Execute --------------------------------------------------------
      this.inFlight = true;
      let stopHeartbeat: (() => void) | null = null;
      try {
        await markBusy(this.workerId, job.id, redis);
        stopHeartbeat = startHeartbeat(this.workerId, job.id, job.queueName, redis);
        // Persist the PENDING→ACTIVE transition to Postgres (best-effort,
        // off the hot path) so the audit log and dashboard show started_at
        // for in-flight jobs. Redis already holds the source of truth.
        void recordJobActive(job, pool);

        try {
          await executeJob(job);
          if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
          await completeJob(job, redis, pool);
        } catch (err) {
          if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
          const e = err instanceof Error ? err : new Error(String(err));
          if (e instanceof JobTimeoutError) {
            logger.warn('job_timeout', {
              workerId: this.workerId,
              jobId: job.id,
              queueName: job.queueName,
              timeoutSeconds: e.timeoutSeconds,
            });
          } else {
            logger.warn('job_threw', {
              workerId: this.workerId,
              jobId: job.id,
              queueName: job.queueName,
              message: e.message,
            });
          }
          // failJob is itself try/catch-internal for Postgres but its
          // Redis MULTI can throw — if THAT throws the loop crashes by
          // design; that means Redis is gone and we can't recover anyway.
          await failJob(job, e, redis, pool);
        }
      } finally {
        if (stopHeartbeat) stopHeartbeat();
        try {
          await markIdle(this.workerId, redis);
        } catch (err) {
          logger.warn('mark_idle_failed', {
            workerId: this.workerId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        this.inFlight = false;
      }
    }

    logger.info('worker_loop_exited', { workerId: this.workerId });
  }

  // -------------------------------------------------------------------------

  /**
   * Idempotent. Writes `lastHeartbeat = Date.now()` every
   * HEARTBEAT_INTERVAL_MS, plus an immediate kick so we don't wait one
   * full interval for the first signal of life. Failures are best-effort
   * — the next tick will overwrite. We deliberately do NOT touch
   * `currentJobId` here (that's owned by markBusy/markIdle); a separate
   * per-job heartbeat keeps refreshing currentJobId during execution.
   */
  private startLifetimeHeartbeat(redis: Redis): void {
    if (this.lifetimeHeartbeatHandle) return;
    const tick = (): void => {
      redis
        .hset(redisKeys.worker(this.workerId), {
          [WORKER_HASH_FIELDS.lastHeartbeat]: String(Date.now()),
        })
        .catch((err: Error) => {
          logger.warn('lifetime_heartbeat_failed', {
            workerId: this.workerId,
            message: err.message,
          });
        });
    };
    tick();
    this.lifetimeHeartbeatHandle = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  }

  private stopLifetimeHeartbeat(): void {
    if (this.lifetimeHeartbeatHandle) {
      clearInterval(this.lifetimeHeartbeatHandle);
      this.lifetimeHeartbeatHandle = null;
    }
  }

  private bindSignalHandlers(): void {
    if (this.signalsBound) return;
    this.signalsBound = true;
    this.boundSigint = (): void => { void this.stop().then(() => process.exit(0)); };
    this.boundSigterm = (): void => { void this.stop().then(() => process.exit(0)); };
    process.on('SIGINT', this.boundSigint);
    process.on('SIGTERM', this.boundSigterm);
  }

  private unbindSignalHandlers(): void {
    if (!this.signalsBound) return;
    if (this.boundSigint) process.removeListener('SIGINT', this.boundSigint);
    if (this.boundSigterm) process.removeListener('SIGTERM', this.boundSigterm);
    this.signalsBound = false;
  }
}

/* ============================================================================
 * Entry point
 * ============================================================================
 *
 * Reads queue name + poll interval from env vars and starts ONE
 * WorkerProcess. To run multiple workers, start multiple processes
 * (k8s replicas, docker scale, pm2 instances). See class JSDoc above
 * for the rationale.
 *
 * Auto-starts only when this file is the program entry point — being
 * imported by a test or by the e2e harness must NOT trigger the main()
 * side effect. `require.main === module` is the standard CommonJS guard
 * for this.
 */
async function main(): Promise<void> {
  const queueName = process.env.WORKER_QUEUE ?? 'default';
  const pollIntervalMs = Number(process.env.WORKER_POLL_MS ?? 1_000);
  const enableWatchdog = process.env.WORKER_DISABLE_WATCHDOG !== '1';
  const watchdogCheckIntervalMs = process.env.WATCHDOG_CHECK_MS
    ? Number(process.env.WATCHDOG_CHECK_MS)
    : undefined;
  const watchdogHeartbeatTimeoutMs = process.env.WATCHDOG_HEARTBEAT_TIMEOUT_MS
    ? Number(process.env.WATCHDOG_HEARTBEAT_TIMEOUT_MS)
    : undefined;

  const worker = new WorkerProcess({
    queueName,
    pollIntervalMs,
    enableWatchdog,
    watchdogCheckIntervalMs,
    watchdogHeartbeatTimeoutMs,
  });
  await worker.start();
  // Do not return — the loop is alive in the background. The signal
  // handlers in the class wire stop() → process.exit(0).
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('worker_boot_fatal', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
