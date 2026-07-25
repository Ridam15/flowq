import { useEffect, useState } from 'react';

/**
 * Live "X seconds ago" label.
 *
 * Re-renders every second so the value stays current without forcing
 * the parent to re-render on every tick. Each instance owns its own
 * interval; for hundreds of rows this is still cheap (interval handlers
 * are O(rows) per second on a modern browser).
 *
 * Color thresholds are encoded here, not in the consumer:
 *   • > warnSeconds (default 8s) → amber
 *   • > dangerSeconds (default 12s) → red
 *
 * Pass `colored={false}` to opt out of coloring (e.g. for "started 5s
 * ago" labels where the color would be misleading).
 */
interface RelativeTimeProps {
  /** Unix epoch ms, or null to render an em-dash. */
  ts: number | null;
  colored?: boolean;
  warnSeconds?: number;
  dangerSeconds?: number;
  className?: string;
}

export function RelativeTime({
  ts,
  colored = false,
  warnSeconds = 8,
  dangerSeconds = 12,
  className = '',
}: RelativeTimeProps): JSX.Element {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (ts === null) {
    return <span className={`text-flow-dim ${className}`}>—</span>;
  }

  const ageSec = Math.max(0, Math.round((now - ts) / 1000));
  const tone = !colored
    ? 'text-flow-dim'
    : ageSec >= dangerSeconds
      ? 'text-flow-danger'
      : ageSec >= warnSeconds
        ? 'text-flow-warn'
        : 'text-flow-success';

  return (
    <span className={`font-mono tabular-nums ${tone} ${className}`}>
      {formatRelative(ageSec)}
    </span>
  );
}

function formatRelative(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`;
  const h = Math.floor(ageSec / 3600);
  const m = Math.floor((ageSec % 3600) / 60);
  return `${h}h ${m}m ago`;
}
