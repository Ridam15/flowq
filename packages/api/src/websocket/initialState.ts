import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import {
  JobStatus,
  redisKeys,
  redisHashToJob,
  type Job,
} from '@flowq/sdk';

/* ============================================================================
 * Initial-state snapshot for newly-connected dashboard clients.
 * ============================================================================
 *
 * On WS connect we must give the client *enough context to render
 * something meaningful in the first tick* without forcing it to issue a
 * dozen REST round-trips. The shape is fixed:
 *
 *   • EVERY currently-active job (so the "jobs in flight right now"
 *     panel is accurate the moment the WS opens), discovered via the
 *     queue registry → ZRANGE active → HGETALL job.
 *   • The 50 MOST RECENT terminal-state jobs (COMPLETED / FAILED / DEAD)
 *     pulled from Postgres so the dashboard's history list isn't blank.
 *
 * We dedupe by id so a job that just went from active → completed
 * between Step 1 and Step 4 doesn't show up twice.
 *
 * Why N=50? It's the sweet spot between "useful at-a-glance history"
 * and "oversized init payload". A 50-job snapshot is ~50KB on the wire
 * which is cheap; 500 starts to be felt on slow networks.
 *
 * This function is best-effort. If Redis or Postgres is partially down,
 * we return what we have rather than failing the WS handshake — the
 * dashboard would much rather show "active panel populated, history
 * empty" than refuse to connect.
 */
export async function fetchInitialJobs(redis: Redis, pool: Pool): Promise<Job[]> {
  const out: Job[] = [];
  const seen = new Set<string>();

  // ---- 1. live active jobs across every known queue ----------------------
  try {
    const queues = await redis.smembers(redisKeys.queuesRegistry());
    if (queues.length > 0) {
      const idsPipeline = redis.pipeline();
      for (const q of queues) {
        idsPipeline.zrange(redisKeys.queueActive(q), 0, -1);
      }
      const idsRes = (await idsPipeline.exec()) ?? [];
      const activeIds: string[] = [];
      for (const [err, ids] of idsRes) {
        if (err || !Array.isArray(ids)) continue;
        for (const id of ids as string[]) activeIds.push(id);
      }

      if (activeIds.length > 0) {
        // HGETALL each active job in a single pipeline.
        const hashPipeline = redis.pipeline();
        for (const id of activeIds) hashPipeline.hgetall(redisKeys.job(id));
        const hashRes = (await hashPipeline.exec()) ?? [];
        for (const [err, hash] of hashRes) {
          if (err || !hash) continue;
          const h = hash as Record<string, string>;
          if (!h.id) continue;
          try {
            const job = redisHashToJob(h);
            if (!seen.has(job.id)) {
              seen.add(job.id);
              out.push(job);
            }
          } catch {
            // corrupted hash — skip rather than poison the snapshot
          }
        }
      }
    }
  } catch {
    // Redis path failed — continue to Postgres; we still want history.
  }

  // ---- 2. last 50 terminal jobs from Postgres ----------------------------
  try {
    const result = await pool.query<{
      id: string;
      queueName: string;
      payload: Record<string, unknown> | null;
      priority: number;
      status: string;
      attempts: number;
      maxAttempts: number;
      idempotencyKey: string | null;
      timeout: number;
      workerId: string | null;
      lastError: string | null;
      createdAt: string | number;
      scheduledAt: string | number;
      startedAt: string | number | null;
      completedAt: string | number | null;
      failedAt: string | number | null;
    }>(
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
       WHERE status IN ('COMPLETED', 'FAILED', 'DEAD')
       ORDER BY COALESCE(completed_at, failed_at, scheduled_at) DESC NULLS LAST
       LIMIT 50`,
    );

    for (const row of result.rows) {
      if (seen.has(row.id)) continue;
      const createdAt = Number(row.createdAt);
      const scheduledAt = Number(row.scheduledAt);
      const job: Job = {
        id: row.id,
        queueName: row.queueName,
        payload: row.payload ?? {},
        priority: Number(row.priority),
        status: row.status as JobStatus,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.maxAttempts),
        delay: Math.max(0, Math.round((scheduledAt - createdAt) / 1000)),
        idempotencyKey: row.idempotencyKey,
        createdAt,
        scheduledAt,
        startedAt: row.startedAt !== null ? Number(row.startedAt) : null,
        completedAt: row.completedAt !== null ? Number(row.completedAt) : null,
        failedAt: row.failedAt !== null ? Number(row.failedAt) : null,
        lastError: row.lastError,
        workerId: row.workerId,
        timeout: Number(row.timeout),
      };
      seen.add(job.id);
      out.push(job);
    }
  } catch {
    // Postgres path failed — return whatever active jobs we managed.
  }

  return out;
}
