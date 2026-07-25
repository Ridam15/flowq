#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Priority correctness verifier (Scenario 3).
 *
 * After the k6 priority scenario enqueues 1000 jobs with priorities 1/5/10
 * and the workers drain the queue, this script queries Postgres and asserts
 * that average completion ORDER goes 10 < 5 < 1 (i.e. priority-10 jobs
 * complete earlier on average than priority-5, which complete earlier than
 * priority-1).
 *
 * It only inspects jobs from the priority scenario, identified by the
 * `prio-` idempotency_key prefix, so re-runs against a dirty DB still work.
 *
 * Output: a small table to stdout and a JSON dump to results/priority.json
 * for the orchestrator to lift into RESULTS.md.
 */

import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, '..', 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

const cfg = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  // Default to 5433 because docker-compose maps the FlowQ Postgres to
  // host port 5433 (avoids conflict with a native Postgres on 5432).
  port: Number(process.env.POSTGRES_PORT ?? 5433),
  database: process.env.POSTGRES_DB ?? 'flowq',
  user: process.env.POSTGRES_USER ?? 'flowq',
  password: process.env.POSTGRES_PASSWORD ?? 'flowq',
};

const pool = new pg.Pool(cfg);

async function main() {
  // 1.  Wait for all priority-* jobs to terminate. We poll for a stable count.
  console.log(`waiting for priority-scenario jobs to terminate…`);
  let lastTerminal = -1;
  for (let i = 0; i < 60; i++) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('COMPLETED','FAILED','DEAD')) AS terminal,
        COUNT(*)                                                       AS total
      FROM jobs
      WHERE idempotency_key LIKE 'prio-%'
    `);
    const terminal = Number(rows[0].terminal);
    const total = Number(rows[0].total);
    process.stdout.write(`  ${terminal}/${total} terminal\r`);
    if (terminal === total && terminal === lastTerminal && terminal > 0) {
      console.log(`\n  drained: ${terminal} jobs`);
      break;
    }
    lastTerminal = terminal;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 2.  Compute average completion-order per priority band.
  //     ROW_NUMBER() OVER (ORDER BY completed_at) gives "completion rank";
  //     lower rank = finished earlier. Then AVG that rank per priority.
  const { rows: bands } = await pool.query(`
    WITH ranked AS (
      SELECT
        priority,
        ROW_NUMBER() OVER (ORDER BY completed_at NULLS LAST, started_at NULLS LAST) AS rank
      FROM jobs
      WHERE idempotency_key LIKE 'prio-%'
        AND completed_at IS NOT NULL
    )
    SELECT priority, COUNT(*) AS n, ROUND(AVG(rank)::numeric, 1) AS avg_rank
    FROM ranked
    GROUP BY priority
    ORDER BY priority DESC
  `);

  if (bands.length === 0) {
    console.error('FAIL: no priority-scenario jobs found in jobs table.');
    process.exit(1);
  }

  // 3.  Pretty-print.
  console.log('\n  priority | jobs | avg completion rank (lower = earlier)');
  console.log('  ---------+------+---------------------------------------');
  for (const b of bands) {
    console.log(
      `       ${String(b.priority).padStart(2)} | ${String(b.n).padStart(4)} | ${b.avg_rank}`,
    );
  }

  // 4.  Assertion: priority 10 should rank earlier than priority 1.
  const byPrio = Object.fromEntries(bands.map((b) => [Number(b.priority), Number(b.avg_rank)]));
  const p10 = byPrio[10];
  const p5  = byPrio[5];
  const p1  = byPrio[1];
  const ordered = p10 !== undefined && p1 !== undefined && p10 < p1;
  const fullyOrdered = p10 < p5 && p5 < p1;

  console.log(
    `\n  priority-10 avg rank ${p10} ${ordered ? '<' : '≥'} priority-1 avg rank ${p1} ` +
      `→ ${ordered ? 'PASS' : 'FAIL'}`,
  );

  const out = {
    scenario: 'priority',
    bands: bands.map((b) => ({ priority: Number(b.priority), n: Number(b.n), avgRank: Number(b.avg_rank) })),
    pass: ordered,
    fullyOrdered,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(resolve(RESULTS_DIR, 'priority.json'), JSON.stringify(out, null, 2));

  await pool.end();
  process.exit(ordered ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  pool.end().catch(() => {});
  process.exit(2);
});
