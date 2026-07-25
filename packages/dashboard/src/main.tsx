import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './index.css';

/**
 * Root bootstrap.
 *
 * One QueryClient for the whole app. The defaults below are tuned for
 * an operations dashboard:
 *
 *   • staleTime: 0          — list data should reflect reality, not
 *                              cache. We rely on `refetchInterval` per
 *                              query for cadence, not staleness.
 *   • retry: 2              — APIs flap during deploys; a couple of
 *                              quiet retries on a 5xx are friendlier
 *                              than a red error banner.
 *   • refetchOnWindowFocus  — true. Switching back from another tab
 *                              should snap the data forward.
 *   • refetchOnReconnect    — true. The dashboard shouldn't sit on
 *                              stale data if the network blipped.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 2,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
