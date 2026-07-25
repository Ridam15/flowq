import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Structured one-line-per-request logger.
 *
 * Output is JSON so it can be parsed by Loki / CloudWatch / Datadog
 * without any additional shipping config. Every line carries:
 *   - method, path, statusCode, durationMs  (operational signal)
 *   - requestId                              (correlation)
 *   - userAgent, ip                          (security/abuse)
 *
 * Why we log on `res.on('finish')` rather than wrapping `res.send`:
 *   - finish fires AFTER the response is fully written, so durationMs
 *     reflects real latency including header flush.
 *   - it also fires on connection-close / abort, which lets us see
 *     truncated responses (statusCode reflects what we sent).
 *
 * We deliberately do NOT log request bodies. Bodies can contain
 * idempotency keys, payload secrets, customer PII. If you need body
 * logging for debugging, do it behind a per-request-id gated debug
 * mode — never on by default.
 */
export function requestLog(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    const requestId = req.header('x-request-id') ?? randomRequestId();
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const line = {
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        msg: 'http_request',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs,
        requestId,
        ip: req.ip,
        userAgent: req.header('user-agent') ?? '',
      };
      // One line, one JSON object. Stable key order isn't guaranteed
      // by JSON.stringify but parsers don't care.
      process.stdout.write(`${JSON.stringify(line)}\n`);
    });

    next();
  };
}

function randomRequestId(): string {
  // Cheap correlation ID — not crypto-grade. We only need uniqueness
  // within the lifetime of a few seconds across this process.
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
