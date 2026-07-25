/**
 * Job <-> Redis HASH codec.
 *
 * Lives in @flowq/sdk because both the API (writer at enqueue time) and
 * the worker (reader at claim time, writer at complete/fail time) need
 * the EXACT same encoding. Drift here is silent corruption.
 *
 * Encoding rules:
 *   • Redis HSET only stores strings.
 *   • `payload` is JSON-encoded (the only nested object in the model).
 *   • All numbers are stringified (timestamps, attempts, priority, …).
 *   • Nullable fields are OMITTED rather than stored as "" — HGETALL on
 *     a missing field returns `undefined`, which the decoder maps to
 *     `null`. This avoids the "" vs real-empty-string ambiguity.
 *
 * Symmetric guarantee: `redisHashToJob(jobToRedisHash(j))` === `j`
 * (modulo `payload` reference identity — JSON round-trip).
 */
import { Job, JobStatus } from './types';

/** Encode a Job into the field map that ioredis HSET accepts. */
export function jobToRedisHash(job: Job): Record<string, string> {
  const out: Record<string, string> = {
    id: job.id,
    queueName: job.queueName,
    payload: JSON.stringify(job.payload),
    priority: String(job.priority),
    status: job.status,
    attempts: String(job.attempts),
    maxAttempts: String(job.maxAttempts),
    delay: String(job.delay),
    createdAt: String(job.createdAt),
    scheduledAt: String(job.scheduledAt),
    timeout: String(job.timeout),
  };
  if (job.idempotencyKey !== null) out.idempotencyKey = job.idempotencyKey;
  if (job.startedAt !== null) out.startedAt = String(job.startedAt);
  if (job.completedAt !== null) out.completedAt = String(job.completedAt);
  if (job.failedAt !== null) out.failedAt = String(job.failedAt);
  if (job.lastError !== null) out.lastError = job.lastError;
  if (job.workerId !== null) out.workerId = job.workerId;
  return out;
}

/**
 * Decode an HGETALL result back into a Job. Tolerant of missing nullable
 * fields. Throws if `id` is absent — that means the caller is looking
 * at an empty hash (i.e. the job key does not exist), and the caller
 * should be checking for that explicitly upstream.
 */
export function redisHashToJob(h: Record<string, string>): Job {
  if (!h.id) {
    throw new Error('redisHashToJob: hash is empty (job key missing in Redis)');
  }
  return {
    id: h.id,
    queueName: h.queueName,
    payload: JSON.parse(h.payload) as Record<string, unknown>,
    priority: Number(h.priority),
    status: h.status as JobStatus,
    attempts: Number(h.attempts),
    maxAttempts: Number(h.maxAttempts),
    delay: Number(h.delay),
    idempotencyKey: h.idempotencyKey ?? null,
    createdAt: Number(h.createdAt),
    scheduledAt: Number(h.scheduledAt),
    startedAt: h.startedAt !== undefined ? Number(h.startedAt) : null,
    completedAt: h.completedAt !== undefined ? Number(h.completedAt) : null,
    failedAt: h.failedAt !== undefined ? Number(h.failedAt) : null,
    lastError: h.lastError ?? null,
    workerId: h.workerId ?? null,
    timeout: Number(h.timeout),
  };
}

/* ============================================================================
 * SCORE FORMULA — `score = scheduledAt - (priority * PRIORITY_SCORE_BOOST_MS)`
 * ----------------------------------------------------------------------------
 * Redis sorted sets are min-ordered: ZRANGEBYSCORE returns lowest-first.
 * To make "highest priority eligible job" pop first we encode BOTH
 * "when is it due?" and "how important is it?" into one scalar where
 * lower-is-better.
 *
 * Properties:
 *   1. AT EQUAL PRIORITY, earlier scheduledAt wins → FIFO within a class.
 *   2. AT EQUAL scheduledAt, higher priority wins by 1 second per level.
 *   3. THE BOOST IS SMALL (10s max). Priority is a tie-breaker, not an
 *      override — a priority-1 job scheduled 1 minute ago still drains
 *      before a priority-10 job scheduled 1 minute from now. This is
 *      intentional: priority must never starve old work.
 *
 * KNOWN HAZARD (handled by the dequeue Lua script):
 *   A high-priority FUTURE job has score (scheduledAt - boost) which
 *   may be ≤ now. A naive ZRANGEBYSCORE would pop it early. The
 *   dequeue script therefore re-checks `scheduledAt <= nowMs` from
 *   the job's HASH before claiming.
 * ========================================================================= */
export const PRIORITY_SCORE_BOOST_MS = 1000;

/** The single function the rest of FlowQ uses to compute a queue score. */
export function computeScore(scheduledAt: number, priority: number): number {
  return scheduledAt - priority * PRIORITY_SCORE_BOOST_MS;
}
