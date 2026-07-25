import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  children: ReactNode;
}

/**
 * Single Button component covering every clickable action in the app.
 * The variants encode INTENT, not just color — so pages stay consistent
 * (e.g. "destructive" = `danger` variant everywhere; never primary).
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
    primary:
      'bg-flow-success/20 text-flow-success border border-flow-success/40 ' +
      'hover:bg-flow-success/30',
    secondary:
      'bg-flow-raised text-flow-text border border-flow-border ' +
      'hover:bg-flow-border',
    danger:
      'bg-flow-danger/15 text-flow-danger border border-flow-danger/40 ' +
      'hover:bg-flow-danger/25',
    ghost:
      'bg-transparent text-flow-dim border border-transparent ' +
      'hover:text-flow-text hover:bg-flow-raised',
  };

  return (
    <button
      type="button"
      className={
        `inline-flex items-center gap-1.5 font-medium rounded ${sizing} ${variants[variant]} ` +
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-flow-accent ' +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
}
