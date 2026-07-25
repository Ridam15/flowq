# @flowq/dashboard

React + Vite + TailwindCSS UI for inspecting queues, jobs, and worker
health.

## Current state

Scaffold only. Renders a single page that probes the API's `/health`
endpoint as a connectivity smoke test.

## Run locally (without Docker)

```bash
pnpm --filter @flowq/dashboard dev
# open http://localhost:5173
```

## Environment variables

| Variable        | Default                   | Notes                       |
| --------------- | ------------------------- | --------------------------- |
| `VITE_API_BASE` | `http://localhost:3000`   | Base URL of the FlowQ API   |

## Design notes

This package intentionally overrides `module` and `jsx` from
`tsconfig.base.json` because Vite needs ESM modules and the React JSX
transform — every other package stays on CommonJS as the base mandates.
