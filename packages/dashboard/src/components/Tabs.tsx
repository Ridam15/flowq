import type { ReactNode } from 'react';

export interface TabDef<TKey extends string = string> {
  key: TKey;
  label: string;
  /** Optional small badge / count to render next to the label. */
  badge?: ReactNode;
}

interface TabsProps<TKey extends string> {
  tabs: TabDef<TKey>[];
  active: TKey;
  onChange: (key: TKey) => void;
}

/**
 * Tab strip with bottom border indicator. Keyboard-accessible
 * (Tab/Enter/Space) — every clickable element in this app is also a
 * focusable button so SREs can navigate without a mouse.
 */
export function Tabs<TKey extends string>({
  tabs,
  active,
  onChange,
}: TabsProps<TKey>): JSX.Element {
  return (
    <div
      className="flex items-center gap-1 border-b border-flow-border"
      role="tablist"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={
              'relative px-4 py-3 text-sm font-medium transition-colors ' +
              'focus:outline-none focus-visible:text-flow-accent ' +
              (isActive
                ? 'text-flow-text'
                : 'text-flow-dim hover:text-flow-text')
            }
          >
            <span className="inline-flex items-center gap-2">
              {t.label}
              {t.badge !== undefined && t.badge !== null && (
                <span className="text-flow-dim font-mono text-xs">{t.badge}</span>
              )}
            </span>
            {isActive && (
              <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-flow-success" />
            )}
          </button>
        );
      })}
    </div>
  );
}
