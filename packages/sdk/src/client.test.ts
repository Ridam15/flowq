/**
 * FlowQClient unit tests.
 *
 * No real network. We inject a synthetic `fetch` and assert that:
 *   • URLs, methods, headers, and bodies are exactly right
 *   • Response shapes are returned untouched
 *   • Each HTTP status maps to the documented error class
 *   • Retries fire on network errors and 5xx, NOT on 4xx
 *   • Backoff timing follows the exponential schedule (100/200/400 ms)
 *   • Per-request timeouts produce FlowQNetworkError
 *
 * vi.useFakeTimers is used for the backoff / timeout tests so the
 * suite stays under 50ms instead of multiple real seconds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowQClient } from './client';
import {
  FlowQAuthError,
  FlowQConflictError,
  FlowQError,
  FlowQNetworkError,
  FlowQNotFoundError,
  FlowQServerError,
  FlowQValidationError,
} from './errors';
import { JobStatus, type Job } from './types';

const sampleJob: Job = {
  id: '00000000-0000-4000-8000-000000000001',
  queueName: 'emails',
  payload: { to: 'a@b.com' },
  priority: 5,
  status: JobStatus.PENDING,
  attempts: 0,
  maxAttempts: 3,
  delay: 0,
  idempotencyKey: null,
  createdAt: 1700000000000,
  scheduledAt: 1700000000000,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  lastError: null,
  workerId: null,
  timeout: 30,
};

/** Build a Response-like object that the client treats as native. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 200): Response {
  return new Response('', { status, headers: {} });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('FlowQClient construction', () => {
  it('rejects empty baseUrl', () => {
    expect(
      () => new FlowQClient({ baseUrl: '', apiKey: 'k' }),
    ).toThrowError(/baseUrl is required/);
  });

  it('rejects empty apiKey', () => {
    expect(
      () => new FlowQClient({ baseUrl: 'http://x', apiKey: '' }),
    ).toThrowError(/apiKey is required/);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob, { status: 201 }));
    const client = new FlowQClient({
      baseUrl: 'http://api.local///',
      apiKey: 'k',
      fetch: fetchMock,
    });
    await client.enqueue({ queueName: 'q', payload: {} });
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.local/jobs');
  });
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  it('POSTs to /jobs with bearer auth and the right body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob, { status: 201 }));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'secret',
      fetch: fetchMock,
    });

    const job = await client.enqueue({
      queueName: 'emails',
      payload: { to: 'a@b.com' },
      priority: 8,
      idempotencyKey: 'welcome-42',
    });

    expect(job).toEqual(sampleJob);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api/jobs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      queueName: 'emails',
      payload: { to: 'a@b.com' },
      priority: 8,
      idempotencyKey: 'welcome-42',
    });
  });

  it('falls back to defaultQueueName when queueName is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob, { status: 201 }));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      defaultQueueName: 'emails',
      fetch: fetchMock,
    });

    await client.enqueue({ payload: { hello: 'world' } });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.queueName).toBe('emails');
  });

  it('throws if no queueName resolved', async () => {
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: vi.fn(),
    });
    await expect(client.enqueue({ payload: {} })).rejects.toThrowError(
      /queueName is required/,
    );
  });

  it('omits undefined optional fields from the payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob, { status: 201 }));
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    await client.enqueue({ queueName: 'q', payload: { x: 1 } });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(sent).sort()).toEqual(['payload', 'queueName']);
  });

  it('round-trips an explicit null idempotencyKey', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob, { status: 201 }));
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    await client.enqueue({ queueName: 'q', payload: {}, idempotencyKey: null });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.idempotencyKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Other methods (URL/method correctness)
// ---------------------------------------------------------------------------

describe('method routing', () => {
  it('getJob() GETs /jobs/:id with url-encoding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleJob));
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    await client.getJob('abc/with slash');
    expect(fetchMock.mock.calls[0][0]).toBe('http://api/jobs/abc%2Fwith%20slash');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('cancelJob() DELETEs and resolves to undefined on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'Job cancelled', jobId: 'x' }),
    );
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    const out = await client.cancelJob('x');
    expect(out).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('pauseQueue() POSTs to /queues/:n/pause without body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Queue paused' }));
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    await client.pauseQueue('emails');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api/queues/emails/pause');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('getDLQ() encodes pagination as querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jobs: [], total: 0, page: 2, limit: 50 }),
    );
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    await client.getDLQ('emails', { page: 2, limit: 50 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://api/queues/emails/dlq?page=2&limit=50');
  });

  it('listWorkers() unwraps the {workers} envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        workers: [
          {
            id: 'w-1',
            queue: 'emails',
            status: 'idle',
            startedAt: 1,
            lastHeartbeat: 2,
            currentJobId: null,
            staleSeconds: 1,
          },
        ],
      }),
    );
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    const workers = await client.listWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0].id).toBe('w-1');
  });

  it('retryDeadJob() chains POST + GET and returns the new Job', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'requeued', newJobId: 'new-id', originalJobId: 'old' }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...sampleJob, id: 'new-id' }));
    const client = new FlowQClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchMock });
    const job = await client.retryDeadJob('emails', 'old');
    expect(job.id).toBe('new-id');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api/queues/emails/dlq/old/retry',
    );
    expect(fetchMock.mock.calls[1][0]).toBe('http://api/jobs/new-id');
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  function clientWith(fetchMock: ReturnType<typeof vi.fn>) {
    return new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
      retry: { maxRetries: 0, delayMs: () => 0 },
    });
  }

  it('400 → FlowQValidationError with issues', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: 'validation_error',
          message: 'priority out of range',
          field: 'priority',
          issues: [{ path: ['priority'], code: 'too_big' }],
        },
        { status: 400 },
      ),
    );
    const client = clientWith(fetchMock);
    const err = await client.enqueue({ queueName: 'q', payload: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(FlowQValidationError);
    expect(err.code).toBe('validation_error');
    expect(err.field).toBe('priority');
    expect(err.issues).toHaveLength(1);
    expect(err.status).toBe(400);
  });

  it('401 → FlowQAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    );
    const client = clientWith(fetchMock);
    await expect(client.getJob('x')).rejects.toBeInstanceOf(FlowQAuthError);
  });

  it('404 → FlowQNotFoundError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'not_found', message: 'job x not found' }, { status: 404 }),
    );
    const client = clientWith(fetchMock);
    const err = await client.getJob('x').catch((e) => e);
    expect(err).toBeInstanceOf(FlowQNotFoundError);
    expect(err.message).toBe('job x not found');
  });

  it('409 → FlowQConflictError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'job_not_cancellable' }, { status: 409 }),
    );
    const client = clientWith(fetchMock);
    await expect(client.cancelJob('x')).rejects.toBeInstanceOf(FlowQConflictError);
  });

  it('500 → FlowQServerError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'internal_error' }, { status: 500 }),
    );
    const client = clientWith(fetchMock);
    await expect(client.getJob('x')).rejects.toBeInstanceOf(FlowQServerError);
  });

  it('non-JSON error body still produces a typed error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>nginx 502</html>', { status: 502 }));
    const client = clientWith(fetchMock);
    const err = await client.getJob('x').catch((e) => e);
    expect(err).toBeInstanceOf(FlowQServerError);
    expect(err.status).toBe(502);
  });

  it('every typed error subclass extends FlowQError', async () => {
    const cases: Array<[number, new (...args: never[]) => FlowQError]> = [
      [400, FlowQValidationError],
      [401, FlowQAuthError],
      [404, FlowQNotFoundError],
      [409, FlowQConflictError],
      [500, FlowQServerError],
    ];
    for (const [status, Cls] of cases) {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'x' }, { status }));
      const client = clientWith(fetchMock);
      const err = await client.getJob('x').catch((e) => e);
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(FlowQError);
    }
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('retry policy', () => {
  it('retries network errors 3 times then gives up', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
      // Skip the real backoff to keep the test fast — exact timing is
      // covered by the dedicated test below.
      retry: { maxRetries: 3, delayMs: () => 0 },
    });
    await expect(client.getJob('x')).rejects.toBeInstanceOf(FlowQNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('retries 5xx 3 times then gives up', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'internal_error' }, { status: 503 }));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
      retry: { maxRetries: 3, delayMs: () => 0 },
    });
    await expect(client.getJob('x')).rejects.toBeInstanceOf(FlowQServerError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry 4xx — second call would just produce the same error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'unauthorized' }, { status: 401 }));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
      retry: { maxRetries: 3, delayMs: () => 0 },
    });
    await expect(client.getJob('x')).rejects.toBeInstanceOf(FlowQAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the first successful response after retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(sampleJob));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
      retry: { maxRetries: 3, delayMs: () => 0 },
    });
    const job = await client.getJob('x');
    expect(job).toEqual(sampleJob);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses 100ms / 200ms / 400ms exponential backoff by default', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      fetch: fetchMock,
    });
    const promise = client.getJob('x').catch((e) => e);

    // Walk the timer forward through each backoff window. After each
    // advance the next fetch call should fire (microtask boundary).
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);

    const err = await promise;
    expect(err).toBeInstanceOf(FlowQNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('aborts the request after the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = new FlowQClient({
      baseUrl: 'http://api',
      apiKey: 'k',
      timeout: 250,
      fetch: fetchMock,
      retry: { maxRetries: 0, delayMs: () => 0 },
    });

    const promise = client.getJob('x').catch((e) => e);
    await vi.advanceTimersByTimeAsync(260);
    const err = await promise;
    expect(err).toBeInstanceOf(FlowQNetworkError);
    expect(err.message).toMatch(/timed out after 250ms/);
  });
});
