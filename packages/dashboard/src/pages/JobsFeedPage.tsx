import { useEffect, useMemo, useRef, useState } from 'react';

import { JobStatus } from '../api/types';
import type { Job, QueueStats } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { MonoId } from '../components/MonoId';
import { StatusBadge } from '../components/StatusBadge';
import {
  EmptyRow,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '../components/Table';

interface JobsFeedPageProps {
  jobs: Job[];
  queueStats: Record<string, QueueStats>;
}

/**
 * The "what's happening right now" tab. The whole tab is a single
 * derived view of the `jobs` list maintained by `useFlowQSocket` —
 * filter + render. Selecting a row opens a side panel with the full
 * job object.
 *
 * Two UX touches matter:
 *
 *   1. Auto-scroll to top: the list is newest-first, so a freshly
 *      arrived job pushes everything down. We ONLY snap to top when the
 *      user is already at the top — if they've scrolled into history,
 *      we leave them there. This is the same behaviour every chat app
 *      uses, and it's the correct default.
 *
 *   2. Pause-scroll: explicit toggle to opt out of auto-scroll
 *      entirely. Useful when the operator wants to inspect the most
 *      recent few rows in a fast-moving queue without the list jumping.
 */
export function JobsFeedPage({ jobs, queueStats }: JobsFeedPageProps): JSX.Element {
  const [queueFilter, setQueueFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const queueOptions = useMemo(
    () => Object.keys(queueStats).sort(),
    [queueStats],
  );

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (queueFilter && j.queueName !== queueFilter) return false;
      if (statusFilter && j.status !== statusFilter) return false;
      return true;
    });
  }, [jobs, queueFilter, statusFilter]);

  // Snap to top on new arrivals UNLESS the user is paused or scrolled
  // away from the top. Threshold is generous (50px) so micro-scrolls
  // don't accidentally lock the list.
  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el === null) return;
    if (el.scrollTop > 50) return;
    el.scrollTop = 0;
  }, [filtered, paused]);

  const selectedJob = selectedId === null ? null : jobs.find((j) => j.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
      <Card noPad className="overflow-hidden">
        <Toolbar
          queueFilter={queueFilter}
          statusFilter={statusFilter}
          paused={paused}
          queues={queueOptions}
          onQueueChange={setQueueFilter}
          onStatusChange={setStatusFilter}
          onTogglePause={() => setPaused((p) => !p)}
          shown={filtered.length}
          total={jobs.length}
        />

        <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
          <Table>
            <THead>
              <tr>
                <TH>Job ID</TH>
                <TH>Queue</TH>
                <TH>Status</TH>
                <TH>Worker</TH>
                <TH className="text-right">Duration</TH>
                <TH>Updated</TH>
              </tr>
            </THead>
            <TBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={6}>
                  {jobs.length === 0
                    ? 'waiting for events…'
                    : 'no jobs match current filters'}
                </EmptyRow>
              ) : (
                filtered.map((j) => (
                  <TR
                    key={j.id}
                    clickable
                    highlighted={j.id === selectedId}
                    onClick={() => setSelectedId(j.id)}
                  >
                    <TD>
                      <MonoId id={j.id} />
                    </TD>
                    <TD className="font-mono text-xs text-flow-text">{j.queueName}</TD>
                    <TD>
                      <StatusBadge status={j.status} size="sm" />
                    </TD>
                    <TD className="font-mono text-xs text-flow-dim">
                      {j.workerId === null ? '—' : truncWorker(j.workerId)}
                    </TD>
                    <TD className="text-right font-mono text-xs tabular-nums text-flow-dim">
                      {formatDuration(j)}
                    </TD>
                    <TD className="font-mono text-xs text-flow-dim tabular-nums">
                      {fmtClock(latestTimestamp(j))}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </div>
      </Card>

      <JobDetailPanel job={selectedJob} onClose={() => setSelectedId(null)} />
    </div>
  );
}

interface ToolbarProps {
  queueFilter: string;
  statusFilter: string;
  paused: boolean;
  queues: string[];
  shown: number;
  total: number;
  onQueueChange: (q: string) => void;
  onStatusChange: (s: string) => void;
  onTogglePause: () => void;
}

function Toolbar({
  queueFilter,
  statusFilter,
  paused,
  queues,
  shown,
  total,
  onQueueChange,
  onStatusChange,
  onTogglePause,
}: ToolbarProps): JSX.Element {
  return (
    <div className="px-4 py-3 border-b border-flow-border flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-xs uppercase tracking-wider text-flow-dim">Queue</label>
        <select
          value={queueFilter}
          onChange={(e) => onQueueChange(e.target.value)}
          className="bg-flow-raised border border-flow-border text-sm font-mono px-2 py-1 rounded text-flow-text focus:outline-none focus:shadow-flow-focus"
        >
          <option value="">all</option>
          {queues.map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs uppercase tracking-wider text-flow-dim">Status</label>
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value)}
          className="bg-flow-raised border border-flow-border text-sm font-mono px-2 py-1 rounded text-flow-text focus:outline-none focus:shadow-flow-focus"
        >
          <option value="">all</option>
          {Object.values(JobStatus).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="font-mono text-xs text-flow-dim tabular-nums">
          {shown.toLocaleString()} / {total.toLocaleString()}
        </span>
        <Button size="sm" variant={paused ? 'primary' : 'secondary'} onClick={onTogglePause}>
          {paused ? 'Resume scroll' : 'Pause scroll'}
        </Button>
      </div>
    </div>
  );
}

interface JobDetailPanelProps {
  job: Job | null;
  onClose: () => void;
}

function JobDetailPanel({ job, onClose }: JobDetailPanelProps): JSX.Element {
  if (job === null) {
    return (
      <Card>
        <div className="text-xs text-flow-dim text-center py-12">
          select a job to inspect
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-flow-dim">Job</div>
          <div className="font-mono text-xs text-flow-text break-all mt-0.5">{job.id}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>×</Button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <StatusBadge status={job.status} />
        <span className="font-mono text-xs text-flow-dim">
          attempt {job.attempts} / {job.maxAttempts}
        </span>
      </div>

      <DetailGrid
        rows={[
          ['Queue', <span className="font-mono">{job.queueName}</span>],
          ['Priority', <span className="font-mono tabular-nums">{job.priority}</span>],
          ['Timeout', <span className="font-mono tabular-nums">{job.timeout}s</span>],
          ['Worker', <span className="font-mono text-xs">{job.workerId ?? '—'}</span>],
          ['Created', <span className="font-mono">{fmtClock(job.createdAt)}</span>],
          ['Scheduled', <span className="font-mono">{fmtClock(job.scheduledAt)}</span>],
          ['Started', <span className="font-mono">{job.startedAt === null ? '—' : fmtClock(job.startedAt)}</span>],
          ['Completed', <span className="font-mono">{job.completedAt === null ? '—' : fmtClock(job.completedAt)}</span>],
          ['Failed', <span className="font-mono">{job.failedAt === null ? '—' : fmtClock(job.failedAt)}</span>],
        ]}
      />

      {job.lastError !== null && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-flow-dim mb-1">Last error</div>
          <pre className="font-mono text-xs text-flow-danger bg-flow-bg border border-flow-border rounded p-2 whitespace-pre-wrap break-words">
            {job.lastError}
          </pre>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs uppercase tracking-wider text-flow-dim mb-1">Payload</div>
        <pre className="font-mono text-xs text-flow-text bg-flow-bg border border-flow-border rounded p-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
      </div>
    </Card>
  );
}

function DetailGrid({ rows }: { rows: Array<[string, JSX.Element]> }): JSX.Element {
  return (
    <dl className="mt-4 grid grid-cols-[110px_1fr] gap-y-1.5 text-xs">
      {rows.map(([label, value], idx) => (
        <FragmentRow key={idx} label={label}>{value}</FragmentRow>
      ))}
    </dl>
  );
}

function FragmentRow({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <dt className="text-flow-dim uppercase tracking-wider">{label}</dt>
      <dd className="text-flow-text">{children}</dd>
    </>
  );
}

function truncWorker(workerId: string): string {
  // Worker IDs look like worker-host-pid-ts; the pid+ts tail is the
  // unique part. Show the trailing 12 chars.
  return workerId.length <= 14 ? workerId : `…${workerId.slice(-12)}`;
}

function latestTimestamp(j: Job): number {
  return j.completedAt ?? j.failedAt ?? j.startedAt ?? j.createdAt;
}

function formatDuration(j: Job): string {
  const start = j.startedAt;
  const end = j.completedAt ?? j.failedAt;
  if (start === null) return '—';
  const ms = (end ?? Date.now()) - start;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  return time;
}
