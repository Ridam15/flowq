import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  Job,
  JobStatus,
  JOB_DEFAULTS,
  IDEMPOTENCY_TTL_SECONDS,
  redisKeys,
  QUEUE_STATS_FIELDS,
  jobToRedisHash,
  redisHashToJob,
  computeScore,
} from '@flowq/sdk';

/**
 * Public input shape for the producer side. All optional fields use
 * defaults sourced from `@flowq/sdk` (`JOB_DEFAULTS`) so the SDK and
 * the API can never disagree about what "default" means.
 */
export interface EnqueueInput {
  queueName: string;
  payload: Record<string, unknown>;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  timeout?: number;
}

/**
 * Push a job onto a queue.
 *
 * Step contract (in order):
 *   1. Idempotency lookup — if key exists and points to a live job hash,
 *      return that job verbatim. Skip everything else.
 *   2. Build the Job (UUID v4, scheduledAt = now + delay).
 *   3. Atomic Redis write via MULTI/EXEC: HSET job, ZADD pending,
 *      HINCRBY stats.enqueued, optional SET idempotency EX 86400.
 *   4. Best-effort Postgres audit (jobs + job_events). Errors logged,
 *      never thrown — Redis is the source of truth for queue state.
 *   5. Return the Job.
 *
 * IDEMPOTENCY RACE NOTE:
 *   Step 1 reads the idempotency pointer; step 3 writes it. Two
 *   producers racing on the same key can both pass step 1 and both
 *   create a job. The Postgres `UNIQUE(idempotency_key)` constraint
 *   catches one of them — but only after the Redis write is in.
 *   The clean fix is `SET … NX` first and branch on the result; we
 *   are following the spec's order here. Hardening item.
 */
export async function enqueueJob(
  input: EnqueueInput,
  redis: Redis,
  pool: Pool,
): Promise<Job> {
  // -------------------------- Step 1: idempotency check --------------------
  if (input.idempotencyKey) {
    const existingId = await redis.get(redisKeys.idempotency(input.idempotencyKey));
    if (existingId) {
      const existingHash = await redis.hgetall(redisKeys.job(existingId));
      // A non-empty hash (HGETALL on a missing key returns {}) means the
      // job is still in Redis — return it verbatim, do not re-enqueue.
      if (existingHash && existingHash.id) {
        return redisHashToJob(existingHash);
      }
      // Pointer is stale (job was deleted). Fall through to create a fresh
      // job; the SET in step 3 will overwrite the dangling pointer.
    }
  }

  // -------------------------- Step 2: build job ----------------------------
  const now = Date.now();
  const priority = input.priority ?? JOB_DEFAULTS.priority;
  const delay = input.delay ?? JOB_DEFAULTS.delay;
  const scheduledAt = now + delay * 1000;

  const job: Job = {
    id: uuidv4(),
    queueName: input.queueName,
    payload: input.payload,
    priority,
    status: JobStatus.PENDING,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? JOB_DEFAULTS.maxAttempts,
    delay,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
    scheduledAt,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
    workerId: null,
    timeout: input.timeout ?? JOB_DEFAULTS.timeout,
  };

  // -------------------------- Step 3: atomic Redis write --------------------
  // MULTI/EXEC guarantees all four writes hit Redis atomically. If any
  // command in the batch errors, none take effect; ioredis surfaces it
  // as a non-null first element in each `[err, result]` tuple.
  const tx = redis.multi();
  tx.hset(redisKeys.job(job.id), jobToRedisHash(job));
  tx.zadd(
    redisKeys.queuePending(job.queueName),
    computeScore(scheduledAt, priority),
    job.id,
  );
  tx.hincrby(
    redisKeys.queueStats(job.queueName),
    QUEUE_STATS_FIELDS.enqueued,
    1,
  );
  // Register this queue so the watchdog can discover it.
  // SADD on an existing member is a no-op — cheap to call every enqueue
  // and it means we never need a separate "create queue" admin call.
  tx.sadd(redisKeys.queuesRegistry(), job.queueName);
  if (job.idempotencyKey) {
    tx.set(
      redisKeys.idempotency(job.idempotencyKey),
      job.id,
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  const execResult = await tx.exec();
  if (execResult === null) {
    // exec() returns null only when a WATCHed key changed. We do not WATCH
    // here, so this is genuinely unexpected — surface it loudly.
    throw new Error('redis MULTI/EXEC returned null — transaction aborted');
  }
  for (const [err] of execResult) {
    if (err) throw err;
  }

  // -------------------------- Step 4: Postgres audit ------------------------
  // Best-effort. Redis is the source of truth for queue state; Postgres
  // is the durable audit log. If the DB is down, jobs still flow — we
  // log loudly so observability picks the gap up, but we never throw
  // here because that would make a transient DB blip a producer-facing
  // failure for work that is ALREADY accepted into the queue.
  try {
    await pool.query(
      `INSERT INTO jobs
         (id, queue_name, payload, priority, status, attempts, max_attempts,
          idempotency_key, created_at, scheduled_at, timeout_seconds)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8,
          to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0), $11)`,
      [
        job.id,
        job.queueName,
        job.payload,
        job.priority,
        job.status,
        job.attempts,
        job.maxAttempts,
        job.idempotencyKey,
        job.createdAt,
        job.scheduledAt,
        job.timeout,
      ],
    );
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, metadata)
       VALUES ($1, $2, $3, $4)`,
      [job.id, null, JobStatus.PENDING, { source: 'enqueue' }],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[enqueue] postgres audit write failed for job ${job.id}: ${msg}`);
  }

  // -------------------------- Step 5: return -------------------------------
  return job;
}
