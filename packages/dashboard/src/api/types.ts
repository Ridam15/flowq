/**
 * Public API contract types — shapes the REST API and WebSocket layer
 * actually return. Many of these are re-exports from @flowq/sdk; the
 * purely API-facing ones (queue stats, DLQ rows, worker info) live here
 * because they are wire types specific to the control-plane API, not
 * SDK domain types.
 *
 * Why redeclare `JobStatus` locally instead of re-exporting it from
 * @flowq/sdk?
 *
 *   The SDK is compiled to CommonJS (tsconfig.base.json sets
 *   `module: CommonJS` so the API and worker can `require()` it).
 *   Rollup, the bundler under Vite, cannot statically trace named
 *   exports through TypeScript's CJS `__exportStar` helper, so
 *   `export { JobStatus } from '@flowq/sdk'` fails the production
 *   build. Type-only imports (`Job`, `JobEvent`) compile away and
 *   are unaffected — but the value-side `JobStatus` does need to
 *   exist at runtime.
 *
 *   The fix is intentional: redefine the enum here as a `const`
 *   object with the EXACT same string values. The wire contract
 *   between API and dashboard is the string literals themselves
 *   ("PENDING", "ACTIVE", …), which both sides agree on by
 *   construction. The SDK's enum and the dashboard's const object
 *   are structurally compatible because TypeScript treats string
 *   enums and string-literal unions interchangeably.
 *
 *   The alternative — dual ESM/CJS output from the SDK — is the
 *   "correct" long-term solution but is a much larger change. We can
 *   make it later without touching this file.
 */
export type { Job, JobEvent, JobEventType } from '@flowq/sdk';

export const JobStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export interface QueueStats {
  queueName: string;
  enqueued: number;
  completed: number;
  failed: number;
  dead: number;
  currentPending: number;
  currentActive: number;
  paused: boolean;
}

export interface WorkerInfo {
  id: string;
  queue: string | null;
  status: 'idle' | 'busy' | 'unknown';
  startedAt: number | null;
  lastHeartbeat: number | null;
  currentJobId: string | null;
  staleSeconds: number | null;
}

export interface DeadLetterRow {
  id: string;
  jobId: string;
  queueName: string;
  payload: Record<string, unknown>;
  lastError: string | null;
  attempts: number;
  manuallyRetried: boolean;
  diedAt: number | null;
  retriedAt: number | null;
}

export interface DlqPage {
  jobs: DeadLetterRow[];
  total: number;
  page: number;
  limit: number;
}

export interface HealthResponse {
  status: string;
  redis?: string;
  postgres?: string;
  uptime?: number;
}

/* -------------------------------------------------------------------------
 * WebSocket frame types
 *
 * The API server sends three frame shapes. We model them as a
 * discriminated union so the consumer hook can switch on `type` with
 * full type-narrowing.
 * ------------------------------------------------------------------------- */
import type { Job, JobEvent } from '@flowq/sdk';

export interface WSInitFrame {
  type: 'init';
  jobs: Job[];
  connectedClients: number;
}

export interface WSEventFrame {
  type: 'event';
  event: JobEvent;
}

export interface WSStatsFrame {
  type: 'stats';
  queues: QueueStats[];
}

export type WSFrame = WSInitFrame | WSEventFrame | WSStatsFrame;
