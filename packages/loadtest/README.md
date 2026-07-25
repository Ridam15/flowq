# @flowq/loadtest

k6 + Node.js harness for load-testing and chaos-testing FlowQ.

Four scenarios:

1. **`baseline`** — 10 VUs, 2 min, 1 worker, end-to-end (enqueue → completion).
2. **`queueDepth`** — 100 VUs blast for 30 s with workers off, then 2 workers
   drain the backlog.
3. **`priority`** — 1,000 jobs at priorities {1, 5, 10}, verifies that
   higher-priority jobs complete earlier.
4. **`failureRecovery`** — `SIGKILL`s a worker mid-flight and asserts
   zero job loss + bounded recovery time.

## Prerequisites

* Docker / docker-compose with the FlowQ stack running (`docker compose up -d` from repo root).
* k6 ≥ 1.x (`brew install k6` on macOS).
* Node ≥ 20.

## Running

All four scenarios in sequence (~9 minutes total):

```sh
bash scripts/run-all.sh
```

Single scenarios:

```sh
pnpm loadtest:baseline
pnpm loadtest:queue-depth
pnpm loadtest:priority
pnpm loadtest:chaos
```

Each scenario writes raw output to `results/`:

| File | What |
| --- | --- |
| `baseline.txt` / `baseline.json` | k6 console + summary export |
| `queue-depth-burst.txt` / `queue-depth-burst.json` | k6 burst phase |
| `queue-depth-drain.txt` / `queue-depth.json` | drain measurement |
| `priority.txt` / `priority.json` | k6 enqueue phase |
| `priority-verify.txt` / `priority.json` | rank-order verifier output |
| `recovery.txt` / `recovery.json` | chaos test |

See [`RESULTS.md`](./RESULTS.md) for the latest captured numbers.

## Env knobs

| Var | Default | What |
| --- | --- | --- |
| `API_URL` | `http://127.0.0.1:3000` | FlowQ API base URL |
| `API_KEY` | `dev-api-key-change-me` | Bearer token |
| `QUEUE` | `e2e-deploy` | Queue name to target (must match worker `WORKER_QUEUE`) |
| `POSTGRES_HOST` | `127.0.0.1` | Postgres host (verifier + chaos script) |
| `POSTGRES_PORT` | `5433` | Postgres host port (compose maps 5432:5432 → 5433 to dodge native pg installs) |
| `CHAOS_JOBS` | `200` | Batch size for the chaos scenario |
| `CHAOS_JOB_MS` | `800` | Per-job sleep so workers stay busy when the kill lands |
