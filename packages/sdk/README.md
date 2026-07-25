# @flowq/sdk

The official TypeScript SDK for the [FlowQ](https://github.com/flowq/flowq) distributed task queue.

> Producer client. Use this in your application to enqueue jobs against
> a running FlowQ API server.

- Zero dependencies — uses the runtime's native `fetch`
- Strongly-typed responses (full TypeScript types for every endpoint)
- Typed error hierarchy (`instanceof FlowQNotFoundError`, no status-code branching)
- Automatic retries with exponential backoff for network errors and 5xx
- AbortController-backed per-request timeouts
- Idempotency-first design

## Install

```bash
pnpm add @flowq/sdk
# or
npm install @flowq/sdk
# or
yarn add @flowq/sdk
```

Requires Node.js 18+ (or any modern runtime with global `fetch` —
Bun, Deno, browsers).

## Quick start

```ts
import { FlowQClient } from '@flowq/sdk';

const client = new FlowQClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
  defaultQueueName: 'email-jobs',
});

const job = await client.enqueue({
  payload: { to: 'user@example.com', template: 'welcome' },
  priority: 8,
  idempotencyKey: `welcome-email-${userId}`,
});

console.log('enqueued', job.id);
```

That's the whole "happy path". Everything below is detail you read
when you need it.

## Configuration

```ts
new FlowQClient({
  baseUrl: 'http://localhost:3000', // required
  apiKey: 'your-api-key',           // required, sent as Bearer
  defaultQueueName: 'emails',       // optional fallback for enqueue()
  timeout: 5000,                    // ms per request, default 5000
  retry: {                          // optional override
    maxRetries: 3,
    delayMs: (n) => 100 * 2 ** (n - 1), // 100, 200, 400 ms
  },
});
```

## Methods

| Method                                            | HTTP                                          | Returns               |
| ------------------------------------------------- | --------------------------------------------- | --------------------- |
| `enqueue(opts)`                                   | `POST /jobs`                                  | `Promise<Job>`        |
| `getJob(jobId)`                                   | `GET /jobs/:id`                               | `Promise<Job>`        |
| `cancelJob(jobId)`                                | `DELETE /jobs/:id`                            | `Promise<void>`       |
| `getQueueStats(queueName)`                        | `GET /queues/:name/stats`                     | `Promise<QueueStats>` |
| `pauseQueue(queueName)`                           | `POST /queues/:name/pause`                    | `Promise<void>`       |
| `resumeQueue(queueName)`                          | `POST /queues/:name/resume`                   | `Promise<void>`       |
| `getDLQ(queueName, { page?, limit? })`            | `GET /queues/:name/dlq`                       | `Promise<DLQResponse>`|
| `retryDeadJob(queueName, jobId)`                  | `POST /queues/:name/dlq/:jobId/retry` + `GET` | `Promise<Job>`        |
| `listWorkers()`                                   | `GET /workers`                                | `Promise<WorkerInfo[]>` |
| `health()`                                        | `GET /health`                                 | `Promise<HealthResponse>` |

### Typed payloads

`enqueue` is generic so your payload type flows through:

```ts
interface WelcomeEmail {
  to: string;
  template: 'welcome' | 'reactivation';
}

const job = await client.enqueue<WelcomeEmail>({
  queueName: 'emails',
  payload: { to: 'a@b.com', template: 'welcome' },
});
// job.payload is typed as WelcomeEmail
```

### Idempotency

Pass an `idempotencyKey` and the API returns the existing job
verbatim if you re-enqueue with the same key within 24 hours:

```ts
const job1 = await client.enqueue({
  queueName: 'emails',
  payload: { to: 'a@b.com' },
  idempotencyKey: 'welcome-user-42',
});

const job2 = await client.enqueue({
  queueName: 'emails',
  payload: { to: 'a@b.com' },
  idempotencyKey: 'welcome-user-42',
});

job1.id === job2.id; // true — same job, no duplicate enqueue
```

### Delayed jobs

```ts
await client.enqueue({
  queueName: 'reports',
  payload: { reportId: '...' },
  delay: 60, // seconds; runs no earlier than now + 60s
});
```

## Errors

Every method throws a member of the typed error hierarchy. Catch the
specific class you care about; everything ultimately extends
`FlowQError` so a single `instanceof FlowQError` catches them all:

```ts
import {
  FlowQError,
  FlowQAuthError,
  FlowQNotFoundError,
  FlowQValidationError,
  FlowQNetworkError,
  FlowQConflictError,
  FlowQServerError,
} from '@flowq/sdk';

try {
  await client.enqueue({ payload: { to: 'x' }, priority: 99 });
} catch (err) {
  if (err instanceof FlowQValidationError) {
    console.error('bad input:', err.field, err.issues);
  } else if (err instanceof FlowQAuthError) {
    console.error('check your API key');
  } else if (err instanceof FlowQNetworkError) {
    console.error('API unreachable, will be retried by caller:', err.cause);
  } else if (err instanceof FlowQError) {
    console.error('flowq:', err.code, err.status, err.message);
  } else {
    throw err;
  }
}
```

| Error class             | When                                           |
| ----------------------- | ---------------------------------------------- |
| `FlowQValidationError`  | `400` — payload rejected (carries `issues[]`)  |
| `FlowQAuthError`        | `401` — bad / missing API key                  |
| `FlowQNotFoundError`    | `404` — job, queue, or DLQ entry doesn't exist |
| `FlowQConflictError`    | `409` — illegal in current state               |
| `FlowQServerError`      | `5xx` — server failed (after retries)          |
| `FlowQNetworkError`     | timeout, DNS, ECONNREFUSED, abort              |
| `FlowQError`            | base class for all of the above                |

## Retry policy

The SDK retries on `FlowQNetworkError` and `FlowQServerError` only —
**never** on `4xx`. Re-sending a malformed request just produces the
same `400`; the SDK refuses to amplify load with pointless retries.

Defaults: 3 retries, exponential backoff (`100ms`, `200ms`, `400ms`).
Override via the `retry` option:

```ts
new FlowQClient({
  baseUrl, apiKey,
  retry: {
    maxRetries: 5,
    delayMs: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
  },
});
```

## Building

```bash
pnpm build       # emits dist/ (CJS) and dist/esm/ (ESM)
pnpm test        # vitest — 34 unit tests
pnpm typecheck   # tsc --noEmit
pnpm clean       # rm -rf dist + tsbuildinfo
```

Outputs both CommonJS (`main`) and ES module (`module`) builds, with
type definitions and source maps. The package's `exports` map honours
modern Node.js conditional resolution. Zero runtime dependencies.

## Publishing to npm

The package is published as `@flowq/sdk` with public access. The
`prepublishOnly` script enforces the full quality gate:

```
clean → typecheck → test → build
```

so an attempted publish from a broken tree fails locally before it ever
hits the registry.

### Steps

```bash
# 1. Dry-run from the package directory: see exactly what would be published
cd packages/sdk
npm publish --dry-run --access public

# 2. Inspect the tarball contents
npm pack --dry-run

# 3. (One-time) authenticate
npm login                              # for the @flowq scope

# 4. Bump the version (semver)
npm version patch     # or minor / major
# this updates packages/sdk/package.json AND creates a git tag

# 5. Publish
npm publish --access public

# 6. Verify
npm view @flowq/sdk versions
```

### What ships in the tarball

Only the four entries in `files`:

```
dist/        # both dist/*.js (CJS) and dist/esm/*.js (ESM) + .d.ts + sourcemaps
README.md
LICENSE
package.json
```

Source files, tests, and tsconfigs do NOT ship — keeps the install
size minimal.

### Pre-publish checklist

- [ ] `pnpm test` is green.
- [ ] `pnpm typecheck` is green.
- [ ] Version bumped in `package.json` (and a corresponding entry in the
      root `CHANGELOG.md`).
- [ ] `npm publish --dry-run` lists only `dist/`, `README.md`, `LICENSE`,
      and `package.json`.
- [ ] If this is a breaking change, the major version was bumped and the
      breaking change is called out in the changelog.

## License

[MIT](./LICENSE)
