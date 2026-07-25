/**
 * Registry unit tests — verify both keys move atomically and the
 * status/currentJobId transitions write the right fields.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { registerWorker, deregisterWorker, markBusy, markIdle } from './registry';
import {
  redisKeys,
  WORKER_HASH_FIELDS,
  WORKER_STATUS,
} from '@flowq/sdk';

interface MockMulti {
  hset: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makeMulti(): MockMulti {
  const m: MockMulti = {
    hset: vi.fn(),
    sadd: vi.fn(),
    del: vi.fn(),
    srem: vi.fn(),
    hdel: vi.fn(),
    exec: vi.fn(async () => [
      [null, 'OK'],
      [null, 1],
    ]),
  };
  m.hset.mockReturnValue(m);
  m.sadd.mockReturnValue(m);
  m.del.mockReturnValue(m);
  m.srem.mockReturnValue(m);
  m.hdel.mockReturnValue(m);
  return m;
}

function makeRedis() {
  const m = makeMulti();
  return {
    multi: vi.fn(() => m),
    hset: vi.fn(async () => 'OK'),
    _multi: m,
  };
}

const asRedis = (r: ReturnType<typeof makeRedis>) => r as unknown as Redis;

describe('registerWorker', () => {
  it('writes the worker HASH and adds to the registry SET in one MULTI', async () => {
    const redis = makeRedis();
    await registerWorker('worker-test', 'emails', asRedis(redis));

    expect(redis.multi).toHaveBeenCalledOnce();

    const [hsetKey, fields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetKey).toBe(redisKeys.worker('worker-test'));
    expect(fields[WORKER_HASH_FIELDS.id]).toBe('worker-test');
    expect(fields[WORKER_HASH_FIELDS.queue]).toBe('emails');
    expect(fields[WORKER_HASH_FIELDS.status]).toBe(WORKER_STATUS.idle);
    expect(fields[WORKER_HASH_FIELDS.startedAt]).toMatch(/^\d+$/);
    expect(fields[WORKER_HASH_FIELDS.lastHeartbeat]).toMatch(/^\d+$/);

    expect(redis._multi.sadd).toHaveBeenCalledWith(
      redisKeys.workersRegistry(),
      'worker-test',
    );
    expect(redis._multi.exec).toHaveBeenCalledOnce();
  });
});

describe('deregisterWorker', () => {
  it('DELs the HASH and SREMs from registry in one MULTI', async () => {
    const redis = makeRedis();
    await deregisterWorker('worker-test', asRedis(redis));

    expect(redis._multi.del).toHaveBeenCalledWith(redisKeys.worker('worker-test'));
    expect(redis._multi.srem).toHaveBeenCalledWith(
      redisKeys.workersRegistry(),
      'worker-test',
    );
    expect(redis._multi.exec).toHaveBeenCalledOnce();
  });
});

describe('markBusy / markIdle', () => {
  it('markBusy sets status=busy and currentJobId in a single HSET', async () => {
    const redis = makeRedis();
    await markBusy('worker-test', 'job-123', asRedis(redis));
    expect(redis.hset).toHaveBeenCalledOnce();
    const [key, fields] = redis.hset.mock.calls[0] as [string, Record<string, string>];
    expect(key).toBe(redisKeys.worker('worker-test'));
    expect(fields[WORKER_HASH_FIELDS.status]).toBe(WORKER_STATUS.busy);
    expect(fields[WORKER_HASH_FIELDS.currentJobId]).toBe('job-123');
  });

  it('markIdle flips status back and HDELs currentJobId', async () => {
    const redis = makeRedis();
    await markIdle('worker-test', asRedis(redis));

    const [hsetKey, fields] = redis._multi.hset.mock.calls[0] as [string, Record<string, string>];
    expect(hsetKey).toBe(redisKeys.worker('worker-test'));
    expect(fields[WORKER_HASH_FIELDS.status]).toBe(WORKER_STATUS.idle);

    expect(redis._multi.hdel).toHaveBeenCalledWith(
      redisKeys.worker('worker-test'),
      WORKER_HASH_FIELDS.currentJobId,
    );
  });
});
