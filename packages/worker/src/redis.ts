import Redis, { RedisOptions } from 'ioredis';
import { logger } from './logger';

/**
 * Worker-side Redis singleton. Mirrors the API's pattern but lives here
 * so the worker process has zero runtime dep on @flowq/api.
 *
 * Why duplicate ~30 lines instead of factoring to a shared package?
 *   • The connection lifecycle has process-side effects (event handlers,
 *     reconnect strategy). SDK is intentionally side-effect free.
 *   • Two callers, identical 30 lines. The cost of an extra package
 *     (build step, version bump, import path churn) is higher than the
 *     cost of one duplicate. Revisit if a third caller appears.
 */
let client: Redis | null = null;

export function initRedis(): Redis {
  if (client) return client;

  const baseConfig: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number): number => Math.min(times * 200, 2_000),
  };

  if (process.env.REDIS_URL) {
    client = new Redis(process.env.REDIS_URL, baseConfig);
  } else {
    client = new Redis({
      ...baseConfig,
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });
  }

  client.on('connect', () => logger.info('redis_connect', { host: config.host, port: config.port }));
  client.on('ready', () => logger.info('redis_ready'));
  client.on('error', (err: Error) => logger.error('redis_error', { message: err.message }));
  client.on('close', () => logger.info('redis_close'));
  client.on('reconnecting', (delay: number) => logger.info('redis_reconnecting', { delayMs: delay }));

  return client;
}

export function getRedis(): Redis {
  if (!client) throw new Error('[worker] getRedis() called before initRedis()');
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    logger.error('redis_close_error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    client = null;
  }
}
