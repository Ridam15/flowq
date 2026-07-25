import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError, httpErrors } from '../http/errors';

/**
 * Terminal 404 handler — mounted AFTER all routes. If we got here,
 * no route matched. This avoids Express's default HTML "Cannot GET"
 * page leaking through, and ensures even 404s carry our error
 * envelope so the SDK doesn't need a special case.
 */
export function notFoundHandler(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(httpErrors.notFound('route'));
  };
}

/**
 * Global error handler — mounted LAST. Express identifies error
 * middleware by arity (4 args), do not shorten the signature.
 *
 * Three classes of errors, in priority order:
 *   1. HttpError      → already structured, render as-is
 *   2. ZodError       → 400 validation_error with the issue list
 *   3. anything else  → unknown / unintended; 500 with no internals
 *      leaked to the client. The full error is logged server-side.
 *
 * We deliberately do not echo `err.message` for case 3. A bug that
 * accidentally throws `new Error("DB password is foo")` should not
 * become an outbound JSON response. Hide it.
 */
export function errorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'validation_error',
        message: 'request body failed validation',
        issues: err.issues,
      });
      return;
    }

    // Unknown error: log everything, return generic 500.
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'unhandled_error',
        method: req.method,
        path: req.originalUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })}\n`,
    );
    res.status(500).json({ error: 'internal_error', message: 'internal server error' });
  };
}
