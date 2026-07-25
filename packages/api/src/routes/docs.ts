import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import { buildOpenApiSpec } from '../openapi';

/**
 * /docs — interactive Swagger UI.
 *
 * No auth: docs should be discoverable. The keys/data the user can
 * pull through the UI are gated by the `Authorize` button anyway —
 * the UI just sends the configured Bearer token along with each
 * "Try it out" request.
 *
 * If you need to keep docs internal, do it at the network layer
 * (NetworkPolicy, ALB allowlist) — same advice as /metrics.
 *
 * `/docs.json` exposes the raw spec, useful for code generation
 * (openapi-generator-cli, swagger-codegen, the SDK build, etc.).
 */
export function createDocsRouter(): Router {
  const router = Router();
  const spec = buildOpenApiSpec();

  router.get('/docs.json', (_req, res) => {
    res.status(200).json(spec);
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'FlowQ API',
      swaggerOptions: {
        // Persist the Bearer token across page reloads so a developer
        // doesn't have to paste it on every refresh.
        persistAuthorization: true,
        docExpansion: 'list',
      },
    }),
  );

  return router;
}
