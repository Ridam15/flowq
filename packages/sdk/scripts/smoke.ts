/**
 * Live end-to-end smoke against the running FlowQ stack.
 *
 *   pnpm exec tsx packages/sdk/scripts/smoke.ts
 *
 * Exercises the SDK from the outside the way an external producer
 * would: real HTTP, real Redis, real Postgres. If this script
 * completes without an error code the SDK is wired correctly.
 *
 * Not part of `pnpm test` — the unit suite is hermetic; this requires
 * the docker-compose stack (or local services) to be running.
 */

import { FlowQClient, FlowQNotFoundError } from '../src';

const BASE_URL = process.env.FLOWQ_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.FLOWQ_KEY ?? 'dev-api-key-change-me';

async function main(): Promise<void> {
  const client = new FlowQClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    defaultQueueName: 'emails',
    timeout: 5000,
  });

  console.log('1. health()');
  const health = await client.health();
  console.log('   ', health.status, 'redis=' + health.redis, 'pg=' + health.postgres);

  console.log('2. enqueue() with idempotencyKey');
  const idem = `sdk-smoke-${Date.now()}`;
  const job1 = await client.enqueue({
    payload: { sdk: 'smoke', duration: 50 },
    priority: 7,
    idempotencyKey: idem,
  });
  const job2 = await client.enqueue({
    payload: { sdk: 'smoke', duration: 50 },
    priority: 7,
    idempotencyKey: idem,
  });
  console.log('   job1.id =', job1.id);
  console.log('   job2.id =', job2.id);
  if (job1.id !== job2.id) throw new Error('idempotency broken');
  console.log('   ✓ same id (idempotency)');

  console.log('3. getJob()');
  const fetched = await client.getJob(job1.id);
  console.log('   status =', fetched.status, 'attempts =', fetched.attempts);

  console.log('4. getQueueStats()');
  const stats = await client.getQueueStats('emails');
  console.log(
    '   enqueued =', stats.enqueued,
    'completed =', stats.completed,
    'pending =', stats.currentPending,
  );

  console.log('5. listWorkers()');
  const workers = await client.listWorkers();
  console.log('   workers =', workers.length, '/', workers.map((w) => w.id.slice(0, 18)));

  console.log('6. getDLQ()');
  const dlq = await client.getDLQ('reports', { page: 1, limit: 5 });
  console.log('   total =', dlq.total, 'rows =', dlq.jobs.length);

  console.log('7. typed error: getJob(non-existent) → FlowQNotFoundError');
  try {
    await client.getJob('00000000-0000-0000-0000-000000000000');
    throw new Error('expected 404');
  } catch (err) {
    if (!(err instanceof FlowQNotFoundError)) throw err;
    console.log('   ✓', err.code, err.status);
  }

  console.log('8. pauseQueue / resumeQueue cycle');
  await client.pauseQueue('emails');
  const paused = await client.getQueueStats('emails');
  console.log('   paused =', paused.paused);
  await client.resumeQueue('emails');
  const resumed = await client.getQueueStats('emails');
  console.log('   paused =', resumed.paused);

  console.log('\nALL SDK SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
