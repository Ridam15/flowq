import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { httpErrors } from '../http/errors';

/**
 * Bearer-token middleware.
 *
 * Why a factory:
 *   - the API key is captured at startup; we don't want each request
 *     re-reading `process.env.API_KEY` (rotation requires a restart,
 *     which is exactly what we want — opaque atomicity).
 *   - tests can inject a known key without touching env.
 *
 * Why one shared 401 with no detail (instead of "missing header" vs
 * "wrong key"): we don't want to give a probe enough information to
 * distinguish "no auth scheme installed" from "wrong key". Both look
 * identical from the outside.
 *
 * IMPORTANT: this middleware MUST NOT be mounted on /health, /metrics
 * or /docs. Prometheus scrapers and Kubernetes probes don't carry the
 * Bearer token. Mounting auth on those endpoints is a great way to
 * cause an outage with a single config change.
 */
export function bearerAuth(apiKey: string): RequestHandler {
  if (!apiKey || apiKey.length === 0) {
    throw new Error('bearerAuth: apiKey must be a non-empty string');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      return next(httpErrors.unauthorized());
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0 || token !== apiKey) {
      return next(httpErrors.unauthorized());
    }
    next();
  };
}
