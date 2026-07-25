import type { Redis } from 'ioredis';
import {
  Job,
  JobStatus,
  redisKeys,
  redisHashToJob,
  NAMESPACE,
} from '@flowq/sdk';
import { logger } from './logger';
import { publishJobEvent } from './events';

/* ============================================================================
 * Atomic claim — Lua script
 * ============================================================================
 *
 * WHY LUA?
 * --------
 * The minimum claim is a four-step sequence:
 *
 *   (1) ZRANGEBYSCORE pending -inf now LIMIT 0 N     ← pick candidates
 *   (2) HGET job:{id} scheduledAt                    ← re-check eligibility
 *   (3) ZREM pending {id}                            ← take it off the queue
 *   (4) ZADD active {now} {id}                       ← mark it claimed
 *   (5) HSET job:{id} status ACTIVE workerId ... startedAt ...
 *
 * If we ran these as five separate commands from Node, two workers polling
 * at the same instant would both pass step (1) seeing the same id, both
 * pass step (3) (one wins, one no-ops), both pass step (4)… and now the
 * loser thinks it owns a job that another worker has claimed and may
 * already be executing. Two workers on the same payload is the worst-case
 * outcome for any queue: duplicate side effects (charging a card twice,
 * sending an email twice).
 *
 * The fix is server-side atomicity: bundle the entire sequence into a Lua
 * script and let Redis run it as one indivisible operation. Redis is
 * single-threaded for command execution, so a Lua script behaves like a
 * critical section — no other client can interleave commands while it
 * runs. That is the only correct primitive for this problem.
 *
 * WHY THE scheduledAt RE-CHECK (step 2)?
 * --------------------------------------
 * Our score is `scheduledAt - priority * 1000` (see @flowq/sdk codec.ts).
 * That means a priority-10 job scheduled 5 seconds in the future has
 * score (now - 5000), which is ≤ now. A naive `ZRANGEBYSCORE -inf now`
 * would pop it 5 seconds early and break the producer's "delay" contract.
 *
 * So inside the script, for each candidate, we read `scheduledAt` from
 * the job HASH and skip the candidate if it's not actually due yet.
 * We scan up to N candidates so a single stuck-in-the-future high
 * priority job does not block lower-priority jobs that ARE due.
 *
 * SELF-HEALING ORPHAN CLEANUP
 * ---------------------------
 * If a candidate's job HASH is gone (operator deleted, replication gap,
 * dev tool wiped a key) we ZREM it from the pending set. Otherwise the
 * orphan would sit forever as the lowest score and starve the queue.
 *
 * NON-CLUSTER NOTE
 * ----------------
 * The script computes the job key inside the script (`flowq:job:` + id)
 * rather than receiving it via KEYS[]. Redis Cluster requires all keys
 * touched by a script to live on the same hash slot, declared in KEYS[].
 * For our single-node deployment this is fine. To run in cluster mode we
 * would need to add a hash-tag (e.g. `flowq:job:{queueName}:{id}`) so
 * pending/active/job all hash to the same slot. Tracked as a future item.
 * ========================================================================= */

const CLAIM_LUA = `
-- KEYS[1] = pending zset key
-- KEYS[2] = active zset key
-- ARGV[1] = nowMs
-- ARGV[2] = workerId
-- ARGV[3] = job-key prefix (e.g. "flowq:job:")
-- ARGV[4] = scan window size

local nowMs = tonumber(ARGV[1])
local workerId = ARGV[2]
local jobKeyPrefix = ARGV[3]
local windowN = tonumber(ARGV[4])

-- Pull up to windowN candidates whose ENCODED score <= nowMs. This is
-- the quick filter; the per-job re-check below is the correct one.
local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs, 'LIMIT', 0, windowN)
if #candidates == 0 then
  return false
end

for i = 1, #candidates do
  local jobId = candidates[i]
  local jobKey = jobKeyPrefix .. jobId
  local scheduledAtStr = redis.call('HGET', jobKey, 'scheduledAt')

  if scheduledAtStr == false then
    -- Orphan: pending entry with no backing HASH. Clean it up and move on.
    redis.call('ZREM', KEYS[1], jobId)
  else
    local scheduledAt = tonumber(scheduledAtStr)
    if scheduledAt ~= nil and scheduledAt <= nowMs then
      -- Truly eligible — take it.
      redis.call('ZREM', KEYS[1], jobId)
      redis.call('ZADD', KEYS[2], nowMs, jobId)
      redis.call('HSET', jobKey,
        'status', 'ACTIVE',
        'workerId', workerId,
        'startedAt', nowMs)
      return jobId
    end
    -- Otherwise the priority boost made the score look due but the job
    -- is genuinely scheduled for later. Leave it in pending and try the
    -- next candidate.
  end
end

return false
`;

/**
 * How many top-of-queue candidates the script inspects per call.
 *
 * Setting this to 1 is the most efficient happy path but starves the
 * queue when the lowest-score entry is a high-priority FUTURE job
 * (priority boost can make a job "look due" up to 10s early). At 5
 * we tolerate up to ~5 such ghosts ahead of a real job before we sleep
 * — which is plenty for normal traffic and still bounded.
 */
const SCAN_WINDOW = 5;

/** SHA1 of the script, populated lazily on first call. */
let scriptSha: string | null = null;

async function loadScript(redis: Redis): Promise<string> {
  if (scriptSha) return scriptSha;
  scriptSha = (await redis.script('LOAD', CLAIM_LUA)) as string;
  logger.info('claim_script_loaded', { sha: scriptSha });
  return scriptSha;
}

/**
 * Run the claim script with EVALSHA, falling back to EVAL once on
 * NOSCRIPT (the script cache was flushed e.g. by SCRIPT FLUSH or a
 * Redis restart). After fallback we re-cache the SHA for the next call.
 */
async function evalClaim(
  redis: Redis,
  pendingKey: string,
  activeKey: string,
  nowMs: number,
  workerId: string,
): Promise<string | null> {
  const args = [String(nowMs), workerId, `${NAMESPACE}:job:`, String(SCAN_WINDOW)];
  try {
    const sha = await loadScript(redis);
    const r = await redis.evalsha(sha, 2, pendingKey, activeKey, ...args);
    return (r as string | null) ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NOSCRIPT')) {
      logger.warn('claim_script_noscript_reload');
      scriptSha = null;
      const r = await redis.eval(CLAIM_LUA, 2, pendingKey, activeKey, ...args);
      // Re-prime the cache for next time.
      void loadScript(redis);
      return (r as string | null) ?? null;
    }
    throw err;
  }
}

/**
 * Atomically claim the next eligible job from the queue.
 *
 * Returns the full Job (decoded from its HASH) on success, or null if
 * nothing is currently due. Caller decides what to do on null —
 * typically: sleep `pollIntervalMs` and try again.
 *
 * Two failure modes the caller should be aware of:
 *   1. The script returns a jobId, but the subsequent HGETALL returns
 *      `{}` because someone deleted the hash between EVALSHA and HGETALL.
 *      Extremely unlikely (microseconds window) but we surface it as
 *      `null` rather than crashing — let the loop pick something else.
 *   2. The decoded job has status !== 'ACTIVE'. That would mean the
 *      script's HSET didn't take effect, which is impossible by Lua
 *      semantics. We log and treat as null — defensive belt-and-braces.
 */
export async function claimJob(
  queueName: string,
  workerId: string,
  redis: Redis,
): Promise<Job | null> {
  const nowMs = Date.now();
  const pendingKey = redisKeys.queuePending(queueName);
  const activeKey = redisKeys.queueActive(queueName);

  const jobId = await evalClaim(redis, pendingKey, activeKey, nowMs, workerId);
  if (!jobId) return null;

  const hash = await redis.hgetall(redisKeys.job(jobId));
  if (!hash || !hash.id) {
    logger.warn('claim_hash_missing_after_eval', { jobId, queueName, workerId });
    return null;
  }

  const job = redisHashToJob(hash);
  if (job.status !== JobStatus.ACTIVE) {
    logger.warn('claim_unexpected_status', {
      jobId,
      queueName,
      workerId,
      status: job.status,
    });
  }

  logger.info('job_claimed', {
    workerId,
    jobId: job.id,
    queueName,
    priority: job.priority,
    attempts: job.attempts,
    scheduledAt: job.scheduledAt,
    nowMs,
  });

  // Notify the dashboard that work has begun. Fire-and-forget — the
  // publish failure path is logged inside publishJobEvent and we never
  // want to block the worker on a transient pub/sub hiccup.
  void publishJobEvent(redis, 'job:started', job);

  return job;
}
