import type { TopicClient } from './client.js';
import type { Logger } from '../logger.js';

/**
 * Keypad event detection for Zigbee2MQTT locks.
 *
 * Zigbee2MQTT publishes lock activity on `<base>/<friendly_name>` with:
 * - `action`: lock | unlock | lock_failure_* | unlock_failure_* | manual_lock
 *   | manual_unlock | key_lock | key_unlock | one_touch_lock | auto_lock |
 *   schedule_* | non_access_user_operational_event | unknown
 * - `action_source_name`: keypad | rfid | manual | rf
 * - `action_user`: the user slot that triggered the action
 *
 * Only successful lock/unlock actions from the keypad with a recognized slot
 * produce notifications; everything else is recorded in the activity log.
 */

export type LockEventKind =
  | 'keypad-unlock'
  | 'keypad-lock'
  | 'keypad-failure'
  | 'manual'
  | 'other';

export interface NormalizedLockEvent {
  kind: LockEventKind;
  /** Raw Zigbee2MQTT action string */
  action: string;
  source?: string;
  /** action_user — Zigbee2MQTT slot number, used verbatim */
  slot?: number;
}

const FAILURE_RE = /^(lock|unlock)_failure_/;

/**
 * Normalizes a Zigbee2MQTT lock state payload into a lock event.
 * Returns undefined for payloads without an action (regular state updates).
 */
export function normalizeLockEvent(payload: unknown): NormalizedLockEvent | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const { action, action_source_name, action_user } = payload as {
    action?: unknown;
    action_source_name?: unknown;
    action_user?: unknown;
  };
  if (typeof action !== 'string' || action === '') {
    return undefined;
  }

  const source =
    typeof action_source_name === 'string' && action_source_name !== ''
      ? action_source_name
      : undefined;
  const slot =
    typeof action_user === 'number' && Number.isInteger(action_user) && action_user >= 0
      ? action_user
      : undefined;

  return { kind: classify(action, source), action, ...(source ? { source } : {}), ...(slot !== undefined ? { slot } : {}) };
}

function classify(action: string, source: string | undefined): LockEventKind {
  // Defensive variants: some converters emit keypad_* action names directly.
  if (action === 'keypad_unlock') return 'keypad-unlock';
  if (action === 'keypad_lock') return 'keypad-lock';

  const fromKeypad = source === 'keypad' || source === undefined;

  if (action === 'unlock' || action === 'lock') {
    if (source === 'keypad') return action === 'unlock' ? 'keypad-unlock' : 'keypad-lock';
    return 'other';
  }
  if (FAILURE_RE.test(action)) {
    return fromKeypad ? 'keypad-failure' : 'other';
  }
  if (['manual_lock', 'manual_unlock', 'key_lock', 'key_unlock'].includes(action)) {
    return 'manual';
  }
  return 'other';
}

export interface LockEventOccurrence {
  lockId: string;
  friendlyName: string;
  event: NormalizedLockEvent;
}

/**
 * Subscribes to the state topics of managed locks and emits normalized events.
 */
export class LockEventMonitor {
  private readonly watches = new Map<string, { lockId: string; topic: string }>();
  private readonly eventCallbacks: Array<(occurrence: LockEventOccurrence) => void> = [];

  constructor(
    private readonly mqtt: TopicClient,
    private readonly logger: Logger,
  ) {}

  onEvent(cb: (occurrence: LockEventOccurrence) => void): void {
    this.eventCallbacks.push(cb);
  }

  /** Watches (or re-watches, after a friendly-name change) a managed lock. */
  watch(lockId: string, friendlyName: string): void {
    const existing = this.watches.get(lockId);
    const topic = friendlyName;
    if (existing !== undefined && existing.topic === topic) {
      return;
    }
    if (existing !== undefined) {
      this.mqtt.unsubscribe(existing.topic);
    }
    this.watches.set(lockId, { lockId, topic });
    this.mqtt.subscribe(topic, (payload) => {
      const event = normalizeLockEvent(payload);
      if (event === undefined) {
        return;
      }
      this.logger.debug('lock event', {
        lock: friendlyName,
        kind: event.kind,
        action: event.action,
        slot: event.slot,
      });
      for (const cb of this.eventCallbacks) {
        cb({ lockId, friendlyName, event });
      }
    });
  }

  unwatch(lockId: string): void {
    const existing = this.watches.get(lockId);
    if (existing !== undefined) {
      this.mqtt.unsubscribe(existing.topic);
      this.watches.delete(lockId);
    }
  }

  stop(): void {
    for (const { topic } of this.watches.values()) {
      this.mqtt.unsubscribe(topic);
    }
    this.watches.clear();
  }
}