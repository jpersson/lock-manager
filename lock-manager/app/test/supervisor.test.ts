import { describe, expect, it } from 'vitest';
import { SupervisorClient, type FetchLike } from '../src/ha/supervisor.js';
import { createLogger } from '../src/logger.js';

const quietLogger = createLogger('error', () => {});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SupervisorClient', () => {
  it('reports unavailable without a token', async () => {
    const client = new SupervisorClient({}, async () => jsonResponse(200, {}), quietLogger);
    expect(client.available).toBe(false);
    expect(await client.getMqttService()).toBeUndefined();
  });

  it('returns the MQTT service connection', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        result: 'ok',
        data: {
          addon: 'core_mosquitto',
          host: 'core-mosquitto',
          port: '1883',
          ssl: false,
          username: 'addons',
          password: 'hunter2',
        },
      });
    };
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      fetchImpl,
      quietLogger,
    );
    const conn = await client.getMqttService();
    expect(conn).toEqual({
      host: 'core-mosquitto',
      port: 1883,
      user: 'addons',
      password: 'hunter2',
      ssl: false,
    });
    expect(calls[0]?.url).toBe('http://supervisor/services/mqtt');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok',
    );
  });

  it('returns undefined when the service is missing (404)', async () => {
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      async () => jsonResponse(404, { result: 'error', message: 'No access to mqtt service!' }),
      quietLogger,
    );
    expect(await client.getMqttService()).toBeUndefined();
  });

  it('returns undefined when the supervisor reports an error envelope', async () => {
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      async () => jsonResponse(200, { result: 'error', message: 'boom' }),
      quietLogger,
    );
    expect(await client.getMqttService()).toBeUndefined();
  });

  it('returns undefined on network failure', async () => {
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as FetchLike,
      quietLogger,
    );
    expect(await client.getMqttService()).toBeUndefined();
  });

  it('falls back to port 1883 for a missing or invalid port', async () => {
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      async () =>
        jsonResponse(200, { result: 'ok', data: { host: 'h', port: 'not-a-number' } }),
      quietLogger,
    );
    expect(await client.getMqttService()).toEqual({ host: 'h', port: 1883, ssl: false });
  });
});

describe('SupervisorClient.callNotifyService', () => {
  it('POSTs to /core/api/services/<domain>/<service> with the payload', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { message: 'Notification sent' });
    };
    const client = new SupervisorClient({ SUPERVISOR_TOKEN: 'tok' }, fetchImpl, quietLogger);

    await client.callNotifyService('notify.mobile_app_pixel', 'Lock Manager', 'Alice unlocked front_door');

    expect(calls[0]?.url).toBe('http://supervisor/core/api/services/notify/mobile_app_pixel');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      title: 'Lock Manager',
      message: 'Alice unlocked front_door',
    });
  });

  it('rejects invalid targets', async () => {
    const client = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      async () => jsonResponse(200, {}),
      quietLogger,
    );
    await expect(client.callNotifyService('notify', 't', 'm')).rejects.toThrow(/invalid/i);
    await expect(client.callNotifyService('a/b.c', 't', 'm')).rejects.toThrow(/invalid/i);
  });

  it('throws on HTTP errors and when the supervisor is unavailable', async () => {
    const failing = new SupervisorClient(
      { SUPERVISOR_TOKEN: 'tok' },
      async () => jsonResponse(500, {}),
      quietLogger,
    );
    await expect(failing.callNotifyService('notify.notify', 't', 'm')).rejects.toThrow(/HTTP 500/);

    const offline = new SupervisorClient({}, async () => jsonResponse(200, {}), quietLogger);
    await expect(offline.callNotifyService('notify.notify', 't', 'm')).rejects.toThrow(
      /not available/i,
    );
  });
});