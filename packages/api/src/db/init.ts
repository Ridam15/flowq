import { Pool, PoolConfig } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Module-level singleton pool. We never construct a `pg.Client` directly
 * in app code — all queries go through this pool so we get connection
 * reuse, bounded concurrency, and clean shutdown semantics for free.
 */
let pool: Pool | null = null;

export interface InitDBOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** Max concurrent connections held by this Node process. */
  max?: number;
  /** If true, skip applying schema.sql (useful for tests). */
  skipSchema?: boolean;
}

/**
 * Build a pg Pool, prove the connection works, and apply schema.sql.
 *
 * Idempotent: calling this twice returns the same pool. Safe to call
 * during a hot reload or after an integration test setup.
 */
export async function initDB(opts: InitDBOptions = {}): Promise<Pool> {
  if (pool) return pool;

  const config: PoolConfig = {
    host: opts.host ?? process.env.POSTGRES_HOST ?? 'localhost',
    port: opts.port ?? Number(process.env.POSTGRES_PORT ?? 5432),
    database: opts.database ?? process.env.POSTGRES_DB ?? 'flowq',
    user: opts.user ?? process.env.POSTGRES_USER ?? 'flowq',
    password: opts.password ?? process.env.POSTGRES_PASSWORD ?? 'flowq',
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'flowq-api',
  };

  pool = new Pool(config);

  // Pool-level errors fire when an *idle* client breaks. We log loudly
  // but don't crash the process — pg recovers by handing out fresh clients.
  pool.on('error', (err: Error) => {
    console.error(`[db] idle pool error: ${err.message}`);
  });

  console.log(`[db] connecting postgres://${config.user}@${config.host}:${config.port}/${config.database}`);

  // Validate connectivity *before* anybody else gets a chance to query.
  // Acquiring a client triggers the actual TCP handshake.
  const probe = await pool.connect();
  try {
    await probe.query('SELECT 1');
    console.log('[db] connected');

    if (!opts.skipSchema) {
      await applySchema(probe);
    }
  } finally {
    probe.release();
  }

  return pool;
}

/**
 * Apply schema.sql in one round-trip. The file is read from a sibling
 * directory of the compiled JS — the build step copies `src/db/*.sql`
 * into `dist/db/`. See packages/api/package.json `build` script.
 */
async function applySchema(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  await client.query(sql);
  console.log(`[db] schema applied from ${schemaPath}`);
}

/**
 * Accessor for the rest of the API. Loud failure if init was skipped.
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('[db] getPool() called before initDB()');
  }
  return pool;
}

/** Graceful shutdown. Safe to call multiple times. */
export async function closeDB(): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch (err) {
    console.error('[db] error during pool.end()', err);
  } finally {
    pool = null;
  }
}
