/**
 * OpenAPI 3.0 specification for the FlowQ control-plane API.
 *
 * Hand-written, not generated from zod. Why? Because:
 *   1. zod-to-openapi tooling produces schemas that are technically
 *      correct but verbose to the point of being unreadable. Humans
 *      browsing /docs will look at this every day; Prometheus won't.
 *   2. Hand-writing forces us to think about the public contract as a
 *      separate artifact from internal validation. The two converge
 *      (zod is the runtime guard; this is the documented contract)
 *      but they need not be byte-identical, and that's OK.
 *   3. CI can diff this file against route handlers to flag drift
 *      (future hardening item).
 *
 * Update procedure: when you add or change a route, update the schemas
 * and paths below. There's a unit test that loads the spec and asserts
 * `paths` is non-empty for each route prefix — so a new route without
 * docs will fail CI.
 */

/**
 * The return type is `Record<string, unknown>` rather than a typed
 * `OpenAPIObject`. Pulling in a full OpenAPI types package would add
 * a runtime-irrelevant dependency just for one return-type annotation;
 * `swagger-ui-express` accepts `any`. Tradeoff intentionally accepted.
 */
export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'FlowQ API',
      description:
        'Control plane for the FlowQ distributed task queue. Producers enqueue jobs, ' +
        'operators inspect queues and recover failures. All endpoints except /health, ' +
        '/metrics, and /docs require `Authorization: Bearer <API_KEY>`.',
      version: '0.1.0',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local dev (docker-compose)' },
    ],
    tags: [
      { name: 'Jobs', description: 'Enqueue, fetch, and cancel individual jobs' },
      { name: 'Queues', description: 'Per-queue stats, pause/resume, dead-letter handling' },
      { name: 'Workers', description: 'Inspect connected workers' },
      { name: 'Ops', description: 'Health, metrics, docs (no auth required)' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Job: {
          type: 'object',
          required: [
            'id', 'queueName', 'payload', 'priority', 'status', 'attempts',
            'maxAttempts', 'delay', 'createdAt', 'scheduledAt', 'timeout',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            queueName: { type: 'string' },
            payload: { type: 'object', additionalProperties: true },
            priority: { type: 'integer', minimum: 1, maximum: 10 },
            status: {
              type: 'string',
              enum: ['PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED'],
            },
            attempts: { type: 'integer', minimum: 0 },
            maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
            delay: { type: 'integer', minimum: 0, description: 'Initial delay in seconds' },
            idempotencyKey: { type: 'string', nullable: true },
            createdAt: { type: 'integer', format: 'int64', description: 'Unix epoch ms' },
            scheduledAt: { type: 'integer', format: 'int64' },
            startedAt: { type: 'integer', format: 'int64', nullable: true },
            completedAt: { type: 'integer', format: 'int64', nullable: true },
            failedAt: { type: 'integer', format: 'int64', nullable: true },
            lastError: { type: 'string', nullable: true },
            workerId: { type: 'string', nullable: true },
            timeout: { type: 'integer', minimum: 1, description: 'Per-attempt timeout in seconds' },
          },
        },
        EnqueueJobRequest: {
          type: 'object',
          required: ['queueName', 'payload'],
          properties: {
            queueName: {
              type: 'string',
              pattern: '^[A-Za-z0-9_-]+$',
              maxLength: 128,
            },
            payload: { type: 'object', additionalProperties: true },
            priority: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
            delay: { type: 'integer', minimum: 0, default: 0 },
            maxAttempts: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
            idempotencyKey: { type: 'string', nullable: true },
            timeout: { type: 'integer', minimum: 1, maximum: 3600, default: 30 },
          },
        },
        QueueStats: {
          type: 'object',
          required: [
            'queueName', 'enqueued', 'completed', 'failed', 'dead',
            'currentPending', 'currentActive', 'paused',
          ],
          properties: {
            queueName: { type: 'string' },
            enqueued: { type: 'integer' },
            completed: { type: 'integer' },
            failed: { type: 'integer' },
            dead: { type: 'integer' },
            currentPending: { type: 'integer' },
            currentActive: { type: 'integer' },
            paused: { type: 'boolean' },
          },
        },
        DlqEntry: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            jobId: { type: 'string', format: 'uuid' },
            queueName: { type: 'string' },
            payload: { type: 'object', additionalProperties: true },
            lastError: { type: 'string', nullable: true },
            attempts: { type: 'integer' },
            manuallyRetried: { type: 'boolean' },
            diedAt: { type: 'integer', format: 'int64', nullable: true },
            retriedAt: { type: 'integer', format: 'int64', nullable: true },
          },
        },
        WorkerInfo: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            queue: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['idle', 'busy', 'unknown'] },
            startedAt: { type: 'integer', format: 'int64', nullable: true },
            lastHeartbeat: { type: 'integer', format: 'int64', nullable: true },
            currentJobId: { type: 'string', nullable: true },
            staleSeconds: { type: 'integer', nullable: true },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', description: 'Stable machine-readable error code' },
            message: { type: 'string', description: 'Human-readable detail' },
            field: { type: 'string', description: 'Offending field name (validation errors)' },
            issues: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'Detailed validation issues (zod)',
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      // ---------------- Jobs ----------------
      '/jobs': {
        post: {
          tags: ['Jobs'],
          summary: 'Enqueue a new job',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnqueueJobRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Job created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
            },
            '400': errorRef('Validation error'),
            '401': errorRef('Missing or invalid bearer token'),
          },
        },
      },
      '/jobs/{id}': {
        parameters: [pathParam('id', 'string', 'uuid')],
        get: {
          tags: ['Jobs'],
          summary: 'Fetch a job by id (Redis hot path, Postgres fallback)',
          responses: {
            '200': okRef('Job'),
            '401': errorRef('Unauthorized'),
            '404': errorRef('Job not found'),
          },
        },
        delete: {
          tags: ['Jobs'],
          summary: 'Cancel a PENDING job',
          description:
            'Only jobs in PENDING state can be cancelled. Once a worker has claimed ' +
            'a job (status=ACTIVE), it must be allowed to finish. Returns 409 in any ' +
            'state other than PENDING.',
          responses: {
            '200': {
              description: 'Cancelled',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      jobId: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': errorRef('Unauthorized'),
            '404': errorRef('Job not found'),
            '409': errorRef('Job not in PENDING state'),
          },
        },
      },

      // ---------------- Queues ----------------
      '/queues/{name}/stats': {
        parameters: [pathParam('name', 'string')],
        get: {
          tags: ['Queues'],
          summary: 'Per-queue counters and live depths',
          responses: {
            '200': okRef('QueueStats'),
            '401': errorRef('Unauthorized'),
          },
        },
      },
      '/queues/{name}/pause': {
        parameters: [pathParam('name', 'string')],
        post: {
          tags: ['Queues'],
          summary: 'Pause workers from claiming new jobs from this queue',
          responses: {
            '200': okMessageRef('Paused'),
            '401': errorRef('Unauthorized'),
          },
        },
      },
      '/queues/{name}/resume': {
        parameters: [pathParam('name', 'string')],
        post: {
          tags: ['Queues'],
          summary: 'Resume workers on this queue',
          responses: {
            '200': okMessageRef('Resumed'),
            '401': errorRef('Unauthorized'),
          },
        },
      },
      '/queues/{name}/dlq': {
        parameters: [pathParam('name', 'string')],
        get: {
          tags: ['Queues'],
          summary: 'Paginated dead-letter queue entries',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: {
            '200': {
              description: 'DLQ page',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jobs: { type: 'array', items: { $ref: '#/components/schemas/DlqEntry' } },
                      total: { type: 'integer' },
                      page: { type: 'integer' },
                      limit: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': errorRef('Unauthorized'),
          },
        },
      },
      '/queues/{name}/dlq/{jobId}/retry': {
        parameters: [pathParam('name', 'string'), pathParam('jobId', 'string', 'uuid')],
        post: {
          tags: ['Queues'],
          summary: 'Manually re-enqueue a dead job (creates a fresh Job)',
          responses: {
            '200': {
              description: 'Re-enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      newJobId: { type: 'string', format: 'uuid' },
                      originalJobId: { type: 'string', format: 'uuid' },
                    },
                  },
                },
              },
            },
            '401': errorRef('Unauthorized'),
            '404': errorRef('DLQ entry not found'),
            '409': errorRef('DLQ entry already retried'),
          },
        },
      },

      // ---------------- Workers ----------------
      '/workers': {
        get: {
          tags: ['Workers'],
          summary: 'List currently registered workers',
          responses: {
            '200': {
              description: 'Worker list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workers: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/WorkerInfo' },
                      },
                    },
                  },
                },
              },
            },
            '401': errorRef('Unauthorized'),
          },
        },
      },

      // ---------------- Ops (no auth) ----------------
      '/health': {
        get: {
          tags: ['Ops'],
          summary: 'Liveness/readiness probe',
          security: [],
          responses: {
            '200': { description: 'All dependencies healthy' },
            '503': { description: 'One or more dependencies unhealthy' },
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Ops'],
          summary: 'Prometheus exposition (text/plain)',
          security: [],
          responses: { '200': { description: 'Metrics text' } },
        },
      },
    },
  };
}

// -----------------------------------------------------------------------
// Tiny helpers to keep the spec readable (lots of repetition otherwise).
// -----------------------------------------------------------------------

function pathParam(
  name: string,
  type: 'string' | 'integer',
  format?: string,
): {
  name: string;
  in: 'path';
  required: true;
  schema: { type: 'string' | 'integer'; format?: string };
} {
  const schema: { type: 'string' | 'integer'; format?: string } = { type };
  if (format) schema.format = format;
  return { name, in: 'path', required: true, schema };
}

function errorRef(description: string): {
  description: string;
  content: { 'application/json': { schema: { $ref: string } } };
} {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
    },
  };
}

function okRef(schemaName: string): {
  description: string;
  content: { 'application/json': { schema: { $ref: string } } };
} {
  return {
    description: 'OK',
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
    },
  };
}

function okMessageRef(description: string): {
  description: string;
  content: {
    'application/json': {
      schema: { type: string; properties: Record<string, { type: string }> };
    };
  };
} {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            queueName: { type: 'string' },
          },
        },
      },
    },
  };
}
