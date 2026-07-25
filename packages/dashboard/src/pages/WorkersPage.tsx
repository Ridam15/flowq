import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { Card } from '../components/Card';
import { MonoId } from '../components/MonoId';
import { RelativeTime } from '../components/RelativeTime';
import {
  EmptyRow,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '../components/Table';

/**
 * Worker fleet view. Pulled from REST every 5s — the worker registry
 * doesn't have a real-time event channel (it's polled state, not
 * transitional events) and 5s is fast enough for "did a worker just
 * crash?" detection.
 *
 * Heartbeat-age coloring is the operational signal here:
 *   • < 8s  → green   (healthy)
 *   • 8-12s → amber   (stalled, may be GC'ing or recovering)
 *   • > 12s → red     (almost certainly dead, watchdog reaping soon)
 *
 * The watchdog uses a default heartbeat timeout of 15s, so red here
 * means "this worker is on borrowed time".
 */
export function WorkersPage(): JSX.Element {
  const workersQuery = useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => api.listWorkers(signal),
    refetchInterval: 5_000,
  });

  if (workersQuery.isError) {
    return (
      <Card>
        <div className="text-flow-danger text-sm">
          Failed to fetch workers: {(workersQuery.error as Error).message}
        </div>
      </Card>
    );
  }

  const workers = workersQuery.data?.workers ?? [];

  return (
    <Card noPad>
      <div className="px-4 py-3 border-b border-flow-border flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-flow-text">Workers</h2>
          <div className="text-xs text-flow-dim mt-0.5">
            polled every 5s · {workers.length} registered
          </div>
        </div>
      </div>
      <Table>
        <THead>
          <tr>
            <TH>Worker ID</TH>
            <TH>Queue</TH>
            <TH>Status</TH>
            <TH>Heartbeat</TH>
            <TH>Current Job</TH>
            <TH>Started</TH>
          </tr>
        </THead>
        <TBody>
          {workers.length === 0 ? (
            <EmptyRow colSpan={6}>
              {workersQuery.isLoading ? 'loading…' : 'no workers connected'}
            </EmptyRow>
          ) : (
            workers.map((w) => (
              <TR key={w.id}>
                <TD>
                  <MonoId id={w.id} visible={20} />
                </TD>
                <TD className="font-mono text-xs text-flow-text">{w.queue ?? '—'}</TD>
                <TD>
                  <WorkerStatusPill status={w.status} />
                </TD>
                <TD>
                  <RelativeTime ts={w.lastHeartbeat} colored />
                </TD>
                <TD>
                  {w.currentJobId === null ? (
                    <span className="text-flow-dim">—</span>
                  ) : (
                    <MonoId id={w.currentJobId} />
                  )}
                </TD>
                <TD className="font-mono text-xs text-flow-dim tabular-nums">
                  {w.startedAt === null ? '—' : new Date(w.startedAt).toLocaleTimeString()}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </Card>
  );
}

function WorkerStatusPill({ status }: { status: 'idle' | 'busy' | 'unknown' }): JSX.Element {
  const styles = {
    idle: 'bg-flow-success/15 text-flow-success',
    busy: 'bg-flow-accent/15 text-flow-accent',
    unknown: 'bg-flow-mute/20 text-flow-dim',
  }[status];
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${styles}`}>
      {status}
    </span>
  );
}
