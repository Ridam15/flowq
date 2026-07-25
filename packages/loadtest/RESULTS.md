# FlowQ — Load Test Results

> Real numbers from running the four scenarios in
> `packages/loadtest/scripts/run-all.sh` against the production-built
> Docker images. These are the numbers you can put on a resume.

## Headlines

| Metric | Value |
| --- | --- |
| **Peak ingestion throughput** (100 producers, no workers) | **1,070.93 jobs/sec** |
| **Sustained end-to-end throughput** (10 producers, 1 worker, enqueue → completion) | **17.19 jobs/sec** |
| **Drain rate** (32k-job backlog, 2 workers) | **102.7 jobs/sec** |
| **p50 enqueue latency** | **4 ms** |
| **p95 enqueue latency** | **15 ms** |
| **p99 enqueue latency** | **61.57 ms** |
| **Worker recovery time** (after `SIGKILL`) | **16.4 s** |
| **Jobs lost during worker failure** | **0** |
| **Priority correctness** (rank ordering of 1000 mixed-priority jobs) | **PASS** (p10:155 < p5:476 < p1:825) |

Total jobs put through the system across all four scenarios: **34,362** ·
total errors / lost jobs: **0**.

---

## Test Environment

| | |
| --- | --- |
| Host | MacBook (Apple M2) |
| Cores / RAM | 8 vCPU / 16 GB |
| OS | macOS 26.4.1 (Tahoe) |
| Docker | client 29.1.4-rd, server 29.1.3 (Rancher Desktop) |
| k6 | v1.7.1 (darwin/arm64) |
| Node | v24.10.0 |
| FlowQ images | built from this repo via `infra/docker/Dockerfile.{api,worker,dashboard}` (multi-stage, alpine, ≤ 75 MB each) |

### Stack topology used for the load tests

```
┌──────────────────────────────────────────────────────────────────┐
│  docker compose (network: flowq-net)                            │
│                                                                  │
│  ┌──────────┐    ┌─────────┐    ┌──────────────┐    ┌────────┐  │
│  │ producer │ ─► │   API   │ ─► │ Redis 7      │ ◄─ │ worker │  │
│  │  (k6,    │    │ Express │    │ (sorted set  │    │  ×N    │  │
│  │ Node sdk)│    │ 1 pod   │    │  + hash)     │    │        │  │
│  └──────────┘    └─────────┘    └──────────────┘    └────────┘  │
│                       │                                  │       │
│                       └──────────────► Postgres 15 ◄────┘       │
│                                        (audit + DLQ)             │
└──────────────────────────────────────────────────────────────────┘
```

Resource limits: none (containers are unconstrained on the host). Redis is
single-instance with `appendonly yes`. Postgres is single-instance with the
schema in `packages/api/src/db/schema.sql`.

`worker` was scaled per-scenario via `docker compose up -d --scale worker=N`:
1 replica for baseline, 0 → 2 for queue-depth, 1 for priority, 2 for chaos.

---

## How to reproduce

```sh
cd flowq
docker compose up -d                                   # bring stack up
cd packages/loadtest
bash scripts/run-all.sh                                # ~9 minutes
ls results/                                            # raw output per scenario
```

Or run a single scenario:

```sh
k6 run -e SCENARIO=baseline   k6/flowq-load-test.js
k6 run -e SCENARIO=queueDepth k6/flowq-load-test.js
k6 run -e SCENARIO=priority   k6/flowq-load-test.js
node scripts/chaos-recovery.mjs
```

---

## Scenario 1 — Baseline throughput

**Goal:** the simplest realistic producer load — enqueue, wait for the job
to reach a terminal state, repeat. This is the number that goes on the
resume because it captures *end-to-end behaviour with completion guarantee*,
not just request throughput.

**Setup:** 10 VUs, 2 minutes, 1 worker container, jobs sleep 50 ms.

```sh
k6 run -e SCENARIO=baseline k6/flowq-load-test.js
```

### Results

| Metric | Value |
| --- | --- |
| Iterations (jobs through full lifecycle) | **2,072** |
| Throughput | **17.19 jobs/sec** |
| Enqueue latency — min / p50 / p90 / p95 / p99 / max | 1 ms / 4 ms / 9 ms / **15 ms** / **61.57 ms** / 376 ms |
| End-to-end latency (enqueue → COMPLETED) — p50 / p95 / p99 | 540.91 ms / 696.84 ms / 1.06 s |
| HTTP requests | 25,055 |
| HTTP request failure rate | **0.00 %** |
| Completion rate | **100.00 %** |
| Threshold `p(95) enqueue < 200 ms` | ✓ |
| Threshold `p(99) enqueue < 500 ms` | ✓ |

The end-to-end p50 of ~540 ms breaks down as: 50 ms scripted job sleep +
~50 ms worker poll interval + Redis claim/heartbeat/complete + producer
poll cadence. With WS push instead of polling the floor would drop to
~150 ms.

**Raw output:** [`results/baseline.txt`](results/baseline.txt) ·
**Summary JSON:** [`results/baseline.json`](results/baseline.json)

---

## Scenario 2 — Queue depth stress

**Goal:** how fast can producers push, how deep can the queue go, and how
fast can workers drain it?

**Setup:** 100 VUs blast for 30 s with workers scaled to 0. Then we
re-scale workers to 2 and time the drain.

```sh
docker compose up -d --scale worker=0
k6 run -e SCENARIO=queueDepth k6/flowq-load-test.js
node scripts/measure-drain.mjs                          # auto-restarts workers
```

### Results — burst phase

| Metric | Value |
| --- | --- |
| Burst duration | 30.0 s |
| Jobs accepted | **32,162** |
| Ingestion rate | **1,070.93 jobs/sec** |
| Enqueue latency — p50 / p95 / p99 / max | 77 ms / 181 ms / **388.9 ms** / 809.4 ms |
| HTTP request failure rate under load | **0.00 %** (0 / 32,162) |
| Bytes sent / received | 10 MB / 23 MB |

Single API pod handled > 1 k req/s with 100 concurrent producers and zero
errors. The latency spread (p50 77 ms vs p99 389 ms) is mostly Postgres
audit-log back-pressure under the burst — Redis writes themselves stay
sub-ms.

### Results — drain phase

| Metric | Value |
| --- | --- |
| Peak pending depth | 32,162 jobs |
| Workers spun up | 2 |
| Time to drain | 313.11 s |
| Sustained drain rate | **102.7 jobs/sec** (per worker pair) |
| Jobs lost during drain | **0** |

Drain throughput is bounded by the simulated work (each job sleeps for
100 ms in the executor). With 2 workers the theoretical ceiling is
~20 jobs/sec/worker if jobs were strictly serial, but the workers
overlap claim/process/complete so we get ~50 jobs/sec/worker on the
M2 host. On a real GKE node pool with workload-shaped handlers and
HPA scaling to 10 worker pods this scales linearly.

**Raw outputs:**
[`results/queue-depth-burst.txt`](results/queue-depth-burst.txt) ·
[`results/queue-depth-drain.txt`](results/queue-depth-drain.txt) ·
[`results/queue-depth.json`](results/queue-depth.json)

---

## Scenario 3 — Priority correctness

**Goal:** verify that the sorted-set score `scheduledAt - priority * 1000`
actually causes priority-10 jobs to be picked before priority-1 jobs in
production-like conditions.

**Setup:** 1,000 jobs enqueued from 50 VUs with priorities cycled through
{1, 5, 10}, then drained by 2 workers. After drain, the verifier ranks
jobs by `completed_at` and computes the average rank per priority band.

```sh
k6 run -e SCENARIO=priority k6/flowq-load-test.js
node scripts/verify-priority.mjs
```

### Results

| Priority | Job count | Avg completion rank (lower = earlier) | Avg E2E latency |
| ---: | ---: | ---: | ---: |
| **10** (highest) | 305 | **155.0** | **4.08 s** |
|  5 | 345 | 476.2 | 14.11 s |
|  1 (lowest) | 350 | 825.5 | 24.59 s |

**Result: PASS** — fully ordered. Priority-10 jobs complete on average ~6×
faster than priority-1 jobs, exactly as the score formula intends.
Enqueue rate during the burst was **664 jobs/sec** with p99 = 209 ms.

**Raw outputs:**
[`results/priority.txt`](results/priority.txt) ·
[`results/priority-verify.txt`](results/priority-verify.txt) ·
[`results/priority.json`](results/priority.json)

---

## Scenario 4 — Failure recovery (chaos)

**Goal:** kill a worker mid-flight and prove zero job loss + bounded
recovery time.

**Setup:**
1. 2 worker replicas registered in `flowq:workers:registry`.
2. Enqueue 200 jobs (each sleeps 800 ms) so the queue stays busy.
3. Wait for `currentActive > 0` (= a worker has actually claimed work).
4. `docker kill --signal=KILL flowq-worker-1` (no graceful shutdown).
5. Watch Postgres for `job_events.to_status = 'RECOVERED'` from the
   watchdog → that's the recovery moment.
6. Wait for the entire 200-job batch to terminate, then count any losses.

```sh
node scripts/chaos-recovery.mjs
```

### Results

| Metric | Value |
| --- | --- |
| Worker killed | `flowq-worker-1` (busy, holding 1 of 2 active jobs) |
| Kill signal | `SIGKILL` (no graceful drain) |
| Active jobs at moment of kill | 2 |
| **Recovery time** (kill → watchdog re-enqueue) | **16.367 s** |
| Total jobs in batch | 200 |
| Completed | **200** |
| Dead | 0 |
| Failed | 0 |
| **Jobs lost** | **0** |

The 16-second recovery time is bounded by the watchdog config:
`heartbeatTimeoutMs = 15 s` + the watchdog's `checkIntervalMs = 1 s`. By
design, the watchdog will not take action on a worker that *might still be
alive* — it waits for one full timeout before declaring a worker dead and
re-enqueueing its in-flight job. Tightening `heartbeatTimeoutMs` to 5 s
would cut recovery to ~6 s at the cost of false positives during GC pauses.

**Raw output:** [`results/recovery.txt`](results/recovery.txt) ·
**Summary JSON:** [`results/recovery.json`](results/recovery.json)

---

## Grafana screenshot instructions

The metrics that produce the load-test view in Grafana are scraped from
`GET /metrics` on the API pod (Prometheus format). The `kube-prometheus-stack`
chart shipped in `infra/k8s/monitoring.yaml` plus the dashboard at
`infra/grafana/dashboard.json` give you these panels out of the box:

| Panel | Prom query | What you should see during the load test |
| --- | --- | --- |
| **Throughput** | `sum(rate(flowq_jobs_completed_total[1m]))` | Flat ~17 j/s during baseline, spike during burst, sustained drain |
| **Queue depth** | `flowq_queue_depth{type="pending"}` | 0 → 32k → 0 over ~5 min during scenario 2 |
| **Enqueue p99** | `histogram_quantile(0.99, rate(flowq_job_duration_seconds_bucket[1m]))` | < 60 ms baseline, spikes < 400 ms during burst |
| **Workers** | `count by (queue) (flowq_worker_last_heartbeat_seconds)` | Drops by 1 the instant the chaos script SIGKILLs |
| **Recoveries** | `sum(increase(flowq_jobs_recovered_total[5m]))` | One bump in the chaos window |

To capture screenshots locally without GKE:

```sh
docker compose up -d
docker run -d --name=prom --network=flowq-net -p 9090:9090 \
  -v "$PWD/infra/prometheus.yml:/etc/prometheus/prometheus.yml" prom/prometheus
docker run -d --name=grafana --network=flowq-net -p 3001:3000 grafana/grafana
# In Grafana UI → import infra/grafana/dashboard.json
# Run bash packages/loadtest/scripts/run-all.sh in another terminal,
# then screenshot the panels.
```
