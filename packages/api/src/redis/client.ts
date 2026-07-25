import Redis, { RedisOptions } from 'ioredis';

/**
 * Module-level singleton. Held here (not on `globalThis`) so each
 * Node process gets exactly one client. The `init` / `get` split keeps
 * import-time side effects out of the picture, which makes unit testing
 * sane: a test that imports `redisKeys` does not accidentally connect
 * to a real Redis.
 */
let client: Redis | null = null;

export interface InitRedisOptions {
  host?: string;
  port?: number;
  /**
   * `null` disables the per-request retry cap, which we need for the
   * worker's blocking commands (BLPOP, BRPOPLPUSH, ZSCAN long-running).
   * Default is `null` to be safe across both api and worker callers.
   */
  maxRetriesPerRequest?: number | null;
}

/**
 * Construct (or return the existing) ioredis client.
 *
 * Reads connection params from env vars by default so the same code
 * works in docker-compose, k8s, and a local shell with no changes.
 */
export function initRedis(opts: InitRedisOptions = {}): Redis {
  if (client) return client;

  const config: RedisOptions = {
    host: opts.host ?? process.env.REDIS_HOST ?? 'localhost',
    port: opts.port ?? Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number): number => Math.min(times * 200, 2_000),
  };

  client = new Redis(config);

  client.on('connect', () => {
    console.log(`[redis] connecting tcp://${config.host}:${config.port}`);
  });

  client.on('ready', () => {
    console.log('[redis] ready');
  });

  client.on('error', (err: Error) => {
    console.error(`[redis] error: ${err.message}`);
  });

  client.on('close', () => {
    console.log('[redis] connection closed');
  });

  client.on('reconnecting', (delay: number) => {
    console.log(`[redis] reconnecting in ${delay}ms`);
  });

  return client;
}

/**
 * Accessor used by the rest of the codebase. Throws if `initRedis` has
 * not been called — that mistake should be loud, not silent.
 */
export function getRedis(): Redis {
  if (!client) {
    throw new Error('[redis] getRedis() called before initRedis()');
  }
  return client;
}

/** Graceful shutdown. Safe to call multiple times. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    console.error('[redis] error during quit', err);
  } finally {
    client = null;
  }
}
