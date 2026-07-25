# Changelog

All notable changes to FlowQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Real handler registry** (`packages/worker/src/handlers.ts`) — the worker
  executor now dispatches on `payload.type` to real handlers modelling genuine
  use cases (`password-hash`, `rsa-keygen`, `http-fetch`, `compress`,
  `prime-count`, `image-thumbnail`), using only Node built-ins. The legacy
  `duration`/`fail` sleep behaviour is preserved as a fallback.
- **ACTIVE-transition audit** — `recordJobActive` writes the `PENDING→ACTIVE`
  transition and `started_at` to Postgres on claim (best-effort, off the hot
  path), completing the `job_events` forensic timeline.

### Fixed
- **Duplicate execution of long-running jobs.** Jobs running longer than the
  watchdog heartbeat timeout were re-recovered and re-executed on healthy
  workers. Two root causes fixed: (1) the heartbeat now renews the `:active`
  lease (`ZADD active XX GT`), the classic visibility-timeout pattern, so a
  live worker keeps its lease; (2) the watchdog now verifies a job is still
  owned by the dead worker before reaping it, preventing PATH A from
  re-recovering a job PATH B already handed to a live worker. Verified via
  chaos test: recovery and execution now happen exactly once, zero jobs lost.
- **`jobs.started_at` always NULL.** The claim wrote `startedAt` to Redis but
  never to Postgres; `completeJob` now persists it, so execution-duration
  queries and the dashboard timeline work.

## [0.1.0] — 2026-04-19

Initial public release. The full distributed task queue from broker to dashboard
to deploy story.

### Added — Core
- **Job lifecycle:** `PENDING → ACTIVE → COMPLETED | FAILED | DEAD | CANCELLED`
  with full audit trail in PostgreSQL.
- **Atomic claim** via Lua script — `ZRANGEBYSCORE` + `ZREM` + `ZADD` + `HSET`
  in a single round-trip, so two workers can never claim the same job.
- **Sorted-set scheduling** with `score = scheduledAt - priority * 1000`
  giving O(log N) priority + delay handling in one data structure.
- **Idempotency keys** (`flowq:idempotency:{key}`, 24 h TTL) for
  enqueue-side deduplication.
- **Exponential backoff with jitter** for retries; configurable max attempts.
- **Dead-letter queue** persisted in Postgres with REST endpoints to
  inspect and manually retry.
- **Watchdog** with optimistic locking (`WATCH`/`MULTI`/`EXEC`) for
  race-free recovery of jobs from crashed workers.
- **Redis-based leader election** ensures exactly one watchdog instance
  is active at a time.

### Added — API (`@flowq/api`)
- Express server with Bearer-token auth, Zod request validation, CORS,
  request logging, and a global error handler.
- Endpoints: `POST /jobs`, `GET /jobs/:id`, `DELETE /jobs/:id`,
  `GET /queues/:name/stats`, `POST /queues/:name/pause|resume`,
  `GET /queues/:name/dlq`, `POST /queues/:name/dlq/:jobId/retry`,
  `GET /workers`, `GET /health`.
- Prometheus `/metrics` (counters, histograms, gauges) via `prom-client`.
- OpenAPI 3.0 spec served as Swagger UI at `/docs`.
- WebSocket job feed at `/ws` plus an SSE fallback at `/events/stream`.
- Worker → API event bridge over Redis Pub/Sub on a dedicated subscriber
  connection.

### Added — Worker (`@flowq/worker`)
- Worker registration / deregistration with the workers registry.
- Heartbeat loop (5 s interval, sub-watchdog timeout).
- `executeJob` placeholder with timeout wrapping (`JobTimeoutError`).
- `completeJob` and `failJob` with backoff + DLQ promotion.
- Watchdog instance with leader election and recovery.
- Graceful shutdown on `SIGTERM`/`SIGINT` — finishes in-flight jobs
  before exit.

### Added — Dashboard (`@flowq/dashboard`)
- React 18 + Vite + Tailwind, dark industrial theme.
- Tabs: Overview, Queues, Live Jobs Feed, Workers, Dead Letter Queue.
- Real-time updates over WebSocket, with auto-reconnect + exponential backoff.
- Recharts visualisations for queue depth and throughput.
- Runtime config injection via `/config.js` for environment-agnostic
  container images.

### Added — SDK (`@flowq/sdk`)
- Zero-dependency typed client over the runtime's native `fetch`.
- Strongly-typed methods for every API endpoint.
- Discriminated error hierarchy: `FlowQAuthError`, `FlowQNotFoundError`,
  `FlowQValidationError`, `FlowQConflictError`, `FlowQServerError`,
  `FlowQNetworkError`, all extending `FlowQError`.
- Automatic retry with exponential backoff on network errors and 5xx
  (never on 4xx).
- AbortController-backed per-request timeouts.
- Dual CJS + ESM build with `exports` map for modern Node.js resolution.

### Added — Infrastructure
- Multi-stage Alpine Dockerfiles for `api`, `worker`, `dashboard`
  (all under 75 MB).
- `docker-compose.yml` for one-command local dev (Redis + Postgres +
  API + worker + dashboard).
- Kubernetes manifests in `infra/k8s/` (Namespace, ConfigMap, Secret,
  StatefulSets for Redis & Postgres, Deployments + Services + Ingresses
  for API/worker/dashboard, HPA for workers).
- Helm chart in `infra/helm/flowq/` with templated manifests and a
  prod-example `values.yaml`.
- `kube-prometheus-stack` integration with a `ServiceMonitor` for the
  API and a `prometheus-adapter` config that exposes `flowq_queue_depth`
  to the HPA via `external.metrics.k8s.io`.
- Pre-built Grafana dashboard JSON at `infra/grafana/dashboard.json`.

### Added — CI/CD
- `ci.yml` runs typecheck + lint + test for every package, plus
  `helm lint` + `helm template` + `kubectl apply --dry-run` against
  default and prod-example values.
- `deploy.yml` triggers on push to `main`: tests → builds + pushes
  images to GCR via Workload Identity Federation → `helm upgrade --install`
  to GKE.

### Added — Testing
- 82 unit tests across `sdk`, `api`, `worker` packages (Vitest).
- End-to-end smoke script (`scripts/e2e-deploy-smoke.mjs`) covering the
  full enqueue → execute → complete / DLQ retry / pause/resume / metrics
  / workers / WS handshake flow against a running stack.
- Load-test suite in `packages/loadtest/` with four scenarios
  (baseline / queue-depth / priority correctness / failure recovery)
  driven by k6 + Node.js.

### Documented
- Top-level `README.md` with architecture diagram, feature list,
  deep-dive on Redis sorted sets, at-least-once guarantees, watchdog
  optimistic locking, and leader election.
- `DEPLOY.md` step-by-step GCP + GKE deployment guide.
- `packages/sdk/README.md` with full SDK reference, error hierarchy,
  retry policy, and publishing instructions.
- `packages/loadtest/RESULTS.md` with real benchmark numbers from a
  full run on an Apple M2 host (1,070 jobs/sec ingestion, 0 jobs lost
  through chaos).

[Unreleased]: https://github.com/flowq/flowq/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/flowq/flowq/releases/tag/v0.1.0
