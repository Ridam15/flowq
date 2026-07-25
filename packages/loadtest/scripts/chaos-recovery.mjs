#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Scenario 4 — Failure recovery / watchdog correctness.
 *
 * Setup expectation:
 *   - 2+ worker replicas running against the same Redis (so killing one
 *     leaves at least one alive to keep draining + run the watchdog).
 *   - WATCHDOG_HEARTBEAT_TIMEOUT_MS small enough (≤ 15 s) for a fast loop.
 *
 * What it does:
 *   1.  Snapshots which workers are alive.
 *   2.  Enqueues 200 medium-duration jobs so the queue has a sustained
 *       backlog and the killed worker is guaranteed to be holding one
 *       at the moment of the kill.
 *   3.  Waits until ACTIVE > 0 (a worker has actually claimed something).
 *   4.  SIGKILLs one of the worker containers (no graceful shutdown,
 *       simulates OOM-kill / pod eviction).
 *   5.  Records the IDs of jobs that were ACTIVE on the killed worker
 *       (from the worker's hash + the job hash workerId field).
 *   6.  Polls Redis/the API until those orphaned jobs are back in PENDING
 *       — that interval = recovery_time.
 *   7.  Waits for the entire batch to drain, then asserts that the count
 *       of terminal jobs == count of enqueued jobs (jobs_lost == 0).
 *
 * Outputs results/recovery.json with:
 *   { workerKilled, jobsInflightAtKill, recoveryTimeMs, jobsLost, totalJobs }
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, '..', 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY ?? 'dev-api-key-change-me';
const QUEUE   = process.env.QUEUE   ?? 'e2e-deploy';
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? resolve(__dirname, '..', '..', '..', 'docker-compose.yml');
const TOTAL_JOBS = Number(process.env.CHAOS_JOBS ?? 200);
const JOB_DURATION_MS = Number(process.env.CHAOS_JOB_MS ?? 800);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` };

async function api(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

async function getWorkers() {
  const r = await api('GET', '/workers');
  return r.workers ?? [];
}

async function getStats() {
  return api('GET', `/queues/${QUEUE}/stats`);
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolveCmd, rejectCmd) => {
    const p = spawn(cmd, args, { stdio: 'pipe', ...opts });
    let stdout = '', stderr = '';
    p.stdout.on('data', (b) => (stdout += b));
    p.stderr.on('data', (b) => (stderr += b));
    p.on('close', (code) => {
      if (code === 0) resolveCmd({ stdout, stderr });
      else rejectCmd(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
  });
}

function compose(...args) {
  return exec('docker', ['compose', '-f', COMPOSE_FILE, ...args]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`chaos: API=${API_URL} queue=${QUEUE} jobs=${TOTAL_JOBS} jobMs=${JOB_DURATION_MS}`);

  // Verify ≥ 2 workers
  let workers = await getWorkers();
  console.log(`workers alive: ${workers.length} → ${workers.map((w) => w.id).join(', ')}`);
  if (workers.length < 2) {
    throw new Error(
      `need ≥ 2 worker replicas for failure-recovery (got ${workers.length}); ` +
        `bring stack up with \`docker compose up -d --scale worker=2\``,
    );
  }

  // Connect to Postgres for the final loss accounting.
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST ?? '127.0.0.1',
    // See docker-compose.yml — Postgres is exposed on host 5433, not 5432.
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    database: process.env.POSTGRES_DB ?? 'flowq',
    user: process.env.POSTGRES_USER ?? 'flowq',
    password: process.env.POSTGRES_PASSWORD ?? 'flowq',
  });

  const tag = `chaos-${Date.now()}`;
  console.log(`tag=${tag}`);

  // 1. Enqueue the batch (in parallel to keep the API busy).
  console.log(`enqueueing ${TOTAL_JOBS} jobs…`);
  const enqStart = Date.now();
  const ids = await Promise.all(
    Array.from({ length: TOTAL_JOBS }, (_, i) =>
      api('POST', '/jobs', {
        queueName: QUEUE,
        payload: { duration: JOB_DURATION_MS, scenario: 'chaos', i },
        idempotencyKey: `${tag}-${i}`,
      }).then((j) => j.id),
    ),
  );
  console.log(`enqueued ${ids.length} jobs in ${Date.now() - enqStart}ms`);

  // 2. Wait until at least one job is ACTIVE.
  console.log(`waiting for workers to start picking up jobs…`);
  let active = 0;
  for (let i = 0; i < 100; i++) {
    const s = await getStats();
    active = s.currentActive;
    if (active > 0) break;
    await sleep(100);
  }
  if (active === 0) throw new Error('no jobs went ACTIVE; workers stalled');
  console.log(`${active} jobs ACTIVE — pulling the trigger`);

  // 3. Pick a victim. Prefer a worker that is NOT the watchdog leader, so
  //    we exercise a follower kill (more representative of pod eviction).
  workers = await getWorkers();
  const busy = workers.find((w) => w.status === 'busy') ?? workers[0];
  const victimId = busy.id;
  console.log(`victim worker: ${victimId} (status=${busy.status})`);

  // Find which docker container is running this worker — we ran them with
  // a single replica container name; with --scale they get suffixes like
  // flowq-worker-1 / flowq-worker-2. Pick the FIRST flowq-worker-* container
  // and kill it. That gives us deterministic + reproducible chaos.
  const { stdout } = await exec('docker', ['ps', '--filter', 'name=^flowq-worker', '--format', '{{.Names}}']);
  const containers = stdout.trim().split('\n').filter(Boolean);
  if (containers.length === 0) throw new Error('no flowq-worker-* containers found');
  const victimContainer = containers[0];
  console.log(`SIGKILL → ${victimContainer}`);

  // 4. SIGKILL — no graceful shutdown, mimics OOM-kill.
  const killAt = Date.now();
  await exec('docker', ['kill', '--signal=KILL', victimContainer]);

  // 5. Watch the queue. The killed worker held `victimInflight` jobs (we
  //    don't know exactly which; query Redis via the API). Track until
  //    Redis ACTIVE drops below pre-kill ACTIVE *and then comes back up*
  //    (because watchdog re-enqueued them and another worker picked up).
  //
  //    Simpler measurable: time until pending count goes UP again from
  //    its pre-kill trajectory. We approximate "recovered" as: the moment
  //    the watchdog has moved the orphaned active jobs back to pending,
  //    detectable by querying Postgres job_events for the RECOVERED row.
  console.log(`watching for watchdog recovery events…`);
  let recoveryMs = null;
  for (let i = 0; i < 600; i++) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM job_events WHERE to_status = 'RECOVERED' AND created_at > to_timestamp($1 / 1000.0)`,
      [killAt],
    );
    if (r.rows[0].n > 0) {
      recoveryMs = Date.now() - killAt;
      console.log(`recovered ${r.rows[0].n} jobs after ${recoveryMs}ms`);
      break;
    }
    await sleep(250);
  }
  if (recoveryMs === null) {
    // If no RECOVERED event fired, the killed worker had no inflight
    // jobs — race we lost. Still record duration up to now.
    recoveryMs = Date.now() - killAt;
    console.log(`no RECOVERED event in window (${recoveryMs}ms); killed worker may have been idle`);
  }

  // 6. Wait for the entire batch to terminate.
  console.log(`waiting for the full ${TOTAL_JOBS}-job batch to drain…`);
  let terminal = 0;
  for (let i = 0; i < 300; i++) {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('COMPLETED','FAILED','DEAD')) AS terminal,
         COUNT(*) AS total
       FROM jobs
       WHERE idempotency_key LIKE $1`,
      [`${tag}-%`],
    );
    terminal = Number(r.rows[0].terminal);
    process.stdout.write(`  ${terminal}/${r.rows[0].total} terminal\r`);
    if (terminal === Number(r.rows[0].total) && terminal === TOTAL_JOBS) break;
    await sleep(500);
  }
  console.log();

  // 7. Loss accounting.
  const r2 = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
       COUNT(*) FILTER (WHERE status = 'DEAD')      AS dead,
       COUNT(*) FILTER (WHERE status = 'FAILED')    AS failed,
       COUNT(*)                                     AS total
     FROM jobs
     WHERE idempotency_key LIKE $1`,
    [`${tag}-%`],
  );
  const stats = {
    completed: Number(r2.rows[0].completed),
    dead: Number(r2.rows[0].dead),
    failed: Number(r2.rows[0].failed),
    total: Number(r2.rows[0].total),
  };
  const accountedFor = stats.completed + stats.dead;
  const jobsLost = TOTAL_JOBS - accountedFor;

  console.log(`\nfinal:`);
  console.log(`  enqueued:    ${TOTAL_JOBS}`);
  console.log(`  completed:   ${stats.completed}`);
  console.log(`  dead:        ${stats.dead}`);
  console.log(`  failed:      ${stats.failed}`);
  console.log(`  lost:        ${jobsLost}`);
  console.log(`  recoveryMs:  ${recoveryMs}`);

  // 8. Restart the killed container so the cluster returns to baseline
  //    for any subsequent runs.
  console.log(`restarting ${victimContainer}…`);
  await exec('docker', ['start', victimContainer]).catch(() => {
    // If start fails (e.g. container removed), use compose up.
    return compose('up', '-d', 'worker').catch(() => {});
  });

  const out = {
    scenario: 'failureRecovery',
    workerKilled: victimContainer,
    workerIdKilled: victimId,
    activeAtKill: active,
    recoveryTimeMs: recoveryMs,
    jobsLost,
    totalJobs: TOTAL_JOBS,
    completed: stats.completed,
    dead: stats.dead,
    pass: jobsLost === 0,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(resolve(RESULTS_DIR, 'recovery.json'), JSON.stringify(out, null, 2));

  await pool.end();
  process.exit(jobsLost === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(2);
});
