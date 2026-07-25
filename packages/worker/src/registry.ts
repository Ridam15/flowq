import type { Redis } from 'ioredis';
import { redisKeys, WORKER_HASH_FIELDS, WORKER_STATUS } from '@flowq/sdk';

/**
 * Worker registry: who is alive right now, and what are they doing.
 *
 * Two keys are involved per worker:
 *   • flowq:worker:{id}     — HASH with id, queue, startedAt,
 *                             lastHeartbeat, status, [currentJobId]
 *   • flowq:workers:registry — SET<workerId> for cheap "list all workers"
 *
 * Why both? The HASH is detail per worker; the SET is a directory.
 * SCANning `flowq:worker:*` would also find them but that is O(N) over
 * the whole keyspace. The SET is O(1) lookup + O(M) iteration over
 * exactly the worker IDs.
 *
 * Atomicity: both register and deregister use MULTI so the dashboard
 * can never see a worker in the registry but missing its detail HASH
 * (or vice versa).
 */
export async function registerWorker(
  workerId: string,
  queueName: string,
  redis: Redis,
): Promise<void> {
  const now = Date.now();
  const tx = redis.multi();
  tx.hset(redisKeys.worker(workerId), {
    [WORKER_HASH_FIELDS.id]: workerId,
    [WORKER_HASH_FIELDS.queue]: queueName,
    [WORKER_HASH_FIELDS.startedAt]: String(now),
    [WORKER_HASH_FIELDS.lastHeartbeat]: String(now),
    [WORKER_HASH_FIELDS.status]: WORKER_STATUS.idle,
  });
  tx.sadd(redisKeys.workersRegistry(), workerId);
  const res = await tx.exec();
  if (res === null) throw new Error('registerWorker: MULTI/EXEC returned null');
  for (const [err] of res) if (err) throw err;
}

/**
 * Deregister on graceful shutdown. We DO NOT clear the worker HASH on
 * SIGKILL / process death — that's intentional. A stalled worker should
 * leave its HASH behind so the watchdog (future module) can find it via
 * `flowq:workers:registry` and reclaim any held jobs based on the
 * `lastHeartbeat` timestamp.
 *
 * Safe to call multiple times (DEL/SREM are idempotent).
 */
export async function deregisterWorker(workerId: string, redis: Redis): Promise<void> {
  const tx = redis.multi();
  tx.del(redisKeys.worker(workerId));
  tx.srem(redisKeys.workersRegistry(), workerId);
  const res = await tx.exec();
  if (res === null) throw new Error('deregisterWorker: MULTI/EXEC returned null');
  for (const [err] of res) if (err) throw err;
}

/**
 * Mark the worker as currently processing a job. Called immediately
 * after a successful claim. Single HSET so the watchdog can rely on
 * the {status, currentJobId} pair flipping atomically.
 */
export async function markBusy(
  workerId: string,
  jobId: string,
  redis: Redis,
): Promise<void> {
  await redis.hset(redisKeys.worker(workerId), {
    [WORKER_HASH_FIELDS.status]: WORKER_STATUS.busy,
    [WORKER_HASH_FIELDS.currentJobId]: jobId,
    [WORKER_HASH_FIELDS.lastHeartbeat]: String(Date.now()),
  });
}

/**
 * Mark the worker idle again after the job is settled (completed/failed
 * either way — both terminate the busy span). HDEL the currentJobId
 * field so a subsequent HGETALL doesn't return a stale jobId.
 */
export async function markIdle(workerId: string, redis: Redis): Promise<void> {
  const tx = redis.multi();
  tx.hset(redisKeys.worker(workerId), {
    [WORKER_HASH_FIELDS.status]: WORKER_STATUS.idle,
    [WORKER_HASH_FIELDS.lastHeartbeat]: String(Date.now()),
  });
  tx.hdel(redisKeys.worker(workerId), WORKER_HASH_FIELDS.currentJobId);
  const res = await tx.exec();
  if (res === null) throw new Error('markIdle: MULTI/EXEC returned null');
  for (const [err] of res) if (err) throw err;
}
