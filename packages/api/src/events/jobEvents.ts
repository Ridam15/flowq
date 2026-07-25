import { EventEmitter } from 'node:events';
import type { JobEvent } from '@flowq/sdk';

/* ============================================================================
 * Local in-process event bus
 * ============================================================================
 *
 * Single source of truth for "something happened to a job in this process or
 * was reported to us via Redis pub/sub". Two kinds of consumers attach:
 *
 *   1. WebSocketServer — broadcasts each event as a JSON message to every
 *      connected dashboard client.
 *   2. SSE route       — same idea but as `data: ...\n\n` writes on a
 *      long-lived HTTP response.
 *
 * Producers attach via:
 *
 *   • emitJobEvent(event)  — used by route handlers / queue helpers running
 *     INSIDE this process. Always pairs with a publishJobEvent(...) call
 *     so other API replicas see it too (see redisBridge.ts).
 *
 *   • The Redis subscriber (redisBridge.ts) calls emitJobEvent for messages
 *     it pulls off the `flowq:events` channel — that's how worker-side
 *     transitions reach our connected clients.
 *
 * Why a Node EventEmitter instead of an RxJS Subject or a custom thing?
 *   • Zero deps, well-understood semantics, native `setMaxListeners(0)`
 *     handles the "many WS clients" case without warnings.
 *   • All emits are synchronous so a slow consumer can't head-of-line
 *     block the producer — we deliberately fire-and-forget.
 *
 * Listener cleanup is the caller's responsibility: the helpers below return
 * an `unsubscribe` function. WS / SSE handlers MUST call it on
 * disconnect or we'll leak a listener per dropped client.
 */

const EVENT_NAME = 'event';

class JobEventBus extends EventEmitter {}

const bus = new JobEventBus();
// 0 = unlimited. We don't know how many dashboard clients will connect.
// The default 10 would noisily warn at 11+ WS clients which is normal.
bus.setMaxListeners(0);

/** Fire an event to every local listener. Synchronous, never throws. */
export function emitJobEvent(event: JobEvent): void {
  bus.emit(EVENT_NAME, event);
}

/**
 * Subscribe to events. Returns an `unsubscribe` function — ALWAYS call
 * it from the consumer's teardown path (`ws.on('close', ...)`,
 * `req.on('close', ...)`, etc.) to avoid leaking listeners.
 */
export function onJobEvent(listener: (event: JobEvent) => void): () => void {
  bus.on(EVENT_NAME, listener);
  return (): void => {
    bus.off(EVENT_NAME, listener);
  };
}

/** Test/diagnostic helper. */
export function jobEventListenerCount(): number {
  return bus.listenerCount(EVENT_NAME);
}
