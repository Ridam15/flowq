import { z } from 'zod';

/**
 * Zod schemas for every HTTP boundary.
 *
 * Why a single file:
 *   - the same schemas are reused by routes, by openapi.ts (for spec
 *     generation), and by tests. One source of truth = one place to
 *     change validation rules.
 *
 * Naming convention:
 *   - `<Verb><Resource>Body`  for request body schemas
 *   - `<Resource>Params`      for path-param schemas
 *   - `<Resource>Query`       for query-string schemas
 *
 * Why we re-validate things that the queue layer also validates
 * (queueName charset, priority range, etc.): defense in depth. A
 * direct call to `enqueueJob` from a future internal caller (cron,
 * SDK, retry-from-DLQ) MUST NOT trust upstream validation. The HTTP
 * layer enforces "don't waste CPU on garbage", the queue layer
 * enforces "the system invariants must hold".
 */

// -----------------------------------------------------------------------
// Reusable atoms
// -----------------------------------------------------------------------

/**
 * Queue/key name charset. Matches what the underlying validator allows
 * (alphanumeric, dash, underscore). We constrain length to keep Redis
 * keys bounded — Redis itself accepts up to 512MB keys but anything
 * over a few hundred bytes is a smell.
 */
const queueName = z
  .string()
  .min(1, 'queueName must be non-empty')
  .max(128, 'queueName must be at most 128 chars')
  .regex(/^[A-Za-z0-9_-]+$/, 'queueName must match /^[A-Za-z0-9_-]+$/');

/**
 * Job/DLQ ID is a UUID v4 produced by the API. We validate strictly so
 * a malformed `:id` returns 400 rather than wandering into Redis with
 * a key like `flowq:job:undefined`.
 */
const uuid = z.string().uuid('id must be a valid UUID');

// -----------------------------------------------------------------------
// POST /jobs
// -----------------------------------------------------------------------

export const EnqueueJobBody = z.object({
  queueName,
  // payload is opaque to the queue. We only enforce "is an object" —
  // not an array, not null, not a primitive. Producers serialize
  // their own domain types inside.
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(1).max(10).optional(),
  delay: z.number().int().min(0).max(60 * 60 * 24 * 30).optional(), // cap at 30 days
  maxAttempts: z.number().int().min(1).max(10).optional(),
  idempotencyKey: z.string().min(1).max(512).nullable().optional(),
  timeout: z.number().int().min(1).max(3600).optional(),
});
export type EnqueueJobBody = z.infer<typeof EnqueueJobBody>;

// -----------------------------------------------------------------------
// /jobs/:id
// -----------------------------------------------------------------------

export const JobIdParams = z.object({
  id: uuid,
});

// -----------------------------------------------------------------------
// /queues/:name/...
// -----------------------------------------------------------------------

export const QueueNameParams = z.object({
  name: queueName,
});

export const DlqRetryParams = z.object({
  name: queueName,
  jobId: uuid,
});

/**
 * GET /queues/:name/dlq pagination.
 *
 * - `page` is 1-indexed (humans). Internally we'll convert to OFFSET.
 * - `limit` capped at 100 to prevent a single request from sweeping
 *   the entire DLQ table — that's what /dlq/export would be for.
 */
export const DlqListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type DlqListQuery = z.infer<typeof DlqListQuery>;
