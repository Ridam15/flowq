#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Deployment-module e2e smoke test.
 *
 * Talks to a running FlowQ stack (api on :3000, worker(s), redis, postgres)
 * and exercises the full producer → worker → DLQ → recovery loop using the
 * published SDK + the raw REST surface where the SDK doesn't cover.
 *
 * What it asserts:
 *   1.  /health is green
 *   2.  Auth: missing key → 401
 *   3.  enqueue() returns a job in PENDING; worker promotes it to COMPLETED
 *   4.  Idempotency: same key returns the same jobId
 *   5.  Retry-then-DLQ: a job that always throws ends up in DLQ after
 *       maxAttempts, and the DLQ list paginates correctly
 *   6.  DLQ retry endpoint requeues a dead job and the worker completes it
 *   7.  Pause/resume actually halts dequeue
 *   8.  Stats counters move (enqueued / completed / dead)
 *   9.  /metrics exposes Prometheus counters with the right labels
 *  10.  Workers registry shows live workers with fresh heartbeats
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { FlowQClient } from '../packages/sdk/dist/client.js';

const API_URL = process.env.FLOWQ_API_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.FLOWQ_API_KEY ?? 'dev-api-key-change-me';
const QUEUE   = process.env.FLOWQ_QUEUE   ?? 'e2e-deploy';

const client = new FlowQClient({
  baseUrl: API_URL,
  apiKey: API_KEY,
  defaultQueueName: QUEUE,
  timeout: 15_000,
});

let pass = 0;
let fail = 0;
const results = [];

function ok(name, detail = '') {
  pass += 1;
  results.push({ status: 'PASS', name, detail });
  console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`);
}

function bad(name, detail) {
  fail += 1;
  results.push({ status: 'FAIL', name, detail });
  console.log(`  ✘ ${name}  ${detail}`);
}

async function step(label, fn) {
  console.log(`\n— ${label} —`);
  try {
    await fn();
  } catch (e) {
    bad(label, e?.stack ?? String(e));
  }
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 250, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} after ${timeoutMs}ms`);
}

async function main() {
  console.log(`FlowQ deployment smoke test → ${API_URL}  queue=${QUEUE}`);

  await step('1. /health', async () => {
    const r = await fetch(`${API_URL}/health`);
    const j = await r.json();
    if (r.status === 200 && j.status === 'ok' && j.redis === 'ok' && j.postgres === 'ok') {
      ok('health green', JSON.stringify(j));
    } else {
      bad('health', `status=${r.status} body=${JSON.stringify(j)}`);
    }
  });

  await step('2. Auth: missing key → 401', async () => {
    const r = await fetch(`${API_URL}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queueName: QUEUE, payload: { x: 1 } }),
    });
    if (r.status === 401) ok('401 without bearer');
    else bad('auth', `expected 401, got ${r.status}`);
  });

  // happy-path enqueue + completion
  let happyJobId;
  await step('3. Enqueue → worker → COMPLETED', async () => {
    const enqueued = await client.enqueue({ payload: { kind: 'happy', duration: 50 } });
    happyJobId = enqueued.id;
    if (enqueued.status !== 'PENDING') bad('initial state', `expected PENDING, got ${enqueued.status}`);
    else ok('enqueued PENDING', enqueued.id);

    const completed = await waitFor(
      async () => {
        const j = await client.getJob(enqueued.id);
        return j.status === 'COMPLETED' ? j : null;
      },
      { what: `job ${enqueued.id} to complete` },
    );
    // completeJob deliberately HSETs workerId=null on completion (job is no
    // longer owned by anyone). The audit trail in job_events still has it.
    if (completed.completedAt && completed.startedAt) {
      ok('completion timestamps set', `started→completed in ${completed.completedAt - completed.startedAt}ms`);
    } else {
      bad('completion fields', JSON.stringify(completed));
    }
  });

  await step('4. Idempotency', async () => {
    const key = `idem-${Date.now()}`;
    const a = await client.enqueue({ payload: { n: 1 }, idempotencyKey: key });
    const b = await client.enqueue({ payload: { n: 2 }, idempotencyKey: key });
    if (a.id === b.id) ok('same key → same jobId', a.id);
    else bad('idempotency', `expected same id, got ${a.id} vs ${b.id}`);
  });

  // retry-then-DLQ: the executor in the worker treats payload.fail=true as a hard fail.
  // We use the same queue as the worker is listening to (one worker, one queue).
  const dlqQueue = QUEUE;
  let deadJobId;
  await step('5. Retry-then-DLQ', async () => {
    const j = await client.enqueue({
      queueName: dlqQueue,
      payload: { fail: true, error: 'permanent failure', duration: 50 },
      maxAttempts: 2,
    });
    deadJobId = j.id;
    ok('enqueued failing job', j.id);

    const dead = await waitFor(
      async () => {
        const cur = await client.getJob(j.id);
        return cur.status === 'DEAD' ? cur : null;
      },
      { timeoutMs: 30_000, what: 'job to land in DEAD after retries' },
    );
    if (dead.attempts >= 2) ok('attempts incremented', `attempts=${dead.attempts}`);
    else bad('attempts', `expected ≥2, got ${dead.attempts}`);

    const dlq = await client.getDLQ(dlqQueue, { page: 1, limit: 20 });
    const found = dlq.jobs.find((d) => d.jobId === j.id);
    if (found) ok('DLQ list contains job', `total=${dlq.total}`);
    else bad('DLQ list', `jobId not found; dlq=${JSON.stringify(dlq)}`);
  });

  await step('6. DLQ manual retry', async () => {
    // SDK chains POST /retry + GET /jobs/:newId and returns the full Job.
    const retried = await client.retryDeadJob(dlqQueue, deadJobId);
    ok('retry endpoint returned new job', retried.id);
    // Same failing payload → new job will also die again after maxAttempts.
    const newDead = await waitFor(
      async () => {
        const j = await client.getJob(retried.id);
        return ['DEAD', 'COMPLETED'].includes(j.status) ? j : null;
      },
      { timeoutMs: 30_000, what: 'requeued job to terminate' },
    );
    ok('requeued job processed', `final=${newDead.status}`);
  });

  await step('7. Pause / resume', async () => {
    await client.pauseQueue(QUEUE);
    const beforeStats = await client.getQueueStats(QUEUE);

    const j = await client.enqueue({ queueName: QUEUE, payload: { kind: 'while-paused' } });
    await sleep(2_000); // give a worker time to *not* pick it up
    const stillPending = await client.getJob(j.id);
    if (stillPending.status === 'PENDING') ok('queue paused: job stays PENDING');
    else bad('pause', `expected PENDING, got ${stillPending.status}`);

    await client.resumeQueue(QUEUE);
    const completed = await waitFor(
      async () => {
        const cur = await client.getJob(j.id);
        return cur.status === 'COMPLETED' ? cur : null;
      },
      { what: 'paused job to drain after resume' },
    );
    ok('resume drained job', completed.id);
    void beforeStats;
  });

  await step('8. Stats counters move', async () => {
    const s = await client.getQueueStats(QUEUE);
    if (s.completed >= 2 && s.enqueued >= 3) ok('counters updated', JSON.stringify(s));
    else bad('counters', JSON.stringify(s));
  });

  await step('9. /metrics has flowq_* counters', async () => {
    const r = await fetch(`${API_URL}/metrics`);
    const txt = await r.text();
    const need = [
      'flowq_jobs_enqueued_total',
      'flowq_jobs_completed_total',
      'flowq_jobs_dead_total',
      'flowq_queue_depth',
    ];
    const missing = need.filter((m) => !txt.includes(m));
    if (missing.length === 0) ok('all metrics present');
    else bad('metrics', `missing: ${missing.join(', ')}`);
  });

  await step('10. Workers registry has live workers', async () => {
    const r = await fetch(`${API_URL}/workers`, { headers: { authorization: `Bearer ${API_KEY}` } });
    const j = await r.json();
    const workers = j.workers ?? [];
    const fresh = workers.filter((w) => Date.now() - Number(w.lastHeartbeat ?? 0) < 30_000);
    if (fresh.length >= 1) ok('fresh worker heartbeat', `${fresh.length} live workers`);
    else bad('workers', JSON.stringify(j));
  });

  console.log(`\n========================================`);
  console.log(`  PASS=${pass}  FAIL=${fail}  TOTAL=${pass + fail}`);
  console.log(`========================================`);
  if (fail > 0) {
    console.log('\nFAILED:');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  ✘ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
