import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/store.js';
import { LockManager } from '../src/domain/lockManager.js';
import { DiscoveryService, type DiscoveredLock } from '../src/mqtt/discovery.js';
import type { SupervisorClient } from '../src/ha/supervisor.js';
import type { TopicClient, MqttMessageHandler } from '../src/mqtt/client.js';
import type { AppOptions } from '../src/config/options.js';
import { loadOptions } from '../src/config/options.js';
import { createLogger, type Logger } from '../src/logger.js';

const quietLogger: Logger = createLogger('error', () => {});
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-domain-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeMqtt implements TopicClient {
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

class FakeDiscovery {
  service: DiscoveryService;
  locksCallbacks: Array<(locks: DiscoveredLock[]) => void> = [];

  constructor(mqtt: TopicClient) {
    this.service = new DiscoveryService(mqtt, quietLogger);
    const original = this.service.onLocks.bind(this.service);
    this.service.onLocks = (cb: (locks: DiscoveredLock[]) => void) => {
      this.locksCallbacks.push(cb);
      original(cb);
    };
    this.service.start();
  }

  publish(locks: DiscoveredLock[]): void {
    this.locksCallbacks.forEach((cb) => cb(locks));
  }
}

class FakeSupervisor {
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

function testOptions(overrides: Partial<AppOptions> = {}): AppOptions {
  return { ...loadOptions({ LM_DATA_DIR: tempDir() }), ...overrides };
}

const frontDoor: DiscoveredLock = {
  id: '0x286d97000113d867',
  friendlyName: 'front_door',
  model: '910',
  vendor: 'Kwikset',
};

const backDoor: DiscoveredLock = {
  id: '0x00158d0005fbd7c2',
  friendlyName: 'garage/back_door',
  model: 'V3-BTZB/V3-BTZBE',
  vendor: 'Danalock',
};

async function createManager(opts?: {
  options?: Partial<AppOptions>;
  mqtt?: FakeMqtt;
  supervisor?: FakeSupervisor;
}): Promise<{
  manager: LockManager;
  store: Store;
  mqtt: FakeMqtt;
  supervisor: FakeSupervisor;
  options: AppOptions;
  discovery: FakeDiscovery;
}> {
  const mqtt = opts?.mqtt ?? new FakeMqtt();
  const supervisor = opts?.supervisor ?? new FakeSupervisor();
  const options = testOptions(opts?.options);
  const store = await Store.open(options.dataDir, quietLogger);
  const discovery = new FakeDiscovery(mqtt);
  const manager = new LockManager({
    store,
    mqtt,
    discovery: discovery.service,
    supervisor: supervisor.asClient(),
    options,
    logger: quietLogger,
  });
  await manager.start();
  return { manager, store, mqtt, supervisor, options, discovery };
}

describe('LockManager — lock management', () => {
  it('manages a lock and watches its state topic', async () => {
    const { manager, store, mqtt } = await createManager();
    manager.manageLock(frontDoor);
    expect(store.getLock(frontDoor.id)?.friendlyName).toBe('front_door');
    expect(mqtt.handlers.has('front_door')).toBe(true);
  });

  it('unmanaging a lock stops watching and drops its users', async () => {
    const { manager, store, mqtt } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 1, name: 'Alice' });
    expect(manager.unmanageLock(frontDoor.id)).toBe(true);
    expect(mqtt.handlers.has('front_door')).toBe(false);
    expect(store.getLock(frontDoor.id)).toBeUndefined();
    expect(manager.unmanageLock(frontDoor.id)).toBe(false);
  });

  it('follows friendly-name changes from discovery', async () => {
    const { manager, store, mqtt, discovery } = await createManager();
    manager.manageLock(frontDoor);
    expect(mqtt.handlers.has('front_door')).toBe(true);

    discovery.publish([{ ...frontDoor, friendlyName: 'front_door_lock' }]);

    expect(store.getLock(frontDoor.id)?.friendlyName).toBe('front_door_lock');
    expect(mqtt.handlers.has('front_door')).toBe(false);
    expect(mqtt.handlers.has('front_door_lock')).toBe(true);
  });
});

describe('LockManager — PIN apply/clear', () => {
  it('applies a stored PIN to the owning lock (status → applied, activity recorded)', async () => {
    const { manager, store, mqtt } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice', pin: '1234' });

    const results = await manager.applyUserPin(frontDoor.id, 2, [], 'admin');
    expect(results).toEqual([{ lockId: frontDoor.id, ok: true }]);
    expect(mqtt.published).toEqual([
      {
        topic: 'front_door/set',
        payload: {
          pin_code: { user: 2, user_type: 'unrestricted', user_enabled: true, pin_code: '1234' },
        },
      },
    ]);
    expect(store.getUser(frontDoor.id, 2)?.status).toBe('applied');
    const activity = store.getActivity(10).entries;
    expect(activity[0]).toMatchObject({
      type: 'pin-apply',
      lockName: 'front_door',
      slot: 2,
      userName: 'Alice',
      byUser: 'admin',
    });
  });

  it('applies the same PIN to multiple locks in one action', async () => {
    const { manager, store, mqtt } = await createManager();
    manager.manageLock(frontDoor);
    manager.manageLock(backDoor);
    store.upsertUser(frontDoor.id, { slot: 1, name: 'Alice', pin: '9988' });

    const results = await manager.applyUserPin(frontDoor.id, 1, [backDoor.id]);
    expect(results).toEqual([
      { lockId: frontDoor.id, ok: true },
      { lockId: backDoor.id, ok: true },
    ]);
    expect(mqtt.published.map((p) => p.topic).sort()).toEqual([
      'front_door/set',
      'garage/back_door/set',
    ]);
    // the user (name + PIN) is mirrored onto the target lock
    expect(store.getUser(backDoor.id, 1)?.name).toBe('Alice');
    expect(store.getPin(backDoor.id, 1)).toBe('9988');
    expect(store.getUser(backDoor.id, 1)?.status).toBe('applied');
  });

  it('marks the slot failed and records the error when a write fails', async () => {
    const mqtt = new FakeMqtt();
    mqtt.failTopics.add('front_door/set');
    const { manager, store } = await createManager({ mqtt });
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice', pin: '1234' });

    const results = await manager.applyUserPin(frontDoor.id, 2);
    expect(results).toEqual([{ lockId: frontDoor.id, ok: false, error: 'broker unreachable' }]);
    const entry = store.getUser(frontDoor.id, 2);
    expect(entry?.status).toBe('failed');
    expect(entry?.lastError).toBe('broker unreachable');
    expect(store.getActivity(10).entries[0]).toMatchObject({
      type: 'pin-failed',
      detail: 'broker unreachable',
    });
  });

  it('rejects apply when no user/PIN is stored', async () => {
    const { manager, store } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 5, name: 'NameOnly' });
    await expect(manager.applyUserPin(frontDoor.id, 5)).rejects.toThrow(/No PIN stored/);
    await expect(manager.applyUserPin(frontDoor.id, 9)).rejects.toThrow(/No user in slot 9/);
  });

  it('clearing a PIN sends the clear payload and removes the entry', async () => {
    const { manager, store, mqtt } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 3, name: 'Bob', pin: '4321' });

    const result = await manager.clearUserPin(frontDoor.id, 3, 'admin');
    expect(result).toEqual({ lockId: frontDoor.id, ok: true });
    expect(mqtt.published).toEqual([
      { topic: 'front_door/set', payload: { pin_code: { user: 3 } } },
    ]);
    expect(store.getUser(frontDoor.id, 3)).toBeUndefined();
    expect(store.getActivity(10).entries[0]).toMatchObject({
      type: 'pin-clear',
      slot: 3,
      userName: 'Bob',
      byUser: 'admin',
    });
  });

  it('failed clear keeps the entry and marks it failed', async () => {
    const mqtt = new FakeMqtt();
    mqtt.failTopics.add('front_door/set');
    const { manager, store } = await createManager({ mqtt });
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 3, name: 'Bob', pin: '4321' });

    const result = await manager.clearUserPin(frontDoor.id, 3);
    expect(result.ok).toBe(false);
    expect(store.getUser(frontDoor.id, 3)).toBeDefined();
    expect(store.getUser(frontDoor.id, 3)?.status).toBe('failed');
  });
});

describe('LockManager — event pipeline + notifications', () => {
  it('recognized keypad unlock → activity + notification with lock/user/action', async () => {
    const { manager, store, mqtt, supervisor } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice' });

    mqtt.deliver('front_door', {
      action: 'unlock',
      action_source_name: 'keypad',
      action_user: 2,
    });
    await new Promise((r) => setImmediate(r));

    expect(supervisor.notifyCalls).toEqual([
      { target: 'notify.notify', title: 'Lock Manager', message: 'Alice unlocked front_door' },
    ]);
    expect(store.getActivity(10).entries[0]).toMatchObject({
      type: 'keypad-unlock',
      lockName: 'front_door',
      slot: 2,
      userName: 'Alice',
      action: 'unlock',
      source: 'keypad',
    });
  });

  it('recognized keypad lock also notifies; unknown slots are logged without notification', async () => {
    const { manager, store, mqtt, supervisor } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice' });

    mqtt.deliver('front_door', { action: 'lock', action_source_name: 'keypad', action_user: 2 });
    mqtt.deliver('front_door', {
      action: 'unlock',
      action_source_name: 'keypad',
      action_user: 42,
    });
    await new Promise((r) => setImmediate(r));

    expect(supervisor.notifyCalls).toHaveLength(1);
    expect(supervisor.notifyCalls[0]?.message).toBe('Alice locked front_door');
    const activity = store.getActivity(10).entries;
    expect(activity[0]).toMatchObject({ type: 'keypad-unlock', slot: 42 });
    expect('userName' in (activity[0] as object)).toBe(false);
    expect(activity[1]).toMatchObject({ type: 'keypad-lock', slot: 2, userName: 'Alice' });
  });

  it('manual and remote events are logged but never notify', async () => {
    const { manager, store, mqtt, supervisor } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice' });

    mqtt.deliver('front_door', { action: 'manual_unlock' });
    mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'rf', action_user: 2 });
    mqtt.deliver('front_door', {
      action: 'unlock_failure_invalid_pin_or_id',
      action_source_name: 'keypad',
      action_user: 2,
    });
    await new Promise((r) => setImmediate(r));

    expect(supervisor.notifyCalls).toHaveLength(0);
    const types = store.getActivity(10).entries.map((e) => e.type);
    expect(types).toEqual(['keypad-failure', 'other', 'manual']);
  });

  it('notification failures land in the activity log and never crash the app', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.shouldFail = true;
    const { manager, store, mqtt } = await createManager({ supervisor });
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice' });

    mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'keypad', action_user: 2 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const activity = store.getActivity(10).entries;
    expect(activity[0]).toMatchObject({
      type: 'notify-failed',
      detail: expect.stringContaining('notify.notify'),
    });
    expect(activity[1]).toMatchObject({ type: 'keypad-unlock' });
  });

  it('respects the notifications toggle and the notify target override', async () => {
    const { manager, store, mqtt, supervisor } = await createManager();
    manager.manageLock(frontDoor);
    store.upsertUser(frontDoor.id, { slot: 2, name: 'Alice' });

    manager.updateSettings({ notificationsEnabled: false });
    mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'keypad', action_user: 2 });
    await new Promise((r) => setImmediate(r));
    expect(supervisor.notifyCalls).toHaveLength(0);

    manager.updateSettings({ notificationsEnabled: true, notifyTarget: 'notify.mobile_app_pixel' });
    mqtt.deliver('front_door', { action: 'lock', action_source_name: 'keypad', action_user: 2 });
    await new Promise((r) => setImmediate(r));
    expect(supervisor.notifyCalls).toEqual([
      { target: 'notify.mobile_app_pixel', title: 'Lock Manager', message: 'Alice locked front_door' },
    ]);

    // clearing the override falls back to the add-on option
    manager.updateSettings({ notifyTarget: null });
    mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'keypad', action_user: 2 });
    await new Promise((r) => setImmediate(r));
    expect(supervisor.notifyCalls[1]?.target).toBe('notify.notify');
  });

  it('purges activity older than 90 days on start', async () => {
    const options = testOptions();
    const store = await Store.open(options.dataDir, quietLogger);
    store.addActivity({
      lockId: 'x',
      lockName: 'X',
      type: 'system',
      ts: '2020-01-01T00:00:00Z',
    });
    store.addActivity({ lockId: 'x', lockName: 'X', type: 'system', ts: new Date().toISOString() });
    store.flushNow();

    const mqtt = new FakeMqtt();
    const supervisor = new FakeSupervisor();
    const manager = new LockManager({
      store,
      mqtt,
      discovery: new DiscoveryService(mqtt, quietLogger),
      supervisor: supervisor.asClient(),
      options,
      logger: quietLogger,
    });
    await manager.start();
    expect(store.getActivity(10).total).toBe(1);
    await manager.stop();
  });
});