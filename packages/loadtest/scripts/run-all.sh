#!/usr/bin/env bash
# Run all four FlowQ load-test scenarios end-to-end against a docker-compose
# stack. Each scenario writes its raw output to packages/loadtest/results/.
#
# Required: docker, k6 (≥ 1.x), node 20+.
#
# Optional env:
#   API_URL   default http://127.0.0.1:3000
#   API_KEY   default dev-api-key-change-me
#   QUEUE     default e2e-deploy
#   STACK     "compose" (default) — compose down/up between phases
#             "external" — assume the stack is already running, do not touch it

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"
RESULTS="$HERE/../results"
mkdir -p "$RESULTS"

API_URL="${API_URL:-http://127.0.0.1:3000}"
API_KEY="${API_KEY:-dev-api-key-change-me}"
QUEUE="${QUEUE:-e2e-deploy}"
STACK="${STACK:-compose}"
export API_URL API_KEY QUEUE COMPOSE_FILE

K6="${K6:-k6}"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
err() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; }

stack_up_with_workers () {
  local replicas="$1"
  log "compose up (worker scale=${replicas})"
  docker compose -f "$COMPOSE_FILE" up -d --scale "worker=${replicas}" --remove-orphans
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "$API_URL/health" >/dev/null 2>&1; then
      log "API healthy after ${i}s"; return 0
    fi
    sleep 1
  done
  err "API never became healthy"; exit 1
}

stack_workers_off () {
  log "scaling workers to 0 (so the burst can build a backlog)"
  docker compose -f "$COMPOSE_FILE" up -d --scale worker=0
}

stack_down () {
  if [[ "$STACK" == "compose" ]]; then
    log "compose down -v"
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans || true
  fi
}

flush_state () {
  # Wipe Redis + Postgres jobs between scenarios so percentiles aren't
  # poisoned by previous runs. We're explicit about this: scenarios share
  # the same queue, so cross-contamination would skew everything.
  log "flushing Redis + clearing Postgres jobs/job_events/dead_letter_queue"
  docker exec flowq-redis redis-cli FLUSHALL >/dev/null
  docker exec flowq-postgres psql -U flowq -d flowq -c \
    "TRUNCATE job_events, dead_letter_queue, jobs CASCADE;" >/dev/null
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if [[ "$STACK" == "compose" ]]; then
  stack_down
  stack_up_with_workers 1
fi

# --- 1. Baseline throughput -------------------------------------------------
log "Scenario 1: baseline throughput (10 VUs, 2 min)"
flush_state
"$K6" run -e SCENARIO=baseline -e API_URL="$API_URL" -e API_KEY="$API_KEY" -e QUEUE="$QUEUE" \
  --summary-export "$RESULTS/baseline.json" \
  "$HERE/../k6/flowq-load-test.js" | tee "$RESULTS/baseline.txt"

# --- 2. Queue depth stress --------------------------------------------------
log "Scenario 2: queue depth stress (100 VUs, 30 s, workers off → on)"
flush_state
stack_workers_off
sleep 2

# Burst with workers off so jobs accumulate.
"$K6" run -e SCENARIO=queueDepth -e API_URL="$API_URL" -e API_KEY="$API_KEY" -e QUEUE="$QUEUE" \
  --summary-export "$RESULTS/queue-depth-burst.json" \
  "$HERE/../k6/flowq-load-test.js" | tee "$RESULTS/queue-depth-burst.txt"

# Now turn workers back on and time the drain.
node "$HERE/measure-drain.mjs" | tee "$RESULTS/queue-depth-drain.txt"

# --- 3. Priority correctness ------------------------------------------------
log "Scenario 3: priority correctness (1000 mixed-priority jobs)"
flush_state
"$K6" run -e SCENARIO=priority -e API_URL="$API_URL" -e API_KEY="$API_KEY" -e QUEUE="$QUEUE" \
  --summary-export "$RESULTS/priority.json" \
  "$HERE/../k6/flowq-load-test.js" | tee "$RESULTS/priority.txt"

node "$HERE/verify-priority.mjs" | tee "$RESULTS/priority-verify.txt"

# --- 4. Failure recovery ----------------------------------------------------
log "Scenario 4: failure recovery (kill one of two worker pods mid-run)"
flush_state
# Need ≥ 2 worker replicas for this scenario.
docker compose -f "$COMPOSE_FILE" up -d --scale worker=2
# Give the new replica time to elect the watchdog leader, register, etc.
sleep 5
node "$HERE/chaos-recovery.mjs" | tee "$RESULTS/recovery.txt"

log "all scenarios finished — raw output in $RESULTS/"
ls -la "$RESULTS"
