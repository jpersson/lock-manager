import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DiscoveryService,
  extractBaseTopicFromBridgeInfo,
  parseBridgeDevices,
  type DiscoveredLock,
} from '../src/mqtt/discovery.js';
import type { TopicClient, MqttMessageHandler } from '../src/mqtt/client.js';
import { createLogger, type Logger } from '../src/logger.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const quietLogger: Logger = createLogger('error', () => {});

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as unknown;
}

describe('parseBridgeDevices', () => {
  it('finds PIN-capable locks and filters everything else out', () => {
    const locks = parseBridgeDevices(loadFixture('bridge-devices.json'));
    expect(locks.map((l) => l.friendlyName).sort()).toEqual([
      'front_door',
      'garage/back_door',
      'nimly_front',
    ]);
    const front = locks.find((l) => l.friendlyName === 'front_door') as DiscoveredLock;
    expect(front.id).toBe('0x286d97000113d867');
    expect(front.model).toBe('910');
    expect(front.vendor).toBe('Kwikset');
    expect(front.description).toContain('SmartCode');
  });

  it('ignores non-array payloads', () => {
    expect(parseBridgeDevices('online')).toEqual([]);
    expect(parseBridgeDevices(null)).toEqual([]);
  });
});

describe('extractBaseTopicFromBridgeInfo', () => {
  it('reads the base topic from config.mqtt', () => {
    expect(extractBaseTopicFromBridgeInfo(loadFixture('bridge-info.json'))).toBe('home/zigbee');
  });

  it('returns undefined for missing or invalid shapes', () => {
    expect(extractBaseTopicFromBridgeInfo({ version: '1.0' })).toBeUndefined();
    expect(extractBaseTopicFromBridgeInfo({ config: { mqtt: {} } })).toBeUndefined();
    expect(extractBaseTopicFromBridgeInfo(null)).toBeUndefined();
    expect(extractBaseTopicFromBridgeInfo({ config: { mqtt: { base_topic: '' } } })).toBeUndefined();
  });
});

class FakeTopicClient implements TopicClient {
  connected = true;
  currentBaseTopic: string;
  handlers = new Map<string, MqttMessageHandler>();
  setBaseTopicCalls: string[] = [];

  constructor(baseTopic = 'zigbee2mqtt') {
    this.currentBaseTopic = baseTopic;
  }

  subscribe(relativeTopic: string, handler: MqttMessageHandler): void {
    this.handlers.set(relativeTopic, handler);
  }

  publish(): Promise<void> {
    return Promise.resolve();
  }

  async setBaseTopic(base: string): Promise<void> {
    this.setBaseTopicCalls.push(base);
    this.currentBaseTopic = base;
  }

  onConnected(): void {}
  onDisconnected(): void {}
  onBaseTopicChanged(): void {}

  deliver(relativeTopic: string, payload: unknown): void {
    this.handlers.get(relativeTopic)?.(payload, { topic: relativeTopic, retain: false });
  }
}

describe('DiscoveryService', () => {
  it('tracks discovered locks and notifies subscribers', () => {
    const mqtt = new FakeTopicClient();
    const discovery = new DiscoveryService(mqtt, quietLogger);
    const seen: DiscoveredLock[][] = [];
    discovery.onLocks((locks) => seen.push(locks));
    discovery.start();

    mqtt.deliver('bridge/devices', loadFixture('bridge-devices.json'));
    expect(discovery.getDiscovered().map((l) => l.friendlyName)).toEqual([
      'front_door',
      'garage/back_door',
      'nimly_front',
    ]);
    expect(seen.at(-1)).toHaveLength(3);
    expect(discovery.friendlyNameOf('0x286d97000113d867')).toBe('front_door');
  });

  it('corrects the base topic when bridge/info reports a different one', () => {
    const mqtt = new FakeTopicClient('zigbee2mqtt');
    const discovery = new DiscoveryService(mqtt, quietLogger);
    discovery.start();

    mqtt.deliver('bridge/info', loadFixture('bridge-info.json'));
    expect(mqtt.setBaseTopicCalls).toEqual(['home/zigbee']);
    expect(mqtt.currentBaseTopic).toBe('home/zigbee');
  });

  it('does not churn the base topic when it already matches', () => {
    const mqtt = new FakeTopicClient('home/zigbee');
    const discovery = new DiscoveryService(mqtt, quietLogger);
    discovery.start();

    mqtt.deliver('bridge/info', loadFixture('bridge-info.json'));
    expect(mqtt.setBaseTopicCalls).toHaveLength(0);
  });
});