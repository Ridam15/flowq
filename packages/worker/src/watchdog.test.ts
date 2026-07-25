/**
 * Watchdog integration tests.
 *
 * These run against a REAL Redis. We do not mock ioredis here because
 * the whole point of the watchdog is the WATCH/MULTI/EXEC dance — and
 * a mock that "implements" optimistic locking would just be re-implementing
 * Redis. Mocks would prove nothing.
 *
 * To run: have Redis listening at REDIS_URL (default redis://127.0.0.1:6379).
 * To skip: set FLOWQ_SKIP_INTEGRATION=1 (CI without redis can opt out).
 *
 * Isolation strategy: every test generates unique queue / worker / job
 * IDs (UUID-style timestamp+random). We DEL only the keys we created
 * in afterEach — never `FLUSHDB` the shared local Redis, because dev
 * users may have other things running on the same instance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  redisKeys,
  WORKER_HASH_FIELDS,
  WORKER_STATUS,
  JOB_HASH_FIELDS,
  JOB_DEFAULTS,
  JobStatus,
  jobToRedisHash,
  type Job,
} from '@flowq/sdk';

import { Watchdog } from './watchdog';
import { LeaderElector } from './leader';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const SKIP = process.env.FLOWQ_SKIP_INTEGRATION === '1';

/** Probe redis connectivity once. If it fails, skip the whole file. */
let redisReachable = false;
let probeError: string | null = null;

beforeAll(async () => {
  if (SKIP) return;
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
  });
  try {
    await probe.connect();
    await probe.ping();
    redisReachable = true;
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  } finally {
    probe.disconnect();
  }
});

const itLive = (name: string, fn: () => Promise<void> | void) =>
  it(name, async () => {
    if (SKIP) return;
    if (!redisReachable) {
      throw new Error(`redis unreachable at ${REDIS_URL}: ${probeError ?? 'unknown'}`);
    }
    await fn();
  });

// ---------------------------------------------------------------------------
// Fake Postgres pool — watchdog uses it best-effort; we just record calls.
// ---------------------------------------------------------------------------
function makeFakePool(): Pool {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fake = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
    _calls: calls,
  };
  return fake as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Per-test scope: a unique namespace and cleanup.
// ---------------------------------------------------------------------------
interface Scope {
  redis: Redis;
  queueName: string;
  workerId: string;
  cleanupKeys: Set<string>;
}

function newScope(): Scope {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const tag = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    redis: r,
    queueName: `${tag}-q`,
    workerId: `${tag}-w`,
    cleanupKeys: new Set<string>(),
  };
}

async function cleanupScope(scope: Scope): Promise<void> {
  const keys = [
    redisKeys.queuePending(scope.queueName),
    redisKeys.queueActive(scope.queueName),
    redisKeys.queueStats(scope.queueName),
    redisKeys.queuePaused(scope.queueName),
    redisKeys.worker(scope.workerId),
    ...scope.cleanupKeys,
  ];
  if (keys.length) await scope.redis.del(...keys);
  // SREM us out of any registry sets we may have populated.
  await scope.redis.srem(redisKeys.workersRegistry(), scope.workerId);
  await scope.redis.srem(redisKeys.queuesRegistry(), scope.queueName);
  scope.redis.disconnect();
}

/** Build a Job, write it to the active zset + job hash as if a now-dead
 * worker had just claimed it. heartbeat lag controls how stuck it is. */
async function plantStuckJob(
  scope: Scope,
  opts: {
    jobId: string;
    claimedAtMs: number;
    workerId?: string;
    status?: JobStatus;
  },
): Promise<Job> {
  const { jobId, claimedAtMs, workerId, status = JobStatus.ACTIVE } = opts;
  const job: Job = {
    id: jobId,
    queueName: scope.queueName,
    payload: { wedge: true },
    priority: 5,
    status,
    attempts: 0,
    maxAttempts: JOB_DEFAULTS.maxAttempts,
    delay: 0,
    idempotencyKey: null,
    createdAt: claimedAtMs - 1_000,
    scheduledAt: claimedAtMs - 1_000,
    startedAt: claimedAtMs,
    completedAt: null,
    failedAt: null,
    lastError: null,
    workerId: workerId ?? null,
    timeout: JOB_DEFAULTS.timeout,
  };
  scope.cleanupKeys.add(redisKeys.job(jobId));
  await scope.redis.hset(redisKeys.job(jobId), jobToRedisHash(job));
  await scope.redis.zadd(redisKeys.queueActive(scope.queueName), claimedAtMs, jobId);
  await scope.redis.sadd(redisKeys.queuesRegistry(), scope.queueName);
  return job;
}

async function plantWorker(
  scope: Scope,
  opts: { workerId: string; lastHeartbeatMs: number; currentJobId?: string | null },
): Promise<void> {
  const { workerId, lastHeartbeatMs, currentJobId = null } = opts;
  const fields: Record<string, string> = {
    [WORKER_HASH_FIELDS.id]: workerId,
    [WORKER_HASH_FIELDS.queue]: scope.queueName,
    [WORKER_HASH_FIELDS.startedAt]: String(lastHeartbeatMs - 60_000),
    [WORKER_HASH_FIELDS.lastHeartbeat]: String(lastHeartbeatMs),
    [WORKER_HASH_FIELDS.status]: currentJobId ? WORKER_STATUS.busy : WORKER_STATUS.idle,
  };
  if (currentJobId) fields[WORKER_HASH_FIELDS.currentJobId] = currentJobId;
  await scope.redis.hset(redisKeys.worker(workerId), fields);
  await scope.redis.sadd(redisKeys.workersRegistry(), workerId);
  scope.cleanupKeys.add(redisKeys.worker(workerId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Watchdog — recoverJob (real redis)', () => {
  let scope: Scope;
  beforeEach(() => { scope = newScope(); });
  afterEach(async () => { await cleanupScope(scope); });

  itLive('re-enqueues a job whose owning worker timed out', async () => {
    const jobId = `job-${Date.now()}-a`;
    const deadWorker = `${scope.workerId}-dead`;
    const oldHeartbeat = Date.now() - 60_000; // 60s stale, well past 15s

    await plantStuckJob(scope, { jobId, claimedAtMs: oldHeartbeat, workerId: deadWorker });
    await plantWorker(scope, {
      workerId: deadWorker,
      lastHeartbeatMs: oldHeartbeat,
      currentJobId: jobId,
    });
    scope.cleanupKeys.add(redisKeys.worker(deadWorker));

    const wd = new Watchdog({
      redis: scope.redis,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });
    await wd.check();
    await wd.stop();

    // Job should be back in pending, not in active, status PENDING.
    const inActive = await scope.redis.zscore(
      redisKeys.queueActive(scope.queueName),
      jobId,
    );
    expect(inActive).toBeNull();

    const pendingScore = await scope.redis.zscore(
      redisKeys.queuePending(scope.queueName),
      jobId,
    );
    expect(pendingScore).not.toBeNull();
    // Score should be ~now (recovery uses Date.now(), no priority boost).
    expect(Number(pendingScore)).toBeGreaterThan(Date.now() - 5_000);

    const hash = await scope.redis.hgetall(redisKeys.job(jobId));
    expect(hash[JOB_HASH_FIELDS.status]).toBe(JobStatus.PENDING);
    expect(hash[JOB_HASH_FIELDS.workerId]).toBeUndefined();
    expect(hash[JOB_HASH_FIELDS.startedAt]).toBeUndefined();

    // Stats counter incremented.
    const enq = await scope.redis.hget(
      redisKeys.queueStats(scope.queueName),
      'enqueued',
    );
    expect(Number(enq)).toBe(1);

    // Dead worker SHOULD have been deregistered.
    const inReg = await scope.redis.sismember(redisKeys.workersRegistry(), deadWorker);
    expect(inReg).toBe(0);
    const deadHash = await scope.redis.hgetall(redisKeys.worker(deadWorker));
    expect(Object.keys(deadHash).length).toBe(0);
  });

  itLive('catches orphaned active-zset entries via the belt-and-suspenders scan', async () => {
    // No worker hash exists at all — only the stuck job. PATH B should
    // pick it up purely from the :active score being older than cutoff.
    const jobId = `job-${Date.now()}-b`;
    const oldClaim = Date.now() - 60_000;
    await plantStuckJob(scope, { jobId, claimedAtMs: oldClaim, workerId: 'ghost-worker' });

    const wd = new Watchdog({
      redis: scope.redis,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });
    await wd.check();
    await wd.stop();

    const inActive = await scope.redis.zscore(
      redisKeys.queueActive(scope.queueName),
      jobId,
    );
    expect(inActive).toBeNull();
    const inPending = await scope.redis.zscore(
      redisKeys.queuePending(scope.queueName),
      jobId,
    );
    expect(inPending).not.toBeNull();
  });

  itLive('does NOT recover a job whose worker is still heartbeating', async () => {
    const jobId = `job-${Date.now()}-c`;
    const liveWorker = `${scope.workerId}-live`;
    const recentHeartbeat = Date.now() - 1_000; // 1s stale, well within 15s

    await plantStuckJob(scope, {
      jobId,
      claimedAtMs: recentHeartbeat,
      workerId: liveWorker,
    });
    await plantWorker(scope, {
      workerId: liveWorker,
      lastHeartbeatMs: recentHeartbeat,
      currentJobId: jobId,
    });
    scope.cleanupKeys.add(redisKeys.worker(liveWorker));

    const wd = new Watchdog({
      redis: scope.redis,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });
    await wd.check();
    await wd.stop();

    const inActive = await scope.redis.zscore(
      redisKeys.queueActive(scope.queueName),
      jobId,
    );
    expect(inActive).not.toBeNull(); // still claimed, untouched
    const hash = await scope.redis.hgetall(redisKeys.job(jobId));
    expect(hash[JOB_HASH_FIELDS.status]).toBe(JobStatus.ACTIVE);
    // Live worker still in registry.
    const inReg = await scope.redis.sismember(redisKeys.workersRegistry(), liveWorker);
    expect(inReg).toBe(1);
  });

  itLive('skips jobs whose status is no longer ACTIVE (race with returning worker)', async () => {
    // Plant the job in active, but with status COMPLETED in the hash —
    // simulates the original worker finishing the job a moment before
    // the watchdog gets to it.
    const jobId = `job-${Date.now()}-d`;
    const oldClaim = Date.now() - 60_000;
    await plantStuckJob(scope, {
      jobId,
      claimedAtMs: oldClaim,
      workerId: 'returning-worker',
      status: JobStatus.COMPLETED,
    });

    const wd = new Watchdog({
      redis: scope.redis,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });
    const outcome = await wd.recoverJob(jobId, null);
    await wd.stop();

    expect(outcome).toEqual({ recovered: false, reason: 'not_active' });
    // The hash status must NOT have been overwritten back to PENDING.
    const hash = await scope.redis.hgetall(redisKeys.job(jobId));
    expect(hash[JOB_HASH_FIELDS.status]).toBe(JobStatus.COMPLETED);
    // Pending must remain empty for this job.
    const inPending = await scope.redis.zscore(
      redisKeys.queuePending(scope.queueName),
      jobId,
    );
    expect(inPending).toBeNull();
  });

  itLive('optimistic lock: only one of two concurrent watchdogs recovers the job', async () => {
    // The scenario: leader handoff window. Two watchdog instances both
    // see the same stuck job and both call recoverJob simultaneously.
    // We expect EXACTLY ONE to return recovered=true.
    const jobId = `job-${Date.now()}-e`;
    const oldClaim = Date.now() - 60_000;
    await plantStuckJob(scope, {
      jobId,
      claimedAtMs: oldClaim,
      workerId: 'ghost-worker',
    });

    // Each watchdog needs its OWN connection — WATCH state is
    // per-connection in Redis. Sharing one ioredis client across both
    // calls would silently serialise the WATCH/EXEC cycles and we'd
    // never observe the race.
    const r1 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const r2 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const wd1 = new Watchdog({
      redis: r1,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });
    const wd2 = new Watchdog({
      redis: r2,
      pool: makeFakePool(),
      checkIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000,
    });

    const [o1, o2] = await Promise.all([
      wd1.recoverJob(jobId, null).catch((e) => ({ error: String(e) })),
      wd2.recoverJob(jobId, null).catch((e) => ({ error: String(e) })),
    ]);

    await Promise.all([wd1.stop(), wd2.stop()]);
    r1.disconnect();
    r2.disconnect();

    const recovered = [o1, o2].filter(
      (o) => 'recovered' in o && o.recovered === true,
    );
    const skipped = [o1, o2].filter(
      (o) => 'recovered' in o && o.recovered === false,
    );

    expect(recovered.length).toBe(1);
    expect(skipped.length).toBe(1);
    // The skip MUST be either lock_lost (lost the EXEC race) or
    // not_active (the other watchdog already flipped it to PENDING
    // before we got past the status check). Anything else is a bug.
    const skipReason = (skipped[0] as { reason: string }).reason;
    expect(['lock_lost', 'not_active']).toContain(skipReason);

    // And critically: stats counter must equal exactly 1, not 2.
    const enq = await scope.redis.hget(
      redisKeys.queueStats(scope.queueName),
      'enqueued',
    );
    expect(Number(enq)).toBe(1);

    // And the job is in pending exactly once.
    const pendingCount = await scope.redis.zcard(
      redisKeys.queuePending(scope.queueName),
    );
    expect(pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------
describe('LeaderElector (real redis)', () => {
  // Use a per-test override of the leader key so parallel test runs / leftover
  // state from a real worker can't interfere. We do this by deleting the key
  // in beforeEach (one process, one key — simplest).
  let r1: Redis;
  let r2: Redis;
  beforeEach(async () => {
    if (SKIP || !redisReachable) return;
    r1 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    r2 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    await r1.del(redisKeys.watchdogLeader());
  });
  afterEach(async () => {
    if (SKIP || !redisReachable) return;
    try {
      await r1.del(redisKeys.watchdogLeader());
    } catch { /* ignore */ }
    r1.disconnect();
    r2.disconnect();
  });

  itLive('only one of two concurrent electors wins the lease', async () => {
    const idA = `leader-${Date.now()}-a`;
    const idB = `leader-${Date.now()}-b`;
    let acquiredA = false;
    let acquiredB = false;
    const a = new LeaderElector(r1, idA, { onAcquired: () => { acquiredA = true; } });
    const b = new LeaderElector(r2, idB, { onAcquired: () => { acquiredB = true; } });

    await Promise.all([a.start(), b.start()]);

    // Exactly one should have won.
    const wins = [acquiredA, acquiredB].filter(Boolean).length;
    expect(wins).toBe(1);
    expect(a.isLeader() !== b.isLeader()).toBe(true);

    // The leader-key value must equal the winner's id.
    const holder = await r1.get(redisKeys.watchdogLeader());
    if (a.isLeader()) expect(holder).toBe(idA);
    else expect(holder).toBe(idB);

    await Promise.all([a.stop(), b.stop()]);
    // After stop the key should be released by the winner.
    const after = await r1.get(redisKeys.watchdogLeader());
    expect(after).toBeNull();
  });

  itLive('release is compare-and-DEL: a follower stop() does not clobber the leader key', async () => {
    const winnerId = `leader-${Date.now()}-w`;
    const loserId = `leader-${Date.now()}-l`;
    const winner = new LeaderElector(r1, winnerId);
    const loser = new LeaderElector(r2, loserId);

    await winner.start();
    expect(winner.isLeader()).toBe(true);
    await loser.start();
    expect(loser.isLeader()).toBe(false);

    // Stop the loser FIRST. The leader key must still belong to winner.
    await loser.stop();
    const stillHeld = await r1.get(redisKeys.watchdogLeader());
    expect(stillHeld).toBe(winnerId);

    await winner.stop();
    const after = await r1.get(redisKeys.watchdogLeader());
    expect(after).toBeNull();
  });
});
