import { describe, expect, it } from 'vitest';
import { createHarness } from './fakes.js';

describe('app skeleton', () => {
  it('GET /health returns ok', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await h.cleanup();
  });

  it('GET /api/status reports connection and effective settings', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.mqtt).toBe('connected');
    expect(body.baseTopic).toBe('zigbee2mqtt');
    expect(body.notifyTarget).toBe('notify.notify');
    expect(body.notificationsEnabled).toBe(true);
    await h.cleanup();
  });

  it('serves the SPA index for unknown non-API GET paths', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/locks' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    await h.cleanup();
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
    await h.cleanup();
  });
});