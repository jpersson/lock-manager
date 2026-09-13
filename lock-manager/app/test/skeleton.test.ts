import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { loadOptions } from '../src/config/options.js';
import type { AppOptions } from '../src/config/options.js';

function testOptions(overrides: Partial<AppOptions> = {}): AppOptions {
  const base = loadOptions({ LM_DATA_DIR: '/tmp/lm-test-data' });
  return { ...base, ...overrides };
}

describe('app skeleton', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp({
      options: testOptions(),
      logger: createLogger('info', () => {}),
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /api/status returns a status payload', async () => {
    const app = await buildApp({
      options: testOptions(),
      logger: createLogger('info', () => {}),
    });
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ok');
    await app.close();
  });

  it('serves the SPA index for unknown non-API GET paths', async () => {
    const app = await buildApp({
      options: testOptions(),
      logger: createLogger('info', () => {}),
    });
    const res = await app.inject({ method: 'GET', url: '/locks' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const app = await buildApp({
      options: testOptions(),
      logger: createLogger('info', () => {}),
    });
    const res = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
    await app.close();
  });
});