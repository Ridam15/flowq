/**
 * Executor unit tests.
 *
 * No Redis, no Postgres — these only exercise the timeout wrapper and
 * the placeholder handler. The real value here is locking down the
 * timeout semantics: that path is dead-easy to break by accident and
 * the consequence is workers wedging on hung jobs.
 */
import { describe, it, expect } from 'vitest';
import { executeJob, JobTimeoutError } from './executor';
import { Job, JobStatus } from '@flowq/sdk';

function jobOf(payload: Record<string, unknown>, timeoutSeconds = 30): Job {
  return {
    id: 'test-id',
    queueName: 'test',
    payload,
    priority: 5,
    status: JobStatus.ACTIVE,
    attempts: 0,
    maxAttempts: 3,
    delay: 0,
    idempotencyKey: null,
    createdAt: Date.now(),
    scheduledAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    failedAt: null,
    lastError: null,
    workerId: 'worker-x',
    timeout: timeoutSeconds,
  };
}

describe('executeJob', () => {
  it('resolves on a successful no-op job within the timeout', async () => {
    await expect(executeJob(jobOf({ duration: 10 }))).resolves.toBeUndefined();
  });

  it('throws the handler error when payload.fail is true', async () => {
    await expect(
      executeJob(jobOf({ duration: 10, fail: true, error: 'boom' })),
    ).rejects.toThrow('boom');
  });

  it('throws JobTimeoutError when handler exceeds timeout', async () => {
    // duration 200ms, timeout 0 (rounded up to 0s = 0ms — ensures timeout
    // fires immediately on the next tick before the handler resolves).
    // We use a small but non-zero timeout to keep the test deterministic.
    const job = jobOf({ duration: 500 }, 1); // 1s timeout, 500ms handler — should pass
    await expect(executeJob(job)).resolves.toBeUndefined();

    const slow = jobOf({ duration: 2_000 }, 1); // 1s timeout, 2s handler
    await expect(executeJob(slow)).rejects.toBeInstanceOf(JobTimeoutError);
  }, 5_000);

  it('JobTimeoutError carries the jobId and timeoutSeconds', async () => {
    const slow = jobOf({ duration: 1_000 }, 1);
    try {
      await executeJob(slow);
      expect.fail('expected timeout');
    } catch (err) {
      expect(err).toBeInstanceOf(JobTimeoutError);
      expect((err as JobTimeoutError).jobId).toBe('test-id');
      expect((err as JobTimeoutError).timeoutSeconds).toBe(1);
    }
  }, 5_000);
});
