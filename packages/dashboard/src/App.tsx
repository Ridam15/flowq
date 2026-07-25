import { useMemo, useState } from 'react';

import { ConnectionDot } from './components/ConnectionDot';
import { Tabs } from './components/Tabs';
import type { TabDef } from './components/Tabs';
import { useFlowQSocket } from './hooks/useFlowQSocket';
import { useRollingStats } from './hooks/useRollingStats';
import { DLQPage } from './pages/DLQPage';
import { JobsFeedPage } from './pages/JobsFeedPage';
import { OverviewPage } from './pages/OverviewPage';
import { QueuesPage } from './pages/QueuesPage';
import { WorkersPage } from './pages/WorkersPage';

type TabKey = 'overview' | 'queues' | 'feed' | 'workers' | 'dlq';

/**
 * Top-level app shell.
 *
 * One persistent WebSocket lives at this level (via useFlowQSocket) and
 * its derived state is threaded into the relevant pages. Mounting the
 * socket here — rather than inside each tab — guarantees:
 *
 *   • Switching tabs doesn't drop the connection.
 *   • Background tabs still receive events, so re-entering the Live
 *     Feed shows accurate recent state.
 *
 * Tab routing is plain React state (no react-router). The dashboard is
 * a single deep-linked URL and we don't need history support — adding
 * routing would be cargo cult.
 */
export default function App(): JSX.Element {
  const socket = useFlowQSocket();
  const { series } = useRollingStats(socket.queueStats, socket.lastStatsAt);

  const [tab, setTab] = useState<TabKey>('overview');
  // When the user clicks "View DLQ" on a queue card, we jump to the
  // DLQ tab AND preselect that queue. This piece of cross-tab state is
  // held here, in the only common ancestor.
  const [pendingDlqQueue, setPendingDlqQueue] = useState<string | null>(null);

  const tabs = useMemo<TabDef<TabKey>[]>(
    () => [
      { key: 'overview', label: 'Overview' },
      {
        key: 'queues',
        label: 'Queues',
        badge: Object.keys(socket.queueStats).length || undefined,
      },
      {
        key: 'feed',
        label: 'Jobs Live Feed',
        badge: socket.jobs.length || undefined,
      },
      { key: 'workers', label: 'Workers' },
      { key: 'dlq', label: 'DLQ' },
    ],
    [socket.queueStats, socket.jobs.length],
  );

  const handleShowDlq = (queueName: string): void => {
    setPendingDlqQueue(queueName);
    setTab('dlq');
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        connectionStatus={socket.connectionStatus}
        reconnectAttempts={socket.reconnectAttempts}
        connectedClients={socket.connectedClients}
      />

      <div className="px-6 pt-2">
        <Tabs<TabKey> tabs={tabs} active={tab} onChange={setTab} />
      </div>

      <main className="flex-1 px-6 py-6">
        {tab === 'overview' && <OverviewPage queueStats={socket.queueStats} />}
        {tab === 'queues' && (
          <QueuesPage
            queueStats={socket.queueStats}
            series={series}
            onShowDlq={handleShowDlq}
          />
        )}
        {tab === 'feed' && (
          <JobsFeedPage jobs={socket.jobs} queueStats={socket.queueStats} />
        )}
        {tab === 'workers' && <WorkersPage />}
        {tab === 'dlq' && (
          <DLQPage queueStats={socket.queueStats} initialQueue={pendingDlqQueue} />
        )}
      </main>

      <Footer />
    </div>
  );
}

interface HeaderProps {
  connectionStatus: ReturnType<typeof useFlowQSocket>['connectionStatus'];
  reconnectAttempts: number;
  connectedClients: number;
}

function Header({
  connectionStatus,
  reconnectAttempts,
  connectedClients,
}: HeaderProps): JSX.Element {
  return (
    <header className="px-6 pt-5 pb-2 flex items-end justify-between border-b border-flow-border/0">
      <div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-2xl font-semibold tracking-tight text-flow-text">
            flowq
          </span>
          <span className="text-xs uppercase tracking-[0.2em] text-flow-dim">
            control plane
          </span>
        </div>
        <div className="mt-1 text-xs text-flow-dim font-mono">
          distributed task queue · v0.1.0
        </div>
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono text-xs text-flow-dim">
          {connectedClients} dashboard{connectedClients === 1 ? '' : 's'} connected
        </span>
        <ConnectionDot
          status={connectionStatus}
          reconnectAttempts={reconnectAttempts}
        />
      </div>
    </header>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="px-6 py-4 border-t border-flow-border text-xs text-flow-dim font-mono flex items-center justify-between">
      <span>flowq · built for SREs</span>
      <span>
        REST + WebSocket · all times local · click any ID to copy
      </span>
    </footer>
  );
}
