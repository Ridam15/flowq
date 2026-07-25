/**
 * enqueue + validate unit tests.
 *
 * We inject mocks via the function arguments rather than `vi.mock`-ing
 * `ioredis` and `pg`. That keeps the tests fast, makes failure modes
 * explicit (you see exactly which mock returned what), and avoids
 * fighting with the module loader.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import { enqueueJob, EnqueueInput } from './enqueue';
import { validateEnqueueInput, ValidationError } from './validate';
import {
  JobStatus,
  IDEMPOTENCY_TTL_SECONDS,
  computeScore,
  redisHashToJob,
  redisKeys,
  QUEUE_STATS_FIELDS,
} from '@flowq/sdk';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MockMulti {
  hset: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  hincrby: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makeMulti(): MockMulti {
  const m: MockMulti = {
    hset: vi.fn(),
    zadd: vi.fn(),
    hincrby: vi.fn(),
    sadd: vi.fn(),
    set: vi.fn(),
    // Default: 5 commands all succeed (idempotency SET is optional;
    // ioredis ignores extra slots).
    exec: vi.fn(async () => [
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 'OK'],
    ]),
  };
  m.hset.mockReturnValue(m);
  m.zadd.mockReturnValue(m);
  m.hincrby.mockReturnValue(m);
  m.sadd.mockReturnValue(m);
  m.set.mockReturnValue(m);
  return m;
}

interface MockRedis {
  get: ReturnType<typeof vi.fn>;
  hgetall: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
  _multi: MockMulti;
}

function makeRedis(opts: {
  existingIdempotency?: string | null;
  existingJob?: Record<string, string> | null;
} = {}): MockRedis {
  const m = makeMulti();
  return {
    get: vi.fn(async () => opts.existingIdempotency ?? null),
    hgetall: vi.fn(async () => opts.existingJob ?? {}),
    multi: vi.fn(() => m),
    _multi: m,
  };
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(): MockPool {
  return { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
}

// Cast helpers — the mocks satisfy the surface we use, not the full
// ioredis / pg types. `as unknown as` keeps the cast loud.
const asRedis = (m: MockRedis) => m as unknown as Redis;
const asPool = (m: MockPool) => m as unknown as Pool;

// ---------------------------------------------------------------------------
// computeScore — pure unit
// ---------------------------------------------------------------------------
describe('computeScore', () => {
  it('subtracts priority * 1000 from scheduledAt (lower-is-better)', () => {
    expect(computeScore(1_000_000, 5)).toBe(1_000_000 - 5_000);
    expect(computeScore(1_000_000, 1)).toBe(1_000_000 - 1_000);
    expect(computeScore(1_000_000, 10)).toBe(1_000_000 - 10_000);
  });

  it('higher priority => lower score (so ZPOPMIN picks it first)', () => {
    expect(computeScore(0, 10)).toBeLessThan(computeScore(0, 1));
  });
});

// ---------------------------------------------------------------------------
// enqueueJob — happy path
// ---------------------------------------------------------------------------
describe('enqueueJob — happy path', () => {
  it('returns a Job with the documented shape and defaults', async () => {
    const redis = makeRedis();
    const pool = makePool();
    const before = Date.now();

    const job = await enqueueJob(
      { queueName: 'emails', payload: { to: 'a@b.c' }, priority: 7 },
      asRedis(redis),
      asPool(pool),
    );

    expect(job.queueName).toBe('emails');
    expect(job.payload).toEqual({ to: 'a@b.c' });
    expect(job.status).toBe(JobStatus.PENDING);
    expect(job.priority).toBe(7);
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3); // SDK default
    expect(job.delay).toBe(0); // SDK default
    expect(job.timeout).toBe(30); // SDK default
    expect(job.idempotencyKey).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
    expect(job.workerId).toBeNull();
    expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(job.createdAt).toBeGreaterThanOrEqual(before);
    expect(job.scheduledAt).toBe(job.createdAt); // delay=0
  });

  it('writes job HASH, pending ZADD with score, and stats HINCRBY in a MULTI', async () => {
    const redis = makeRedis();
    const pool = makePool();

    const job = await enqueueJob(
      { queueName: 'emails', payload: { x: 1 }, priority: 5 },
      asRedis(redis),
      asPool(pool),
    );

    expect(redis.multi).toHaveBeenCalledOnce();
    expect(redis._multi.hset).toHaveBeenCalledOnce();
    expect(redis._multi.zadd).toHaveBeenCalledOnce();
    expect(redis._multi.hincrby).toHaveBeenCalledOnce();
    expect(redis._multi.sadd).toHaveBeenCalledWith(redisKeys.queuesRegistry(), 'emails');
    expect(redis._multi.exec).toHaveBeenCalledOnce();

    // HSET hits the right key with serialized payload + null fields omitted
    const [hsetKey, hsetFields] = redis._multi.hset.mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(hsetKey).toBe(redisKeys.job(job.id));
    expect(hsetFields.payload).toBe(JSON.stringify({ x: 1 }));
    expect(hsetFields.status).toBe('PENDING');
    expect(hsetFields.startedAt).toBeUndefined();
    expect(hsetFields.completedAt).toBeUndefined();
    expect(hsetFields.lastError).toBeUndefined();
    expect(hsetFields.workerId).toBeUndefined();

    // ZADD uses the priority-aware score
    const [zaddKey, zaddScore, zaddMember] = redis._multi.zadd.mock.calls[0] as [
      string,
      number,
      string,
    ];
    expect(zaddKey).toBe(redisKeys.queuePending('emails'));
    expect(zaddScore).toBe(computeScore(job.scheduledAt, 5));
    expect(zaddMember).toBe(job.id);

    // HINCRBY enqueued by 1
    expect(redis._multi.hincrby).toHaveBeenCalledWith(
      redisKeys.queueStats('emails'),
      QUEUE_STATS_FIELDS.enqueued,
      1,
    );

    // No idempotency SET in this case
    expect(redis._multi.set).not.toHaveBeenCalled();
  });

  it('sets idempotency pointer with 24h TTL when key is provided', async () => {
    const redis = makeRedis();
    const pool = makePool();

    const job = await enqueueJob(
      { queueName: 'emails', payload: {}, idempotencyKey: 'order-9' },
      asRedis(redis),
      asPool(pool),
    );

    expect(redis._multi.set).toHaveBeenCalledWith(
      redisKeys.idempotency('order-9'),
      job.id,
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
  });

  it('writes both jobs and job_events rows to Postgres', async () => {
    const redis = makeRedis();
    const pool = makePool();

    await enqueueJob(
      { queueName: 'emails', payload: {} },
      asRedis(redis),
      asPool(pool),
    );

    expect(pool.query).toHaveBeenCalledTimes(2);
    const sql1 = pool.query.mock.calls[0][0] as string;
    const sql2 = pool.query.mock.calls[1][0] as string;
    expect(sql1).toContain('INSERT INTO jobs');
    expect(sql2).toContain('INSERT INTO job_events');
  });

  it('honors delay: scheduledAt = createdAt + delay*1000', async () => {
    const redis = makeRedis();
    const pool = makePool();
    const job = await enqueueJob(
      { queueName: 'emails', payload: {}, delay: 30 },
      asRedis(redis),
      asPool(pool),
    );
    expect(job.scheduledAt - job.createdAt).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// enqueueJob — idempotency
// ---------------------------------------------------------------------------
describe('enqueueJob — idempotency', () => {
  it('returns existing job and skips MULTI + Postgres on hit', async () => {
    const existing = {
      id: '11111111-1111-1111-1111-111111111111',
      queueName: 'emails',
      payload: '{"to":"prior@example.com"}',
      priority: '5',
      status: 'PENDING',
      attempts: '0',
      maxAttempts: '3',
      delay: '0',
      createdAt: '1700000000000',
      scheduledAt: '1700000000000',
      timeout: '30',
      idempotencyKey: 'order-42',
    };
    const redis = makeRedis({
      existingIdempotency: existing.id,
      existingJob: existing,
    });
    const pool = makePool();

    const job = await enqueueJob(
      {
        queueName: 'emails',
        payload: { to: 'new@example.com' },
        idempotencyKey: 'order-42',
      },
      asRedis(redis),
      asPool(pool),
    );

    expect(job.id).toBe(existing.id);
    expect(job.payload).toEqual({ to: 'prior@example.com' });
    expect(redis.multi).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('falls through to fresh enqueue when pointer exists but job hash is gone', async () => {
    const redis = makeRedis({
      existingIdempotency: 'stale-id',
      existingJob: {}, // HGETALL on missing key returns {}
    });
    const pool = makePool();

    const job = await enqueueJob(
      {
        queueName: 'emails',
        payload: { fresh: true },
        idempotencyKey: 'order-42',
      },
      asRedis(redis),
      asPool(pool),
    );

    expect(job.id).not.toBe('stale-id');
    expect(redis.multi).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// enqueueJob — Postgres failure must NOT throw
// ---------------------------------------------------------------------------
describe('enqueueJob — Postgres resilience', () => {
  it('does not throw when Postgres write fails (Redis is source of truth)', async () => {
    const redis = makeRedis();
    const pool = makePool();
    pool.query.mockRejectedValueOnce(new Error('postgres down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const job = await enqueueJob(
      { queueName: 'emails', payload: {} },
      asRedis(redis),
      asPool(pool),
    );

    expect(job.status).toBe(JobStatus.PENDING);
    expect(redis._multi.exec).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// redisHashToJob — round-trip codec
// ---------------------------------------------------------------------------
describe('redisHashToJob', () => {
  it('decodes a stored hash back into the Job shape with nulls in place', () => {
    const job = redisHashToJob({
      id: 'a',
      queueName: 'q',
      payload: '{"k":1}',
      priority: '5',
      status: 'PENDING',
      attempts: '0',
      maxAttempts: '3',
      delay: '0',
      createdAt: '1700000000000',
      scheduledAt: '1700000000000',
      timeout: '30',
    });
    expect(job.payload).toEqual({ k: 1 });
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
    expect(job.workerId).toBeNull();
    expect(job.idempotencyKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateEnqueueInput
// ---------------------------------------------------------------------------
describe('validateEnqueueInput', () => {
  const valid = (): EnqueueInput => ({ queueName: 'emails', payload: {} });

  it('accepts a minimally valid input', () => {
    expect(() => validateEnqueueInput(valid())).not.toThrow();
  });

  it('accepts alphanumeric, dash, and underscore in queueName', () => {
    expect(() => validateEnqueueInput({ ...valid(), queueName: 'good_name-1' })).not.toThrow();
  });

  it('rejects empty queueName', () => {
    expect(() => validateEnqueueInput({ ...valid(), queueName: '' })).toThrow(ValidationError);
  });

  it('rejects queueName with spaces, slashes, or other special chars', () => {
    expect(() => validateEnqueueInput({ ...valid(), queueName: 'bad name' })).toThrow(/queueName/);
    expect(() => validateEnqueueInput({ ...valid(), queueName: 'bad/name' })).toThrow(/queueName/);
    expect(() => validateEnqueueInput({ ...valid(), queueName: 'bad!name' })).toThrow(/queueName/);
  });

  it('rejects priority below 1, above 10, or non-integer', () => {
    expect(() => validateEnqueueInput({ ...valid(), priority: 0 })).toThrow(/priority/);
    expect(() => validateEnqueueInput({ ...valid(), priority: 11 })).toThrow(/priority/);
    expect(() => validateEnqueueInput({ ...valid(), priority: 1.5 })).toThrow(/priority/);
  });

  it('rejects negative delay', () => {
    expect(() => validateEnqueueInput({ ...valid(), delay: -1 })).toThrow(/delay/);
  });

  it('rejects payload that is not a plain object', () => {
    expect(() =>
      validateEnqueueInput({ queueName: 'q', payload: null as unknown as Record<string, unknown> }),
    ).toThrow(/payload/);
    expect(() =>
      validateEnqueueInput({ queueName: 'q', payload: [] as unknown as Record<string, unknown> }),
    ).toThrow(/payload/);
    expect(() =>
      validateEnqueueInput({ queueName: 'q', payload: 'str' as unknown as Record<string, unknown> }),
    ).toThrow(/payload/);
  });

  it('rejects maxAttempts out of 1..10', () => {
    expect(() => validateEnqueueInput({ ...valid(), maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => validateEnqueueInput({ ...valid(), maxAttempts: 11 })).toThrow(/maxAttempts/);
  });

  it('rejects empty-string idempotencyKey but accepts null/undefined', () => {
    expect(() => validateEnqueueInput({ ...valid(), idempotencyKey: '' })).toThrow(/idempotencyKey/);
    expect(() => validateEnqueueInput({ ...valid(), idempotencyKey: null })).not.toThrow();
    expect(() => validateEnqueueInput({ ...valid(), idempotencyKey: 'x' })).not.toThrow();
  });

  it('rejects timeout below 1 or non-integer', () => {
    expect(() => validateEnqueueInput({ ...valid(), timeout: 0 })).toThrow(/timeout/);
    expect(() => validateEnqueueInput({ ...valid(), timeout: 1.5 })).toThrow(/timeout/);
  });
});
