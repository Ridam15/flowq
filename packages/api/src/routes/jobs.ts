import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import {
  JobStatus,
  redisKeys,
  redisHashToJob,
  JOB_HASH_FIELDS,
  type Job,
} from '@flowq/sdk';

import { enqueueJob } from '../queue/enqueue';
import { httpErrors } from '../http/errors';
import { asyncHandler } from '../http/asyncHandler';
import { EnqueueJobBody, JobIdParams } from '../http/schemas';
import { announceJobEvent } from '../events/redisBridge';

/**
 * /jobs router. Mounted behind the bearer-auth middleware.
 *
 * Why a factory: tests construct it with mock Redis/Pool. See the
 * Module 3 router doc for the full reasoning — we keep that pattern.
 */
export function createJobsRouter(redis: Redis, pool: Pool): Router {
  const router = Router();

  // ---------------------------------------------------------------------
  // POST /jobs — enqueue a new job
  // ---------------------------------------------------------------------
  router.post(
    '/jobs',
    asyncHandler(async (req: Request, res: Response) => {
      // zod validates body shape + basic constraints. Throws ZodError
      // on failure → caught by the global error handler → 400 JSON.
      const body = EnqueueJobBody.parse(req.body);

      const job = await enqueueJob(body, redis, pool);
      // Fan out to dashboard clients (local + cross-replica). Best
      // effort — we don't await beyond the publish round-trip and we
      // never let an event-system failure break the producer response.
      await announceJobEvent(redis, {
        type: 'job:enqueued',
        job,
        timestamp: Date.now(),
      });
      res.status(201).json(job);
    }),
  );

  // ---------------------------------------------------------------------
  // GET /jobs/:id — read a job by id
  //
  // Lookup order: Redis first (hot path, microseconds), Postgres fallback
  // (cold path, jobs aged out of Redis or post-cleanup audit access).
  // ---------------------------------------------------------------------
  router.get(
    '/jobs/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = JobIdParams.parse(req.params);

      // ---- Redis hot path ------------------------------------------------
      const hash = await redis.hgetall(redisKeys.job(id));
      if (hash && hash.id) {
        res.status(200).json(redisHashToJob(hash));
        return;
      }

      // ---- Postgres cold path -------------------------------------------
      // Postgres uses snake_case columns and TIMESTAMPTZ; the SELECT
      // converts to the wire shape (camelCase, epoch ms) so the response
      // is identical regardless of which path served it. The dashboard
      // and SDK don't need to know which store answered.
      const result = await pool.query(
        `SELECT
           id,
           queue_name              AS "queueName",
           payload,
           priority,
           status,
           attempts,
           max_attempts            AS "maxAttempts",
           idempotency_key         AS "idempotencyKey",
           timeout_seconds         AS "timeout",
           worker_id               AS "workerId",
           last_error              AS "lastError",
           (EXTRACT(EPOCH FROM created_at)   * 1000)::bigint AS "createdAt",
           (EXTRACT(EPOCH FROM scheduled_at) * 1000)::bigint AS "scheduledAt",
           (EXTRACT(EPOCH FROM started_at)   * 1000)::bigint AS "startedAt",
           (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint AS "completedAt",
           (EXTRACT(EPOCH FROM failed_at)    * 1000)::bigint AS "failedAt"
         FROM jobs
         WHERE id = $1
         LIMIT 1`,
        [id],
      );

      if (result.rowCount === 0) {
        throw httpErrors.notFound('job', id);
      }

      const row = result.rows[0] as Record<string, unknown>;
      // Postgres returns numeric BIGINT as a JS number once cast; we don't
      // store >2^53 timestamps so this is safe. We also can't store `delay`
      // independently in PG — reconstruct from createdAt/scheduledAt.
      const createdAt = Number(row.createdAt);
      const scheduledAt = Number(row.scheduledAt);
      const job: Job = {
        id: String(row.id),
        queueName: String(row.queueName),
        payload: (row.payload as Record<string, unknown>) ?? {},
        priority: Number(row.priority),
        status: String(row.status) as JobStatus,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.maxAttempts),
        delay: Math.max(0, Math.round((scheduledAt - createdAt) / 1000)),
        idempotencyKey: row.idempotencyKey ? String(row.idempotencyKey) : null,
        createdAt,
        scheduledAt,
        startedAt: row.startedAt !== null ? Number(row.startedAt) : null,
        completedAt: row.completedAt !== null ? Number(row.completedAt) : null,
        failedAt: row.failedAt !== null ? Number(row.failedAt) : null,
        lastError: row.lastError ? String(row.lastError) : null,
        workerId: row.workerId ? String(row.workerId) : null,
        timeout: Number(row.timeout),
      };
      res.status(200).json(job);
    }),
  );

  // ---------------------------------------------------------------------
  // DELETE /jobs/:id — cancel a PENDING job
  //
  // Cancellation is only safe in PENDING. Once a worker has claimed the
  // job (status=ACTIVE) we can't undo it — the worker holds the lease
  // and is executing user code. Trying to "cancel" mid-execution leads
  // to half-applied side effects (the half-sent emails problem). The
  // honest answer is "you can't, file a bug-shaped issue against the
  // worker handler that takes too long".
  //
  // The race we're guarding against:
  //   T1 (HTTP)   : reads status = PENDING
  //   T2 (worker) : Lua claim flips status = ACTIVE, ZREM pending
  //   T1 (HTTP)   : ZREM pending (no-op), HSET status = CANCELLED
  //   → job is now in active zset with status CANCELLED. Disaster.
  //
  // Solution: WATCH the job hash. If anything writes to it between our
  // read and our EXEC, EXEC returns null and we report 409.
  // ---------------------------------------------------------------------
  router.delete(
    '/jobs/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = JobIdParams.parse(req.params);
      const jobKey = redisKeys.job(id);

      await redis.watch(jobKey);
      const [statusField, queueNameField] = await redis.hmget(
        jobKey,
        JOB_HASH_FIELDS.status,
        JOB_HASH_FIELDS.queueName,
      );

      if (statusField === null) {
        await redis.unwatch();
        throw httpErrors.notFound('job', id);
      }
      if (statusField !== JobStatus.PENDING) {
        await redis.unwatch();
        throw httpErrors.conflict(
          'job_not_cancellable',
          `job is in state ${statusField}; only PENDING jobs can be cancelled`,
        );
      }
      if (!queueNameField) {
        // Defensive — a job hash without queueName is corrupt; refuse
        // to act on it rather than guess.
        await redis.unwatch();
        throw httpErrors.internal('job hash is missing queueName');
      }

      const tx = redis.multi();
      tx.zrem(redisKeys.queuePending(queueNameField), id);
      tx.hset(jobKey, JOB_HASH_FIELDS.status, 'CANCELLED');
      const exec = await tx.exec();

      if (exec === null) {
        // Another writer touched the job between WATCH and EXEC.
        // Most likely a worker just claimed it. Honest 409 — the
        // caller can refetch and decide.
        throw httpErrors.conflict(
          'job_state_changed',
          'job changed state during cancellation; refetch and retry if still desired',
        );
      }
      for (const [err] of exec) {
        if (err) throw err;
      }

      // Best-effort Postgres audit. Same philosophy as enqueueJob:
      // Redis is the source of truth, Postgres is the durable log.
      try {
        await pool.query(
          `UPDATE jobs SET status = $1 WHERE id = $2`,
          ['CANCELLED', id],
        );
        await pool.query(
          `INSERT INTO job_events (job_id, from_status, to_status, metadata)
           VALUES ($1, $2, $3, $4)`,
          [id, JobStatus.PENDING, 'CANCELLED', { source: 'http_cancel' }],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'pg_audit_failed',
            op: 'cancel',
            jobId: id,
            error: msg,
          })}\n`,
        );
      }

      // Build the event payload AFTER the cancel has committed. We
      // re-read the hash so the published Job has status=CANCELLED and
      // any other concurrent updates that landed are reflected.
      try {
        const cancelledHash = await redis.hgetall(jobKey);
        if (cancelledHash && cancelledHash.id) {
          await announceJobEvent(redis, {
            type: 'job:cancelled',
            job: redisHashToJob(cancelledHash),
            timestamp: Date.now(),
          });
        }
      } catch {
        // event publish failure must NOT poison the user-visible
        // success response — the cancel itself succeeded.
      }

      res.status(200).json({ message: 'Job cancelled', jobId: id });
    }),
  );

  return router;
}
