/* ============================================================================
 * FlowQ Redis key schema
 * ============================================================================
 *
 * This file lives in @flowq/sdk so the API (producer side) and the worker
 * (consumer side) read from the SAME definition. The cardinal sin in a queue
 * system is having two services that disagree on what "the pending key" is
 * named — one writes, the other can't see the write, jobs vanish.
 *
 * WHY a Sorted Set (ZSET) for the pending queue, not a List?
 * ----------------------------------------------------------
 * A Redis LIST gives you O(1) push/pop and FIFO ordering. That is the
 * obvious choice and it is wrong for this system. Here is the reasoning,
 * the way I want every engineer on this codebase to think about it:
 *
 *   1. Delayed jobs.
 *      A producer can enqueue a job that should not run for 30 minutes.
 *      With a LIST you have nowhere to put it — it would either block
 *      the head of the queue or require a parallel "scheduled" structure.
 *      With a ZSET we use `scheduledAt` (Unix epoch ms) as the score, and
 *      the worker pops jobs whose score is ≤ now via `ZRANGEBYSCORE`.
 *      Delayed and immediate jobs live in the same key — one source of
 *      truth, one atomic claim path.
 *
 *   2. Time-window queries.
 *      "How many jobs become eligible in the next 60 seconds?" is
 *      ZCOUNT in O(log N + M). On a LIST that question is unanswerable
 *      without scanning every element.
 *
 *   3. Atomic claim.
 *      The worker's claim is `ZRANGEBYSCORE … 0 now LIMIT 0 N` followed
 *      by `ZREM` + `ZADD` to active — all wrapped in a Lua script for
 *      atomicity. With a LIST you would use BLPOP, which gives you no
 *      control over which element you take, no priority, no delay handling.
 *
 *   4. Priority bias.
 *      We fold priority into the score (`scheduledAt - priority * 1000`)
 *      so high-priority jobs jump ahead naturally without a separate
 *      priority queue. Cleaner than maintaining one LIST per priority.
 *
 *   5. Stalled-worker recovery.
 *      The `:active` set uses `claimedAt` as the score, so a janitor can
 *      do `ZRANGEBYSCORE active 0 (now - timeout)` to find jobs whose
 *      worker died holding the lease, and re-enqueue them. Impossible
 *      with a LIST — a LIST has no "when did this enter?" metadata.
 *
 * The cost of a ZSET is O(log N) instead of O(1) for push/pop. At our
 * expected scale (millions of jobs, not billions), log(N) ≈ 20-25 ops —
 * irrelevant on Redis. We pay a tiny constant for a fundamentally more
 * powerful primitive. That is the right trade.
 *
 * Operational note: every key is namespaced under `flowq:` so this Redis
 * instance can be safely shared with other applications during local dev.
 * Production should always use a dedicated Redis instance / database.
 * ========================================================================= */

/** Top-level namespace. Change once, propagate everywhere. */
export const NAMESPACE = 'flowq';

/**
 * Functional builders for every Redis key in the system. Always call
 * these — never assemble keys with template literals at the callsite.
 * That way a typo or a rename is a single-file change.
 */
export const redisKeys = {
  /** ZSET<jobId, score = scheduledAt - priority*1000> — jobs waiting to be claimed. */
  queuePending: (queueName: string): string => `${NAMESPACE}:queue:${queueName}:pending`,

  /** ZSET<jobId, claimedAt> — jobs currently held by a worker. */
  queueActive: (queueName: string): string => `${NAMESPACE}:queue:${queueName}:active`,

  /** HASH — full job document keyed by job id. */
  job: (jobId: string): string => `${NAMESPACE}:job:${jobId}`,

  /** HASH — worker metadata: id, queue, startedAt, lastHeartbeat, status, currentJobId. */
  worker: (workerId: string): string => `${NAMESPACE}:worker:${workerId}`,

  /** SET<workerId> — registry of all currently-registered workers. */
  workersRegistry: (): string => `${NAMESPACE}:workers:registry`,

  /** HASH — per-queue counters: enqueued, completed, failed, dead. */
  queueStats: (queueName: string): string => `${NAMESPACE}:queue:${queueName}:stats`,

  /**
   * STRING<jobId> — idempotency lookup. Set with `SET … EX 86400`
   * so the entry self-cleans after 24 hours.
   */
  idempotency: (key: string): string => `${NAMESPACE}:idempotency:${key}`,

  /** STRING<"1"> — when this key exists, the queue accepts no new claims. */
  queuePaused: (queueName: string): string => `${NAMESPACE}:queue:${queueName}:paused`,

  /**
   * SET<queueName> — every queue that has ever been enqueued to.
   *
   * Populated by `enqueueJob` (SADD inside the same MULTI as the rest of
   * the write, so it's atomic and free). Read by the watchdog so it knows
   * which `:active` zsets to scan for orphan jobs without globbing the
   * keyspace. SCAN over `flowq:queue:*:active` would also work but is
   * O(N) over every key in Redis — unacceptable on a shared instance.
   */
  queuesRegistry: (): string => `${NAMESPACE}:queues:registry`,

  /**
   * STRING<workerId> — singleton lease for the watchdog leader.
   *
   * Held with `SET ... NX EX 30` and refreshed every 25s by the holder
   * via a compare-and-PEXPIRE Lua script. Released on graceful shutdown
   * via a compare-and-DEL Lua script. The TTL is the safety net: if the
   * leader dies without releasing, a new leader can claim within 30s.
   */
  watchdogLeader: (): string => `${NAMESPACE}:watchdog:leader`,

  /**
   * STREAM<{queueName, seconds}> — every completed job's wall-clock
   * duration is XADD'd here by the worker. The API's /metrics scraper
   * consumes the stream with a tracked offset and feeds the values
   * into the prom-client histogram.
   *
   * Why a Stream instead of HINCRBY-style aggregates: histograms
   * fundamentally need per-sample observations, not running sums. A
   * Stream gives us a bounded, ordered sample buffer with cheap reads.
   *
   * Bounded with MAXLEN ~ 10000 on every XADD so memory stays fixed
   * regardless of job throughput. If /metrics is scraped less often
   * than 10000 jobs complete between scrapes, we lose the oldest
   * samples — acceptable for a histogram (still statistically valid).
   */
  metricsDurations: (): string => `${NAMESPACE}:metrics:durations`,

  /**
   * PUB/SUB CHANNEL — fan-out for cross-process job lifecycle events.
   *
   * Producers: any process that mutates job state (the API on enqueue/
   * cancel, every worker on claim/complete/fail/dead, the watchdog on
   * recover).
   *
   * Consumers: every API replica's WebSocket / SSE bridge. The bridge
   * subscribes via a *dedicated* ioredis connection (subscribe mode is
   * a connection-wide flag in the Redis protocol) and re-emits on the
   * in-process EventEmitter so all attached clients see the update.
   *
   * Wire format: JSON-serialised `JobEventEnvelope` (event payload +
   * `sourceId` of the producing process). Subscribers skip messages
   * whose sourceId matches their own to avoid double-broadcasting
   * events they themselves emitted locally.
   */
  eventsChannel: (): string => `${NAMESPACE}:events`,
} as const;

/** Field names used inside the `flowq:queue:{q}:stats` HASH. */
export const QUEUE_STATS_FIELDS = {
  enqueued: 'enqueued',
  completed: 'completed',
  failed: 'failed',
  dead: 'dead',
} as const;

/** Field names used inside the `flowq:worker:{id}` HASH. */
export const WORKER_HASH_FIELDS = {
  id: 'id',
  queue: 'queue',
  startedAt: 'startedAt',
  lastHeartbeat: 'lastHeartbeat',
  /** 'idle' | 'busy' — a fast at-a-glance signal for the dashboard. */
  status: 'status',
  /** Set while busy, HDEL'd when the worker returns to idle. */
  currentJobId: 'currentJobId',
} as const;

/** Worker status values stored in the WORKER_HASH_FIELDS.status field. */
export const WORKER_STATUS = {
  idle: 'idle',
  busy: 'busy',
} as const;

/** Field names used inside the `flowq:job:{id}` HASH. */
export const JOB_HASH_FIELDS = {
  id: 'id',
  queueName: 'queueName',
  payload: 'payload',
  priority: 'priority',
  status: 'status',
  attempts: 'attempts',
  maxAttempts: 'maxAttempts',
  delay: 'delay',
  idempotencyKey: 'idempotencyKey',
  createdAt: 'createdAt',
  scheduledAt: 'scheduledAt',
  startedAt: 'startedAt',
  completedAt: 'completedAt',
  failedAt: 'failedAt',
  lastError: 'lastError',
  workerId: 'workerId',
  timeout: 'timeout',
} as const;

/** Static, well-known sentinel values. */
export const REDIS_SENTINELS = {
  /** Value written to the `:paused` key. */
  pausedFlag: '1',
} as const;
