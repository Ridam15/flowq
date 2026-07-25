# 📘 FlowQ — The Complete Project Guide

> **One-line pitch:** FlowQ is a *distributed task queue* — a system that takes "work to be done later" from your app, stores it safely, and hands it out to a fleet of worker machines that do the work reliably, even if some of them crash.

<div align="center">

**Redis-backed broker · Postgres audit log · Express control plane · React dashboard · Typed TypeScript SDK — one monorepo.**

`TypeScript` · `Redis 7` · `PostgreSQL 15` · `React 18` · `Docker` · `Kubernetes` · `Helm` · `Prometheus` · `pnpm`

</div>

---

## 📑 Table of Contents

1. [Explain Like I'm 5](#-explain-like-im-5)
2. [What Problem Does It Solve?](#-what-problem-does-it-solve)
3. [Architecture at a Glance](#-architecture-at-a-glance)
4. [The 5 Packages](#-the-5-packages-modules)
5. [Data Stores — Redis & Postgres](#-data-stores)
6. [The Star Algorithms](#-the-star-algorithms)
7. [End-to-End Flow (Life of a Job)](#-end-to-end-flow--life-of-a-job)
8. [Real-World Use Cases](#-real-world-use-cases)
9. [Full Resource List](#-full-resource-list)
10. [How to Run It](#-how-to-run-it)
11. [Industry Rating](#-industry-rating--8510)

---

## 🧸 Explain Like I'm 5

Imagine a **busy ice-cream shop**. 🍦

- **Customers** walk in and shout their orders. (These are your *apps / producers*.)
- Instead of making every customer wait at the counter, there's a **ticket machine**. Each order gets a numbered ticket and goes into a **spinning basket**. (That basket is **Redis** — the queue.)
- The person at the counter (**the API**) checks each order is real — "you actually want 2 scoops? okay, ticket printed" — and drops the ticket in the basket.
- Behind the counter there are **many ice-cream makers** (**workers**). Each one grabs the next ticket, makes that ice cream, and marks it done. If two makers reach for the same ticket, a **magic rule** makes sure only one gets it (so no customer gets two ice creams by mistake).
- There's a **notebook** where every order and what happened to it is written down forever — "order #7 was made at 2pm, order #9 was dropped on the floor." (That notebook is **Postgres**.)
- If an ice-cream maker faints mid-scoop 😵, a **supervisor** (**the watchdog**) notices the half-made order and puts the ticket back in the basket so someone else finishes it. **No order is ever lost.**
- On the wall there's a **big TV screen** showing live: how many orders waiting, who's making what, what fell on the floor. (That's the **dashboard**.)

That's FlowQ. The whole project is a very careful, very fast version of this ice-cream shop, built so it never loses an order and never makes the same one twice.

---

## 🎯 What Problem Does It Solve?

When your app needs to do something **slow or heavy** — send 10,000 emails, resize a video, charge a credit card, generate a report — you *don't* want the user staring at a spinner while it happens. Instead you:

1. **Accept the request instantly** ("we got it, we'll do it soon").
2. **Queue the work.**
3. **Process it in the background** on separate machines you can scale up or down.

FlowQ is the engine that makes step 2 and 3 reliable. The hard parts it solves:

| Hard problem | FlowQ's answer |
| --- | --- |
| Two workers grabbing the same job | **Atomic Lua claim** (only one wins) |
| A worker crashing mid-job | **Watchdog** re-queues orphaned jobs (0 loss) |
| A job that keeps failing | **Retries with backoff**, then **dead-letter queue** |
| Doing the same job twice | **Idempotency keys** (24h dedupe) |
| "Did job #123 actually run?" | **Postgres audit log** of every state change |
| Delayed / scheduled jobs | **Sorted-set score = time**, pop when due |
| High-priority jobs jumping the line | **Priority folded into the score** |
| Seeing what's happening live | **WebSocket dashboard + Prometheus metrics** |

---

## 🏛️ Architecture at a Glance

```
   PRODUCERS                                                   OPERATOR
   (your apps)                                                 (a human)
       │                                                           │
       │  @flowq/sdk  (typed client)                               │ browser
       ▼          POST /jobs                                       ▼
┌───────────────┐   REST    ┌────────────────────────┐  WS + REST  ┌─────────────┐
│  SDK client   │ ────────▶ │   API  (control plane) │ ◀────────── │  Dashboard  │
└───────────────┘           │  • Zod validation      │             │  (React)    │
                            │  • Bearer auth         │             └─────────────┘
                            │  • Prometheus /metrics │
                            │  • Swagger /docs       │
                            │  • WS broadcast        │
                            └───────┬────────┬───────┘
              SOURCE OF TRUTH       │        │   AUDIT TRAIL (async, off hot path)
                                    ▼        ▼
                            ┌──────────────┐  ┌──────────────────┐
                            │   REDIS 7    │  │  POSTGRESQL 15   │
                            │  pending ZSET│  │  jobs            │
                            │  active  ZSET│  │  job_events      │
                            │  job:*   HASH│  │  dead_letter_q   │
                            │  worker:*HASH│  └──────────────────┘
                            │  pub/sub     │           ▲
                            └──────┬───────┘           │
             CLAIM / HEARTBEAT / COMPLETE / DLQ        │
                                   │                   │
              ┌────────────────────┼───────────────┐   │
              ▼                    ▼               ▼   │
        ┌─────────┐          ┌─────────┐     ┌───────────┐
        │ Worker  │   ...    │ Worker  │     │ Watchdog  │
        │ Lua     │          │ Lua     │     │ leader-   │
        │ claim   │          │ claim   │     │ elected   │
        │ heartbt │          │ heartbt │     │ recovery  │
        └─────────┘          └─────────┘     └───────────┘
```

**The golden rule:** Redis is on the **hot path** (fast, atomic, source of truth for live state). Postgres is **never** on the hot path — it's the durable audit log & dead-letter store you read when you're paged at 3 AM.

---

## 📦 The 5 Packages (Modules)

The repo is a **pnpm monorepo** — five independent packages that share code.

```
packages/
├── 🟦 sdk        The shared brain — types, Redis key schema, codecs, producer client.
├── 🟩 api        Control plane — Express REST + WebSocket. Only thing producers talk to.
├── 🟧 worker     The muscle — claims jobs, executes, retries, recovers crashes.
├── 🟪 dashboard  The eyes — React + Vite live UI over WebSocket.
└── 🟨 loadtest   The proving ground — k6 + chaos tests (hit 1,070 jobs/sec).
```

### Dependency graph

```
              ┌─────────────────────────────┐
              │       🟦 @flowq/sdk          │  ← everyone imports this
              │  types·keys·codec·events·    │    (single source of truth for
              │  client·errors               │     the Redis key names)
              └──▲──────────▲──────────▲─────┘
                 │          │          │
            🟩 api      🟧 worker   🟪 dashboard
```

> **Why the SDK is central:** *"The cardinal sin in a queue system is two services that disagree on what the pending key is named — one writes, the other can't see it, jobs vanish."* — so the key schema lives in ONE place both API and worker import.

### 🟦 `sdk` — The Shared Contract
| File | Job |
| --- | --- |
| `index.ts` | Public barrel — `FlowQClient` + all types |
| `types.ts` | `Job`, `QueueStats`, `JobStatus` — the vocabulary |
| `keys.ts` | 🔑 Redis key schema + the famous "why a ZSET not a List" essay |
| `codec.ts` | Encode/decode jobs ↔ Redis hashes (has tests) |
| `events.ts` | Pub/sub event envelope helpers |
| `client.ts` | `FlowQClient` producer HTTP client (has tests) |
| `errors.ts` | Typed errors for `instanceof` discrimination |

### 🟩 `api` — Control Plane (Express)
| Folder | Job |
| --- | --- |
| `routes/` | `jobs`, `queues`, `workers`, `events`, `health`, `metrics`, `docs` |
| `queue/` | `enqueue.ts` (write path, has tests) + `validate.ts` |
| `http/` | Zod `schemas`, `errors`, `asyncHandler` |
| `middleware/` | `auth` (Bearer), `errorHandler`, `requestLog` |
| `events/` | `jobEvents`, `redisBridge` (pub/sub), `statsBroadcaster` |
| `websocket/` | `server`, `auth`, `initialState` |
| `db/` | `init.ts` (pool) + `schema.sql` (tables) |
| `metrics/` | Prometheus registry |

### 🟧 `worker` — The Execution Engine
| File | Job |
| --- | --- |
| `index.ts` | Poll loop + cancellable sleep (snappy shutdown) |
| `dequeue.ts` | 🎯 `claimJob` — the atomic Lua script |
| `executor.ts` | Runs the job + `JobTimeoutError` |
| `complete.ts` | `completeJob` / `failJob` (retry + DLQ) |
| `heartbeat.ts` | Keeps the worker's lease alive |
| `leader.ts` | Elects exactly one watchdog |
| `watchdog.ts` | 🛡️ Re-enqueues jobs from dead workers |
| `registry.ts` | register/deregister, busy/idle |
| `identity.ts`·`redis.ts`·`db.ts`·`events.ts`·`logger.ts` | Plumbing |

### 🟪 `dashboard` — Live UI (React + Vite + Tailwind)
| Folder | Job |
| --- | --- |
| `pages/` | `Overview`, `JobsFeed`, `Queues`, `Workers`, `DLQ` |
| `hooks/` | `useFlowQSocket` (WebSocket), `useRollingStats` (charts) |
| `components/` | `Table`, `Card`, `Tabs`, `StatusBadge`, `ConnectionDot`… |
| `api/` | `client.ts`, `types.ts` |

### 🟨 `loadtest` — Performance & Chaos
| File | Job |
| --- | --- |
| `k6/flowq-load-test.js` | baseline / queueDepth / priority scenarios |
| `scripts/chaos-recovery.mjs` | SIGKILL a worker → prove 0 loss |
| `scripts/verify-priority.mjs` | prove high-priority jumps ahead |
| `RESULTS.md` | The headline numbers |

---

## 🗄️ Data Stores

### Redis 7 — the fast broker (hot path)
| Key | Type | Purpose |
| --- | --- | --- |
| `flowq:queue:{name}:pending` | ZSET | Waiting jobs, scored by `scheduledAt - priority*1000` |
| `flowq:queue:{name}:active` | ZSET | In-flight jobs, scored by `claimedAt` (for recovery) |
| `flowq:job:{id}` | HASH | The job's fields |
| `flowq:worker:{id}` | HASH | A worker's heartbeat/state |
| `flowq:idempotency:{key}` | STRING | 24h dedupe marker |
| pub/sub channels | — | Live events → API → dashboard |

### PostgreSQL 15 — the durable audit log (cold path)
| Table | Purpose |
| --- | --- |
| `jobs` | Canonical job record. Composite index `(queue_name, status)` + **partial index** on pending jobs only |
| `job_events` | Append-only log of every state transition — full forensic timeline |
| `dead_letter_queue` | Jobs that exhausted retries; own lifecycle (retry/replay/purge) |

**Job lifecycle:** `PENDING → ACTIVE → COMPLETED | FAILED | DEAD | CANCELLED`

---

## ⭐ The Star Algorithms

### 1. Atomic Claim (why Lua?)
Claiming a job is really 4–5 Redis steps: *find candidate → re-check it's due → remove from pending → add to active → mark it ACTIVE.* If you ran those as separate commands, **two workers polling at the same millisecond could both think they own the same job** — charging a card twice, sending an email twice.

The fix: bundle all steps into **one Lua script**. Redis runs scripts single-threaded and indivisibly, so it acts like a critical section. Only one worker can ever win a job. It also **self-heals orphans** (pending entry with no job hash → cleaned up) and **re-checks `scheduledAt`** so priority-boosted future jobs aren't popped early.

### 2. Sorted-Set Scheduling (why not a List?)
A List is O(1) but can't do: delayed jobs, priority, time-window counts, or "when did this enter?" recovery. A **ZSET scored by time** gives all of that for O(log N) ≈ 20 ops — irrelevant on Redis. Priority is folded in: `score = scheduledAt - priority * 1000`, so urgent jobs naturally sort ahead.

### 3. Watchdog Crash Recovery (WATCH/MULTI/EXEC)
One worker is **leader-elected** to be the watchdog. It scans the `active` set for jobs whose worker stopped heartbeating, and re-enqueues them using **optimistic locking** (`WATCH`/`MULTI`/`EXEC`) so two watchdogs (or a race) can't double-recover. Chaos-tested with `SIGKILL`: **0 jobs lost.**

---

## 🔄 End-to-End Flow — Life of a Job

```
STEP 1  Producer calls  sdk.enqueue({ queue, payload, priority })
          │
STEP 2  API receives POST /jobs
          → Bearer auth  → Zod validation  → idempotency check
          │
STEP 3  API writes to Redis (source of truth):
          ZADD flowq:queue:emails:pending  <score>  <jobId>
          HSET flowq:job:<jobId>  status=PENDING ...
          PUBLISH  job:created
          │
STEP 4  API (async, best-effort) writes Postgres audit:
          INSERT jobs (...) ; INSERT job_events (PENDING)
          API WS-broadcasts → Dashboard job feed lights up
          │
STEP 5  Worker poll loop runs the Lua claim:
          ZREM pending → ZADD active → HSET status=ACTIVE
          (only ONE worker wins)  → PUBLISH job:started
          │
STEP 6  Worker executor runs the handler.
          heartbeat.ts keeps the lease fresh while it works.
          │
STEP 7a SUCCESS → complete.ts: remove from active, status=COMPLETED,
          PUBLISH job:completed, INSERT job_events(COMPLETED)
          │
STEP 7b FAILURE → retry with exponential backoff + jitter.
          Re-enqueued to pending with a future score.
          Attempts exhausted → moved to dead_letter_queue (status=DEAD).
          │
STEP 8  IF the worker crashed mid-job:
          Watchdog spots the stale `active` entry (no heartbeat)
          → WATCH/MULTI/EXEC re-enqueues it → another worker finishes it.
          RESULT: 0 jobs lost.
```

Every arrow above also emits a **Prometheus metric** and a **structured JSON log**, and (where relevant) a **WebSocket event** the dashboard renders live.

---

## 🌍 Real-World Use Cases

FlowQ is the kind of engine that sits behind features like these:

| Industry | Example job on the queue |
| --- | --- |
| 🛒 **E-commerce** | "Send order-confirmation email", "charge card", "sync inventory" — accept checkout instantly, do the slow work in the background. Idempotency keys ensure a retried checkout doesn't charge twice. |
| 🎬 **Media / SaaS** | "Transcode this uploaded video to 5 resolutions" — heavy CPU work farmed out to a scalable worker fleet. |
| 📧 **Marketing** | "Send this newsletter to 2 million users" — millions of small jobs, priority-biased so transactional emails beat bulk. |
| 🏦 **Fintech** | "Generate month-end statement", "run fraud check" — the Postgres audit log answers "did this actually run, and when?" for compliance. |
| 🤖 **AI / ML** | "Run inference batch", "embed these documents" — delayed + scheduled jobs, retries when a GPU node dies. |
| 📊 **Analytics** | "Roll up yesterday's events at 2 AM" — scheduled (delayed) jobs via the ZSET score. |

**The pattern is always the same:** *user does something → app says "got it" instantly → real work happens later, reliably, on machines you can scale.*

---

## 📚 Full Resource List

### Languages & Runtimes
- **TypeScript 5.5** (everything), **Node.js ≥ 20**, **Lua** (Redis claim script)

### Backend / API
- **Express 4** — HTTP server
- **Zod 4** — request validation
- **ioredis 5** — Redis client
- **pg / pg-pool 8** — Postgres client
- **ws 8** — WebSocket server
- **prom-client 15** — Prometheus metrics
- **swagger-ui-express** — `/docs` OpenAPI UI
- **uuid** — job IDs

### Frontend / Dashboard
- **React 18** + **Vite 5** + **TailwindCSS 3**
- **@tanstack/react-query 5** — data fetching
- **Recharts 3** — charts

### Data Stores
- **Redis 7** (broker, source of truth on hot path)
- **PostgreSQL 15** (audit log + dead-letter queue)

### Testing & Load
- **Vitest** — unit tests (SDK, API, worker all have `.test.ts` files)
- **k6** — load testing
- Custom Node **chaos scripts** (SIGKILL recovery, priority verification, drain measurement)

### Infra / DevOps
- **Docker** (multi-stage Alpine images ≤ 75 MB) + **docker-compose**
- **Kubernetes** (raw manifests in `infra/k8s/`)
- **Helm** chart (`infra/helm/flowq/`)
- **Prometheus + Grafana** (pre-built dashboard JSON)
- **Nginx** (dashboard serving)
- **GitHub Actions** — CI (`ci.yml`) + deploy (`deploy.yml`)
- **pnpm workspaces** (monorepo), **ESLint + Prettier**

### Docs
- `README.md` (architecture + features), `DEPLOY.md` (GKE + Helm guide), `CHANGELOG.md`, per-package READMEs, OpenAPI spec, `RESULTS.md` (load numbers)

---

## ▶️ How to Run It

```sh
# 1. Local dev — spins up the whole stack (API, worker, dashboard, Redis, Postgres)
pnpm dev            # = docker compose up --build
pnpm dev:down       # tear down + wipe volumes

# 2. Build / test / lint everything (parallel across packages)
pnpm build
pnpm test
pnpm lint
pnpm typecheck

# 3. Load + chaos tests
cd packages/loadtest
bash scripts/run-all.sh    # ~9 minutes, runs all 4 scenarios
```

**Production deploy:** multi-stage Docker images → Kubernetes via the Helm chart in `infra/helm/flowq/` (see `DEPLOY.md` for the GKE walkthrough).

---

## 📊 Measured Performance

| Metric | Value |
| --- | --- |
| Peak ingestion (100 producers) | **1,070 jobs/sec** |
| Drain rate (32k backlog, 2 workers) | **102.7 jobs/sec** |
| p50 / p95 / p99 enqueue latency | **4 ms / 15 ms / 62 ms** |
| Worker recovery after SIGKILL | **16.4 s** |
| **Jobs lost during worker failure** | **0** |
| Total jobs tested / errors | **34,362 / 0** |

---

## 🏆 Industry Rating — 8.5/10

Rated as a **portfolio / reference project** against professional standards.

| Dimension | Score | Notes |
| --- | --- | --- |
| **Architecture & design** | 9.5/10 | Textbook separation: hot path (Redis) vs audit (Postgres); atomic Lua claim; leader-elected watchdog; correct data-structure choices with documented reasoning. |
| **Code quality & docs** | 9.5/10 | Exceptional inline comments that teach *why*, not just *what*. Typed SDK shared across services. |
| **Reliability engineering** | 9/10 | Idempotency, backoff+jitter, DLQ, crash recovery, graceful shutdown — all present and chaos-tested (0 loss). |
| **Testing** | 8/10 | Unit tests on the critical paths + real k6 load + chaos scripts. Could add more integration/E2E coverage. |
| **Observability** | 9/10 | Prometheus metrics, Grafana dashboard, structured logs, live WS feed. |
| **DevOps / deployability** | 9/10 | Docker, compose, K8s manifests, Helm chart, CI/CD, deploy guide. Production-shaped. |
| **Scale (proven)** | 6.5/10 | ~1,070 jobs/sec on a laptop is solid for a demo, not yet "internet scale." Single-node Redis (no Cluster yet — noted as a TODO). |
| **Security** | 7/10 | Bearer-token auth, input validation, secrets via env. Single shared API key; wide-open CORS by design (documented). Fine for internal, would need hardening (per-key auth, rate limiting) for public multi-tenant. |
| **Maturity** | 7/10 | v0.1.0, single-author, no HA Redis yet. Excellent bones, early lifecycle. |

### Verdict
> **A genuinely impressive, production-*shaped* system.** It demonstrates senior-level distributed-systems thinking: the concurrency correctness (atomic claim), failure handling (watchdog + DLQ), and operational maturity (metrics, Helm, chaos tests) are all things real companies get wrong. It's not yet battle-tested at massive scale or hardened for hostile multi-tenant use — but as a piece of engineering craft it comfortably outshines most take-home and portfolio projects. **If this were a job interview, it's a strong hire signal.**

*Compared to industry giants (AWS SQS, RabbitMQ, BullMQ, Temporal): FlowQ is closest in spirit to **BullMQ** (Redis-backed job queue) with a nicer ops story. It's a faithful, well-built implementation of patterns those systems use — at a smaller, single-node scale.*

---

<div align="center">

*Generated by analysing the FlowQ repository end-to-end — every package, schema, algorithm, and infra file.*

</div>
