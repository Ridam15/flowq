/**
 * SDK error hierarchy.
 *
 * Why a hierarchy and not a single FlowQError carrying a status code?
 *   • Producers want to write `if (err instanceof FlowQNotFoundError)`,
 *     not `if (err.status === 404)`. The first reads at intent level;
 *     the second couples consumers to wire-protocol numbers.
 *   • TypeScript narrows by class, so type-guarded branches give the
 *     caller back a strongly-typed `validationIssues` field on the
 *     validation error without `as` casts.
 *   • The retry layer asks "is this a network error?" / "is this a 5xx
 *     I should retry?" — the class itself answers that, no field
 *     inspection required.
 *
 * Every error keeps the original HTTP status (or null for transport
 * failures), the canonical machine code (`unauthorized`, `not_found`,
 * `validation_error`, …), and the original underlying cause when one
 * exists. Callers logging or alerting on FlowQError can rely on those
 * three properties always being present.
 */

/**
 * The single envelope shape the API uses for every error response.
 * Mirrored from the API package (we don't import from it to keep the
 * SDK free of a circular dependency on the server code).
 */
export interface FlowQErrorBody {
  error: string;
  message?: string;
  field?: string;
  issues?: unknown[];
}

/**
 * Base class for every error this SDK throws. Catch this if you want
 * the broadest "anything FlowQ-related went wrong" handler.
 */
export class FlowQError extends Error {
  /** Stable machine-readable code, e.g. "unauthorized", "validation_error". */
  readonly code: string;

  /** HTTP status code if this came from a server response, else null. */
  readonly status: number | null;

  /** Optional originating exception (network failure, parser error, etc). */
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'FlowQError';
    this.code = options.code ?? 'flowq_error';
    this.status = options.status ?? null;
    this.cause = options.cause;
    // Preserve the prototype chain when transpiled to ES5/CJS — without
    // this `instanceof` checks return false in older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 Unauthorized — bad or missing API key. */
export class FlowQAuthError extends FlowQError {
  constructor(message = 'unauthorized', body?: FlowQErrorBody) {
    super(message, { code: body?.error ?? 'unauthorized', status: 401 });
    this.name = 'FlowQAuthError';
    Object.setPrototypeOf(this, FlowQAuthError.prototype);
  }
}

/** 404 Not Found — job / queue / DLQ entry doesn't exist. */
export class FlowQNotFoundError extends FlowQError {
  constructor(message = 'not found', body?: FlowQErrorBody) {
    super(message, { code: body?.error ?? 'not_found', status: 404 });
    this.name = 'FlowQNotFoundError';
    Object.setPrototypeOf(this, FlowQNotFoundError.prototype);
  }
}

/**
 * 400 Bad Request — the API rejected our payload. `issues` contains
 * the zod issue array when the API surfaced a structured validation
 * failure; otherwise the array is empty.
 */
export class FlowQValidationError extends FlowQError {
  /** Zod-style issue list if the server returned one. Empty otherwise. */
  readonly issues: unknown[];

  /** The single offending field name, if the server identified one. */
  readonly field: string | null;

  constructor(message = 'validation error', body?: FlowQErrorBody) {
    super(message, { code: body?.error ?? 'validation_error', status: 400 });
    this.name = 'FlowQValidationError';
    this.issues = body?.issues ?? [];
    this.field = body?.field ?? null;
    Object.setPrototypeOf(this, FlowQValidationError.prototype);
  }
}

/**
 * Transport-layer failure: connection refused, DNS, abort/timeout, or
 * any non-HTTP fault that prevented us from getting a response. The
 * retry layer treats these as retryable.
 */
export class FlowQNetworkError extends FlowQError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: 'network_error', status: null, cause: options.cause });
    this.name = 'FlowQNetworkError';
    Object.setPrototypeOf(this, FlowQNetworkError.prototype);
  }
}

/**
 * 409 Conflict — the operation is illegal in the current resource
 * state (e.g. cancelling a job that's already ACTIVE, retrying a DLQ
 * entry that's already been retried).
 *
 * Not in the spec list but emitted by the API for these legitimate
 * cases — we surface it as its own class so callers don't have to
 * inspect FlowQError.code to distinguish it.
 */
export class FlowQConflictError extends FlowQError {
  constructor(message = 'conflict', body?: FlowQErrorBody) {
    super(message, { code: body?.error ?? 'conflict', status: 409 });
    this.name = 'FlowQConflictError';
    Object.setPrototypeOf(this, FlowQConflictError.prototype);
  }
}

/**
 * 5xx — server failed to process the request. Retryable; the retry
 * layer will attempt up to the configured number of times before
 * letting this propagate.
 */
export class FlowQServerError extends FlowQError {
  constructor(status: number, message = 'server error', body?: FlowQErrorBody) {
    super(message, { code: body?.error ?? 'server_error', status });
    this.name = 'FlowQServerError';
    Object.setPrototypeOf(this, FlowQServerError.prototype);
  }
}

/**
 * Map an HTTP status + body into the right error class.
 *
 * Centralised so every method in the client agrees on the mapping.
 * Unknown status codes default to a plain FlowQError with the status
 * preserved — better than silently swallowing them.
 */
export function errorFromResponse(
  status: number,
  body: FlowQErrorBody | null,
): FlowQError {
  const message = body?.message ?? body?.error ?? `HTTP ${status}`;
  switch (status) {
    case 400:
      return new FlowQValidationError(message, body ?? undefined);
    case 401:
      return new FlowQAuthError(message, body ?? undefined);
    case 404:
      return new FlowQNotFoundError(message, body ?? undefined);
    case 409:
      return new FlowQConflictError(message, body ?? undefined);
    default:
      if (status >= 500 && status <= 599) {
        return new FlowQServerError(status, message, body ?? undefined);
      }
      return new FlowQError(message, {
        code: body?.error ?? `http_${status}`,
        status,
      });
  }
}
