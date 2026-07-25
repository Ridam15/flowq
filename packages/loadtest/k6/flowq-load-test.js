/* eslint-disable */
/**
 * FlowQ k6 load test.
 *
 * Three scenarios live in this one file. The runner picks one via env:
 *
 *   k6 run -e SCENARIO=baseline    k6/flowq-load-test.js   # 2-min throughput
 *   k6 run -e SCENARIO=queueDepth  k6/flowq-load-test.js   # 30-s burst, no workers
 *   k6 run -e SCENARIO=priority    k6/flowq-load-test.js   # 1000 priority-mixed jobs
 *
 * The 4th scenario (failure recovery) is orchestration-heavy — see
 * scripts/chaos-recovery.mjs.
 *
 * Why one file with branching instead of three files:
 *   - Identical helpers (auth, body, retry-on-network) stay in one place.
 *   - One place to point at API_URL / API_KEY.
 *   - k6 thresholds and tags stay consistent across runs, so summaries are
 *     directly comparable.
 *
 * All scenarios export Prometheus-style summary JSON via --summary-export
 * so the orchestrator can lift exact numbers into RESULTS.md.
 */

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ---------------------------------------------------------------------------
// Config (driven by env so the same script runs against compose, kind, GKE)
// ---------------------------------------------------------------------------
const API_URL  = __ENV.API_URL  || 'http://127.0.0.1:3000';
const API_KEY  = __ENV.API_KEY  || 'dev-api-key-change-me';
const QUEUE    = __ENV.QUEUE    || 'e2e-deploy';
const SCENARIO = __ENV.SCENARIO || 'baseline';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
// k6 already records http_req_duration; we tag a *named* trend for enqueue
// latency specifically so it shows up cleanly in the summary table.
const enqueueLatency  = new Trend('flowq_enqueue_latency_ms', true);
const completeLatency = new Trend('flowq_complete_latency_ms', true);
const enqueued        = new Counter('flowq_jobs_enqueued');
const completed       = new Counter('flowq_jobs_completed_observed');
const completionRate  = new Rate('flowq_completion_rate');

// ---------------------------------------------------------------------------
// Scenario / threshold matrix
// ---------------------------------------------------------------------------
//
// Each scenario sets its own VUs, duration, and exec function. Thresholds
// are advisory — they don't fail the run, they just show up in the summary
// so reviewers can see what "good" looks like at a glance.

const SCENARIOS = {
  baseline: {
    executor: 'constant-vus',
    vus: 10,
    duration: '2m',
    exec: 'baseline',
    tags: { scenario: 'baseline' },
  },
  queueDepth: {
    executor: 'constant-vus',
    vus: 100,
    duration: '30s',
    exec: 'queueDepth',
    tags: { scenario: 'queueDepth' },
  },
  priority: {
    executor: 'shared-iterations',
    vus: 50,
    iterations: 1000,
    maxDuration: '5m',
    exec: 'priority',
    tags: { scenario: 'priority' },
  },
};

if (!SCENARIOS[SCENARIO]) {
  throw new Error(`unknown SCENARIO=${SCENARIO}; valid: ${Object.keys(SCENARIOS).join(', ')}`);
}

export const options = {
  // Only enable the one scenario the user asked for; the others are inert.
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  // Don't fail the test on threshold violations — we want to report the
  // raw numbers, not gate on them.
  thresholds: {
    'flowq_enqueue_latency_ms': ['p(95)<200', 'p(99)<500'],
    'flowq_complete_latency_ms': ['p(95)<2000'],
    'http_req_failed': ['rate<0.01'],
  },
  // Quiet the default summary so our RESULTS.md is reproducible.
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${API_KEY}`,
};

function enqueue(payload, opts) {
  const body = JSON.stringify({
    queueName: QUEUE,
    payload,
    priority: opts && opts.priority,
    delay: opts && opts.delay,
    maxAttempts: opts && opts.maxAttempts,
    idempotencyKey: opts && opts.idempotencyKey,
    timeout: opts && opts.timeout,
  });
  const t0 = Date.now();
  const res = http.post(`${API_URL}/jobs`, body, { headers: HEADERS, tags: { endpoint: 'enqueue' } });
  enqueueLatency.add(Date.now() - t0);
  if (!check(res, { 'enqueue 201': (r) => r.status === 201 })) {
    fail(`enqueue failed status=${res.status} body=${res.body}`);
  }
  enqueued.add(1);
  return res.json();
}

function getJob(jobId) {
  const res = http.get(`${API_URL}/jobs/${jobId}`, { headers: HEADERS, tags: { endpoint: 'getJob' } });
  if (res.status !== 200) {
    return null;
  }
  return res.json();
}

/**
 * Poll until the job reaches a terminal state (COMPLETED / FAILED / DEAD)
 * or `timeoutMs` elapses. Returns the final job, or null on timeout.
 */
function waitForTerminal(jobId, timeoutMs = 10_000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = getJob(jobId);
    if (j && (j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'DEAD')) {
      return j;
    }
    sleep(pollMs / 1000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Baseline throughput
// ---------------------------------------------------------------------------
//
// 10 VUs in a tight enqueue→wait-for-completion loop. The k6 reported
// `iteration_duration` is therefore (enqueue + poll-to-complete), and
// `iterations` divided by duration is jobs/sec end-to-end.
//
// Why poll rather than open a websocket: k6 has a `k6/ws` module but it
// makes the script noticeably more complex and we don't need streaming —
// each VU only cares about its own job.

export function baseline() {
  const job = enqueue({ duration: 50, scenario: 'baseline' });
  const t0 = Date.now();
  const final = waitForTerminal(job.id, 10_000, 50);
  if (!final) {
    completionRate.add(false);
    return;
  }
  completeLatency.add(Date.now() - t0);
  completionRate.add(final.status === 'COMPLETED');
  completed.add(1);
}

// ---------------------------------------------------------------------------
// Scenario 2 — Queue depth stress
// ---------------------------------------------------------------------------
//
// 100 VUs blast jobs as fast as the API will accept them, with workers
// turned off. We do NOT poll for completion — the point is to measure
// peak ingestion + back-pressure under a non-draining queue.
//
// The orchestrator then turns workers back on and times the drain.

export function queueDepth() {
  enqueue({ duration: 100, scenario: 'queueDepth', burstId: __VU + ':' + __ITER }, {
    // Tag this batch so we can filter Postgres queries to just these jobs.
    idempotencyKey: `queueDepth-${__VU}-${__ITER}-${Date.now()}`,
  });
}

// ---------------------------------------------------------------------------
// Scenario 3 — Priority correctness
// ---------------------------------------------------------------------------
//
// 1000 jobs with priorities 1, 5, and 10 in roughly equal proportion. We
// enqueue but don't wait — the verifier (scripts/verify-priority.mjs)
// reads the `jobs` table afterwards and checks completion order against
// priority.
//
// Why we use shared-iterations with 50 VUs:
//   - shared-iterations splits the 1000 iterations across the VU pool, so
//     we get bursty parallel enqueue (close to real producer behaviour)
//     without an unbounded backlog forming on the API side.

export function priority() {
  // Cycle 1, 5, 10 deterministically so priority bands stay balanced.
  // (__ITER is the global iteration counter under shared-iterations.)
  const ladder = [1, 5, 10];
  const priority = ladder[__ITER % ladder.length];
  enqueue(
    { duration: 50, scenario: 'priority', priority },
    {
      priority,
      // The verifier filters on this idempotency key prefix.
      idempotencyKey: `prio-${uuidv4()}`,
    },
  );
}
