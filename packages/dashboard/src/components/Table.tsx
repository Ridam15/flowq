import type { ReactNode } from 'react';

/**
 * Bare table primitives — semantic HTML table (not a div grid) so
 * screen readers and copy/paste work correctly. Tailwind-only styling.
 */

interface TableProps {
  children: ReactNode;
  className?: string;
}

export function Table({ children, className = '' }: TableProps): JSX.Element {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }): JSX.Element {
  return (
    <thead className="text-xs uppercase tracking-wider text-flow-dim border-b border-flow-border">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }): JSX.Element {
  return <tbody>{children}</tbody>;
}

interface TRProps {
  children: ReactNode;
  /** When true, the row gets hover + cursor-pointer styling. */
  clickable?: boolean;
  onClick?: () => void;
  highlighted?: boolean;
}

export function TR({
  children,
  clickable = false,
  onClick,
  highlighted = false,
}: TRProps): JSX.Element {
  const base = 'border-b border-flow-border/50 transition-colors';
  const interactive = clickable ? 'cursor-pointer hover:bg-flow-raised' : '';
  const highlight = highlighted ? 'bg-flow-raised' : '';
  return (
    <tr
      className={`${base} ${interactive} ${highlight}`}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function TH({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <th className={`text-left font-medium px-3 py-2 ${className}`}>{children}</th>;
}

export function TD({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}

/** Convenience: empty-state cell that spans the whole row. */
interface EmptyRowProps {
  colSpan: number;
  children: ReactNode;
}

export function EmptyRow({ colSpan, children }: EmptyRowProps): JSX.Element {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-8 text-center text-flow-dim text-sm"
      >
        {children}
      </td>
    </tr>
  );
}
