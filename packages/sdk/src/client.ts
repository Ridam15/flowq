/**
 * FlowQClient — the producer-facing client for the FlowQ control plane.
 *
 * Design choices:
 *   • Native `fetch` (Node 18+, Bun, Deno, browsers). No HTTP library
 *     dependency — the SDK is zero-dep.
 *   • Per-request `AbortController` for hard timeouts. Without this,
 *     a hung TCP socket would leak forever; with it, the client returns
 *     a `FlowQNetworkError` after `timeout` ms regardless of TCP state.
 *   • Retry layer wraps every request. Network failures and 5xx are
 *     retried with exponential backoff. 4xx are NEVER retried —
 *     re-sending a malformed request just produces the same 400.
 *   • Strongly typed response parsing. Every method declares its
 *     response shape; the helper centralises JSON parsing + error
 *     mapping so individual methods stay one-liners.
 */

import {
  FlowQError,
  FlowQNetworkError,
  FlowQServerError,
  errorFromResponse,
  type FlowQErrorBody,
} from './errors';
import type {
  DLQResponse,
  DLQRetryResponse,
  EnqueueInput,
  HealthResponse,
  Job,
  QueueStats,
  WorkerInfo,
} from './types';

// ---------------------------------------------------------------------------
// Public client config
// ---------------------------------------------------------------------------

export interface FlowQClientOptions {
  /** Base URL of the FlowQ API, no trailing slash required. */
  baseUrl: string;
  /** Bearer token for the `Authorization` header. */
  apiKey: string;
  /**
   * Default queue name applied when `enqueue()` is called without one.
   * Optional. If unset, callers must pass `queueName` on every call.
   */
  defaultQueueName?: string;
  /** Per-request timeout in ms. Default: 5000. */
  timeout?: number;
  /** Retry policy override. Sensible defaults are baked in. */
  retry?: Partial<RetryPolicy>;
  /**
   * Override the global fetch implementation. Used by tests; production
   * code should leave this alone and rely on the runtime's native
   * fetch. Typed as the platform `fetch` for type safety.
   */
  fetch?: typeof fetch;
}

/**
 * Retry policy applied to every outbound request.
 *
 * Defaults match the spec: max 3 retries (= 4 total attempts), 100ms /
 * 200ms / 400ms exponential backoff. Only network errors and 5xx are
 * retried — 4xx are bugs, not transient issues.
 */
export interface RetryPolicy {
  /** Max number of retries AFTER the initial attempt. Default 3. */
  maxRetries: number;
  /** Backoff in ms for retry attempt N (1-indexed). */
  delayMs: (attempt: number) => number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  delayMs: (attempt) => 100 * Math.pow(2, attempt - 1),
};

const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// FlowQClient
// ---------------------------------------------------------------------------

export class FlowQClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultQueueName: string | undefined;
  private readonly timeout: number;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FlowQClientOptions) {
    if (!options.baseUrl) {
      throw new FlowQError('baseUrl is required', { code: 'invalid_config' });
    }
    if (!options.apiKey) {
      throw new FlowQError('apiKey is required', { code: 'invalid_config' });
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.defaultQueueName = options.defaultQueueName;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    // Bind to globalThis to preserve the implicit `this` of the platform
    // fetch — without the bind, Node's undici fetch throws "illegal
    // invocation" when called as a free function.
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // Job lifecycle
  // -------------------------------------------------------------------------

  /**
   * Enqueue a new job. The `queueName` falls back to
   * `options.defaultQueueName` from the constructor if omitted.
   *
   * Idempotent when `idempotencyKey` is provided — the API returns the
   * pre-existing Job verbatim if it sees the same key within 24h.
   */
  async enqueue<T extends Record<string, unknown> = Record<string, unknown>>(
    options: Partial<EnqueueInput<T>> & { payload: T },
  ): Promise<Job> {
    const queueName = options.queueName ?? this.defaultQueueName;
    if (!queueName) {
      throw new FlowQError(
        'queueName is required (no defaultQueueName configured)',
        { code: 'invalid_config' },
      );
    }
    const body: EnqueueInput<T> = {
      queueName,
      payload: options.payload,
      ...(options.priority !== undefined && { priority: options.priority }),
      ...(options.delay !== undefined && { delay: options.delay }),
      ...(options.maxAttempts !== undefined && { maxAttempts: options.maxAttempts }),
      ...(options.idempotencyKey !== undefined && {
        idempotencyKey: options.idempotencyKey,
      }),
      ...(options.timeout !== undefined && { timeout: options.timeout }),
    };
    return this.request<Job>('POST', '/jobs', { body });
  }

  /** Fetch a job by id. Throws `FlowQNotFoundError` if it doesn't exist. */
  async getJob(jobId: string): Promise<Job> {
    return this.request<Job>('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * Cancel a PENDING job. Throws `FlowQConflictError` if the job has
   * already been claimed by a worker (cancellation is a control-plane
   * action; we never kill in-flight work).
   */
  async cancelJob(jobId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
  }

  // -------------------------------------------------------------------------
  // Queue control
  // -------------------------------------------------------------------------

  /** Read counters and live depths for a queue. */
  async getQueueStats(queueName: string): Promise<QueueStats> {
    return this.request<QueueStats>(
      'GET',
      `/queues/${encodeURIComponent(queueName)}/stats`,
    );
  }

  /**
   * Pause a queue. Idempotent — already-paused queues stay paused.
   * Workers finish their current job, then idle until resume.
   */
  async pauseQueue(queueName: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/queues/${encodeURIComponent(queueName)}/pause`,
    );
  }

  /** Resume a paused queue. Idempotent. */
  async resumeQueue(queueName: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/queues/${encodeURIComponent(queueName)}/resume`,
    );
  }

  // -------------------------------------------------------------------------
  // Dead letter queue
  // -------------------------------------------------------------------------

  /** Page through dead jobs for a queue, newest first. */
  async getDLQ(
    queueName: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<DLQResponse> {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    const path = `/queues/${encodeURIComponent(queueName)}/dlq${qs ? `?${qs}` : ''}`;
    return this.request<DLQResponse>('GET', path);
  }

  /**
   * Re-enqueue a dead job. The new job gets a fresh UUID — we never
   * resurrect the dead job's id (would conflate two distinct execution
   * lifetimes). The link is preserved in `payload.__retried_from`.
   *
   * Returns the newly-enqueued Job, which the caller can immediately
   * track via {@link getJob} or the live event feed.
   */
  async retryDeadJob(queueName: string, jobId: string): Promise<Job> {
    const path = `/queues/${encodeURIComponent(queueName)}/dlq/${encodeURIComponent(jobId)}/retry`;
    const result = await this.request<DLQRetryResponse>('POST', path);
    // The retry endpoint returns { newJobId } not the full Job, so
    // fetch it once more to honour the SDK's `Promise<Job>` contract.
    return this.getJob(result.newJobId);
  }

  // -------------------------------------------------------------------------
  // Workers + health
  // -------------------------------------------------------------------------

  /** List all currently-registered workers. */
  async listWorkers(): Promise<WorkerInfo[]> {
    const result = await this.request<{ workers: WorkerInfo[] }>('GET', '/workers');
    return result.workers;
  }

  /**
   * Liveness check. Does NOT require auth on the server side, but the
   * SDK still sends the Authorization header for symmetry — the server
   * just ignores it on this route.
   */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Single request execution path used by every public method. Handles:
   *   1. URL composition + Authorization header
   *   2. Per-request AbortController + timeout
   *   3. JSON encode/decode
   *   4. Error mapping (HTTP status → typed error class)
   *   5. Retry with exponential backoff for network errors / 5xx
   */
  private async request<TResp>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { body?: unknown } = {},
  ): Promise<TResp> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const init: RequestInit = {
      method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    };

    let lastError: FlowQError | null = null;
    // Total attempts = 1 initial + maxRetries; spec wording is "max 3
    // retries". Loop bounds reflect that.
    const totalAttempts = this.retry.maxRetries + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        return await this.executeOnce<TResp>(url, init);
      } catch (err) {
        if (!(err instanceof FlowQError)) {
          // Should never happen — executeOnce only throws FlowQError
          // subclasses. Wrap defensively.
          lastError = new FlowQError(
            err instanceof Error ? err.message : String(err),
            { cause: err },
          );
        } else {
          lastError = err;
        }

        if (!this.shouldRetry(lastError) || attempt === totalAttempts) {
          throw lastError;
        }
        await sleep(this.retry.delayMs(attempt));
      }
    }
    // Unreachable — the loop either returns or throws — but TS can't
    // prove it without a final throw.
    throw lastError ?? new FlowQError('exhausted retries with no error captured');
  }

  /** A single HTTP attempt. Maps everything to a FlowQError on failure. */
  private async executeOnce<TResp>(url: string, init: RequestInit): Promise<TResp> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      // fetch() rejects on abort, DNS failure, ECONNREFUSED, TLS error,
      // etc. All of these are "we never got a response" → network error.
      const message =
        controller.signal.aborted
          ? `request timed out after ${this.timeout}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new FlowQNetworkError(message, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await safeReadJson(response);
      throw errorFromResponse(response.status, body);
    }

    // 204 No Content (or empty bodies on DELETE) — return undefined as TResp.
    if (response.status === 204) return undefined as TResp;
    const text = await response.text();
    if (text.length === 0) return undefined as TResp;
    try {
      return JSON.parse(text) as TResp;
    } catch (err) {
      throw new FlowQError('failed to parse JSON response', {
        code: 'invalid_response',
        status: response.status,
        cause: err,
      });
    }
  }

  /**
   * Decide whether an error is worth retrying.
   *
   *   • Network errors  → yes (transient transport failures)
   *   • 5xx responses   → yes (server may recover on next try)
   *   • 4xx responses   → NO (re-sending a bad request gets the same
   *                        bad response; just wastes time and
   *                        amplifies load)
   */
  private shouldRetry(err: FlowQError): boolean {
    if (err instanceof FlowQNetworkError) return true;
    if (err instanceof FlowQServerError) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a response body as JSON without throwing. Returns `null` if the
 * body is empty, non-JSON, or unreadable (the latter being something
 * like a stream that was already consumed). Used for error-body parsing
 * where we'd rather get a typed `FlowQError` with no body than crash
 * the client trying to be perfect.
 */
async function safeReadJson(response: Response): Promise<FlowQErrorBody | null> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return parsed as FlowQErrorBody;
    }
    return null;
  } catch {
    return null;
  }
}
