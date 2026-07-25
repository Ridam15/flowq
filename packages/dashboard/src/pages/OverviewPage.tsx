import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../api/client';
import type { QueueStats } from '../api/types';
import { StatCard } from '../components/Card';

interface OverviewPageProps {
  queueStats: Record<string, QueueStats>;
}

/**
 * Top-of-funnel "is the system healthy?" view. Four metrics, large
 * monospace numbers, no scroll required to see all of them at a glance.
 *
 * Two derived metrics matter here:
 *
 *   • "Jobs processed today" — sum of (completed + failed + dead) across
 *     all queues. We approximate "today" as "since the API started"
 *     because Redis only stores cumulative counters; a true rolling-24h
 *     would require a Redis stream of state-change events. That's an
 *     intentional simplification — the counters reset on cluster restart
 *     anyway, so "since boot" is a useful and honest signal.
 *
 *   • "Success rate" — completed / (completed + failed + dead).
 *     A FAILED-and-retried job counts as both a "failed" attempt AND
 *     (eventually) a "completed". That's correct: it tells the operator
 *     the *first-try* success rate, which is what they actually want to
 *     trend on.
 */
export function OverviewPage({ queueStats }: OverviewPageProps): JSX.Element {
  // Workers list comes from REST (no live event stream for it). React
  // Query refetches every 5s — fast enough that "is a worker missing?"
  // is visible quickly without overwhelming the API.
  const workersQuery = useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => api.listWorkers(signal),
    refetchInterval: 5_000,
  });

  const totals = useMemo(() => {
    let completed = 0;
    let failed = 0;
    let dead = 0;
    let pending = 0;
    let active = 0;

    for (const s of Object.values(queueStats)) {
      completed += s.completed;
      failed += s.failed;
      dead += s.dead;
      pending += s.currentPending;
      active += s.currentActive;
    }
    const processed = completed + failed + dead;
    const successRate = processed === 0 ? null : completed / processed;

    return {
      processed,
      depth: pending + active,
      successRate,
      pending,
      active,
      failed,
      dead,
    };
  }, [queueStats]);

  const workerCount = workersQuery.data?.workers.length ?? 0;
  const idleCount = workersQuery.data?.workers.filter((w) => w.status === 'idle').length ?? 0;
  const busyCount = workersQuery.data?.workers.filter((w) => w.status === 'busy').length ?? 0;

  const successPct =
    totals.successRate === null ? '—' : `${(totals.successRate * 100).toFixed(1)}%`;

  // Tone the success-rate card by health: > 99% green, > 95% amber, else red.
  const successTone =
    totals.successRate === null
      ? 'default'
      : totals.successRate >= 0.99
        ? 'success'
        : totals.successRate >= 0.95
          ? 'warn'
          : 'danger';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Processed (since boot)"
          value={totals.processed.toLocaleString()}
          caption={`${totals.failed.toLocaleString()} failed · ${totals.dead.toLocaleString()} dead`}
        />
        <StatCard
          label="Queue depth"
          value={totals.depth.toLocaleString()}
          caption={`${totals.pending.toLocaleString()} pending · ${totals.active.toLocaleString()} active`}
          tone={totals.depth > 0 ? 'accent' : 'default'}
        />
        <StatCard
          label="Workers"
          value={workerCount}
          caption={
            workersQuery.isError
              ? 'unable to fetch'
              : `${busyCount} busy · ${idleCount} idle`
          }
          tone={workerCount === 0 ? 'danger' : workerCount === idleCount ? 'success' : 'default'}
        />
        <StatCard
          label="Success rate"
          value={successPct}
          caption={
            totals.successRate === null
              ? 'no jobs yet'
              : 'completed / (completed + failed + dead)'
          }
          tone={successTone}
        />
      </div>

      <div className="text-xs text-flow-dim">
        Numbers refresh every 5s from the API. Job-state cards update in
        real time via WebSocket — open the “Jobs Live Feed” tab to watch
        them change.
      </div>
    </div>
  );
}
