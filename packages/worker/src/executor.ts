import type { Job } from '@flowq/sdk';
import { logger } from './logger';
import { runRegisteredHandler } from './handlers';

/**
 * Thrown when a job exceeds its declared `timeout` seconds.
 *
 * It is a real subclass (not a tagged Error) so `failJob` can do
 * `err instanceof JobTimeoutError` and decide on telemetry / metrics
 * separately from generic exceptions. Timeouts and exceptions are
 * different operational signals: a timeout usually means a downstream
 * is slow; an exception usually means the code is wrong.
 */
export class JobTimeoutError extends Error {
  public readonly jobId: string;
  public readonly timeoutSeconds: number;
  constructor(jobId: string, timeoutSeconds: number) {
    super(`job ${jobId} exceeded its ${timeoutSeconds}s timeout`);
    this.name = 'JobTimeoutError';
    this.jobId = jobId;
    this.timeoutSeconds = timeoutSeconds;
  }
}

/**
 * Placeholder executor.
 *
 * Until we ship the handler-registration system (next module), every job
 * is treated as a no-op that "works" for `payload.duration` ms (default
 * 1000). This is enough to drive the full state machine end-to-end:
 *
 *   • If `payload.fail === true`, the job throws — exercises failJob /
 *     retry / DLQ paths.
 *   • If `payload.duration` exceeds `job.timeout * 1000`, the timeout
 *     wrapper fires — exercises the JobTimeoutError path.
 *
 * Real handlers will replace the body of this function in a future
 * module; the timeout wrapper around it stays.
 */
async function runHandler(job: Job): Promise<void> {
  logger.info('job_handler_start', {
    jobId: job.id,
    queueName: job.queueName,
    payload: job.payload,
  });

  // Real handler registry (dispatched by payload.type). Returns null when the
  // job has no recognised type, in which case we fall back to the legacy
  // sleep behaviour so existing demos/tests keep working.
  const result = await runRegisteredHandler(job);

  if (result === null) {
    const duration = typeof job.payload.duration === 'number' ? job.payload.duration : 1000;
    await new Promise<void>((resolve) => setTimeout(resolve, duration));

    if (job.payload.fail === true) {
      throw new Error(
        typeof job.payload.error === 'string' ? job.payload.error : 'simulated failure',
      );
    }

    logger.info('job_handler_done', { jobId: job.id, durationMs: duration });
    return;
  }

  logger.info('job_handler_done', { jobId: job.id, result });
}

/**
 * Run the job's handler under a hard deadline.
 *
 * The pattern is `Promise.race([handler, timeout])`. Two important
 * caveats that I want every reader of this code to internalise:
 *
 *   1. Promise.race does NOT cancel the loser. If the handler is still
 *      running when the timeout wins, it keeps running until it resolves
 *      or the process exits. JavaScript has no general cancellation
 *      primitive, so a misbehaving handler can leak resources past the
 *      timeout — but the WORKER LOOP is unblocked on time, which is
 *      what matters for queue health. Future work: thread an
 *      AbortSignal into the handler and cooperate.
 *
 *   2. We `clearTimeout` in the success path so a long timeout (e.g.
 *      30s) doesn't keep the event loop alive after a fast (e.g. 50ms)
 *      success. Without this, `process.exit(0)` would still be clean
 *      but a graceful shutdown would wait for the timer to fire.
 */
export async function executeJob(job: Job): Promise<void> {
  const timeoutMs = job.timeout * 1000;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new JobTimeoutError(job.id, job.timeout));
    }, timeoutMs);
  });

  try {
    await Promise.race([runHandler(job), timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
