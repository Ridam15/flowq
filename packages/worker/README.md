# @flowq/worker

Long-running process that reserves jobs from Redis, executes the
registered handler, and writes the result back to PostgreSQL.

Responsible for:

- Reliable job reservation (visibility timeouts, lease renewals)
- Retry policies with exponential backoff
- Dead-letter routing for poisoned jobs
- Graceful shutdown so in-flight jobs are returned to the queue

## Current state

Scaffold only — boots, prints a heartbeat, exits cleanly on `SIGINT`/`SIGTERM`.

## Run locally (without Docker)

```bash
pnpm --filter @flowq/worker build
pnpm --filter @flowq/worker start
```

## Environment variables

| Variable        | Default                                          | Notes                            |
| --------------- | ------------------------------------------------ | -------------------------------- |
| `REDIS_URL`     | `redis://redis:6379`                             | Reserved                         |
| `DATABASE_URL`  | `postgres://flowq:flowq@postgres:5432/flowq`     | Reserved                         |
| `HEARTBEAT_MS`  | `15000`                                          | Status log cadence               |
| `CONCURRENCY`   | `8`                                              | Reserved — max in-flight jobs    |
