import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { LockManager } from '../src/domain/lockManager.js';
import { DiscoveryService, type DiscoveredLock } from '../src/mqtt/discovery.js';
import type { SupervisorClient } from '../src/ha/supervisor.js';
import type { TopicClient, MqttMessageHandler } from '../src/mqtt/client.js';
import type { AppOptions } from '../src/config/options.js';
import { loadOptions } from '../src/config/options.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';

export const quietLogger: Logger = createLogger('error', () => {});

export class FakeMqtt implements TopicClient {
  connected = true;
  currentBaseTopic = 'zigbee2mqtt';
  handlers = new Map<string, MqttMessageHandler>();
  published: Array<{ topic: string; payload: unknown }> = [];
  failTopics = new Set<string>();

  subscribe(topic: string, handler: MqttMessageHandler): void {
    this.handlers.set(topic, handler);
  }
  unsubscribe(topic: string): void {
    this.handlers.delete(topic);
  }
  publish(topic: string, payload: unknown): Promise<void> {
    if (this.failTopics.has(topic)) {
      return Promise.reject(new Error('broker unreachable'));
    }
    this.published.push({ topic, payload });
    return Promise.resolve();
  }
  setBaseTopic(): Promise<void> {
    return Promise.resolve();
  }
  onConnected(): void {}
  onDisconnected(): void {}
  onBaseTopicChanged(): void {}

  deliver(topic: string, payload: unknown): void {
    this.handlers.get(topic)?.(payload, { topic, retain: false });
  }
}

export class FakeSupervisor {
  notifyCalls: Array<{ target: string; title: string; message: string }> = [];
  shouldFail = false;

  asClient(): SupervisorClient {
    return {
      available: true,
      getMqttService: () => Promise.resolve(undefined),
      callNotifyService: (target: string, title: string, message: string) => {
        this.notifyCalls.push({ target, title, message });
        if (this.shouldFail) {
          return Promise.reject(new Error('HTTP 404'));
        }
        return Promise.resolve();
      },
    } as unknown as SupervisorClient;
  }
}

export interface TestHarness {
  app: FastifyInstance;
  store: Store;
  manager: LockManager;
  mqtt: FakeMqtt;
  supervisor: FakeSupervisor;
  options: AppOptions;
  discovery: FakeDiscoveryHandle;
  cleanup: () => Promise<void>;
}

export class FakeDiscoveryHandle {
  service: DiscoveryService;
  private readonly mqtt: FakeMqtt;

  constructor(mqtt: FakeMqtt) {
    this.mqtt = mqtt;
    this.service = new DiscoveryService(mqtt, quietLogger);
    this.service.start();
  }

  /** Simulates a fresh bridge/devices delivery (updates the service too). */
  publish(locks: DiscoveredLock[]): void {
    this.mqtt.deliver(
      'bridge/devices',
      locks.map((l) => ({
        ieee_address: l.id,
        friendly_name: l.friendlyName,
        supported: true,
        disabled: false,
        interview_state: 'SUCCESSFUL',
        definition: {
          ...(l.model ? { model: l.model } : {}),
          ...(l.vendor ? { vendor: l.vendor } : {}),
          ...(l.description ? { description: l.description } : {}),
          exposes: [
            { type: 'lock', name: 'state', property: 'state', values: ['LOCK', 'UNLOCK'] },
            {
              type: 'composite',
              name: 'pin_code',
              property: 'pin_code',
              features: [
                { type: 'numeric', name: 'user', property: 'user' },
                { type: 'numeric', name: 'pin_code', property: 'pin_code' },
              ],
            },
          ],
        },
      })),
    );
  }
}

export async function createHarness(opts?: {
  options?: Partial<AppOptions>;
  mqtt?: FakeMqtt;
  supervisor?: FakeSupervisor;
  startManager?: boolean;
}): Promise<TestHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-harness-'));
  const options: AppOptions = { ...loadOptions({ LM_DATA_DIR: dataDir }), ...opts?.options };
  const mqtt = opts?.mqtt ?? new FakeMqtt();
  const supervisor = opts?.supervisor ?? new FakeSupervisor();
  const store = await Store.open(dataDir, quietLogger);
  const discovery = new FakeDiscoveryHandle(mqtt);
  const manager = new LockManager({
    store,
    mqtt,
    discovery: discovery.service,
    supervisor: supervisor.asClient(),
    options,
    logger: quietLogger,
  });
  if (opts?.startManager !== false) {
    await manager.start();
  }
  const app = await buildApp({
    options,
    logger: quietLogger,
    store,
    manager,
    discovery: discovery.service,
    mqtt,
  });

  return {
    app,
    store,
    manager,
    mqtt,
    supervisor,
    options,
    discovery,
    cleanup: async () => {
      await manager.stop();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const frontDoor: DiscoveredLock = {
  id: '0x286d97000113d867',
  friendlyName: 'front_door',
  model: '910',
  vendor: 'Kwikset',
};

export const backDoor: DiscoveredLock = {
  id: '0x00158d0005fbd7c2',
  friendlyName: 'garage/back_door',
  model: 'V3-BTZB/V3-BTZBE',
  vendor: 'Danalock',
};