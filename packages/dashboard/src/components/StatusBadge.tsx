import { JobStatus } from '../api/types';

/**
 * Single source of truth for status-to-color mapping. Used by every
 * table, every list, every detail panel — so a status change anywhere
 * looks the same as a status change anywhere else.
 */
const STATUS_STYLES: Record<JobStatus, { bg: string; fg: string; label: string }> = {
  [JobStatus.PENDING]:   { bg: 'bg-flow-accent/15',  fg: 'text-flow-accent',  label: 'PENDING' },
  [JobStatus.ACTIVE]:    { bg: 'bg-flow-warn/15',    fg: 'text-flow-warn',    label: 'ACTIVE' },
  [JobStatus.COMPLETED]: { bg: 'bg-flow-success/15', fg: 'text-flow-success', label: 'COMPLETED' },
  [JobStatus.FAILED]:    { bg: 'bg-flow-danger/15',  fg: 'text-flow-danger',  label: 'FAILED' },
  [JobStatus.DEAD]:      { bg: 'bg-flow-danger/30',  fg: 'text-flow-danger',  label: 'DEAD' },
};

interface StatusBadgeProps {
  status: JobStatus | string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps): JSX.Element {
  const known = (Object.values(JobStatus) as string[]).includes(status as string);
  const styles = known
    ? STATUS_STYLES[status as JobStatus]
    : { bg: 'bg-flow-mute/20', fg: 'text-flow-dim', label: String(status) };

  const sizing = size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';

  return (
    <span
      className={`${styles.bg} ${styles.fg} ${sizing} font-mono font-medium rounded uppercase tracking-wider inline-block`}
    >
      {styles.label}
    </span>
  );
}
