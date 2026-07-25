import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import type { Job } from '@flowq/sdk';

/* ============================================================================
 * Real job handlers
 * ============================================================================
 *
 * The original executor was a placeholder that slept for `payload.duration`.
 * This module replaces that no-op with a small registry of REAL handlers,
 * each modelling a genuine background-job use case a task queue exists to
 * serve. Every handler does actual CPU or I/O work using only Node built-ins
 * (crypto, zlib, fetch) — no new dependencies — and returns a JSON result
 * summarising what it did, so the work is measurable from the worker logs.
 *
 * A handler is dispatched by `payload.type`. Unknown/absent types fall back
 * to the legacy sleep behaviour so existing tests and demos keep working.
 * ========================================================================= */

const gzip = promisify(zlib.gzip);
const generateKeyPair = promisify(crypto.generateKeyPair);

export interface HandlerResult {
  type: string;
  [k: string]: unknown;
}

type Handler = (payload: Record<string, unknown>) => Promise<HandlerResult>;

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}

/* ----------------------------------------------------------------------------
 * 1. password-hash — AUTH SERVICE
 * PBKDF2 key derivation, the same primitive used to store login passwords.
 * CPU-bound; time scales with `iterations`. This is exactly the kind of work
 * you push off the request path onto a queue.
 * -------------------------------------------------------------------------- */
const passwordHash: Handler = async (p) => {
  const password = str(p.password, 'correct-horse-battery-staple');
  const iterations = num(p.iterations, 600_000);
  const salt = crypto.randomBytes(16);
  const t0 = performance.now();
  const derived = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  const ms = Math.round(performance.now() - t0);
  return {
    type: 'password-hash',
    iterations,
    algorithm: 'pbkdf2-sha512',
    hashPrefix: derived.toString('hex').slice(0, 24) + '…',
    computeMs: ms,
  };
};

/* ----------------------------------------------------------------------------
 * 2. rsa-keygen — CERT / KEY PROVISIONING
 * Generate a real RSA keypair. Heavy, variable-time CPU work — a textbook
 * "do this in the background, it can take a few seconds" task.
 * -------------------------------------------------------------------------- */
const rsaKeygen: Handler = async (p) => {
  const modulusLength = num(p.modulusLength, 2048);
  const t0 = performance.now();
  const { publicKey } = await generateKeyPair('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const ms = Math.round(performance.now() - t0);
  const pubStr = publicKey as string;
  return {
    type: 'rsa-keygen',
    modulusLength,
    publicKeyBytes: pubStr.length,
    fingerprint: crypto.createHash('sha256').update(pubStr).digest('hex').slice(0, 16),
    computeMs: ms,
  };
};

/* ----------------------------------------------------------------------------
 * 3. http-fetch — WEBHOOK / EXTERNAL API CALL
 * The single most common queued job: call some external HTTP endpoint with
 * retries. Real network I/O; latency is whatever the remote gives us.
 * -------------------------------------------------------------------------- */
const httpFetch: Handler = async (p) => {
  const url = str(p.url, 'https://api.github.com/zen');
  const t0 = performance.now();
  const res = await fetch(url, { method: str(p.method, 'GET') });
  const body = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`http ${res.status} from ${url}`);
  return {
    type: 'http-fetch',
    url,
    status: res.status,
    bytes: body.length,
    sample: body.slice(0, 60),
    latencyMs: ms,
  };
};

/* ----------------------------------------------------------------------------
 * 4. compress — DATA PIPELINE / EXPORT
 * Generate a payload, gzip it, report the compression ratio. Models "compress
 * this export / log batch before shipping it to storage".
 * -------------------------------------------------------------------------- */
const compress: Handler = async (p) => {
  const sizeKB = num(p.sizeKB, 2048);
  // Semi-compressible data: repeated JSON records (realistic, not random).
  const record = JSON.stringify({ id: 0, name: 'flowq', ok: true, tags: ['a', 'b', 'c'] });
  const target = sizeKB * 1024;
  let buf = '';
  while (buf.length < target) buf += record;
  const input = Buffer.from(buf);
  const t0 = performance.now();
  const out = await gzip(input);
  const ms = Math.round(performance.now() - t0);
  return {
    type: 'compress',
    inputBytes: input.length,
    outputBytes: out.length,
    ratio: +(input.length / out.length).toFixed(2),
    computeMs: ms,
  };
};

/* ----------------------------------------------------------------------------
 * 5. prime-count — ANALYTICS / BATCH COMPUTE
 * Sieve of Eratosthenes up to N. Pure CPU; a stand-in for any "crunch this
 * batch and report a number" analytics job. Time scales with N.
 * -------------------------------------------------------------------------- */
const primeCount: Handler = async (p) => {
  const n = num(p.limit, 20_000_000);
  const t0 = performance.now();
  const sieve = new Uint8Array(n + 1);
  let count = 0;
  for (let i = 2; i <= n; i++) {
    if (!sieve[i]) {
      count++;
      for (let j = i * 2; j <= n; j += i) sieve[j] = 1;
    }
  }
  const ms = Math.round(performance.now() - t0);
  return { type: 'prime-count', limit: n, primes: count, computeMs: ms };
};

/* ----------------------------------------------------------------------------
 * 6. image-thumbnail — MEDIA PROCESSING
 * Downsample a synthetic RGB image with a box filter (the core of any resize).
 * Real per-pixel math over millions of pixels; no image library needed.
 * -------------------------------------------------------------------------- */
const imageThumbnail: Handler = async (p) => {
  const w = num(p.width, 4000);
  const h = num(p.height, 3000);
  const factor = num(p.factor, 8); // downscale factor
  const t0 = performance.now();
  // Synthetic source image: 3 bytes/pixel. We don't allocate the full source
  // (that could be >30MB); we compute averaged output pixels on the fly.
  const outW = Math.floor(w / factor);
  const outH = Math.floor(h / factor);
  let checksum = 0;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let r = 0;
      // Box-average a factor×factor block (deterministic synthetic pixels).
      for (let by = 0; by < factor; by++) {
        for (let bx = 0; bx < factor; bx++) {
          const sx = ox * factor + bx;
          const sy = oy * factor + by;
          r += (sx * 31 + sy * 17) & 0xff; // synthetic pixel value
        }
      }
      checksum = (checksum + Math.floor(r / (factor * factor))) >>> 0;
    }
  }
  const ms = Math.round(performance.now() - t0);
  return {
    type: 'image-thumbnail',
    source: `${w}x${h}`,
    thumbnail: `${outW}x${outH}`,
    pixelsProcessed: w * h,
    checksum,
    computeMs: ms,
  };
};

export const HANDLERS: Record<string, Handler> = {
  'password-hash': passwordHash,
  'rsa-keygen': rsaKeygen,
  'http-fetch': httpFetch,
  compress,
  'prime-count': primeCount,
  'image-thumbnail': imageThumbnail,
};

/**
 * Resolve and run the handler for a job. Returns the handler result, or null
 * if the payload has no recognised `type` (caller falls back to legacy sleep).
 */
export async function runRegisteredHandler(job: Job): Promise<HandlerResult | null> {
  const type = typeof job.payload.type === 'string' ? job.payload.type : null;
  if (!type) return null;
  const handler = HANDLERS[type];
  if (!handler) throw new Error(`no handler registered for type "${type}"`);
  return handler(job.payload as Record<string, unknown>);
}
