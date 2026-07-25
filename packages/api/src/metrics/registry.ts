import type { Redis } from 'ioredis';
import client from 'prom-client';

import { redisKeys, QUEUE_STATS_FIELDS } from '@flowq/sdk';

/* ============================================================================
 * Prometheus metrics for FlowQ — single /metrics endpoint, distributed truth
 * ============================================================================
 *
 * The hard problem this module solves
 * -----------------------------------
 * `enqueueJob` runs in the API process. `completeJob`/`failJob` run in the
 * worker process. The spec asks for ONE /metrics endpoint exposing counters
 * for all of those events. In-process prom-client increments only see what
 * happens in *their* process, so a naive `enqueuedTotal.inc()` in enqueueJob
 * and a `completedTotal.inc()` in completeJob would give you two endpoints
 * with two halves of the truth.
 *
 * The design
 * ----------
 * Redis is already the source of truth for queue state. Every state
 * transition that matters for metrics already does an atomic HINCRBY on
 * `flowq:queue:{q}:stats` (enqueued/completed/failed/dead) inside the
 * MULTI that performs the state change. Those numbers are MONOTONIC and
 * AUTHORITATIVE.
 *
 * On every /metrics scrape we:
 *   1. SMEMBERS the queues registry
 *   2. HGETALL each queue's stats hash
 *   3. compute (current - lastSeen) deltas per (queue, stat)
 *   4. inc() the corresponding prom-client counter by the delta
 *   5. ZCARD pending+active to set the queue_depth gauge
 *   6. XREAD any new duration samples from the metrics stream and
 *      observe() them on the histogram
 *
 * Why not just expose Gauges of the absolute Redis values?
 * Because Prometheus counters carry semantic meaning: rate(), increase(),
 * reset detection. Naming a Gauge with the `_total` suffix and treating
 * it like a counter is a known anti-pattern that breaks PromQL functions
 * downstream. We do the small bookkeeping to keep counter semantics correct.
 *
 * Why a delta-from-last-seen approach is safe
 * - Redis HINCRBY is monotonic for the lifetime of the queue stats hash.
 * - If Redis is wiped (e.g. dev `flushall`), all stats reset to 0. Our
 *   in-memory `lastSeen` will be > current → we treat negative deltas as
 *   a counter reset and just sync without inc()ing. Same behavior as a
 *   restarted exporter.
 * - If THIS process restarts, lastSeen starts at 0 and the first scrape
 *   inc()s by the full Redis value. Prometheus sees this as a counter
 *   reset on the *exporter* side, also handled by rate() correctly.
 *
 * Why durations live in a Redis Stream
 * Histograms need per-sample observations, not running totals. The worker
 * XADDs `{queueName, seconds}` per completed job. Stream is bounded by
 * MAXLEN so memory stays fixed. The /metrics scraper tracks a per-process
 * cursor (last consumed entry id) and only observes new samples since
 * the last scrape. Multiple API replicas each maintain their own cursor,
 * which means each replica observes the same samples — that's fine,
 * because Prometheus aggregates across replicas anyway and we can use
 * `sum without(instance)` in PromQL.
 * ========================================================================= */

export const register = new client.Registry();
register.setDefaultLabels({ service: '@flowq/api' });
client.collectDefaultMetrics({ register });

// -----------------------------------------------------------------------
// Counters — "X has happened, total"
// -----------------------------------------------------------------------

const enqueuedTotal = new client.Counter({
  name: 'flowq_jobs_enqueued_total',
  help: 'Jobs enqueued, by queue. Sourced from flowq:queue:{q}:stats.enqueued.',
  labelNames: ['queueName'] as const,
  registers: [register],
});

const completedTotal = new client.Counter({
  name: 'flowq_jobs_completed_total',
  help: 'Jobs completed successfully. Sourced from flowq:queue:{q}:stats.completed.',
  labelNames: ['queueName'] as const,
  registers: [register],
});

const failedTotal = new client.Counter({
  name: 'flowq_jobs_failed_total',
  help: 'Job attempts that failed (any attempt — dead jobs count here too).',
  labelNames: ['queueName'] as const,
  registers: [register],
});

const deadTotal = new client.Counter({
  name: 'flowq_jobs_dead_total',
  help: 'Jobs that exhausted retries and moved to the DLQ.',
  labelNames: ['queueName'] as const,
  registers: [register],
});

// -----------------------------------------------------------------------
// Gauge — "current value right now"
// -----------------------------------------------------------------------

const queueDepth = new client.Gauge({
  name: 'flowq_queue_depth',
  help: 'Number of jobs in pending/active state per queue, sampled at scrape time.',
  labelNames: ['queueName', 'type'] as const,
  registers: [register],
});

// -----------------------------------------------------------------------
// Histogram — "distribution of values"
// -----------------------------------------------------------------------

const jobDuration = new client.Histogram({
  name: 'flowq_job_duration_seconds',
  help: 'End-to-end job execution time (worker side). Buckets in seconds.',
  labelNames: ['queueName'] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

// -----------------------------------------------------------------------
// In-memory state for delta computation + stream cursor
// -----------------------------------------------------------------------

interface SnapshotRow {
  enqueued: number;
  completed: number;
  failed: number;
  dead: number;
}
const lastSeen = new Map<string, SnapshotRow>();

/**
 * Stream cursor.
 *
 * '$' means "only entries added AFTER this XREAD call" — which would
 * cause us to miss the first scrape's worth of samples. We use '0-0'
 * on first scrape so we drain everything that was already in the
 * stream when the API booted, then advance from the last id we saw.
 */
let durationStreamCursor = '0';

// -----------------------------------------------------------------------
// Per-scrape collector
// -----------------------------------------------------------------------

/**
 * Shape returned by ioredis `xread`. Entries are tuples
 * `[entryId, [field, value, field, value, ...]]` grouped per stream
 * `[streamName, entries]`. We type as tuples so destructuring works.
 */
type RedisXReadEntry = [string, string[]];
type RedisXReadResult = Array<[string, RedisXReadEntry[]]> | null;

/**
 * Scan all queue stats from Redis, compute per-counter deltas, increment
 * counters, refresh the queue_depth gauge, and observe any new duration
 * samples from the stream.
 *
 * One scrape = one Redis trip per queue × ~3 commands + one XREAD. We
 * use a pipeline to avoid round-trip latency dominating scrape time at
 * scale. At <1k queues this is well under 50ms on local Redis.
 */
export async function collectFromRedis(redis: Redis): Promise<void> {
  const queues = await redis.smembers(redisKeys.queuesRegistry());

  for (const queueName of queues) {
    const pipe = redis.pipeline();
    pipe.hgetall(redisKeys.queueStats(queueName));
    pipe.zcard(redisKeys.queuePending(queueName));
    pipe.zcard(redisKeys.queueActive(queueName));
    const results = await pipe.exec();
    if (!results) continue;

    const statsRaw = (results[0]?.[1] ?? {}) as Record<string, string>;
    const pending = (results[1]?.[1] as number | undefined) ?? 0;
    const active = (results[2]?.[1] as number | undefined) ?? 0;

    const cur: SnapshotRow = {
      enqueued: toNum(statsRaw[QUEUE_STATS_FIELDS.enqueued]),
      completed: toNum(statsRaw[QUEUE_STATS_FIELDS.completed]),
      failed: toNum(statsRaw[QUEUE_STATS_FIELDS.failed]),
      dead: toNum(statsRaw[QUEUE_STATS_FIELDS.dead]),
    };

    const prev = lastSeen.get(queueName) ?? { enqueued: 0, completed: 0, failed: 0, dead: 0 };

    // Counter reset detection: if any current value is < previous, the
    // backing store was wiped (or we're booting fresh against a
    // pre-existing Redis with NEW counters). Sync without inc'ing —
    // Prometheus's rate() handles exporter resets by treating them as
    // a counter reset.
    const reset =
      cur.enqueued < prev.enqueued ||
      cur.completed < prev.completed ||
      cur.failed < prev.failed ||
      cur.dead < prev.dead;

    if (!reset) {
      if (cur.enqueued > prev.enqueued) {
        enqueuedTotal.inc({ queueName }, cur.enqueued - prev.enqueued);
      }
      if (cur.completed > prev.completed) {
        completedTotal.inc({ queueName }, cur.completed - prev.completed);
      }
      if (cur.failed > prev.failed) {
        failedTotal.inc({ queueName }, cur.failed - prev.failed);
      }
      if (cur.dead > prev.dead) {
        deadTotal.inc({ queueName }, cur.dead - prev.dead);
      }
    }
    lastSeen.set(queueName, cur);

    queueDepth.set({ queueName, type: 'pending' }, pending);
    queueDepth.set({ queueName, type: 'active' }, active);
  }

  // Drain new duration samples since last scrape.
  // BLOCK 0 would hang forever; we want a non-blocking read.
  const streamRes = (await redis.xread(
    'COUNT',
    1000,
    'STREAMS',
    redisKeys.metricsDurations(),
    durationStreamCursor,
  )) as RedisXReadResult;

  if (streamRes) {
    for (const [, entries] of streamRes) {
      for (const [id, fields] of entries) {
        const f = pairsToObject(fields);
        const queueName = f.queueName;
        const seconds = Number(f.seconds);
        if (queueName && Number.isFinite(seconds) && seconds >= 0) {
          jobDuration.observe({ queueName }, seconds);
        }
        durationStreamCursor = id;
      }
    }
  }
}

/**
 * Render the metrics text. Always run a fresh collection first so the
 * exposed values reflect Redis state at scrape time.
 */
export async function renderMetrics(redis: Redis): Promise<string> {
  await collectFromRedis(redis);
  return register.metrics();
}

export const metricsContentType = register.contentType;

// -----------------------------------------------------------------------
// Test helpers — exported only for vitest, not for runtime callers
// -----------------------------------------------------------------------

/** Reset all internal state. Used by tests; never call from app code. */
export function __resetMetricsForTest(): void {
  lastSeen.clear();
  durationStreamCursor = '0';
  register.resetMetrics();
}

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

function toNum(s: string | undefined): number {
  if (s === undefined || s === null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pairsToObject(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    out[pairs[i]] = pairs[i + 1];
  }
  return out;
}
