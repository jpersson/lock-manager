import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MqttService,
  tryParseJson,
  type MqttConnection,
  type MqttLike,
  type MqttMessageHandler,
} from '../src/mqtt/client.js';
import { createLogger, type Logger } from '../src/logger.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const quietLogger: Logger = createLogger('error', () => {});

class FakeMqttClient extends EventEmitter implements MqttLike {
  published: Array<{ topic: string; message: string; qos?: number }> = [];
  subscriptions: string[] = [];

  async publishAsync(topic: string, message: string, opts?: { qos?: number }): Promise<void> {
    this.published.push({ topic, message, qos: opts?.qos });
  }

  async subscribeAsync(topic: string): Promise<void> {
    this.subscriptions.push(topic);
  }

  async unsubscribeAsync(topic: string): Promise<void> {
    this.subscriptions = this.subscriptions.filter((t) => t !== topic);
  }

  async endAsync(): Promise<void> {
    this.emit('close');
  }

  /** Simulates an incoming MQTT message. */
  deliver(topic: string, payload: unknown, retain = false): void {
    const message =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('message', topic, Buffer.from(message, 'utf8'), { retain });
  }
}

function createService(opts?: {
  resolve?: () => Promise<MqttConnection | undefined>;
  baseTopic?: string;
  retryDelayMs?: number;
}): { service: MqttService; clients: FakeMqttClient[]; resolve: () => Promise<MqttConnection | undefined> } {
  const clients: FakeMqttClient[] = [];
  const resolve =
    opts?.resolve ??
    (async () => ({ host: 'broker', port: 1883 }) as MqttConnection);
  const service = new MqttService({
    logger: quietLogger,
    resolve,
    baseTopic: opts?.baseTopic ?? 'zigbee2mqtt',
    retryDelayMs: opts?.retryDelayMs ?? 5,
    connectFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  return { service, clients, resolve };
}

async function connect(service: MqttService, clients: FakeMqttClient[]): Promise<FakeMqttClient> {
  void service.start();
  await new Promise((r) => setImmediate(r));
  const client = clients[0];
  if (client === undefined) {
    throw new Error('client was not created');
  }
  client.emit('connect');
  return client;
}

describe('tryParseJson', () => {
  it('parses JSON and falls back to raw text', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson(Buffer.from('hello'))).toBe('hello');
    expect(tryParseJson('')).toBeUndefined();
  });
});

describe('MqttService', () => {
  it('does not connect until resolve() provides a broker', async () => {
    const connections: MqttConnection[] = [];
    const { service, clients } = createService({
      resolve: async () => connections.shift(),
    });
    void service.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(clients).toHaveLength(0);
    expect(service.connected).toBe(false);

    connections.push({ host: 'broker', port: 1883 });
    await new Promise((r) => setTimeout(r, 20));
    expect(clients).toHaveLength(1);
    await service.stop();
  });

  it('subscribes registrations on connect and re-connect', async () => {
    const { service, clients } = createService();
    service.subscribe('bridge/devices', () => undefined);
    const client = await connect(service, clients);

    expect(client.subscriptions).toContain('zigbee2mqtt/bridge/devices');
    client.subscriptions = [];
    client.emit('connect'); // simulate reconnect
    expect(client.subscriptions).toContain('zigbee2mqtt/bridge/devices');
    await service.stop();
  });

  it('routes parsed messages to the matching registration only', async () => {
    const { service, clients } = createService();
    const received: Array<{ payload: unknown; retain: boolean }> = [];
    service.subscribe('bridge/devices', (payload, meta) => {
      received.push({ payload, retain: meta.retain });
    });
    const client = await connect(service, clients);

    client.deliver('zigbee2mqtt/bridge/devices', [{ ieee_address: '0x1' }], true);
    client.deliver('zigbee2mqtt/bridge/health', 'online'); // not registered
    client.deliver('other/base/bridge/devices', []); // different base

    expect(received).toEqual([{ payload: [{ ieee_address: '0x1' }], retain: true }]);
    await service.stop();
  });

  it('publishes JSON to base-prefixed topics with qos 1', async () => {
    const { service, clients } = createService();
    const client = await connect(service, clients);
    await service.publish('front_door/set', { pin_code: { user: 1 } });
    expect(client.published).toEqual([
      { topic: 'zigbee2mqtt/front_door/set', message: '{"pin_code":{"user":1}}', qos: 1 },
    ]);
    await service.stop();
  });

  it('corrects the base topic and re-subscribes everything', async () => {
    const { service, clients } = createService();
    const handler: MqttMessageHandler = () => undefined;
    service.subscribe('bridge/devices', handler);
    service.subscribe('bridge/info', handler);
    const client = await connect(service, clients);

    const baseChanges: string[] = [];
    service.onBaseTopicChanged((base) => baseChanges.push(base));

    await service.setBaseTopic('home/zigbee');
    expect(service.currentBaseTopic).toBe('home/zigbee');
    expect(baseChanges).toEqual(['home/zigbee']);
    expect(client.subscriptions).toContain('home/zigbee/bridge/devices');
    expect(client.subscriptions).toContain('home/zigbee/bridge/info');

    // messages now route under the new base
    const received: unknown[] = [];
    service.subscribe('bridge/state', (payload) => received.push(payload));
    client.deliver('home/zigbee/bridge/state', { state: 'online' });
    expect(received).toEqual([{ state: 'online' }]);
    await service.stop();
  });

  it('emits connect/disconnect callbacks', async () => {
    const { service, clients } = createService();
    const events: string[] = [];
    service.onConnected(() => events.push('connect'));
    service.onDisconnected(() => events.push('disconnect'));
    const client = await connect(service, clients);
    expect(events).toEqual(['connect']);
    client.emit('close');
    expect(events).toEqual(['connect', 'disconnect']);
    await service.stop();
  });

  it('publish rejects when not connected', async () => {
    const { service } = createService();
    await expect(service.publish('x/set', {})).rejects.toThrow(/not connected/i);
  });
});

describe('bridge fixtures', () => {
  it('bridge-info fixture contains a non-default base topic', () => {
    const info = JSON.parse(
      readFileSync(join(fixturesDir, 'bridge-info.json'), 'utf8'),
    ) as { config: { mqtt: { base_topic: string } } };
    expect(info.config.mqtt.base_topic).toBe('home/zigbee');
  });
});