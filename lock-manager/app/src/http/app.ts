import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppOptions } from '../config/options.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';
import type { LockManager } from '../domain/lockManager.js';
import type { DiscoveryService } from '../mqtt/discovery.js';
import type { TopicClient } from '../mqtt/client.js';
import { registerRoutes } from './api.js';

export interface AppDeps {
  options: AppOptions;
  logger: Logger;
  store: Store;
  manager: LockManager;
  discovery: DiscoveryService;
  mqtt: TopicClient;
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
    // The API relies on JSON null (e.g. to clear a settings override); AJV's
    // default type coercion would silently turn null into ""/false.
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/status', async () => ({
    status: 'ok',
    version: '0.1.0',
    mqtt: deps.mqtt.connected ? 'connected' : 'disconnected',
    baseTopic: deps.mqtt.currentBaseTopic,
    notifyTarget: deps.manager.notifyTarget,
    notificationsEnabled: deps.manager.notificationsEnabled,
  }));

  registerRoutes(app, deps);

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