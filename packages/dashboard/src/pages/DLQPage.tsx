import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, api } from '../api/client';
import type { QueueStats } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { MonoId } from '../components/MonoId';
import {
  EmptyRow,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '../components/Table';

interface DLQPageProps {
  queueStats: Record<string, QueueStats>;
  /** Optional preselect from "View DLQ" button on Queues tab. */
  initialQueue?: string | null;
}

const PAGE_SIZE = 20;

/**
 * Dead-letter queue browser. The DLQ lives entirely in Postgres (Redis
 * has long since released the job), so this is REST-only — no live
 * stream. We refetch on retry success and let the operator paginate.
 */
export function DLQPage({ queueStats, initialQueue = null }: DLQPageProps): JSX.Element {
  const queueOptions = Object.keys(queueStats).sort();
  const [queueName, setQueueName] = useState<string>(
    initialQueue ?? queueOptions[0] ?? '',
  );
  const [page, setPage] = useState(1);

  const dlqQuery = useQuery({
    queryKey: ['dlq', queueName, page],
    queryFn: ({ signal }) => api.listDlq(queueName, page, PAGE_SIZE, signal),
    enabled: queueName.length > 0,
  });

  const data = dlqQuery.data;
  const totalPages = data === undefined ? 1 : Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <Card noPad>
      <div className="px-4 py-3 border-b border-flow-border flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-flow-text">Dead-letter queue</h2>
          <div className="text-xs text-flow-dim mt-0.5">
            {data === undefined
              ? 'loading…'
              : `${data.total.toLocaleString()} dead jobs · page ${page} of ${totalPages}`}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-flow-dim">Queue</label>
          <select
            value={queueName}
            onChange={(e) => {
              setQueueName(e.target.value);
              setPage(1);
            }}
            className="bg-flow-raised border border-flow-border text-sm font-mono px-2 py-1 rounded text-flow-text focus:outline-none focus:shadow-flow-focus"
          >
            {queueOptions.length === 0 && <option value="">(no queues)</option>}
            {queueOptions.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
        </div>
      </div>

      <Table>
        <THead>
          <tr>
            <TH>Job ID</TH>
            <TH>Last error</TH>
            <TH className="text-right">Attempts</TH>
            <TH>Died at</TH>
            <TH>State</TH>
            <TH className="text-right">Action</TH>
          </tr>
        </THead>
        <TBody>
          {dlqQuery.isError ? (
            <EmptyRow colSpan={6}>
              <span className="text-flow-danger">
                error: {(dlqQuery.error as Error).message}
              </span>
            </EmptyRow>
          ) : data === undefined ? (
            <EmptyRow colSpan={6}>loading…</EmptyRow>
          ) : data.jobs.length === 0 ? (
            <EmptyRow colSpan={6}>
              <span className="text-flow-success">no dead jobs in {queueName}</span>
            </EmptyRow>
          ) : (
            data.jobs.map((row) => (
              <DLQRow key={row.id} row={row} queueName={queueName} />
            ))
          )}
        </TBody>
      </Table>

      <div className="px-4 py-3 border-t border-flow-border flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={page <= 1 || dlqQuery.isLoading}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← Prev
        </Button>
        <span className="font-mono text-xs text-flow-dim tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={page >= totalPages || dlqQuery.isLoading}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </Button>
      </div>
    </Card>
  );
}

interface DLQRowProps {
  row: import('../api/types').DeadLetterRow;
  queueName: string;
}

function DLQRow({ row, queueName }: DLQRowProps): JSX.Element {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryDeadJob(queueName, row.jobId),
    // On success the row should disappear from this list (manually_retried
    // flips true and we filter on it server-side via the SELECT logic that
    // returns it but flagged). Refetching the page is the simplest correct
    // behaviour and keeps pagination consistent.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['dlq', queueName] });
    },
  });

  const errMsg = retry.error instanceof ApiError ? retry.error.message : null;

  return (
    <TR>
      <TD>
        <MonoId id={row.jobId} />
      </TD>
      <TD className="font-mono text-xs text-flow-danger truncate max-w-[300px]" >
        <span title={row.lastError ?? ''}>{row.lastError ?? '—'}</span>
      </TD>
      <TD className="text-right font-mono text-xs tabular-nums text-flow-text">
        {row.attempts}
      </TD>
      <TD className="font-mono text-xs text-flow-dim tabular-nums">
        {row.diedAt === null ? '—' : new Date(row.diedAt).toLocaleString()}
      </TD>
      <TD>
        {row.manuallyRetried ? (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-flow-accent/15 text-flow-accent">
            retried
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-flow-danger/20 text-flow-danger">
            dead
          </span>
        )}
      </TD>
      <TD className="text-right">
        <div className="inline-flex flex-col items-end gap-1">
          <Button
            size="sm"
            variant="primary"
            disabled={row.manuallyRetried || retry.isPending}
            onClick={() => retry.mutate()}
          >
            {retry.isPending ? 'retrying…' : 'Retry'}
          </Button>
          {errMsg !== null && (
            <span className="text-[10px] text-flow-danger font-mono">{errMsg}</span>
          )}
        </div>
      </TD>
    </TR>
  );
}
