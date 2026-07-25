import { Router, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';

import { redisKeys, WORKER_HASH_FIELDS, WORKER_STATUS } from '@flowq/sdk';

import { asyncHandler } from '../http/asyncHandler';

/**
 * Shape returned by GET /workers. Public contract — the dashboard
 * code reads these field names directly. Adding a field is safe;
 * removing or renaming one is a breaking change.
 */
export interface WorkerInfo {
  id: string;
  queue: string | null;
  status: 'idle' | 'busy' | 'unknown';
  startedAt: number | null;
  lastHeartbeat: number | null;
  currentJobId: string | null;
  /**
   * Seconds since lastHeartbeat. Helpful for the dashboard "is this
   * worker stalled?" indicator without making the client compute it.
   * `null` if the worker has never heartbeat (just registered).
   */
  staleSeconds: number | null;
}

export function createWorkersRouter(redis: Redis): Router {
  const router = Router();

  // ---------------------------------------------------------------------
  // GET /workers
  //
  // Two-phase: SMEMBERS the registry, then HGETALL each worker hash in
  // a single pipeline. We do NOT MGET because each worker's data lives
  // in a separate hash key.
  //
  // Tolerate registry/hash drift: a worker id can be in the SET but
  // the HASH already DEL'd (race during deregistration), or vice versa.
  // We surface those as `status: 'unknown'` rather than 500 — the
  // operator wants to see ghosts, not have the endpoint crash.
  // ---------------------------------------------------------------------
  router.get(
    '/workers',
    asyncHandler(async (_req: Request, res: Response) => {
      const ids = await redis.smembers(redisKeys.workersRegistry());

      if (ids.length === 0) {
        res.status(200).json({ workers: [] });
        return;
      }

      const pipe = redis.pipeline();
      for (const id of ids) {
        pipe.hgetall(redisKeys.worker(id));
      }
      const results = await pipe.exec();
      const now = Date.now();

      const workers: WorkerInfo[] = ids.map((id, idx) => {
        const hash = (results?.[idx]?.[1] ?? {}) as Record<string, string>;
        const isEmpty = !hash || Object.keys(hash).length === 0;
        const lastHeartbeatRaw = hash[WORKER_HASH_FIELDS.lastHeartbeat];
        const lastHeartbeat = lastHeartbeatRaw ? Number(lastHeartbeatRaw) : null;

        const statusRaw = hash[WORKER_HASH_FIELDS.status];
        const status: WorkerInfo['status'] =
          statusRaw === WORKER_STATUS.idle || statusRaw === WORKER_STATUS.busy
            ? statusRaw
            : 'unknown';

        return {
          id,
          queue: hash[WORKER_HASH_FIELDS.queue] ?? null,
          status: isEmpty ? 'unknown' : status,
          startedAt: hash[WORKER_HASH_FIELDS.startedAt]
            ? Number(hash[WORKER_HASH_FIELDS.startedAt])
            : null,
          lastHeartbeat,
          currentJobId: hash[WORKER_HASH_FIELDS.currentJobId] ?? null,
          staleSeconds:
            lastHeartbeat !== null
              ? Math.max(0, Math.round((now - lastHeartbeat) / 1000))
              : null,
        };
      });

      res.status(200).json({ workers });
    }),
  );

  return router;
}
