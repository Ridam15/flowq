import type { ConnectionStatus } from '../hooks/useFlowQSocket';

/**
 * Tiny pulsing dot + label that lives in the header and tells the
 * operator whether the dashboard is actually receiving live data.
 *
 * Three states map cleanly to the three colors:
 *   open         → green pulse        ("LIVE")
 *   connecting   → amber static       ("connecting…")
 *   reconnecting → amber pulse        ("retry #N")
 *   closed       → red static         ("disconnected")
 *
 * No spinner, no progress bar — the pulse animation is enough signal
 * for an SRE glance.
 */
interface ConnectionDotProps {
  status: ConnectionStatus;
  reconnectAttempts: number;
}

export function ConnectionDot({
  status,
  reconnectAttempts,
}: ConnectionDotProps): JSX.Element {
  const styles = {
    open: { color: 'bg-flow-success', label: 'LIVE', pulse: true },
    connecting: { color: 'bg-flow-warn', label: 'connecting…', pulse: false },
    reconnecting: {
      color: 'bg-flow-warn',
      label: `retry #${reconnectAttempts}`,
      pulse: true,
    },
    closed: { color: 'bg-flow-danger', label: 'disconnected', pulse: false },
  }[status];

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className={
          `inline-block w-2 h-2 rounded-full ${styles.color} ` +
          (styles.pulse ? 'animate-pulse-dot' : '')
        }
      />
      <span className="font-mono text-xs uppercase tracking-wider text-flow-dim">
        {styles.label}
      </span>
    </div>
  );
}
