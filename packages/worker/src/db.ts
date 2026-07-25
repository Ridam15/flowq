import { Pool, PoolConfig } from 'pg';
import { logger } from './logger';

/**
 * Worker-side Postgres pool. As with redis.ts, intentionally duplicated
 * from the API rather than shared, because the SDK is side-effect free
 * and a "shared infra" package isn't worth the overhead for one duplicate.
 *
 * The worker connects with `application_name=flowq-worker` so DBA
 * dashboards can tell producer traffic from consumer traffic at a glance
 * (pg_stat_activity.application_name).
 *
 * NOTE: schema application is the API's job — the worker assumes the
 * tables already exist. This avoids a startup race where two services
 * try to CREATE TABLE in parallel.
 */
let pool: Pool | null = null;

export async function initDB(): Promise<Pool> {
  if (pool) return pool;

  const config: PoolConfig = {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'flowq',
    user: process.env.POSTGRES_USER ?? 'flowq',
    password: process.env.POSTGRES_PASSWORD ?? 'flowq',
    max: 5, // Worker holds fewer connections than the API.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'flowq-worker',
  };

  pool = new Pool(config);
  pool.on('error', (err: Error) => logger.error('db_idle_error', { message: err.message }));

  logger.info('db_connect', {
    host: config.host,
    port: config.port,
    database: config.database,
  });

  // Probe to surface auth / network failures at boot, not on first job.
  const probe = await pool.connect();
  try {
    await probe.query('SELECT 1');
    logger.info('db_ready');
  } finally {
    probe.release();
  }

  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('[worker] getPool() called before initDB()');
  return pool;
}

export async function closeDB(): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch (err) {
    logger.error('db_close_error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    pool = null;
  }
}
