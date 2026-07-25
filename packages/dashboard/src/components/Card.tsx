import type { ReactNode } from 'react';

/**
 * The single primitive every panel in the dashboard composes from.
 *
 * We bake in the surface color, border, and rounded corners here so the
 * caller never has to remember the exact Tailwind tokens — and a
 * future palette change is one-edit.
 */
interface CardProps {
  children: ReactNode;
  className?: string;
  /** Removes the inner padding for full-bleed content (e.g. tables). */
  noPad?: boolean;
}

export function Card({ children, className = '', noPad = false }: CardProps): JSX.Element {
  const pad = noPad ? '' : 'p-5';
  return (
    <div
      className={`bg-flow-surface border border-flow-border rounded-lg ${pad} ${className}`}
    >
      {children}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  /** Single-line caption under the value. */
  caption?: string;
  /** Color the value text — defaults to primary. */
  tone?: 'default' | 'success' | 'warn' | 'danger' | 'accent';
  /** Optional trailing icon / glyph element. */
  trailing?: ReactNode;
}

export function StatCard({
  label,
  value,
  caption,
  tone = 'default',
  trailing,
}: StatCardProps): JSX.Element {
  const toneClass = {
    default: 'text-flow-text',
    success: 'text-flow-success',
    warn: 'text-flow-warn',
    danger: 'text-flow-danger',
    accent: 'text-flow-accent',
  }[tone];

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div className="text-xs uppercase tracking-wider text-flow-dim">{label}</div>
        {trailing !== undefined && <div>{trailing}</div>}
      </div>
      <div className={`mt-3 font-mono text-3xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {caption !== undefined && (
        <div className="mt-1 text-xs text-flow-dim">{caption}</div>
      )}
    </Card>
  );
}
