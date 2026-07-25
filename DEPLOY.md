# FlowQ Deployment Guide

FlowQ can be deployed entirely on a **zero-cost, serverless/PaaS stack**. This is the recommended approach for individuals and small teams who want production-grade infrastructure without the overhead of managing Kubernetes.

## Infrastructure Stack

- **Data Layer (Postgres)**: [Neon.tech](https://neon.tech/) (Serverless Postgres)
- **Message Broker (Redis)**: [Upstash](https://upstash.com/) (Serverless Redis)
- **API & Worker Compute**: [Fly.io](https://fly.io/) (Container VMs)
- **Dashboard Frontend**: [Vercel](https://vercel.com/) (Static + SPA hosting)

---

## 1. Provision the Data Layer

Create your free accounts and grab the connection strings.

1. **Neon (Postgres)**: Sign up, create a project, and copy the Postgres connection string. It will look like `postgresql://user:password@host/dbname?sslmode=require`.
2. **Upstash (Redis)**: Sign up, create a Redis database. Go to the "Node.js (ioredis)" section and copy the Redis URL. It will look like `rediss://default:password@host:port`.

## 2. Deploy the Backend (API & Worker)

The backend consists of two Node.js processes built into Docker containers. We deploy both to Fly.io using their generous free tier (up to 3 shared VMs).

### Prerequisites
- Install the [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/).
- Run `fly auth signup` or `fly auth login`.
- **Note:** Fly.io requires a credit card on file for identity verification, but you will not be charged if you stay within the free tier.

### Setup and Deploy

1. **Create the apps:** (Replace `flowq-api` and `flowq-worker` with globally unique names if needed, e.g. `flowq-api-yourname`).
   ```bash
   fly apps create flowq-api
   fly apps create flowq-worker
   ```
2. **Set the secrets:**
   ```bash
   # For the API (Requires API_KEY for authentication)
   fly secrets set -a flowq-api \
     API_KEY="$(openssl rand -hex 32)" \
     REDIS_URL="<your_upstash_redis_url>" \
     DATABASE_URL="<your_neon_postgres_url>"

   # For the Worker
   fly secrets set -a flowq-worker \
     REDIS_URL="<your_upstash_redis_url>" \
     DATABASE_URL="<your_neon_postgres_url>"
   ```
3. **Deploy:**
   Ensure `fly.api.toml` and `fly.worker.toml` reference the correct app names you created in step 1. Then run:
   ```bash
   fly deploy -c fly.api.toml
   fly deploy -c fly.worker.toml
   ```

*Once the API deploys, take note of its URL (e.g. `https://flowq-api.fly.dev`). You will need this for the frontend.*

## 3. Deploy the Dashboard

Vercel will host the frontend React app.

1. Sign in to [Vercel](https://vercel.com).
2. Click **Add New Project** and import your `flowq` GitHub repository.
3. **Configuration Settings**:
    *   **Framework Preset**: Select `Vite`.
    *   **Root Directory**: Click "Edit" and select `packages/dashboard`.
    *   **Environment Variables**:
        *   `VITE_API_URL`: Paste the URL you got from Fly.io in Step 2 (e.g., `https://flowq-api.fly.dev`).
4. Click **Deploy**.

## 4. Verification

Visit your Vercel URL. You should see the FlowQ dashboard. The API connection should light up green, and the worker count should show `1`. You can now start enqueuing jobs!
