/**
 * Structured JSON logger.
 *
 * Every line is one JSON object on stdout. This is non-negotiable for the
 * worker: we will be running many of them, scraping with Loki/CloudWatch/etc,
 * and a free-text log line is a liability — it can't be filtered, aggregated,
 * or alerted on without brittle regex.
 *
 * Schema (every line):
 *   {
 *     "ts":   <ISO 8601 string>,
 *     "level":"info" | "warn" | "error",
 *     "svc":  "@flowq/worker",
 *     "event":<short snake_case verb, e.g. "job_claimed">,
 *     ...rest of the structured payload (workerId, jobId, queueName, ...)
 *   }
 *
 * We do not pull in pino/winston because:
 *   • One file. One process. We don't need transports, file rotation,
 *     or 12 plugins.
 *   • Zero deps means zero supply-chain risk for what is essentially
 *     `console.log(JSON.stringify(...))`.
 *   • If we ever want pino, this is a one-day swap because the call
 *     sites all use `logger.info(event, fields)`.
 */

const SVC = '@flowq/worker';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  // We construct the object in a fixed order so the eyeball-scan of a
  // tail -f reads predictably. JSON.stringify preserves insertion order.
  const line = {
    ts: new Date().toISOString(),
    level,
    svc: SVC,
    event,
    ...fields,
  };
  // stderr for warn/error so process supervisors can split streams if
  // they want; stdout for info.
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(JSON.stringify(line) + '\n');
}

export const logger = {
  info: (event: string, fields: LogFields = {}): void => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}): void => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}): void => emit('error', event, fields),
};
