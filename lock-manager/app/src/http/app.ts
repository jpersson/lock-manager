import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppOptions } from '../config/options.js';
import type { Logger } from '../logger.js';

export interface AppDeps {
  options: AppOptions;
  logger: Logger;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
// dist/http/app.js -> ../../web = app/web (runtime); src/http/app.ts -> ../../web = app/web (tests)
const webRoot = join(moduleDir, '..', '..', 'web');

/**
 * Builds the Fastify app: health endpoint, HTTP API routes and the SPA
 * (served with relative paths only, Ingress-safe).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Placeholder status endpoint; filled in as the domain layer grows.
  app.get('/api/status', async () => ({
    status: 'ok',
    version: '0.1.0',
    mqtt: 'not-connected',
  }));

  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: true,
    });
    // SPA fallback for GET requests; API routes stay untouched.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    deps.logger.warn('web UI build not found; serving API only', {
      webRoot,
    });
  }

  return app;
}