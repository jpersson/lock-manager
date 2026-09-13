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