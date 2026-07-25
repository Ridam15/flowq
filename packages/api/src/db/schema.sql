-- ============================================================================
-- FlowQ PostgreSQL schema
-- ----------------------------------------------------------------------------
-- This file is the canonical, durable schema for FlowQ. Redis is the hot
-- path; this database is the audit log, the dead-letter store, and the
-- "did this job actually run?" source of truth when ops is paged at 03:00.
--
-- Every statement is `IF NOT EXISTS` so init.ts can apply this file on
-- every API boot without breaking anything. That makes container
-- restarts cheap and bootstrap a no-op when state already exists.
--
-- We rely on Postgres 13+'s built-in `gen_random_uuid()`. No extensions
-- needed in core, but we declare pgcrypto for older clusters / safety.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- jobs: the canonical job record. Mirrors @flowq/sdk Job interface.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY,
    queue_name      VARCHAR(255)    NOT NULL,
    payload         JSONB           NOT NULL,
    priority        INTEGER         NOT NULL DEFAULT 5,
    status          VARCHAR(50)     NOT NULL,
    attempts        INTEGER         NOT NULL DEFAULT 0,
    max_attempts    INTEGER         NOT NULL DEFAULT 3,
    -- The UNIQUE constraint below automatically creates a btree index on
    -- idempotency_key. We deliberately do NOT add a separate
    -- `CREATE INDEX … (idempotency_key)` because that would be a duplicate
    -- index that costs writes and disk for zero query benefit.
    idempotency_key VARCHAR(512)    UNIQUE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    scheduled_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    failed_at       TIMESTAMPTZ,
    last_error      TEXT,
    worker_id       VARCHAR(255),
    timeout_seconds INTEGER         NOT NULL DEFAULT 30
);

-- Hot path: dashboard lists "all FAILED jobs in queue X". Composite
-- index aligned with that exact filter pair.
CREATE INDEX IF NOT EXISTS idx_jobs_queue_status
    ON jobs (queue_name, status);

-- Partial index for the scheduler's "what's eligible right now?" query.
-- Partial because PENDING is a tiny fraction of total jobs over time —
-- a partial index stays small and fast forever. Without this we'd
-- scan COMPLETED rows that we'll never look at again.
CREATE INDEX IF NOT EXISTS idx_jobs_pending_scheduled
    ON jobs (scheduled_at)
    WHERE status = 'PENDING';

-- ----------------------------------------------------------------------------
-- job_events: append-only audit log of every state transition.
-- ----------------------------------------------------------------------------
-- Why a separate table instead of in-place updates only?
--   * Forensics: "why did this job retry 3 times then die?" requires the
--     full trail, not just the terminal state.
--   * Debuggability: a single SELECT on job_id rebuilds the timeline.
--   * Cheap: append-only writes are friendly to Postgres MVCC.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_events (
    id          BIGSERIAL       PRIMARY KEY,
    job_id      UUID            NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_status VARCHAR(50),
    to_status   VARCHAR(50)     NOT NULL,
    worker_id   VARCHAR(255),
    error       TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id
    ON job_events (job_id);

-- ----------------------------------------------------------------------------
-- dead_letter_queue: jobs that exhausted retries.
-- ----------------------------------------------------------------------------
-- A dedicated table (rather than just status='DEAD' in jobs) because:
--   * DLQ has its own lifecycle: manual retry, replay, purge.
--   * Operators query the DLQ by queue, not by job id — different access
--     pattern from the jobs table.
--   * We can prune jobs aggressively while keeping a long-lived DLQ
--     record (TTL/retention policies differ).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id            UUID         NOT NULL REFERENCES jobs(id),
    queue_name        VARCHAR(255) NOT NULL,
    payload           JSONB        NOT NULL,
    last_error        TEXT,
    attempts          INTEGER      NOT NULL,
    died_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    manually_retried  BOOLEAN      DEFAULT FALSE,
    retried_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dlq_queue_name
    ON dead_letter_queue (queue_name);
