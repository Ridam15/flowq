/**
 * Typed REST client for the FlowQ control-plane API.
 *
 * Why a hand-rolled fetch wrapper instead of axios / openapi-fetch / etc?
 *
 *   • The API surface is small (≈10 endpoints). Pulling in a client
 *     library would 3x our bundle for no real ergonomic gain.
 *   • Native fetch gets us streaming, abort-signals, and credentials
 *     handling for free in evergreen browsers.
 *   • A 30-line wrapper makes it trivial to centralise auth, base URL,
 *     and error handling — and it stays testable with `globalThis.fetch`
 *     stubbing.
 *
 * Error model:
 *   The API returns JSON `{ error: string, … }` on every non-2xx. We
 *   surface that as a typed `ApiError` so React Query's `error` is
 *   meaningful in component code (`error.status`, `error.body`).
 */
import { API_KEY, API_URL } from '../config';

import type {
  DlqPage,
  HealthResponse,
  Job,
  QueueStats,
  WorkerInfo,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the bearer token for /health, /metrics. */
  noAuth?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, noAuth = false } = opts;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!noAuth) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  // Distinguish JSON-bodied responses from empty / HTML errors. The
  // server promises JSON, but a misconfigured proxy could insert HTML.
  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const message =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, parsed, message);
  }

  return parsed as T;
}

/* ============================================================================
 * Endpoints
 *
 * One named export per endpoint — flat, easy to grep, easy to mock in
 * tests. We don't bundle them into a class because there's no shared
 * state and React Query's `queryFn` plays best with bare functions.
 * ============================================================================ */

export const api = {
  // --- Ops (no auth) -----------------------------------------------------
  health: (signal?: AbortSignal): Promise<HealthResponse> =>
    request<HealthResponse>('/health', { noAuth: true, signal }),

  // --- Jobs --------------------------------------------------------------
  getJob: (id: string, signal?: AbortSignal): Promise<Job> =>
    request<Job>(`/jobs/${encodeURIComponent(id)}`, { signal }),

  cancelJob: (id: string): Promise<{ message: string; jobId: string }> =>
    request(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Queues ------------------------------------------------------------
  queueStats: (name: string, signal?: AbortSignal): Promise<QueueStats> =>
    request<QueueStats>(`/queues/${encodeURIComponent(name)}/stats`, { signal }),

  pauseQueue: (name: string): Promise<{ message: string; queueName: string }> =>
    request(`/queues/${encodeURIComponent(name)}/pause`, { method: 'POST' }),

  resumeQueue: (name: string): Promise<{ message: string; queueName: string }> =>
    request(`/queues/${encodeURIComponent(name)}/resume`, { method: 'POST' }),

  listDlq: (
    name: string,
    page = 1,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<DlqPage> => {
    const qs = `?page=${page}&limit=${limit}`;
    return request<DlqPage>(
      `/queues/${encodeURIComponent(name)}/dlq${qs}`,
      { signal },
    );
  },

  retryDeadJob: (
    queue: string,
    jobId: string,
  ): Promise<{ message: string; newJobId: string; originalJobId: string }> =>
    request(
      `/queues/${encodeURIComponent(queue)}/dlq/${encodeURIComponent(jobId)}/retry`,
      { method: 'POST' },
    ),

  // --- Workers -----------------------------------------------------------
  listWorkers: (signal?: AbortSignal): Promise<{ workers: WorkerInfo[] }> =>
    request<{ workers: WorkerInfo[] }>(`/workers`, { signal }),
};
