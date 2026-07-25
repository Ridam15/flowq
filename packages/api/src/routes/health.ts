import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import { asyncHandler } from '../http/asyncHandler';

/**
 * /health — Kubernetes-friendly liveness/readiness probe.
 *
 * Why no auth: liveness probes have no Bearer token and shouldn't.
 * Why a hard timeout on each check: a hung Redis socket must NOT
 * block the probe — that would make a degraded dependency look like
 * "API is dead" to the orchestrator, triggering a kill loop. We
 * race each check against a 1.5s deadline.
 *
 * Why we return 503 (not 500) on any dependency failure: 503 means
 * "the service exists but cannot serve right now" — kubelet handles
 * that by removing the pod from the load-balancer endpoints (readiness)
 * without restarting the pod (liveness). 500 would imply a logic bug.
 *
 * Status semantics:
 *   "ok"      = both Redis and Postgres responded healthy → 200
 *   anything else                                         → 503
 */
const PROBE_TIMEOUT_MS = 1500;

type CheckStatus = 'ok' | 'error' | 'timeout';

export function createHealthRouter(redis: Redis, pool: Pool, bootedAt: number): Router {
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req: Request, res: Response) => {
      const [redisStatus, postgresStatus] = await Promise.all([
        timed(probeRedis(redis), PROBE_TIMEOUT_MS),
        timed(probePostgres(pool), PROBE_TIMEOUT_MS),
      ]);

      const ok = redisStatus === 'ok' && postgresStatus === 'ok';
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        redis: redisStatus,
        postgres: postgresStatus,
        uptime: Math.round((Date.now() - bootedAt) / 1000),
        timestamp: new Date().toISOString(),
      });
    }),
  );

  return router;
}

async function probeRedis(redis: Redis): Promise<CheckStatus> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

async function probePostgres(pool: Pool): Promise<CheckStatus> {
  try {
    const r = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    return r.rowCount === 1 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * Race a probe against a hard timeout. We never want a probe to take
 * longer than the orchestrator's own probe timeout (kubelet defaults
 * to 1s). Returning 'timeout' explicitly distinguishes "down" from
 * "slow" in the response body — useful when triaging at 3am.
 */
function timed(p: Promise<CheckStatus>, ms: number): Promise<CheckStatus> {
  return new Promise<CheckStatus>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve('error');
      },
    );
  });
}
