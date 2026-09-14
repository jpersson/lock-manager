import { describe, expect, it } from 'vitest';
import {
  extractLastStyleSnapshot,
  lastStyleEvents,
  LockEventMonitor,
  normalizeLockEvent,
} from '../src/mqtt/events.js';
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

describe('last_* style (Onesti/Nimly)', () => {
  const keypadUnlock = {
    state: 'UNLOCK',
    lock_state: 'unlocked',
    last_unlock_source: 'keypad',
    last_unlock_user: '1',
    last_used_pin_code: '1234',
  };

  it('extracts the snapshot and parses string slot numbers', () => {
    expect(extractLastStyleSnapshot(keypadUnlock)).toEqual({
      unlock: { source: 'keypad', user: 1 },
      lock: undefined,
      state: 'UNLOCK',
    });
  });

  it('returns undefined for payloads with no last_* fields and no state', () => {
    expect(extractLastStyleSnapshot({ battery: 90 })).toBeUndefined();
    expect(extractLastStyleSnapshot(null)).toBeUndefined();
  });

  it('first message only establishes the baseline (no historical event)', () => {
    const result = lastStyleEvents(undefined, extractLastStyleSnapshot(keypadUnlock) as never);
    expect(result.unlock).toBeUndefined();
    expect(result.lock).toBeUndefined();
    expect(result.baseline.state).toBe('UNLOCK');
  });

  it('keypad unlock by a user → keypad-unlock event with the slot', () => {
    const baseline = lastStyleEvents(undefined, {
      state: 'LOCK',
      lock: { source: 'self', user: 0 },
    }).baseline;
    const result = lastStyleEvents(baseline, extractLastStyleSnapshot(keypadUnlock) as never);
    expect(result.unlock).toEqual({
      event: { kind: 'keypad-unlock', action: 'unlock', source: 'keypad', slot: 1 },
      viaTupleChange: true,
    });
    expect(result.lock).toBeUndefined();
  });

  it('auto-relock reports as a manual/self lock event', () => {
    let result = lastStyleEvents(undefined, extractLastStyleSnapshot(keypadUnlock) as never);
    result = lastStyleEvents(result.baseline, {
      state: 'LOCK',
      unlock: { source: 'keypad', user: 1 },
      lock: { source: 'self', user: 0 },
    });
    expect(result.lock).toEqual({
      event: { kind: 'manual', action: 'lock', source: 'self', slot: 0 },
      viaTupleChange: true,
    });
    expect(result.unlock).toBeUndefined();
  });

  it('same user unlocking again (tuple unchanged) is caught by the state transition', () => {
    // The Nimly keeps last_unlock_source/user unchanged when the same slot
    // unlocks twice; the LOCK→UNLOCK state transition is the signal.
    let result = lastStyleEvents(undefined, extractLastStyleSnapshot(keypadUnlock) as never);
    result = lastStyleEvents(result.baseline, {
      state: 'LOCK',
      unlock: { source: 'keypad', user: 1 },
      lock: { source: 'self', user: 1 },
    });
    expect(result.lock).toEqual({
      event: { kind: 'manual', action: 'lock', source: 'self', slot: 1 },
      viaTupleChange: true,
    });
    result = lastStyleEvents(result.baseline, { state: 'UNLOCK', unlock: { source: 'keypad', user: 1 } });
    expect(result.unlock).toEqual({
      event: { kind: 'keypad-unlock', action: 'unlock', source: 'keypad', slot: 1 },
      viaTupleChange: false, // detected via the state transition, held briefly
    });
  });

  it('rfid/fingerprint/zigbee/unknown sources classify as other', () => {
    const result = lastStyleEvents({ state: 'LOCK' }, {
      state: 'UNLOCK',
      unlock: { source: 'rfid', user: 3 },
    });
    expect(result.unlock).toEqual({
      event: { kind: 'other', action: 'unlock', source: 'rfid', slot: 3 },
      viaTupleChange: true,
    });
  });

  it('no events when nothing changed', () => {
    const result = lastStyleEvents(
      { state: 'UNLOCK', unlock: { source: 'keypad', user: 1 } },
      { state: 'UNLOCK', unlock: { source: 'keypad', user: 1 } },
    );
    expect(result.unlock).toBeUndefined();
    expect(result.lock).toBeUndefined();
  });

  it('state-only transitions (remote unlock) produce other events', () => {
    const result = lastStyleEvents({ state: 'LOCK' }, { state: 'UNLOCK' });
    expect(result.unlock).toEqual({
      event: { kind: 'other', action: 'unlock' },
      viaTupleChange: false,
    });
  });
});

describe('LockEventMonitor — last_* style end to end', () => {
  const HOLD_MS = 20;

  async function settle(ms = 2 * HOLD_MS): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('Nimly flow: baseline → keypad unlock → auto-relock → re-unlock same user', async () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger, HOLD_MS);
    const seen: Array<{ lockId: string; kind: string; slot?: number }> = [];
    monitor.onEvent((occ) =>
      seen.push({ lockId: occ.lockId, kind: occ.event.kind, slot: occ.event.slot }),
    );
    monitor.watch('0xnimly', 'front_door');

    // retained/initial state: establishes the baseline, no event
    mqtt.deliver('front_door', {
      state: 'LOCK',
      lock_state: 'locked',
      last_unlock_source: 'zigbee',
      last_unlock_user: '0',
      last_lock_source: 'zigbee',
      last_lock_user: '0',
      battery: 95,
    });
    expect(seen).toEqual([]);

    // keypad unlock by user 1
    mqtt.deliver('front_door', {
      state: 'UNLOCK',
      lock_state: 'unlocked',
      last_unlock_source: 'keypad',
      last_unlock_user: '1',
      last_used_pin_code: '1234',
    });
    expect(seen.at(-1)).toEqual({ lockId: '0xnimly', kind: 'keypad-unlock', slot: 1 });

    // auto-relock after 7s
    mqtt.deliver('front_door', {
      state: 'LOCK',
      lock_state: 'locked',
      last_lock_source: 'self',
      last_lock_user: '1',
    });
    expect(seen.at(-1)).toEqual({ lockId: '0xnimly', kind: 'manual', slot: 1 });

    // same user unlocks again — tuple unchanged, the held state-transition
    // fallback fires after the grace period
    mqtt.deliver('front_door', {
      state: 'UNLOCK',
      lock_state: 'unlocked',
      last_unlock_source: 'keypad',
      last_unlock_user: '1',
    });
    await settle();
    expect(seen.at(-1)).toEqual({ lockId: '0xnimly', kind: 'keypad-unlock', slot: 1 });
    expect(seen).toHaveLength(3);
  });

  it('stale-tuple fallback is superseded by the tuple change (E2E duplicate regression)', async () => {
    // The Nimly reports the state change and the last_* update in separate
    // messages. The state transition fires with the PREVIOUS tuple (e.g. a
    // fingerprint unlock from earlier) and must be replaced by the real
    // keypad tuple change that follows moments later — one correct event.
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger, HOLD_MS);
    const seen: Array<{ kind: string; slot?: number; source?: string }> = [];
    monitor.onEvent((occ) =>
      seen.push({ kind: occ.event.kind, slot: occ.event.slot, source: occ.event.source }),
    );
    monitor.watch('0xnimly', 'front_door');

    // baseline: previously unlocked with the fingerprint sensor by user 2
    mqtt.deliver('front_door', {
      state: 'LOCK',
      last_unlock_source: 'fingerprintsensor',
      last_unlock_user: '2',
      last_lock_source: 'self',
      last_lock_user: '2',
    });
    expect(seen).toEqual([]);

    // message A: state transition only — would fire a stale fallback event
    mqtt.deliver('front_door', { state: 'UNLOCK' });
    expect(seen).toEqual([]); // held, not yet emitted

    // message B: the real tuple change (keypad, user 2)
    mqtt.deliver('front_door', {
      last_unlock_source: 'keypad',
      last_unlock_user: '2',
    });

    await settle(); // held fallback is dropped (superseded), never fires
    expect(seen).toEqual([{ kind: 'keypad-unlock', slot: 2, source: 'keypad' }]);
  });

  it('action-style messages still emit exactly one event (no double with state fallback)', () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger);
    const seen: unknown[] = [];
    monitor.onEvent((occ) => seen.push(occ));
    monitor.watch('0xkwikset', 'front_door');

    mqtt.deliver('front_door', {
      state: 'UNLOCK',
      action: 'unlock',
      action_source_name: 'keypad',
      action_user: 2,
    });
    expect(seen).toHaveLength(1);

    // a later state-only message does not re-emit (baseline tracked the state)
    mqtt.deliver('front_door', { state: 'UNLOCK', battery: 88 });
    expect(seen).toHaveLength(1);
  });

  it('re-watching (rename) resets the baseline', async () => {
    const mqtt = new FakeTopicClient();
    const monitor = new LockEventMonitor(mqtt, quietLogger, HOLD_MS);
    const seen: unknown[] = [];
    monitor.onEvent((occ) => seen.push(occ));
    monitor.watch('0x1', 'front_door');
    mqtt.deliver('front_door', { state: 'LOCK', last_unlock_source: 'keypad', last_unlock_user: '1' });
    expect(seen).toHaveLength(0);

    monitor.watch('0x1', 'front_door_lock');
    // the retained state on the new topic re-establishes the baseline
    mqtt.deliver('front_door_lock', { state: 'LOCK', last_unlock_source: 'keypad', last_unlock_user: '1' });
    expect(seen).toHaveLength(0);

    mqtt.deliver('front_door_lock', { state: 'UNLOCK', last_unlock_source: 'keypad', last_unlock_user: '1' });
    await settle();
    expect(seen.at(-1)).toMatchObject({ event: { kind: 'keypad-unlock' } });
  });
});

describe('LockEventMonitor (action style)', () => {
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