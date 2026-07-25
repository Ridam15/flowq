/**
 * complete.ts unit tests.
 *
 * Three layers:
 *   1. computeBackoffMs — pure math, easy.
 *   2. completeJob      — verify the Redis MULTI calls, mock pool.query.
 *   3. failJob          — both branches: retry and DLQ.
 *
 * As with the api enqueue tests, dependencies are injected through the
 * function signature; we never reach for vi.mock('ioredis') because
 * that fights the module loader and obscures intent.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import {
  computeBackoffMs,
  completeJob,
  failJob,
  BACKOFF_CAP_MS,
} from './complete';
import {
  Job,
  JobStatus,
  redisKeys,
  QUEUE_STATS_FIELDS,
  JOB_HASH_FIELDS,
  computeScore,
} from '@flowq/sdk';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
interface MockMulti {
  zrem: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  hincrby: ReturnType<typeof vi.fn>;
  /** XADD is the per-job duration sample for the metrics histogram. */
  xadd: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makeMulti(): MockMulti {
  const m: MockMulti = {
    zrem: vi.fn(),
    zadd: vi.fn(),
    hset: vi.fn(),
    hdel: vi.fn(),
    hincrby: vi.fn(),
    xadd: vi.fn(),
    exec: vi.fn(async () => [
      [null, 1],
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 1],
      [null, '0-1'],
    ]),
  };
  m.zrem.mockReturnValue(m);
  m.zadd.mockReturnValue(m);
  m.hset.mockReturnValue(m);
  m.hdel.mockReturnValue(m);
  m.hincrby.mockReturnValue(m);
  m.xadd.mockReturnValue(m);
  return m;
}

function makeRedis(): { multi: ReturnType<typeof vi.fn>; _multi: MockMulti } {
  const m = makeMulti();
  return { multi: vi.fn(() => m), _multi: m };
}

function makePool(): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
}

const asRedis = (r: { multi: ReturnType<typeof vi.fn> }) => r as unknown as Redis;
const asPool = (p: { query: ReturnType<typeof vi.fn> }) => p as unknown as Pool;

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    queueName: 'q',
    payload: { x: 1 },
    priority: 5,
    status: JobStatus.ACTIVE,
    attempts: 0,
    maxAttempts: 3,
    delay: 0,
    idempotencyKey: null,
    createdAt: 1_700_000_000_000,
    scheduledAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_500,
    completedAt: null,
    failedAt: null,
    lastError: null,
    workerId: 'worker-test',
    timeout: 30,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------
describe('computeBackoffMs', () => {
  it('grows exponentially with attempts', () => {
    const noJitter = (): number => 0;
    expect(computeBackoffMs(1, noJitter)).toBe(2_000);   // 2^1 * 1000
    expect(computeBackoffMs(2, noJitter)).toBe(4_000);
    expect(computeBackoffMs(3, noJitter)).toBe(8_000);
    expect(computeBackoffMs(4, noJitter)).toBe(16_000);
  });

  it('caps at BACKOFF_CAP_MS', () => {
    expect(computeBackoffMs(20, () => 0)).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(100, () => 0.999)).toBe(BACKOFF_CAP_MS);
  });

  it('adds jitter in the [0, 1000) range', () => {
    const a = computeBackoffMs(1, () => 0);
    const b = computeBackoffMs(1, () => 0.999);
    expect(b - a).toBeGreaterThanOrEqual(0);
    expect(b - a).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// completeJob
// ---------------------------------------------------------------------------
describe('completeJob', () => {
  it('runs ZREM active + HSET status/completedAt + HDEL workerId + HINCRBY in one MULTI', async () => {
    const redis = makeRedis();
    const pool = makePool();
    const job = jobOf();

    await completeJob(job, asRedis(redis), asPool(pool));

    expect(redis.multi).toHaveBeenCalledOnce();
    expect(redis._multi.zrem).toHaveBeenCalledWith(redisKeys.queueActive('q'), job.id);

    const [hsetKey, hsetFields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetKey).toBe(redisKeys.job(job.id));
    expect(hsetFields[JOB_HASH_FIELDS.status]).toBe(JobStatus.COMPLETED);
    expect(hsetFields[JOB_HASH_FIELDS.completedAt]).toMatch(/^\d+$/);

    expect(redis._multi.hdel).toHaveBeenCalledWith(
      redisKeys.job(job.id),
      JOB_HASH_FIELDS.workerId,
    );
    expect(redis._multi.hincrby).toHaveBeenCalledWith(
      redisKeys.queueStats('q'),
      QUEUE_STATS_FIELDS.completed,
      1,
    );
    expect(redis._multi.exec).toHaveBeenCalledOnce();
  });

  it('issues an UPDATE jobs and INSERT job_events (best-effort, but called)', async () => {
    const redis = makeRedis();
    const pool = makePool();
    await completeJob(jobOf(), asRedis(redis), asPool(pool));

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toContain('UPDATE jobs');
    expect(pool.query.mock.calls[1][0]).toContain('INSERT INTO job_events');
  });

  it('does NOT throw when Postgres update fails', async () => {
    const redis = makeRedis();
    const pool = makePool();
    pool.query.mockRejectedValueOnce(new Error('pg down'));
    await expect(completeJob(jobOf(), asRedis(redis), asPool(pool))).resolves.toBeUndefined();
  });

  it('emits a duration sample (XADD on the metrics stream) when startedAt is known', async () => {
    const redis = makeRedis();
    const pool = makePool();
    // startedAt 500ms before now (completion time). We don't assert exact
    // duration — that's an integration concern — only that XADD ran with
    // the right key, capped MAXLEN, and a queueName label.
    await completeJob(jobOf(), asRedis(redis), asPool(pool));

    expect(redis._multi.xadd).toHaveBeenCalledOnce();
    const call = redis._multi.xadd.mock.calls[0] as string[];
    expect(call[0]).toBe('flowq:metrics:durations');
    expect(call[1]).toBe('MAXLEN');
    expect(call[2]).toBe('~');
    // The remaining call args carry the field/value pairs for the entry.
    expect(call).toContain('queueName');
    expect(call).toContain('q');
    expect(call).toContain('seconds');
  });

  it('skips the duration XADD when startedAt is null (avoid skewing the histogram)', async () => {
    const redis = makeRedis();
    const pool = makePool();
    await completeJob(jobOf({ startedAt: null }), asRedis(redis), asPool(pool));
    expect(redis._multi.xadd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// failJob — retry path
// ---------------------------------------------------------------------------
describe('failJob (retry path)', () => {
  it('re-enqueues with PENDING status, incremented attempts, and a future scheduledAt', async () => {
    const redis = makeRedis();
    const pool = makePool();
    const job = jobOf({ attempts: 0, maxAttempts: 3, priority: 5 });

    const before = Date.now();
    await failJob(job, new Error('transient'), asRedis(redis), asPool(pool));

    expect(redis.multi).toHaveBeenCalledOnce();
    expect(redis._multi.zrem).toHaveBeenCalledWith(redisKeys.queueActive('q'), job.id);

    const [hsetKey, hsetFields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetKey).toBe(redisKeys.job(job.id));
    expect(hsetFields[JOB_HASH_FIELDS.status]).toBe(JobStatus.PENDING);
    expect(hsetFields[JOB_HASH_FIELDS.attempts]).toBe('1');
    expect(hsetFields[JOB_HASH_FIELDS.lastError]).toBe('transient');
    const scheduledAt = Number(hsetFields[JOB_HASH_FIELDS.scheduledAt]);
    expect(scheduledAt).toBeGreaterThanOrEqual(before + 2_000);

    expect(redis._multi.hdel).toHaveBeenCalledWith(
      redisKeys.job(job.id),
      JOB_HASH_FIELDS.workerId,
      JOB_HASH_FIELDS.startedAt,
    );

    const [zaddKey, zaddScore, zaddMember] = redis._multi.zadd.mock.calls[0] as [string, number, string];
    expect(zaddKey).toBe(redisKeys.queuePending('q'));
    expect(zaddScore).toBe(computeScore(scheduledAt, 5));
    expect(zaddMember).toBe(job.id);

    expect(redis._multi.hincrby).toHaveBeenCalledWith(
      redisKeys.queueStats('q'),
      QUEUE_STATS_FIELDS.failed,
      1,
    );
  });

  it('does not insert into dead_letter_queue on the retry path', async () => {
    const redis = makeRedis();
    const pool = makePool();
    await failJob(jobOf({ attempts: 0, maxAttempts: 3 }), new Error('x'), asRedis(redis), asPool(pool));
    const dlqInsert = pool.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO dead_letter_queue'),
    );
    expect(dlqInsert).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// failJob — DLQ path
// ---------------------------------------------------------------------------
describe('failJob (DLQ path)', () => {
  it('marks the job DEAD, bumps stats.dead, and inserts into DLQ', async () => {
    const redis = makeRedis();
    const pool = makePool();
    // attempts=2, maxAttempts=3 → newAttempts=3 → 3 >= 3 → DLQ
    const job = jobOf({ attempts: 2, maxAttempts: 3 });

    await failJob(job, new Error('permanent'), asRedis(redis), asPool(pool));

    const [, hsetFields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetFields[JOB_HASH_FIELDS.status]).toBe(JobStatus.DEAD);
    expect(hsetFields[JOB_HASH_FIELDS.attempts]).toBe('3');

    expect(redis._multi.hincrby).toHaveBeenCalledWith(
      redisKeys.queueStats('q'),
      QUEUE_STATS_FIELDS.dead,
      1,
    );
    // No re-enqueue.
    expect(redis._multi.zadd).not.toHaveBeenCalled();

    const dlqInsert = pool.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO dead_letter_queue'),
    );
    expect(dlqInsert).toBeDefined();
  });

  it('truncates very long error messages so the audit log stays sane', async () => {
    const redis = makeRedis();
    const pool = makePool();
    const huge = 'x'.repeat(10_000);
    await failJob(
      jobOf({ attempts: 2, maxAttempts: 3 }),
      new Error(huge),
      asRedis(redis),
      asPool(pool),
    );
    const [, hsetFields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetFields[JOB_HASH_FIELDS.lastError].length).toBeLessThan(huge.length);
    expect(hsetFields[JOB_HASH_FIELDS.lastError]).toMatch(/truncated/);
  });
});
