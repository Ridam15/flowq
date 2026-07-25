import type { NextFunction, Request, Response, RequestHandler } from 'express';

/**
 * Express 4 does not catch promise rejections from async handlers.
 * Without this wrapper, an unawaited rejection inside a handler
 * crashes the process via `unhandledRejection`. Wrap every async
 * handler so rejections flow into the error middleware chain instead.
 *
 * Express 5 makes this unnecessary — when we move, this entire helper
 * gets deleted in one PR.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
