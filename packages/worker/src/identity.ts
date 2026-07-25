import { hostname } from 'os';

/**
 * Build the worker ID per spec: `worker-{hostname}-{pid}-{timestamp}`.
 *
 * Three components, each pinning down a different uniqueness axis:
 *   • hostname  — distinguishes pods/VMs in a fleet
 *   • pid       — distinguishes processes on one host (autoscaler restart,
 *                 multi-process supervisor)
 *   • timestamp — breaks the tie when a pid is reused in the same second
 *                 after a crash-restart loop (rare, but possible)
 *
 * We also strip any character that isn't safe in a Redis key. Hostnames
 * on some hosted environments contain dots or colons, and `flowq:worker:{id}`
 * needs the `id` segment to itself be free of `:` so SCAN patterns work.
 */
export function makeWorkerId(): string {
  const safeHost = hostname().replace(/[^A-Za-z0-9_-]/g, '-');
  return `worker-${safeHost}-${process.pid}-${Date.now()}`;
}
