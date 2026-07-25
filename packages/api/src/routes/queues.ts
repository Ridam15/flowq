import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import {
  redisKeys,
  REDIS_SENTINELS,
  QUEUE_STATS_FIELDS,
} from '@flowq/sdk';

import { enqueueJob } from '../queue/enqueue';
import { httpErrors } from '../http/errors';
import { asyncHandler } from '../http/asyncHandler';
import {
  QueueNameParams,
  DlqRetryParams,
  DlqListQuery,
} from '../http/schemas';
import { announceJobEvent } from '../events/redisBridge';

export function createQueuesRouter(redis: Redis, pool: Pool): Router {
  const router = Router();

  // ---------------------------------------------------------------------
  // GET /queues/:name/stats
  //
  // Returns the durable counters (HGETALL) plus live depths (ZCARD).
  // The two are sampled independently — stats are atomic per-event
  // counts; depths are point-in-time. We do them in one pipeline so
  // the snapshot is "as close to the same instant as Redis can give us".
  // ---------------------------------------------------------------------
  router.get(
    '/queues/:name/stats',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = QueueNameParams.parse(req.params);

      const pipe = redis.pipeline();
      pipe.hgetall(redisKeys.queueStats(name));
      pipe.zcard(redisKeys.queuePending(name));
      pipe.zcard(redisKeys.queueActive(name));
      pipe.exists(redisKeys.queuePaused(name));
      const result = await pipe.exec();
      if (!result) throw httpErrors.internal('redis pipeline returned null');

      const stats = (result[0]?.[1] ?? {}) as Record<string, string>;
      const currentPending = (result[1]?.[1] as number | undefined) ?? 0;
      const currentActive = (result[2]?.[1] as number | undefined) ?? 0;
      const paused = ((result[3]?.[1] as number | undefined) ?? 0) === 1;

      res.status(200).json({
        queueName: name,
        enqueued: toNum(stats[QUEUE_STATS_FIELDS.enqueued]),
        completed: toNum(stats[QUEUE_STATS_FIELDS.completed]),
        failed: toNum(stats[QUEUE_STATS_FIELDS.failed]),
        dead: toNum(stats[QUEUE_STATS_FIELDS.dead]),
        currentPending,
        currentActive,
        paused,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // POST /queues/:name/pause
  //
  // Idempotent: SETting an already-set key is a no-op. Workers check
  // EXISTS on the paused key inside their poll loop — they finish the
  // current job in flight (we don't kill mid-execution) and then idle
  // until resume. Pausing is a control-plane action; it does not
  // reject incoming enqueues. That's a deliberate split: queues can
  // accept work while the workers are temporarily down for maintenance.
  // ---------------------------------------------------------------------
  router.post(
    '/queues/:name/pause',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = QueueNameParams.parse(req.params);
      await redis.set(redisKeys.queuePaused(name), REDIS_SENTINELS.pausedFlag);
      res.status(200).json({ message: 'Queue paused', queueName: name });
    }),
  );

  router.post(
    '/queues/:name/resume',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = QueueNameParams.parse(req.params);
      await redis.del(redisKeys.queuePaused(name));
      res.status(200).json({ message: 'Queue resumed', queueName: name });
    }),
  );

  // ---------------------------------------------------------------------
  // GET /queues/:name/dlq?page=1&limit=20
  //
  // DLQ lives in Postgres only — Redis no longer has these jobs. We
  // return a stable, paginated list ordered by died_at DESC (newest
  // failures first; that's what an on-call human looking at "what's
  // broken right now?" wants to see).
  //
  // Two queries in one round-trip via a single SELECT with COUNT() OVER()
  // — gives us total + page rows without a second statement.
  // ---------------------------------------------------------------------
  router.get(
    '/queues/:name/dlq',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = QueueNameParams.parse(req.params);
      const { page, limit } = DlqListQuery.parse(req.query);
      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT
           id,
           job_id          AS "jobId",
           queue_name      AS "queueName",
           payload,
           last_error      AS "lastError",
           attempts,
           manually_retried AS "manuallyRetried",
           (EXTRACT(EPOCH FROM died_at) * 1000)::bigint AS "diedAt",
           (EXTRACT(EPOCH FROM retried_at) * 1000)::bigint AS "retriedAt",
           COUNT(*) OVER() AS "fullCount"
         FROM dead_letter_queue
         WHERE queue_name = $1
         ORDER BY died_at DESC
         LIMIT $2 OFFSET $3`,
        [name, limit, offset],
      );

      const rows = result.rows as Array<Record<string, unknown> & { fullCount: string | number }>;
      const total = rows.length > 0 ? Number(rows[0].fullCount) : 0;

      // Strip the window-function column from the public response.
      const jobs = rows.map(({ fullCount: _ignored, ...rest }) => ({
        ...rest,
        diedAt: rest.diedAt !== null ? Number(rest.diedAt) : null,
        retriedAt: rest.retriedAt !== null ? Number(rest.retriedAt) : null,
      }));

      res.status(200).json({ jobs, total, page, limit });
    }),
  );

  // ---------------------------------------------------------------------
  // POST /queues/:name/dlq/:jobId/retry
  //
  // Requeue a dead job. Critical design decision: the new job gets a
  // FRESH UUID. We never resurrect the dead job's id, because:
  //   - the dead job is already in the audit log forever — re-using its
  //     id would conflate two distinct execution lifetimes.
  //   - any external system that observed the original failure
  //     (notifications, traces, support tickets) would see the id "come
  //     back to life" and start succeeding, which is confusing.
  //
  // The link between the two is preserved in the new job's payload
  // metadata (`__retried_from`) and in the DLQ row's `manually_retried`
  // / `retried_at` columns.
  // ---------------------------------------------------------------------
  router.post(
    '/queues/:name/dlq/:jobId/retry',
    asyncHandler(async (req: Request, res: Response) => {
      const { name, jobId } = DlqRetryParams.parse(req.params);

      // Pull the row + lock it FOR UPDATE so two concurrent retries of
      // the same dead job can't both create new copies. The second
      // request will see manually_retried=true and 409.
      const dead = await pool.query<{
        payload: Record<string, unknown>;
        manually_retried: boolean;
        queue_name: string;
      }>(
        `SELECT payload, manually_retried, queue_name
         FROM dead_letter_queue
         WHERE job_id = $1 AND queue_name = $2
         LIMIT 1
         FOR UPDATE`,
        [jobId, name],
      );

      if (dead.rowCount === 0) {
        throw httpErrors.notFound('dlq entry', jobId);
      }
      const row = dead.rows[0];
      if (row.manually_retried) {
        throw httpErrors.conflict(
          'dlq_already_retried',
          'this DLQ entry was already manually retried',
        );
      }

      // Re-enqueue with a completely fresh job. The original id is
      // recorded in the new job's payload for traceability.
      const newJob = await enqueueJob(
        {
          queueName: row.queue_name,
          payload: { ...row.payload, __retried_from: jobId },
          // Defaults handle priority, attempts (always 0), etc.
        },
        redis,
        pool,
      );

      await pool.query(
        `UPDATE dead_letter_queue
         SET manually_retried = TRUE, retried_at = NOW()
         WHERE job_id = $1`,
        [jobId],
      );

      // Announce the freshly-enqueued retry job. This is intentionally
      // a `job:enqueued` event (not a separate "job:retried") because
      // the new job's lifecycle is genuinely independent — it has a
      // fresh UUID, fresh attempts counter, and the dashboard should
      // treat it as a normal enqueue. The DLQ→new-job link lives in
      // payload.__retried_from for anyone who cares to inspect it.
      await announceJobEvent(redis, {
        type: 'job:enqueued',
        job: newJob,
        timestamp: Date.now(),
      });

      res.status(200).json({
        message: 'Job requeued',
        newJobId: newJob.id,
        originalJobId: jobId,
      });
    }),
  );

  return router;
}

function toNum(s: string | undefined): number {
  if (s === undefined || s === null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
