import { describe, expect, it } from 'vitest';
import { LockEventMonitor, normalizeLockEvent } from '../src/mqtt/events.js';
import type { TopicClient, MqttMessageHandler } from '../src/mqtt/client.js';
import { createLogger, type Logger } from '../src/logger.js';

const quietLogger: Logger = createLogger('error', () => {});

describe('normalizeLockEvent', () => {
  it('recognizes keypad unlock/lock with the user slot', () => {
    expect(
      normalizeLockEvent({ action: 'unlock', action_source_name: 'keypad', action_user: 3 }),
    ).toEqual({ kind: 'keypad-unlock', action: 'unlock', source: 'keypad', slot: 3 });
    expect(
      normalizeLockEvent({ action: 'lock', action_source_name: 'keypad', action_user: 3 }),
    ).toEqual({ kind: 'keypad-lock', action: 'lock', source: 'keypad', slot: 3 });
  });

  it('classifies keypad PIN failures', () => {
    expect(
      normalizeLockEvent({
        action: 'unlock_failure_invalid_pin_or_id',
        action_source_name: 'keypad',
        action_user: 0,
      }),
    ).toEqual({
      kind: 'keypad-failure',
      action: 'unlock_failure_invalid_pin_or_id',
      source: 'keypad',
      slot: 0,
    });
  });

  it('classifies manual operations (log only)', () => {
    expect(normalizeLockEvent({ action: 'manual_unlock' })).toEqual({
      kind: 'manual',
      action: 'manual_unlock',
    });
    expect(normalizeLockEvent({ action: 'key_lock', action_source_name: 'manual' })).toEqual({
      kind: 'manual',
      action: 'key_lock',
      source: 'manual',
    });
  });

  it('classifies remote/auto/schedule/one-touch as other', () => {
    expect(normalizeLockEvent({ action: 'unlock', action_source_name: 'rf' })?.kind).toBe('other');
    expect(normalizeLockEvent({ action: 'auto_lock' })?.kind).toBe('other');
    expect(normalizeLockEvent({ action: 'schedule_unlock' })?.kind).toBe('other');
    expect(normalizeLockEvent({ action: 'one_touch_lock' })?.kind).toBe('other');
    expect(normalizeLockEvent({ action: 'non_access_user_operational_event' })?.kind).toBe('other');
  });

  it('tolerates defensive keypad_* action variants', () => {
    expect(normalizeLockEvent({ action: 'keypad_unlock', action_user: 1 })).toEqual({
      kind: 'keypad-unlock',
      action: 'keypad_unlock',
      slot: 1,
    });
    expect(normalizeLockEvent({ action: 'keypad_lock' })?.kind).toBe('keypad-lock');
  });

  it('ignores state-only payloads and malformed input', () => {
    expect(normalizeLockEvent({ state: 'LOCK', lock_state: 'locked' })).toBeUndefined();
    expect(normalizeLockEvent({})).toBeUndefined();
    expect(normalizeLockEvent('online')).toBeUndefined();
    expect(normalizeLockEvent(null)).toBeUndefined();
  });

  it('drops non-integer or negative action_user values', () => {
    expect(normalizeLockEvent({ action: 'unlock', action_source_name: 'keypad', action_user: 1.5 })?.slot).toBeUndefined();
    expect(normalizeLockEvent({ action: 'unlock', action_source_name: 'keypad', action_user: -1 })?.slot).toBeUndefined();
    expect(normalizeLockEvent({ action: 'unlock', action_source_name: 'keypad', action_user: '3' })?.slot).toBeUndefined();
  });
});

class FakeTopicClient implements TopicClient {
  connected = true;
  currentBaseTopic = 'zigbee2mqtt';
  handlers = new Map<string, MqttMessageHandler>();

  subscribe(topic: string, handler: MqttMessageHandler): void {
    this.handlers.set(topic, handler);
  }
  unsubscribe(topic: string): void {
    this.handlers.delete(topic);
  }
  publish(): Promise<void> {
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

describe('LockEventMonitor', () => {
  it('routes events from the lock state topic with the lock id', () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger);
    const seen: Array<{ lockId: string; action: string }> = [];
    monitor.onEvent((occ) => seen.push({ lockId: occ.lockId, action: occ.event.action }));
    monitor.watch('0x1', 'front_door');
    monitor.watch('0x2', 'garage/back_door');

    mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'keypad', action_user: 2 });
    mqtt.deliver('garage/back_door', { action: 'manual_lock' });
    expect(seen).toEqual([
      { lockId: '0x1', action: 'unlock' },
      { lockId: '0x2', action: 'manual_lock' },
    ]);
  });

  it('ignores state-only messages', () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger);
    const seen: unknown[] = [];
    monitor.onEvent((occ) => seen.push(occ));
    monitor.watch('0x1', 'front_door');

    mqtt.deliver('front_door', { state: 'LOCK' });
    expect(seen).toHaveLength(0);
  });

  it('re-watches under a new friendly name and drops the old subscription', () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger);
    monitor.watch('0x1', 'front_door');
    monitor.watch('0x1', 'front_door_lock');

    expect(mqtt.handlers.has('front_door')).toBe(false);
    expect(mqtt.handlers.has('front_door_lock')).toBe(true);
  });

  it('unwatch stops delivery', () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger);
    monitor.watch('0x1', 'front_door');
    monitor.unwatch('0x1');
    expect(mqtt.handlers.has('front_door')).toBe(false);
    monitor.unwatch('0x1'); // idempotent
  });
});