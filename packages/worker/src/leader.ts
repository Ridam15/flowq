import type { Redis } from 'ioredis';
import { redisKeys } from '@flowq/sdk';

import { logger } from './logger';

/* ============================================================================
 * Leader election for the watchdog
 * ============================================================================
 *
 * WHY do we need leader election at all?
 *
 *   The watchdog is the process that recovers jobs from dead workers. It
 *   does this by SMEMBERS-ing the worker registry, checking heartbeats,
 *   and ZREMing-then-ZADDing stalled jobs. The work is *idempotent at
 *   the per-job level* (`recoverJob` uses WATCH/MULTI/EXEC), but it is
 *   *wasteful* and *noisy* if every worker pod runs a watchdog:
 *
 *     • N workers => N copies of every SMEMBERS / HGETALL every tick.
 *       At 100 workers and a 10s tick that is 100 redundant scans per
 *       check window — fine for correctness, terrible for observability
 *       (every recovery shows up as N-1 "another watchdog already
 *       handled this" log lines, drowning real signal).
 *
 *     • Recovery emits a `RECOVERED` Postgres event. Multiple watchdogs
 *       would race on the WATCH/MULTI/EXEC; one would win and write the
 *       event, the others would log "lost optimistic lock" — same noise
 *       problem, plus a small but real Postgres connection-pool tax.
 *
 *     • At very large fleets the `SMEMBERS workers:registry` payload
 *       times N becomes a measurable Redis bandwidth cost.
 *
 *   So: the watchdog is a *singleton*. The cluster picks one worker to
 *   also play the watchdog role. If that worker dies, another picks up
 *   the role within `LEADER_TTL_MS`.
 *
 * The election itself is the canonical Redis pattern:
 *
 *   • Acquire: `SET key myId NX EX 30`. NX guarantees only one writer
 *     wins on contention; EX is the safety net so a crashed leader
 *     doesn't hold the role forever.
 *
 *   • Refresh: a *plain* `SET ... XX EX 30` is wrong — if I lost the
 *     lease (clock skew, GC pause longer than 30s, a packet got delayed
 *     past TTL), and a new leader took over, my refresh would steal it
 *     back. Two leaders. The fix is compare-and-refresh: a Lua script
 *     that checks `GET key == myId` and only then PEXPIREs. Atomic by
 *     virtue of Lua running single-threaded inside Redis.
 *
 *   • Release: same hazard, same fix — compare-and-DEL via Lua.
 *
 *   This is the single-instance Redlock pattern. We do NOT need
 *   multi-master Redlock here: we already have a single Redis as our
 *   queue store, so its availability is the ceiling on the whole
 *   system. A second Redis just for locking would add complexity for
 *   no extra correctness.
 *
 * ========================================================================= */

/** TTL on the leader key (seconds). */
export const LEADER_TTL_SECONDS = 30;
/** How often the leader refreshes the TTL (ms). Must be < TTL with margin. */
export const LEADER_REFRESH_INTERVAL_MS = 25_000;

/**
 * Compare-and-PEXPIRE. Returns 1 if we still own the key and bumped
 * the expiry; 0 otherwise (we lost it — caller must stop the watchdog).
 *
 *   KEYS[1] = leader key
 *   ARGV[1] = our worker id (the value we expect to find)
 *   ARGV[2] = new ttl in milliseconds
 */
const REFRESH_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/**
 * Compare-and-DEL. Returns 1 if we deleted; 0 if the key no longer
 * pointed at us (someone else holds it now — leave it alone).
 *
 *   KEYS[1] = leader key
 *   ARGV[1] = our worker id
 */
const RELEASE_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * Public callback the elector fires on state transitions.
 * Implementations must be idempotent — `onAcquired` may fire only once
 * per process lifetime, but `onLost` may fire 0 or 1 times depending on
 * whether the elector ever became leader.
 */
export interface LeaderCallbacks {
  onAcquired?: () => void | Promise<void>;
  onLost?: () => void | Promise<void>;
}

/**
 * One-shot leader: tries to acquire ONCE on `start()`. If it doesn't
 * win, it stays a follower for the rest of the process lifetime — we
 * deliberately do not poll for re-acquisition. Rationale:
 *
 *   • The cluster orchestrator (k8s) cycles pods often enough that
 *     leadership churn happens naturally without an inner-loop poller.
 *   • Followers polling indefinitely for the leader role would put
 *     constant load on Redis for a role that, by design, only one of
 *     them can ever play.
 *   • If the current leader dies, the *next deploy* or *next pod
 *     restart* will trigger a fresh acquisition attempt and one of
 *     those attempts will succeed. Worst-case latency is bounded by
 *     `LEADER_TTL_SECONDS` (30s) — well within recovery SLOs for a
 *     queue system.
 *
 * If we wanted faster failover, the right next step is event-driven
 * (subscribe to keyspace expiry on the leader key) not polling. That
 * is a follow-up if/when the 30s ceiling becomes a real problem.
 */
export class LeaderElector {
  private readonly redis: Redis;
  private readonly workerId: string;
  private readonly key: string;
  private readonly callbacks: LeaderCallbacks;

  private acquired = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(redis: Redis, workerId: string, callbacks: LeaderCallbacks = {}) {
    this.redis = redis;
    this.workerId = workerId;
    this.key = redisKeys.watchdogLeader();
    this.callbacks = callbacks;
  }

  /** True iff this instance currently holds the lease. */
  isLeader(): boolean {
    return this.acquired;
  }

  /**
   * Attempt acquisition once. If we win, schedule periodic refresh and
   * fire `onAcquired`. If we lose, log and return — caller stays a
   * follower.
   */
  async start(): Promise<void> {
    if (this.stopped) return;

    // SET key id NX EX ttl. ioredis returns 'OK' on success, null on miss.
    const res = await this.redis.set(this.key, this.workerId, 'EX', LEADER_TTL_SECONDS, 'NX');
    if (res !== 'OK') {
      logger.info('watchdog_leader_follower', {
        workerId: this.workerId,
        leaderKey: this.key,
      });
      return;
    }

    this.acquired = true;
    logger.info('watchdog_leader_acquired', {
      workerId: this.workerId,
      leaderKey: this.key,
      ttlSeconds: LEADER_TTL_SECONDS,
    });

    // Kick off the refresh schedule BEFORE firing the callback so a slow
    // onAcquired callback can't cause us to miss our first refresh window.
    this.scheduleRefresh();

    if (this.callbacks.onAcquired) {
      try {
        await this.callbacks.onAcquired();
      } catch (err) {
        logger.error('watchdog_leader_acquired_callback_failed', {
          workerId: this.workerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Idempotent release. If we are the leader: stop refreshing and DEL
   * (compare-and-DEL via Lua, so we never delete someone else's key).
   * If we never were the leader: no-op.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.acquired) return;

    try {
      const released = (await this.redis.eval(
        RELEASE_LUA,
        1,
        this.key,
        this.workerId,
      )) as number;
      logger.info('watchdog_leader_released', {
        workerId: this.workerId,
        ourKey: released === 1,
      });
    } catch (err) {
      // We deliberately swallow — the worker is shutting down anyway,
      // and the TTL will reap the key within 30s if we couldn't.
      logger.warn('watchdog_leader_release_failed', {
        workerId: this.workerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.acquired = false;
  }

  // -------------------------------------------------------------------------

  private scheduleRefresh(): void {
    this.refreshTimer = setInterval(() => {
      void this.refreshOnce();
    }, LEADER_REFRESH_INTERVAL_MS);
    // Don't keep the event loop alive just for the refresh timer.
    // The worker's poll loop / signal handlers do that job.
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  private async refreshOnce(): Promise<void> {
    if (this.stopped || !this.acquired) return;
    try {
      const ok = (await this.redis.eval(
        REFRESH_LUA,
        1,
        this.key,
        this.workerId,
        String(LEADER_TTL_SECONDS * 1000),
      )) as number;
      if (ok === 1) return;

      // We lost the lease (TTL expired before we got to refresh, OR a
      // new leader took over because we paused longer than the TTL).
      // Stop the watchdog cleanly via the lost callback. Two leaders
      // are FAR worse than zero leaders for the 30-second window before
      // someone else's refresh kicks in.
      logger.warn('watchdog_leader_lost', { workerId: this.workerId });
      this.acquired = false;
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (this.callbacks.onLost) {
        try {
          await this.callbacks.onLost();
        } catch (err) {
          logger.error('watchdog_leader_lost_callback_failed', {
            workerId: this.workerId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // A transient redis error during refresh is NOT enough to relinquish
      // leadership — the next tick will try again. We log so transient
      // blips show up in metrics.
      logger.warn('watchdog_leader_refresh_error', {
        workerId: this.workerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
