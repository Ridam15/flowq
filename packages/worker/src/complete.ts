import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import {
  Job,
  JobStatus,
  redisKeys,
  computeScore,
  QUEUE_STATS_FIELDS,
  JOB_HASH_FIELDS,
} from '@flowq/sdk';
import { logger } from './logger';
import { publishJobEvent } from './events';

/* ============================================================================
 * BACKOFF — `min(2^attempts * 1000 + random(0,1000), 30000)`
 * ----------------------------------------------------------------------------
 * Exponential growth with FULL JITTER. The exponential part is well known:
 * back off harder on consecutive failures so a flapping downstream gets
 * room to recover. The jitter is the part people skip and regret.
 *
 * WHY JITTER (the convoy / thundering-herd argument):
 *   Imagine 100 workers all processing similar jobs that hit the same
 *   downstream API. The downstream goes down for 5 seconds. All 100
 *   jobs fail at roughly the same instant.
 *
 *   Without jitter, every retry is scheduled at exactly
 *   `now + 2^1*1000` = +2000ms. So at T+2s, all 100 workers re-attempt
 *   at once. The downstream — which may still be recovering — gets
 *   slammed and fails again. Now they're all on attempt 2, scheduled
 *   for T+2s + 4s = T+6s. They fire in lockstep again. The convoy
 *   never breaks up; the downstream never gets a quiet moment to
 *   recover. This is a classic distributed-systems failure mode.
 *
 *   With full jitter (random 0..1000ms added) the first retry wave
 *   spreads over a 1-second window. The next wave spreads over more.
 *   The downstream sees a steady trickle instead of a cliff, which is
 *   the load shape recovery actually wants.
 *
 *   We use AWS-style "full jitter" (random within the cap) rather than
 *   "equal jitter" (half-fixed-half-random) because empirically full
 *   jitter has the lowest contention for high-concurrency workloads
 *   (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
 *
 * THE CAP (30s):
 *   Without a cap, attempt #10 waits 17 minutes and #20 waits 12 days.
 *   That makes status diagnosis hard ("why is this stuck?"). 30s is a
 *   reasonable ceiling for a queue worker — past that, the failure is
 *   probably permanent and DLQ is the right destination anyway.
 * ========================================================================= */
export const BACKOFF_CAP_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_JITTER_MS = 1_000;

export function computeBackoffMs(attempts: number, rand: () => number = Math.random): number {
  const exponential = Math.pow(2, attempts) * BACKOFF_BASE_MS;
  const jitter = Math.floor(rand() * BACKOFF_JITTER_MS);
  return Math.min(exponential + jitter, BACKOFF_CAP_MS);
}

/* ----------------------------------------------------------------------------
 * Postgres audit helpers — both best-effort, never throw.
 * The whole worker pipeline keeps Redis as the source of truth; Postgres
 * is the durable journal for the dashboard and post-incident debugging.
 * -------------------------------------------------------------------------- */
async function pgUpdateJobStatus(
  pool: Pool,
  jobId: string,
  fields: {
    status: JobStatus;
    attempts?: number;
    completedAt?: number | null;
    failedAt?: number | null;
    startedAt?: number | null;
    lastError?: string | null;
    workerId?: string | null;
    scheduledAt?: number | null;
  },
  fromStatus: JobStatus | null,
  workerId: string | null,
  errorText: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    // We compose the UPDATE dynamically because every transition writes a
    // different mix of columns. A static query would have to either NULL
    // out untouched columns (wrong) or use COALESCE on every column
    // (verbose and easy to get wrong).
    const sets: string[] = ['status = $1'];
    const args: unknown[] = [fields.status];
    let i = 2;
    if (fields.attempts !== undefined) { sets.push(`attempts = $${i++}`); args.push(fields.attempts); }
    if (fields.completedAt !== undefined) { sets.push(`completed_at = ${fields.completedAt === null ? 'NULL' : `to_timestamp($${i}::bigint / 1000.0)`}`); if (fields.completedAt !== null) { args.push(fields.completedAt); i++; } }
    if (fields.failedAt !== undefined) { sets.push(`failed_at = ${fields.failedAt === null ? 'NULL' : `to_timestamp($${i}::bigint / 1000.0)`}`); if (fields.failedAt !== null) { args.push(fields.failedAt); i++; } }
    if (fields.startedAt !== undefined) { sets.push(`started_at = ${fields.startedAt === null ? 'NULL' : `to_timestamp($${i}::bigint / 1000.0)`}`); if (fields.startedAt !== null) { args.push(fields.startedAt); i++; } }
    if (fields.lastError !== undefined) { sets.push(`last_error = $${i++}`); args.push(fields.lastError); }
    if (fields.workerId !== undefined) { sets.push(`worker_id = $${i++}`); args.push(fields.workerId); }
    if (fields.scheduledAt !== undefined) { sets.push(`scheduled_at = ${fields.scheduledAt === null ? 'NULL' : `to_timestamp($${i}::bigint / 1000.0)`}`); if (fields.scheduledAt !== null) { args.push(fields.scheduledAt); i++; } }
    args.push(jobId);
    await pool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${i}`, args);

    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, worker_id, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [jobId, fromStatus, fields.status, workerId, errorText, metadata],
    );
  } catch (err) {
    logger.error('pg_audit_failed', {
      jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record the PENDING→ACTIVE transition in Postgres. Best-effort and
 * fire-and-forget from the worker loop — Redis (via the Lua claim) is the
 * source of truth for the claim; this only keeps the durable audit trail
 * honest.
 *
 * Why this exists: the Lua claim writes `startedAt`/`workerId`/status to the
 * Redis job hash but nothing was persisting the ACTIVE transition to
 * Postgres. Consequences: `jobs.started_at` stayed NULL for the whole
 * job lifetime, there was no `ACTIVE` row in `job_events` (so the forensic
 * timeline jumped PENDING→COMPLETED), and the dashboard couldn't show a
 * "started at" for a currently-running job. This closes all three.
 *
 * Kept OFF the hot claim path: the caller invokes it with `void` so a slow
 * Postgres never adds latency to claim→execute. A failure is swallowed and
 * logged, exactly like the other pg audit helpers.
 */
export async function recordJobActive(job: Job, pool: Pool): Promise<void> {
  try {
    await pool.query(
      `UPDATE jobs
          SET status = $1,
              worker_id = $2,
              started_at = ${job.startedAt === null ? 'NULL' : 'to_timestamp($3::bigint / 1000.0)'}
        WHERE id = ${job.startedAt === null ? '$3' : '$4'}`,
      job.startedAt === null
        ? [JobStatus.ACTIVE, job.workerId, job.id]
        : [JobStatus.ACTIVE, job.workerId, job.startedAt, job.id],
    );
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, worker_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [job.id, JobStatus.PENDING, JobStatus.ACTIVE, job.workerId, { source: 'claim' }],
    );
  } catch (err) {
    logger.error('pg_active_audit_failed', {
      jobId: job.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mark a job COMPLETED.
 *
 * Atomic Redis writes:
 *   • ZREM active        — release the lease
 *   • HSET status/completedAt + HDEL workerId — update the job document
 *   • HINCRBY stats.completed — counters
 *
 * Then a best-effort Postgres update + audit row. If Postgres is down
 * the job is still completed in Redis — the worst-case outcome is a
 * stale row in the dashboard, not a duplicate execution.
 */
export async function completeJob(job: Job, redis: Redis, pool: Pool): Promise<void> {
  const completedAt = Date.now();
  const durationMs = job.startedAt !== null ? completedAt - job.startedAt : null;

  const tx = redis.multi();
  tx.zrem(redisKeys.queueActive(job.queueName), job.id);
  tx.hset(redisKeys.job(job.id), {
    [JOB_HASH_FIELDS.status]: JobStatus.COMPLETED,
    [JOB_HASH_FIELDS.completedAt]: String(completedAt),
  });
  // The spec says "workerId null" — Redis can't HSET to nil, so HDEL.
  tx.hdel(redisKeys.job(job.id), JOB_HASH_FIELDS.workerId);
  tx.hincrby(
    redisKeys.queueStats(job.queueName),
    QUEUE_STATS_FIELDS.completed,
    1,
  );
  // Emit a duration sample on the metrics stream so the API's /metrics
  // endpoint can observe the histogram. MAXLEN ~ caps memory regardless
  // of throughput; '~' is the approximate trim flag (cheaper than exact).
  // We only emit if we actually know the duration — an unknown startedAt
  // would skew the histogram with zeroes.
  if (durationMs !== null && durationMs >= 0) {
    tx.xadd(
      redisKeys.metricsDurations(),
      'MAXLEN',
      '~',
      '10000',
      '*',
      'queueName',
      job.queueName,
      'seconds',
      String(durationMs / 1000),
    );
  }

  const res = await tx.exec();
  if (res === null) throw new Error('completeJob: MULTI/EXEC returned null');
  for (const [err] of res) if (err) throw err;

  logger.info('job_completed', {
    workerId: job.workerId,
    jobId: job.id,
    queueName: job.queueName,
    completedAt,
    durationMs,
  });

  await pgUpdateJobStatus(
    pool,
    job.id,
    {
      status: JobStatus.COMPLETED,
      completedAt,
      // Persist startedAt too. The Lua claim writes it to the Redis hash
      // but nothing had been writing it to Postgres, so `jobs.started_at`
      // was always NULL — breaking any "execution duration" SQL query and
      // the dashboard timeline. `job.startedAt` is the claim timestamp
      // carried on the decoded job.
      startedAt: job.startedAt,
      workerId: null,
    },
    JobStatus.ACTIVE,
    job.workerId,
    null,
    { source: 'complete' },
  );

  // Mutate a local copy with the post-transition fields so the
  // event payload reflects the new truth. We don't re-HGETALL because
  // we already have everything we need and the round-trip would just
  // delay the broadcast.
  void publishJobEvent(redis, 'job:completed', {
    ...job,
    status: JobStatus.COMPLETED,
    completedAt,
    workerId: null,
  });
}

/**
 * Mark a job FAILED. Two distinct paths:
 *
 *   (a) attempts < maxAttempts   → re-enqueue with backoff delay
 *   (b) attempts >= maxAttempts  → DEAD: insert into DLQ, no retry
 *
 * Both paths are atomic in Redis (one MULTI). Postgres is best-effort.
 *
 * Note `attempts` semantics: incoming `job.attempts` is what was true
 * BEFORE this attempt. After this attempt fails, the new value is
 * `job.attempts + 1`. Backoff is computed from the new value so the
 * first retry already sees a real delay (~2s + jitter), not a 1ms
 * busy-loop.
 */
export async function failJob(
  job: Job,
  err: Error,
  redis: Redis,
  pool: Pool,
): Promise<void> {
  const newAttempts = job.attempts + 1;
  const failedAt = Date.now();
  const errorMessage = err.message || String(err);
  // Truncate to a reasonable size so a misbehaving handler with a
  // megabyte stack trace doesn't blow up the job HASH or the audit log.
  const truncatedError = errorMessage.length > 4096 ? errorMessage.slice(0, 4096) + '…[truncated]' : errorMessage;

  if (newAttempts < job.maxAttempts) {
    // ----- Retry path -----------------------------------------------------
    const backoffMs = computeBackoffMs(newAttempts);
    const scheduledAt = failedAt + backoffMs;
    const score = computeScore(scheduledAt, job.priority);

    const tx = redis.multi();
    tx.zrem(redisKeys.queueActive(job.queueName), job.id);
    tx.hset(redisKeys.job(job.id), {
      [JOB_HASH_FIELDS.status]: JobStatus.PENDING,
      [JOB_HASH_FIELDS.attempts]: String(newAttempts),
      [JOB_HASH_FIELDS.lastError]: truncatedError,
      [JOB_HASH_FIELDS.failedAt]: String(failedAt),
      [JOB_HASH_FIELDS.scheduledAt]: String(scheduledAt),
    });
    tx.hdel(
      redisKeys.job(job.id),
      JOB_HASH_FIELDS.workerId,
      JOB_HASH_FIELDS.startedAt,
    );
    tx.zadd(redisKeys.queuePending(job.queueName), score, job.id);
    tx.hincrby(
      redisKeys.queueStats(job.queueName),
      QUEUE_STATS_FIELDS.failed,
      1,
    );

    const res = await tx.exec();
    if (res === null) throw new Error('failJob(retry): MULTI/EXEC returned null');
    for (const [e] of res) if (e) throw e;

    logger.warn('job_retry_scheduled', {
      workerId: job.workerId,
      jobId: job.id,
      queueName: job.queueName,
      attempts: newAttempts,
      maxAttempts: job.maxAttempts,
      backoffMs,
      scheduledAt,
      error: truncatedError,
    });

    await pgUpdateJobStatus(
      pool,
      job.id,
      {
        status: JobStatus.PENDING,
        attempts: newAttempts,
        failedAt,
        lastError: truncatedError,
        workerId: null,
        startedAt: null,
        scheduledAt,
      },
      JobStatus.ACTIVE,
      job.workerId,
      truncatedError,
      { source: 'fail_retry', backoffMs, attempts: newAttempts },
    );

    void publishJobEvent(redis, 'job:failed', {
      ...job,
      status: JobStatus.PENDING,
      attempts: newAttempts,
      lastError: truncatedError,
      failedAt,
      scheduledAt,
      workerId: null,
      startedAt: null,
    });
    return;
  }

  // ----- DLQ path: max attempts exhausted -------------------------------
  const tx = redis.multi();
  tx.zrem(redisKeys.queueActive(job.queueName), job.id);
  tx.hset(redisKeys.job(job.id), {
    [JOB_HASH_FIELDS.status]: JobStatus.DEAD,
    [JOB_HASH_FIELDS.attempts]: String(newAttempts),
    [JOB_HASH_FIELDS.lastError]: truncatedError,
    [JOB_HASH_FIELDS.failedAt]: String(failedAt),
  });
  tx.hdel(
    redisKeys.job(job.id),
    JOB_HASH_FIELDS.workerId,
    JOB_HASH_FIELDS.startedAt,
  );
  tx.hincrby(
    redisKeys.queueStats(job.queueName),
    QUEUE_STATS_FIELDS.dead,
    1,
  );

  const res = await tx.exec();
  if (res === null) throw new Error('failJob(dead): MULTI/EXEC returned null');
  for (const [e] of res) if (e) throw e;

  logger.error('job_dead', {
    workerId: job.workerId,
    jobId: job.id,
    queueName: job.queueName,
    attempts: newAttempts,
    maxAttempts: job.maxAttempts,
    error: truncatedError,
  });

  // Postgres: status update + DLQ insert. Both inside the same try/catch
  // because we never want a Postgres failure to bubble up here.
  try {
    await pool.query(
      `UPDATE jobs
         SET status = $1,
             attempts = $2,
             failed_at = to_timestamp($3::bigint / 1000.0),
             last_error = $4,
             worker_id = NULL,
             started_at = NULL
       WHERE id = $5`,
      [JobStatus.DEAD, newAttempts, failedAt, truncatedError, job.id],
    );
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, worker_id, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        job.id,
        JobStatus.ACTIVE,
        JobStatus.DEAD,
        job.workerId,
        truncatedError,
        { source: 'fail_dead', attempts: newAttempts },
      ],
    );
    await pool.query(
      `INSERT INTO dead_letter_queue
         (job_id, queue_name, payload, last_error, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [job.id, job.queueName, job.payload, truncatedError, newAttempts],
    );
  } catch (e) {
    logger.error('pg_dlq_failed', {
      jobId: job.id,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  void publishJobEvent(redis, 'job:dead', {
    ...job,
    status: JobStatus.DEAD,
    attempts: newAttempts,
    lastError: truncatedError,
    failedAt,
    workerId: null,
    startedAt: null,
  });
}
