# FlowQ

> **A production-grade distributed task queue.** Redis-backed broker, Postgres-persisted audit log, Express control plane, React dashboard, and a typed TypeScript SDK — all in one monorepo.

[![ci](https://github.com/flowq/flowq/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![deploy](https://github.com/flowq/flowq/actions/workflows/deploy.yml/badge.svg)](.github/workflows/deploy.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![sdk: @flowq/sdk](https://img.shields.io/badge/sdk-%40flowq%2Fsdk-orange.svg)](./packages/sdk)

> **3-minute walkthrough video:** _coming soon — link will be added here._
> [Deployment guide (Zero-Cost PaaS)](./DEPLOY.md) ·
> [Load test results](./packages/loadtest/RESULTS.md) ·
> [SDK reference](./packages/sdk/README.md)

---

## Architecture

```
                                          ┌──────────────────────────────┐
                                          │  React + Vite Dashboard      │
                                          │  WS live job feed, charts    │
                                          └──────────────┬───────────────┘
                                                         │  WS / REST
┌─────────────────┐         REST            ┌────────────▼──────────────┐
│  Producer apps  │  ────────────────────▶  │  Express API (control)    │
│  @flowq/sdk     │   POST /jobs            │  ─────────────────────    │
└─────────────────┘                         │  • Zod validation         │
                                            │  • Bearer-token auth      │
                                            │  • Prometheus /metrics    │
                                            │  • Swagger /docs          │
                                            │  • WS broadcast (jobs)    │
                                            │  • Redis Pub/Sub bridge   │
                                            └────┬───────────────┬──────┘
                                                 │ MULTI/EXEC    │ INSERT
                                                 ▼               ▼
                                       ┌────────────────┐  ┌──────────────────┐
                                       │   Redis 7      │  │  PostgreSQL 15   │
                                       │  ───────────   │  │  ──────────────  │
                                       │  pending  ZSET │  │  jobs            │
                                       │  active   ZSET │  │  job_events      │
                                       │  job:*    HASH │  │  dead_letter_q   │
                                       │  worker:* HASH │  └──────────────────┘
                                       │  registry SET  │           ▲
                                       │  pubsub events │           │
                                       └────┬───────────┘           │
                              CLAIM / HEARTBEAT / COMPLETE / DLQ    │
                                            │                       │
                          ┌─────────────────┼───────────────────┐   │
                          ▼                 ▼                   ▼   │
                    ┌─────────┐       ┌─────────┐         ┌─────────┴─┐
                    │ Worker  │  ...  │ Worker  │   ...   │ Watchdog  │
                    │ Lua     │       │ Lua     │         │ leader-   │
                    │ claim   │       │ claim   │         │ elected   │
                    │ heart-  │       │ heart-  │         │ optimistic│
                    │ beat    │       │ beat    │         │ recovery  │
                    └─────────┘       └─────────┘         └───────────┘
```

The **API** is the only thing producers talk to. **Workers** poll Redis directly via an atomic Lua script (no API hop). The **Watchdog** is a single elected worker process that re-enqueues jobs from dead workers using `WATCH`/`MULTI`/`EXEC` for race-free recovery. **Postgres** is the audit trail and DLQ — never on the hot path of enqueue/claim.

## Features

### Reliability
- **At-least-once delivery** with idempotency keys for end-to-end exactly-once.
- **Watchdog crash recovery** — orphaned in-flight jobs from dead workers are re-enqueued automatically; verified with a `SIGKILL` chaos test (0 jobs lost).
- **Exponential backoff with jitter** for retries; configurable max attempts.
- **Dead-letter queue** with REST endpoints to inspect and manually retry.
- **Graceful shutdown** — workers finish their current job before exiting on `SIGTERM`/`SIGINT`.

### Performance
- **Atomic Lua-scripted claim** (`ZRANGEBYSCORE` + `ZREM` + `ZADD` + `HSET` in one round-trip) so two workers never claim the same job.
- **Sorted-set queues** scored by `scheduledAt - priority * 1000` — single `ZRANGEBYSCORE` returns the next eligible, highest-priority job.
- **Best-effort Postgres writes** — Redis is the source of truth on the hot path, Postgres is async audit. Hard-tested at **1,070 jobs/sec ingestion**.

### Observability
- Prometheus `/metrics` (jobs counters, queue depth gauge, latency histogram, worker count).
- Pre-built Grafana dashboard JSON (`infra/grafana/dashboard.json`).
- Structured JSON logs on every state transition.
- Real-time WebSocket job feed for the React dashboard.
- Server-Sent Events alternative at `GET /events/stream` for clients that can't WS.

### Operability
- **HorizontalPodAutoscaler** on `flowq_queue_depth > 100` via Prometheus Adapter.
- **Helm chart** (`infra/helm/flowq`) with prod-example `values.yaml`.
- **GitHub Actions CI** — typecheck + lint + tests + helm-lint on every PR.
- **GitHub Actions CD** — Workload Identity Federation → GCR → `helm upgrade --install` to GKE on push to `main`.
- Multi-stage Alpine Dockerfiles, all under **75 MB per image**.

### Developer experience
- pnpm monorepo with strict TypeScript across every package.
- Typed SDK (`@flowq/sdk`) with discriminated error classes (no status-code branching).
- React + Tailwind dashboard with WS-driven live updates.
- Swagger UI at `/docs` generated from a TypeScript OpenAPI spec.
- 82 unit tests, plus an end-to-end smoke script and a 4-scenario load-test suite.

## Quick start

You need Docker + pnpm. Two commands and you have a running queue:

```bash
git clone https://github.com/flowq/flowq && cd flowq
docker compose up -d
```

Then:

```bash
curl http://localhost:3000/health           # {"status":"ok",...}
open  http://localhost:5173                 # dashboard
open  http://localhost:3000/docs            # Swagger UI
```

For local development without containers:

```bash
pnpm install
pnpm build
pnpm test     # 82 unit tests
pnpm dev      # docker compose up --build
```

## SDK usage

Install:

```bash
pnpm add @flowq/sdk
```

Enqueue a job:

```ts
import { FlowQClient } from '@flowq/sdk';

const client = new FlowQClient({
  baseUrl: 'http://localhost:3000',
  apiKey:  'your-api-key',
  defaultQueueName: 'emails',
});

const job = await client.enqueue({
  payload:        { to: 'user@example.com', template: 'welcome' },
  priority:       8,
  idempotencyKey: `welcome-${userId}`,   // dedup-safe: same key, same job
});

console.log('enqueued', job.id, 'status', job.status);
```

Wait for a result, retry from the DLQ, pause/resume queues, list workers:

```ts
const final = await poll(() => client.getJob(job.id), j => j.status === 'COMPLETED');
const dlq   = await client.getDLQ('emails', { page: 1, limit: 20 });
const fresh = await client.retryDeadJob('emails', dlq.jobs[0].id);
await client.pauseQueue('emails');
await client.resumeQueue('emails');
const workers = await client.listWorkers();
```

Full SDK docs, error hierarchy, and retry policy: [`packages/sdk/README.md`](./packages/sdk/README.md).

## Architecture deep-dive

### Why Redis sorted sets for priority queues

A naive queue uses a Redis `LIST` with `LPUSH`/`RPOP`. That gives FIFO and nothing else. We need three things a list can't do:

1. **Priority** — high-priority jobs jump the line.
2. **Delayed jobs** — jobs become eligible at a future timestamp.
3. **O(log N) "next eligible job"** — a single command, no scanning.

A `ZSET` (sorted set) gives all three. We score every pending job with:

```
score = scheduledAt - priority * 1000
```

`scheduledAt` is the absolute Unix timestamp (ms) when the job becomes eligible. Subtracting `priority * 1000` puts higher-priority jobs at lower scores, so a single `ZRANGEBYSCORE -inf <now> LIMIT 0 1` returns _the highest-priority job that is currently eligible_ in O(log N). The same data structure handles delays for free — a job scheduled for the future has a score > `now` and is silently skipped until its time comes.

The constant `1000` defines the "priority outranks 1 second of waiting" trade-off. A priority-10 job will be served ahead of any priority-1 job that arrived less than 9 seconds before it. Tunable in one constant if you want different semantics.

### At-least-once delivery

FlowQ promises **at-least-once delivery**. A handler may legitimately run twice — once if it crashed mid-execution and the watchdog re-enqueued it. The protocol guarantees:

- A job is never lost (proven by the chaos test: SIGKILL a worker, 0 jobs lost).
- A job is never silently dropped (failure exhausts retries → DLQ; never `/dev/null`).
- A job _can_ be processed more than once if the worker dies after side-effects but before `completeJob` runs.

This is the right trade-off. The alternative — exactly-once via a 2PC across Redis + your handler's downstream — costs you 5–10× latency for a guarantee you can buy back at the application layer with idempotency keys. FlowQ supports this:

```ts
client.enqueue({ payload, idempotencyKey: `welcome-${userId}` });
```

If you re-enqueue with the same key within 24 h, you get the existing job back (verified by a Redis `SETNX` on `flowq:idempotency:{key}` with TTL). Combine that with an idempotent handler (use `jobId` as a dedup key in your downstream system) and at-least-once becomes effectively exactly-once.

### The watchdog and optimistic locking

The watchdog is the part everyone gets wrong. The setup:

- A worker claims a job (job moves to `flowq:queue:{q}:active` ZSET, status → `ACTIVE`).
- Worker `HSET`s a heartbeat every 5 s.
- Worker process dies (OOM kill, pod eviction, network partition).
- Heartbeat stops. Job sits in `active` forever. Without intervention, **lost.**

The watchdog wakes every 10 s and:

1. `SMEMBERS flowq:workers:registry`
2. For each worker, read `lastHeartbeat`. If older than 15 s → declare dead.
3. Read `currentJobId`, hand to `recoverJob(jobId)`.
4. Belt-and-suspenders: also `ZRANGEBYSCORE active -inf (now - 15s)` to catch jobs whose worker registry entry got cleaned up first.

`recoverJob` is the part with the race condition. Multiple watchdog instances might both try to recover the same job. The fix is **optimistic locking** with `WATCH`/`MULTI`/`EXEC`:

```
WATCH  flowq:job:{id}
HGET   flowq:job:{id} status   → if not 'ACTIVE', UNWATCH and bail (someone else handled it)
MULTI
  ZREM   flowq:queue:{q}:active {id}
  ZADD   flowq:queue:{q}:pending {now} {id}
  HSET   flowq:job:{id} status PENDING workerId "" startedAt ""
  HINCRBY flowq:queue:{q}:stats enqueued 1
EXEC                            → returns nil if anyone else touched the job hash
```

If `EXEC` returns `nil`, the optimistic lock failed — another watchdog beat us to it. We log and move on. No work is lost, no job is double-recovered, no distributed lock needed.

### Leader election for a single watchdog

Even with the optimistic lock, you don't want N watchdogs hammering Postgres with `RECOVERED` rows for the same job. So FlowQ runs **exactly one** watchdog at a time using a Redis-based leader election:

```
SET flowq:watchdog:leader {workerId} NX EX 30
```

`NX` makes it atomic: only the first caller wins. The winner refreshes the key every 25 s (`SET ... EX 30` again — within the TTL, so it's a renewal not a takeover). The losers just skip the watchdog loop and run as plain workers. If the leader dies, its key TTLs out within 30 s and one of the followers wins the next election.

This is the same pattern Kubernetes uses for leader-elected controllers (`coordination.k8s.io/Lease` is just a fancy version of this). Five lines of Redis, no Zookeeper, no etcd.

## Performance

Real numbers from running the load-test suite at [`packages/loadtest/`](./packages/loadtest/RESULTS.md) against production-built Docker images on a single MacBook (Apple M2, 8 vCPU, 16 GB RAM):

| Metric | Value |
| --- | --- |
| **Peak ingestion** (100 producers, no workers) | **1,070 jobs/sec** |
| **End-to-end throughput** (1 worker, enqueue → completion) | **17.2 jobs/sec** |
| **Drain rate** (32k-job backlog, 2 workers) | **102.7 jobs/sec** |
| **p50 / p95 / p99 enqueue latency** | **4 ms / 15 ms / 62 ms** |
| **Worker recovery time after `SIGKILL`** | **16.4 s** |
| **Jobs lost during worker crash** | **0** |
| **Priority correctness** (1k mixed-priority jobs) | **PASS** — p10 finishes 6× faster than p1 |

34,362 jobs through the system across all four scenarios with **0 errors, 0 lost**. Methodology, raw outputs, and Grafana panel queries in [`packages/loadtest/RESULTS.md`](./packages/loadtest/RESULTS.md).

## API reference

`docker compose up -d` and open <http://localhost:3000/docs> — Swagger UI generated from the OpenAPI 3.0 spec at [`packages/api/src/openapi.ts`](./packages/api/src/openapi.ts).

| Endpoint | What |
| --- | --- |
| `POST   /jobs`                                | Enqueue a job |
| `GET    /jobs/:id`                            | Fetch job state |
| `DELETE /jobs/:id`                            | Cancel (only `PENDING`) |
| `GET    /queues/:name/stats`                  | Counters + current depth |
| `POST   /queues/:name/pause`                  | Pause a queue |
| `POST   /queues/:name/resume`                 | Resume a queue |
| `GET    /queues/:name/dlq`                    | List DLQ (paginated) |
| `POST   /queues/:name/dlq/:jobId/retry`       | Manually retry a dead job |
| `GET    /workers`                             | List active workers |
| `GET    /health`                              | Liveness probe |
| `GET    /metrics`                             | Prometheus metrics |
| `GET    /events/stream`                       | SSE job feed |
| `WS     /ws`                                  | WebSocket job feed |

All routes except `/health`, `/metrics`, and `/docs` require `Authorization: Bearer ${API_KEY}`.

## Deployment

FlowQ is designed to be deployed on zero-cost PaaS infrastructure for hobbyists, but ships with Helm charts for production Kubernetes environments.

- **Step-by-step PaaS setup:** [`DEPLOY.md`](./DEPLOY.md) — Neon (Postgres), Upstash (Redis), Fly.io (API/Worker), and Vercel (Dashboard).
- **Helm chart:** [`infra/helm/flowq/`](./infra/helm/flowq/) for Kubernetes.
- **Local k8s** (kind / minikube): apply the raw manifests in [`infra/k8s/`](./infra/k8s/).

## Contributing

Contributions welcome. The short version:

1. Open an issue first for non-trivial changes (templates in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/)).
2. Fork → branch → PR. The PR template walks you through the checklist.
3. CI must be green: `pnpm typecheck && pnpm lint && pnpm test && helm lint ./infra/helm/flowq`.
4. Match the existing code style (Prettier, ESLint config in repo root).
5. Add tests for behaviour changes — every package has a Vitest setup, see `packages/*/src/**/*.test.ts` for examples.

The full development loop:

```bash
pnpm install
pnpm dev                       # docker compose, hot-reload everything
pnpm test                      # 82 unit tests
node scripts/e2e-deploy-smoke.mjs   # full e2e smoke against the running stack
bash packages/loadtest/scripts/run-all.sh   # 4 load-test scenarios (~9 min)
```

See [`CHANGELOG.md`](./CHANGELOG.md) for the release log.

## License

[MIT](./LICENSE)
