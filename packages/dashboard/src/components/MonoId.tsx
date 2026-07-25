import { useState } from 'react';

/**
 * Truncated monospace ID with click-to-copy.
 *
 * UUIDs everywhere in this dashboard. Showing the full 36-char string
 * destroys table layouts, but a truncated id with no copy affordance is
 * useless for grepping logs. Click → write to clipboard → flash a
 * "copied!" tooltip → revert. No tooltip library, just a tiny piece of
 * state.
 */
interface MonoIdProps {
  id: string;
  /** How many leading chars to keep. Default 8. */
  visible?: number;
  className?: string;
}

export function MonoId({ id, visible = 8, className = '' }: MonoIdProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const display = id.length > visible ? `${id.slice(0, visible)}…` : id;

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // Browsers without clipboard permission silently fail; not a
        // user-actionable error.
      });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? 'copied' : id}
      className={
        `font-mono text-xs text-flow-dim hover:text-flow-text transition-colors ` +
        `cursor-pointer ${className}`
      }
    >
      {copied ? 'copied' : display}
    </button>
  );
}
