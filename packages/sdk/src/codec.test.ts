/**
 * Codec round-trip tests.
 *
 * The cardinal sin of `jobToRedisHash` ↔ `redisHashToJob` is silent
 * data loss on a round-trip — the api writes one shape, the worker
 * reads a different shape, jobs end up with NaN priority or null
 * payloads. These tests are the safety net.
 */
import { describe, it, expect } from 'vitest';
import { jobToRedisHash, redisHashToJob, computeScore, PRIORITY_SCORE_BOOST_MS } from './codec';
import { Job, JobStatus } from './types';

function fullJob(over: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    queueName: 'emails',
    payload: { to: 'a@b.c', body: { nested: [1, 2, 3] } },
    priority: 7,
    status: JobStatus.PENDING,
    attempts: 0,
    maxAttempts: 5,
    delay: 0,
    idempotencyKey: 'order-42',
    createdAt: 1_700_000_000_000,
    scheduledAt: 1_700_000_000_000,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
    workerId: null,
    timeout: 30,
    ...over,
  };
}

describe('codec', () => {
  it('round-trips a minimal job (all nullables null)', () => {
    const j = fullJob();
    const back = redisHashToJob(jobToRedisHash(j));
    expect(back).toEqual(j);
  });

  it('round-trips a fully-populated job (all nullables set)', () => {
    const j = fullJob({
      status: JobStatus.COMPLETED,
      attempts: 2,
      startedAt: 1_700_000_000_500,
      completedAt: 1_700_000_001_000,
      failedAt: 1_700_000_000_700,
      lastError: 'something broke',
      workerId: 'worker-host-1234-1700000000',
    });
    const back = redisHashToJob(jobToRedisHash(j));
    expect(back).toEqual(j);
  });

  it('omits null fields in the encoded hash (instead of storing "")', () => {
    const enc = jobToRedisHash(fullJob());
    expect(enc.startedAt).toBeUndefined();
    expect(enc.completedAt).toBeUndefined();
    expect(enc.failedAt).toBeUndefined();
    expect(enc.lastError).toBeUndefined();
    expect(enc.workerId).toBeUndefined();
  });

  it('encodes payload as JSON string', () => {
    const enc = jobToRedisHash(fullJob());
    expect(enc.payload).toBe(JSON.stringify({ to: 'a@b.c', body: { nested: [1, 2, 3] } }));
  });

  it('throws on an empty hash (caller forgot to check job-key existence)', () => {
    expect(() => redisHashToJob({})).toThrow();
  });
});

describe('computeScore', () => {
  it('lowers score by exactly priority * PRIORITY_SCORE_BOOST_MS', () => {
    expect(computeScore(1_000_000, 5)).toBe(1_000_000 - 5 * PRIORITY_SCORE_BOOST_MS);
    expect(computeScore(1_000_000, 1)).toBe(1_000_000 - 1 * PRIORITY_SCORE_BOOST_MS);
    expect(computeScore(1_000_000, 10)).toBe(1_000_000 - 10 * PRIORITY_SCORE_BOOST_MS);
  });

  it('higher priority always yields lower score (so ZRANGEBYSCORE picks it first)', () => {
    expect(computeScore(0, 10)).toBeLessThan(computeScore(0, 1));
  });
});
