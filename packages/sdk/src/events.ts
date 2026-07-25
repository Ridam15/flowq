import type { Job } from './types';

/**
 * The fixed set of lifecycle transitions the dashboard cares about.
 *
 * We deliberately enumerate these as string literals rather than reusing
 * `JobStatus`:
 *   • Status is a *state* (where the job is now). Event type is a
 *     *transition* (what just happened). Two distinct concepts.
 *   • Some events (`job:recovered`, `job:dead`) don't map 1:1 to a
 *     status — `recovered` is a re-PENDING after watchdog rescue;
 *     `dead` is the precise moment we move to DLQ.
 *   • Stable, hand-curated string ids are easier to filter on the
 *     dashboard side than computed enum values.
 */
export type JobEventType =
  | 'job:enqueued'
  | 'job:started'
  | 'job:completed'
  | 'job:failed'
  | 'job:dead'
  | 'job:recovered'
  | 'job:cancelled';

/**
 * Domain payload broadcast to dashboard clients (WebSocket + SSE).
 * Carries the full Job snapshot at the moment of the transition so
 * clients don't need to re-fetch.
 */
export interface JobEvent {
  type: JobEventType;
  job: Job;
  /** Wall-clock ms when the producing process emitted the event. */
  timestamp: number;
}

/**
 * The wire envelope used on the Redis pub/sub channel. Adds a
 * `sourceId` so subscribing API replicas can distinguish events they
 * themselves published (already broadcast locally) from events
 * produced elsewhere (need to be broadcast). Without this dedup, a
 * single API replica would emit each enqueue twice — once via the
 * local EventEmitter and once via the round-trip through Redis.
 */
export interface JobEventEnvelope {
  event: JobEvent;
  /** Unique id of the process that produced this event. */
  sourceId: string;
}

/** Stable JSON serialisation. Centralised so producer/consumer can't drift. */
export function encodeEnvelope(envelope: JobEventEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(payload: string): JobEventEnvelope | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'event' in parsed &&
      'sourceId' in parsed
    ) {
      return parsed as JobEventEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}
