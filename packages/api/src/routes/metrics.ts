import { Router, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';

import { asyncHandler } from '../http/asyncHandler';
import { metricsContentType, renderMetrics } from '../metrics/registry';

/**
 * /metrics — Prometheus exposition endpoint.
 *
 * No auth: scrapers don't carry Bearer tokens. If you need to lock
 * /metrics down, do it at the network layer (NetworkPolicy / VPC
 * security group / nginx allowlist). Auth-on-/metrics is one of the
 * top operational footguns in Kubernetes deployments.
 *
 * Content-Type comes from prom-client's registry — currently
 * `text/plain; version=0.0.4; charset=utf-8`. Don't override it; the
 * Prometheus parser reads the version negotiation from this header.
 */
export function createMetricsRouter(redis: Redis): Router {
  const router = Router();

  router.get(
    '/metrics',
    asyncHandler(async (_req: Request, res: Response) => {
      const body = await renderMetrics(redis);
      res.setHeader('Content-Type', metricsContentType);
      res.status(200).send(body);
    }),
  );

  return router;
}
