/**
 * @flowq/sdk — public entry point.
 *
 * Two audiences read this barrel:
 *   1. External producers — they want `FlowQClient` and the typed
 *      response shapes (Job, QueueStats, …) plus the error classes
 *      to discriminate failures with `instanceof`.
 *   2. Internal FlowQ packages — they additionally need the wire
 *      codecs, Redis key schema, and event envelope helpers so all
 *      processes encode/decode identically. Those live in
 *      ./codec, ./keys, ./events and are re-exported below.
 *
 * Backward-compatible: every name that was exported pre-Module 9 is
 * still exported. New: `FlowQClient`, the error classes, and the
 * additional response types.
 */

export const SDK_VERSION = '0.1.0';

// Domain types + producer input shape
export * from './types';

// Internal-shared modules (codec, keys, event envelope)
export * from './keys';
export * from './codec';
export * from './events';

// Producer client + typed errors
export { FlowQClient } from './client';
export type { FlowQClientOptions, RetryPolicy } from './client';

export {
  FlowQError,
  FlowQAuthError,
  FlowQNotFoundError,
  FlowQValidationError,
  FlowQNetworkError,
  FlowQConflictError,
  FlowQServerError,
  errorFromResponse,
} from './errors';
export type { FlowQErrorBody } from './errors';

// Default export: the client itself, for `import FlowQ from '@flowq/sdk'` ergonomics.
import { FlowQClient } from './client';
export default FlowQClient;
