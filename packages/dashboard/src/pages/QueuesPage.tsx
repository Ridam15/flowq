import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { api } from '../api/client';
import type { QueueStats } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import type { RollingDatapoint } from '../hooks/useRollingStats';

interface QueuesPageProps {
  queueStats: Record<string, QueueStats>;
  series: Record<string, RollingDatapoint[]>;
  onShowDlq: (queueName: string) => void;
}

/**
 * Per-queue control + chart strip.
 *
 * One Card per queue. Cards are alphabetically sorted so the layout
 * stays stable as new queues appear (avoid the dashboard "shuffling"
 * underneath the operator's pointer).
 */
export function QueuesPage({
  queueStats,
  series,
  onShowDlq,
}: QueuesPageProps): JSX.Element {
  const queueNames = Object.keys(queueStats).sort();

  if (queueNames.length === 0) {
    return (
      <Card>
        <div className="text-center py-12 text-flow-dim text-sm">
          No queues registered yet. Enqueue a job and it'll appear here.
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {queueNames.map((name) => (
        <QueueCard
          key={name}
          stats={queueStats[name]}
          datapoints={series[name] ?? []}
          onShowDlq={() => onShowDlq(name)}
        />
      ))}
    </div>
  );
}

interface QueueCardProps {
  stats: QueueStats;
  datapoints: RollingDatapoint[];
  onShowDlq: () => void;
}

function QueueCard({ stats, datapoints, onShowDlq }: QueueCardProps): JSX.Element {
  const qc = useQueryClient();

  // We invalidate the workers query on pause/resume mostly so the
  // dashboard refreshes immediately rather than waiting for the next
  // 5s refetch tick — pause/resume affects worker `status: idle/busy`
  // distribution.
  const pauseMutation = useMutation({
    mutationFn: () => api.pauseQueue(stats.queueName),
    onSettled: () => qc.invalidateQueries({ queryKey: ['workers'] }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.resumeQueue(stats.queueName),
    onSettled: () => qc.invalidateQueries({ queryKey: ['workers'] }),
  });

  const isMutating = pauseMutation.isPending || resumeMutation.isPending;

  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-sm font-medium text-flow-text">{stats.queueName}</h3>
            <StatusPill paused={stats.paused} />
          </div>
          <div className="mt-1 text-xs text-flow-dim">
            <span className="font-mono tabular-nums text-flow-text">{stats.currentPending}</span>{' '}
            pending ·{' '}
            <span className="font-mono tabular-nums text-flow-text">{stats.currentActive}</span>{' '}
            active ·{' '}
            <span className="font-mono tabular-nums text-flow-success">{stats.completed}</span>{' '}
            completed ·{' '}
            <span className="font-mono tabular-nums text-flow-danger">{stats.dead}</span>{' '}
            dead
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {stats.paused ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => resumeMutation.mutate()}
              disabled={isMutating}
            >
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => pauseMutation.mutate()}
              disabled={isMutating}
            >
              Pause
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onShowDlq}>
            View DLQ
          </Button>
        </div>
      </div>

      <div className="mt-4 h-44 w-full min-w-0 -mx-1">
        {datapoints.length < 2 ? (
          <div className="h-full flex items-center justify-center text-xs text-flow-dim">
            collecting samples…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} debounce={50}>
            <LineChart
              data={datapoints}
              margin={{ top: 6, right: 8, bottom: 0, left: -16 }}
            >
              <CartesianGrid stroke="#262b3d" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={fmtClock}
                stroke="#3a4055"
                tick={{ fill: '#8b93ad', fontSize: 10 }}
              />
              <YAxis
                stroke="#3a4055"
                tick={{ fill: '#8b93ad', fontSize: 10 }}
                allowDecimals={false}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: '#151823',
                  border: '1px solid #262b3d',
                  borderRadius: 6,
                  fontSize: 12,
                  color: '#e2e6f3',
                }}
                labelFormatter={(v) => fmtClock(Number(v))}
                formatter={(value, name) => [
                  typeof value === 'number' ? value.toFixed(1) : String(value),
                  String(name),
                ]}
              />
              <Line
                type="monotone"
                dataKey="enqueuedRate"
                name="enqueue/min"
                stroke="#5e8cff"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="completedRate"
                name="complete/min"
                stroke="#00ff88"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-2 flex items-center gap-4 text-[10px] uppercase tracking-wider text-flow-dim">
        <LegendDot color="#5e8cff" label="enqueue/min" />
        <LegendDot color="#00ff88" label="complete/min" />
        <span className="ml-auto font-mono">10-min rolling window</span>
      </div>
    </Card>
  );
}

function StatusPill({ paused }: { paused: boolean }): JSX.Element {
  if (paused) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-flow-warn/15 text-flow-warn">
        paused
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-flow-success/15 text-flow-success">
      active
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}
