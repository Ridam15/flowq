/**
 * Input validation for the enqueue path.
 *
 * Validation lives in its own module (not inline in the route handler) for
 * three reasons:
 *   1. It is exhaustively unit-testable without a Redis or Postgres.
 *   2. It can be reused by future producer paths (CLI, scheduled enqueue,
 *      bulk import) without dragging Express in.
 *   3. Keeping a single, named ValidationError class lets every caller
 *      branch on `err instanceof ValidationError` and produce a 400 with
 *      a precise field name.
 *
 * Philosophy: validate STRUCTURE here, validate BUSINESS RULES at the
 * point where the rule is enforced. e.g. "queue is paused" is not
 * checked here — that lives in enqueue itself.
 */

const QUEUE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const QUEUE_NAME_MAX = 255;
const IDEMPOTENCY_KEY_MAX = 512;

export class ValidationError extends Error {
  public readonly field: string | undefined;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Returns true for `{}`, `{a:1}`, `Object.create(null)`. Returns false
 * for arrays, class instances, dates, null, primitives. We treat
 * payloads strictly as JSON-shaped data — if a producer is sending us
 * a `Date` or a class instance, that is a bug on their side that should
 * be loud, not silently coerced.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/**
 * Throws ValidationError on the FIRST violation. We intentionally do
 * not collect all errors and return them in a list — fail-fast keeps
 * the API surface and the producer's mental model simple. If you want
 * a "tell me everything wrong" linter, build it on top, not here.
 */
export function validateEnqueueInput(input: unknown): void {
  if (!isPlainObject(input)) {
    throw new ValidationError('input must be a plain object');
  }
  const i = input;

  // ---- queueName -----------------------------------------------------------
  if (typeof i.queueName !== 'string' || i.queueName.length === 0) {
    throw new ValidationError(
      'queueName is required and must be a non-empty string',
      'queueName',
    );
  }
  if (i.queueName.length > QUEUE_NAME_MAX) {
    throw new ValidationError(
      `queueName must be at most ${QUEUE_NAME_MAX} characters`,
      'queueName',
    );
  }
  if (!QUEUE_NAME_RE.test(i.queueName)) {
    throw new ValidationError(
      'queueName must contain only letters, digits, dash (-), or underscore (_)',
      'queueName',
    );
  }

  // ---- payload -------------------------------------------------------------
  if (!isPlainObject(i.payload)) {
    throw new ValidationError('payload must be a plain object', 'payload');
  }

  // ---- priority (optional) -------------------------------------------------
  if (i.priority !== undefined) {
    if (
      typeof i.priority !== 'number' ||
      !Number.isInteger(i.priority) ||
      i.priority < 1 ||
      i.priority > 10
    ) {
      throw new ValidationError(
        'priority must be an integer between 1 and 10',
        'priority',
      );
    }
  }

  // ---- delay (optional) ----------------------------------------------------
  if (i.delay !== undefined) {
    if (
      typeof i.delay !== 'number' ||
      !Number.isFinite(i.delay) ||
      i.delay < 0
    ) {
      throw new ValidationError(
        'delay must be a non-negative finite number (seconds)',
        'delay',
      );
    }
  }

  // ---- maxAttempts (optional) ---------------------------------------------
  if (i.maxAttempts !== undefined) {
    if (
      typeof i.maxAttempts !== 'number' ||
      !Number.isInteger(i.maxAttempts) ||
      i.maxAttempts < 1 ||
      i.maxAttempts > 10
    ) {
      throw new ValidationError(
        'maxAttempts must be an integer between 1 and 10',
        'maxAttempts',
      );
    }
  }

  // ---- idempotencyKey (optional, nullable) ---------------------------------
  if (i.idempotencyKey !== undefined && i.idempotencyKey !== null) {
    if (typeof i.idempotencyKey !== 'string' || i.idempotencyKey.length === 0) {
      throw new ValidationError(
        'idempotencyKey, if provided, must be a non-empty string',
        'idempotencyKey',
      );
    }
    if (i.idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
      throw new ValidationError(
        `idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX} characters`,
        'idempotencyKey',
      );
    }
  }

  // ---- timeout (optional) --------------------------------------------------
  if (i.timeout !== undefined) {
    if (
      typeof i.timeout !== 'number' ||
      !Number.isInteger(i.timeout) ||
      i.timeout < 1
    ) {
      throw new ValidationError(
        'timeout must be a positive integer (seconds)',
        'timeout',
      );
    }
  }
}
