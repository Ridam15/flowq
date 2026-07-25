import type { Redis } from 'ioredis';
import {
  redisKeys,
  encodeEnvelope,
  type Job,
  type JobEvent,
  type JobEventType,
} from '@flowq/sdk';

import { logger } from './logger';

/* ============================================================================
 * Worker-side event publisher
 * ============================================================================
 *
 * The worker only ever PUBLISHES — it never subscribes. So we do not
 * need a dedicated subscribe-mode connection here; the existing main
 * Redis client is fine for `PUBLISH` (which is a normal command and
 * does not switch the connection into subscribe mode).
 *
 * Producer side of the cross-process bridge defined in
 * `@flowq/api/src/events/redisBridge.ts` — keep the wire format
 * (channel name + JSON envelope shape) in lockstep with the consumer.
 * Both ends consume the SDK's `encodeEnvelope` to make drift impossible.
 *
 * Failure handling: pub/sub is a best-effort dashboard concern. A failed
 * publish must NEVER bubble out of the queue mutation that produced
 * it — we'd rather lose a UI update than fail a job completion. So
 * `publishJobEvent` swallows errors and logs them. Callers don't need
 * a try/catch.
 */

let workerSourceId: string | null = null;

/** Call once per worker process, immediately after registration. */
export function initEventPublisher(workerId: string): void {
  workerSourceId = workerId;
}

export async function publishJobEvent(
  redis: Redis,
  type: JobEventType,
  job: Job,
): Promise<void> {
  if (workerSourceId === null) {
    // No initialised source id — almost certainly a test that didn't
    // call initEventPublisher. Skip rather than publishing with an
    // empty id (which would defeat the API-side dedup).
    return;
  }
  const event: JobEvent = { type, job, timestamp: Date.now() };
  const payload = encodeEnvelope({ event, sourceId: workerSourceId });
  try {
    await redis.publish(redisKeys.eventsChannel(), payload);
  } catch (err) {
    logger.warn('event_publish_failed', {
      type,
      jobId: job.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
