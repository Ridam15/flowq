# @flowq/api

The FlowQ control plane: an Express REST API that producers and the
dashboard talk to. Responsible for:

- Accepting job enqueue requests
- Exposing queue / job inspection endpoints
- Serving metrics and health probes
- Authenticating and authorizing API callers

## Current state

Scaffold only. Exposes:

- `GET /health` — liveness probe
- `GET /` — service banner

## Run locally (without Docker)

```bash
pnpm --filter @flowq/api build
pnpm --filter @flowq/api start
```

## Environment variables

| Variable      | Default                                          | Notes                |
| ------------- | ------------------------------------------------ | -------------------- |
| `PORT`        | `3000`                                           | HTTP listen port     |
| `REDIS_URL`   | `redis://redis:6379`                             | Reserved             |
| `DATABASE_URL`| `postgres://flowq:flowq@postgres:5432/flowq`     | Reserved             |
