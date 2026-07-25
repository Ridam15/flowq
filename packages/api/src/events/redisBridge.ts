import IORedis, { type Redis } from 'ioredis';
import { redisKeys, encodeEnvelope, decodeEnvelope, type JobEvent } from '@flowq/sdk';

import { emitJobEvent } from './jobEvents';

/* ============================================================================
 * Cross-process event bridge over Redis pub/sub
 * ============================================================================
 *
 * Why a separate Redis connection for SUBSCRIBE?
 *
 *   In the Redis protocol, once a connection issues SUBSCRIBE / PSUBSCRIBE
 *   it enters "subscribe mode" and may only run a tiny allow-list of
 *   commands until it UNSUBSCRIBEs from everything (SUBSCRIBE,
 *   UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PING, RESET, QUIT). Trying to
 *   issue ZADD / HSET / etc on a subscribed connection returns
 *   "ERR Can't execute 'zadd': only (P)SUBSCRIBE / ..." and ioredis will
 *   reject the promise. ioredis simply mirrors this server-side
 *   restriction — it cannot multiplex.
 *
 *   So the rule is:
 *     • Use the existing app-level Redis client for PUBLISH (publish is
 *       just a normal command — no protocol mode change).
 *     • Allocate a DEDICATED ioredis instance for SUBSCRIBE. This module
 *       owns it, opens it on startEventSubscriber(), closes it on stop().
 *
 *   Cost: one extra Redis TCP connection per API process. That is
 *   negligible — Redis comfortably handles tens of thousands of
 *   connections; we'd open at most O(replicas) of them.
 *
 * Why dedup by sourceId?
 *
 *   The API both EMITS locally (so its own WS clients see the event with
 *   zero round-trip latency) AND PUBLISHES to the channel (so OTHER API
 *   replicas can broadcast it to their connected clients). When the local
 *   subscriber receives its own published message, it must skip it —
 *   otherwise the same event reaches every WS client twice on the
 *   originating API replica. The sourceId is just `<role>-<pid>-<rand>`,
 *   chosen at process boot.
 */

let subscriber: Redis | null = null;
let selfSourceId: string | null = null;

/** Generate a unique id for this process. Stable for the process lifetime. */
export function makeProcessSourceId(role: string): string {
  return `${role}-${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Open the dedicated subscriber connection and start re-emitting messages
 * on the local bus. Idempotent — calling twice is a no-op.
 *
 * @returns a `stop()` function that closes the subscriber. Caller's
 *          shutdown path must invoke it.
 */
export async function startEventSubscriber(
  sourceId: string,
): Promise<() => Promise<void>> {
  if (subscriber !== null) {
    // Already started — return a no-op stopper to keep the API symmetric.
    return async () => {};
  }
  selfSourceId = sourceId;

  const baseConfig = {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  };

  let sub: Redis;
  if (process.env.REDIS_URL) {
    sub = new IORedis(process.env.REDIS_URL, baseConfig);
  } else {
    sub = new IORedis({
      ...baseConfig,
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });
  }

  // Surface connection errors but do NOT crash the API — without the
  // subscriber the only thing we lose is cross-replica live updates;
  // local EventEmitter still works.
  sub.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'error',
      msg: 'event_subscriber_error',
      message: err.message,
    }));
  });

  await sub.subscribe(redisKeys.eventsChannel());

  sub.on('message', (_channel: string, payload: string) => {
    const env = decodeEnvelope(payload);
    if (env === null) return;
    if (env.sourceId === selfSourceId) return; // our own publish, already emitted locally
    emitJobEvent(env.event);
  });

  subscriber = sub;

  return async (): Promise<void> => {
    if (subscriber === null) return;
    try { await subscriber.unsubscribe(); } catch { /* shutting down */ }
    try { await subscriber.quit(); } catch { /* shutting down */ }
    subscriber = null;
    selfSourceId = null;
  };
}

/**
 * Publish an event to every other API replica. Uses the caller-provided
 * "main" Redis connection (NOT the subscriber). Best-effort: a publish
 * failure logs and resolves — we never want the live-updates layer to
 * block job mutations.
 */
export async function publishJobEvent(redis: Redis, event: JobEvent): Promise<void> {
  if (selfSourceId === null) {
    // Subscriber was never started; pick a fallback id so consumers can
    // still distinguish if multiple unbridged producers exist.
    selfSourceId = makeProcessSourceId('api-pub');
  }
  const payload = encodeEnvelope({ event, sourceId: selfSourceId });
  try {
    await redis.publish(redisKeys.eventsChannel(), payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'warn',
      msg: 'event_publish_failed',
      type: event.type,
      jobId: event.job.id,
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Convenience: emit locally AND publish for cross-replica fanout. The
 * normal call path for an API-side mutation. Order matters: emit first
 * so connected clients see updates in the lowest possible latency, then
 * publish (network round-trip).
 */
export async function announceJobEvent(redis: Redis, event: JobEvent): Promise<void> {
  emitJobEvent(event);
  await publishJobEvent(redis, event);
}

/** For tests only. */
export function _resetEventSubscriberForTests(): void {
  subscriber = null;
  selfSourceId = null;
}
