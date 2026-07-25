#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Drain-rate measurer for Scenario 2 (queue depth stress).
 *
 * Called after the k6 burst has accumulated a backlog with workers off.
 * Re-starts workers, samples currentPending every 250 ms, and reports:
 *
 *   - peakPending      : highest pending count we observed
 *   - drainStartMs     : when we re-started workers
 *   - drainEndMs       : when pending hit 0
 *   - drainSeconds     : end - start in seconds
 *   - drainRate        : peakPending / drainSeconds  (jobs/sec sustained)
 *
 * Writes results/queue-depth.json.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, '..', 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY ?? 'dev-api-key-change-me';
const QUEUE   = process.env.QUEUE   ?? 'e2e-deploy';
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? resolve(__dirname, '..', '..', '..', 'docker-compose.yml');

function exec(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'pipe' });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => (code === 0 ? res({ out, err }) : rej(new Error(`${cmd} ${code}: ${err}`))));
  });
}

async function getStats() {
  const r = await fetch(`${API_URL}/queues/${QUEUE}/stats`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  return r.json();
}

async function main() {
  // 1. Snapshot peak pending right now (workers should be off when called).
  const before = await getStats();
  const peakPending = before.currentPending;
  console.log(`peak pending before drain: ${peakPending} (active=${before.currentActive})`);
  if (peakPending === 0) {
    console.error('peak pending is 0; nothing to drain. Did the burst run with workers off?');
    process.exit(2);
  }

  // 2. Re-start workers via docker compose. Scale=2 so we get two drainers.
  console.log('starting workers (scale=2)…');
  const drainStart = Date.now();
  await exec('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--scale', 'worker=2', 'worker']);

  // 3. Sample until pending hits 0.
  let pending = peakPending;
  let active  = 0;
  const samples = [];
  for (let i = 0; i < 1200; i++) {
    const s = await getStats();
    pending = s.currentPending;
    active  = s.currentActive;
    samples.push({ tMs: Date.now() - drainStart, pending, active });
    if (i % 8 === 0) process.stdout.write(`  pending=${pending} active=${active}\r`);
    if (pending === 0 && active === 0) break;
    await sleep(250);
  }
  const drainEnd = Date.now();
  const drainSeconds = (drainEnd - drainStart) / 1000;
  const drainRate = peakPending / drainSeconds;

  console.log(`\ndrained ${peakPending} jobs in ${drainSeconds.toFixed(2)}s → ${drainRate.toFixed(1)} jobs/s`);

  const out = {
    scenario: 'queueDepth',
    peakPending,
    drainSeconds,
    drainRate,
    workerReplicas: 2,
    samples,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(resolve(RESULTS_DIR, 'queue-depth.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
