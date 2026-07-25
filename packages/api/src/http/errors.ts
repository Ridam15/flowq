/**
 * One error envelope for the entire HTTP surface.
 *
 *   {
 *     "error":   "<short_machine_code>",
 *     "message": "<human-readable detail>",      // optional
 *     "field":   "<offending field>",            // optional
 *     "issues":  [...zod issues]                 // optional
 *   }
 *
 * Why one shape: dashboards, on-call humans, and the SDK retry layer
 * all want a single contract for "is this an error?" and "what failed?"
 * Mixing `{error}` vs `{message}` vs `{detail}` across routes is the
 * #1 reason API consumers write defensive `body.error || body.message
 * || body.detail` chains. We pay the small cost of one envelope here
 * once so every consumer pays nothing.
 *
 * `error` is always a stable, snake_case string usable as a metric
 * label. It MUST NOT contain user data, IDs, or timestamps — those go
 * in `message`.
 */
export interface ApiErrorBody {
  error: string;
  message?: string;
  field?: string;
  issues?: unknown[];
}

/**
 * Throwable error that the global error handler converts into a JSON
 * response with the given status code. Use this in route handlers
 * instead of `res.status(...).json({error: ...})` so all error paths
 * funnel through one place that can also log + emit metrics.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly issues?: unknown[];

  constructor(
    status: number,
    code: string,
    message?: string,
    extra?: { field?: string; issues?: unknown[] },
  ) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.field = extra?.field;
    this.issues = extra?.issues;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { error: this.code };
    if (this.message && this.message !== this.code) body.message = this.message;
    if (this.field) body.field = this.field;
    if (this.issues) body.issues = this.issues;
    return body;
  }
}

// -----------------------------------------------------------------------
// Common factories — keeps route code intent-revealing.
// -----------------------------------------------------------------------
export const httpErrors = {
  unauthorized: (message?: string): HttpError =>
    new HttpError(401, 'unauthorized', message),
  notFound: (resource: string, id?: string): HttpError =>
    new HttpError(404, 'not_found', id ? `${resource} ${id} not found` : `${resource} not found`),
  conflict: (code: string, message?: string): HttpError =>
    new HttpError(409, code, message),
  badRequest: (code: string, message?: string, field?: string): HttpError =>
    new HttpError(400, code, message, { field }),
  validation: (issues: unknown[], message = 'request body failed validation'): HttpError =>
    new HttpError(400, 'validation_error', message, { issues }),
  internal: (message?: string): HttpError =>
    new HttpError(500, 'internal_error', message),
  serviceUnavailable: (code: string, message?: string): HttpError =>
    new HttpError(503, code, message),
};
