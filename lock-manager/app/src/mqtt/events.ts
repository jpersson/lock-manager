import type { TopicClient } from './client.js';
import type { Logger } from '../logger.js';

/**
 * Keypad event detection for Zigbee2MQTT locks.
 *
 * Two event styles exist:
 *
 * 1. `action` style (Kwikset, Weiser, Yale, Danalock, …): the state message
 *    carries `action` (lock | unlock | lock_failure_* | …),
 *    `action_source_name` (keypad | rfid | manual | rf) and `action_user`.
 *
 * 2. `last_*` style (Onesti Nimly, EasyAccess code touch): the lock keeps
 *    *state fields* — `last_unlock_source` / `last_unlock_user` and
 *    `last_lock_source` / `last_lock_user` — that change when someone
 *    operates the lock. Sources: zigbee | keypad | fingerprintsensor | rfid |
 *    self | unknown. There is no explicit event, so changes to these fields
 *    (and lock state transitions) are turned into events.
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
  /** Raw Zigbee2MQTT action string (synthetic 'unlock'/'lock' for last_* style) */
  action: string;
  source?: string;
  /** action_user / last_*_user — Zigbee2MQTT slot number, used verbatim */
  slot?: number;
}

const FAILURE_RE = /^(lock|unlock)_failure_/;

/**
 * Normalizes a Zigbee2MQTT lock state payload into a lock event (`action`
 * style). Returns undefined for payloads without an action.
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

// ---------------------------------------------------------------------------
// last_* style (Onesti/Nimly)
// ---------------------------------------------------------------------------

interface SourceUser {
  source?: string;
  user?: number;
}

export interface LastStyleSnapshot {
  unlock?: SourceUser;
  lock?: SourceUser;
  state?: 'LOCK' | 'UNLOCK';
}

export type LastStyleBaseline = LastStyleSnapshot;

function parseSlot(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * Extracts the last_* style fields (plus the lock state) from a state payload.
 * Returns undefined when the payload carries neither.
 */
export function extractLastStyleSnapshot(payload: unknown): LastStyleSnapshot | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const p = payload as Record<string, unknown>;
  const hasLast =
    'last_unlock_source' in p ||
    'last_unlock_user' in p ||
    'last_lock_source' in p ||
    'last_lock_user' in p;
  const state = p.state === 'LOCK' || p.state === 'UNLOCK' ? p.state : undefined;
  if (!hasLast && state === undefined) {
    return undefined;
  }
  const group = (sourceKey: string, userKey: string): SourceUser | undefined => {
    const source = p[sourceKey];
    const user = p[userKey];
    if (source === undefined && user === undefined) {
      return undefined;
    }
    return {
      ...(typeof source === 'string' ? { source } : {}),
      ...(parseSlot(user) !== undefined ? { user: parseSlot(user) } : {}),
    };
  };
  return {
    unlock: group('last_unlock_source', 'last_unlock_user'),
    lock: group('last_lock_source', 'last_lock_user'),
    ...(state !== undefined ? { state } : {}),
  };
}

function sourceUserEqual(a: SourceUser | undefined, b: SourceUser | undefined): boolean {
  return a?.source === b?.source && a?.user === b?.user;
}

function classifyLast(direction: 'unlock' | 'lock', who: SourceUser | undefined): NormalizedLockEvent {
  const source = who?.source;
  const kind: LockEventKind =
    source === 'keypad'
      ? direction === 'unlock'
        ? 'keypad-unlock'
        : 'keypad-lock'
      : source === 'self'
        ? 'manual'
        : 'other';
  return {
    kind,
    action: direction,
    ...(source !== undefined ? { source } : {}),
    ...(who?.user !== undefined ? { slot: who.user } : {}),
  };
}

export interface LastStyleResult {
  events: NormalizedLockEvent[];
  baseline: LastStyleBaseline;
}

/**
 * Turns a new state message into events by diffing it against the baseline.
 *
 * A direction (unlock/lock) counts as an event when its last_* tuple changed,
 * or — as a fallback for repeated activity by the same user (e.g. the same
 * slot unlocking twice in a row) — when the lock state transitioned. The two
 * detections are deduplicated per direction and message.
 */
export function lastStyleEvents(
  prev: LastStyleBaseline | undefined,
  cur: LastStyleSnapshot,
): LastStyleResult {
  if (prev === undefined) {
    // First message after (re)watching a lock only establishes the baseline;
    // its content is history, not a fresh event.
    return { events: [], baseline: { ...cur } };
  }

  const events: NormalizedLockEvent[] = [];

  // A direction counts as an event when its last_* tuple is present and
  // changed, or — as a fallback for repeated activity by the same user
  // (e.g. the same slot unlocking twice in a row) — when the lock state
  // transitioned. Absent tuples are not treated as changes: partial payloads
  // (the lock only reporting the fields relevant to what happened) must not
  // produce false events. The two detections are deduplicated per direction.
  const unlockChanged = cur.unlock !== undefined && !sourceUserEqual(prev.unlock, cur.unlock);
  const unlockByState = prev.state !== 'UNLOCK' && cur.state === 'UNLOCK';
  if (unlockChanged || unlockByState) {
    events.push(classifyLast('unlock', cur.unlock));
  }

  const lockChanged = cur.lock !== undefined && !sourceUserEqual(prev.lock, cur.lock);
  const lockByState = prev.state !== 'LOCK' && cur.state === 'LOCK';
  if (lockChanged || lockByState) {
    events.push(classifyLast('lock', cur.lock));
  }

  return { events, baseline: { ...cur } };
}

export interface LockEventOccurrence {
  lockId: string;
  friendlyName: string;
  event: NormalizedLockEvent;
}

interface Watch {
  lockId: string;
  topic: string;
  lastBaseline?: LastStyleBaseline;
}

/**
 * Subscribes to the state topics of managed locks and emits normalized events.
 */
export class LockEventMonitor {
  private readonly watches = new Map<string, Watch>();
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
    const watch: Watch = { lockId, topic };
    this.watches.set(lockId, watch);
    this.mqtt.subscribe(topic, (payload, meta) => {
      // Diagnostic aid: with log_level=debug this shows every raw state message
      // the app receives for a watched lock (secrets are scrubbed by the logger).
      this.logger.debug('lock state message', {
        lock: friendlyName,
        topic: meta.topic,
        retain: meta.retain,
        payload,
      });
      this.handleMessage(watch, friendlyName, payload);
    });
  }

  private handleMessage(watch: Watch, friendlyName: string, payload: unknown): void {
    // last_* style baseline diff — computed first so the baseline is always
    // tracked, even for messages consumed by the action style below.
    const snapshot = extractLastStyleSnapshot(payload);
    const lastResult =
      snapshot !== undefined ? lastStyleEvents(watch.lastBaseline, snapshot) : undefined;

    const actionEvent = normalizeLockEvent(payload);

    const emit = (event: NormalizedLockEvent): void => {
      this.logger.debug('lock event', {
        lock: friendlyName,
        kind: event.kind,
        action: event.action,
        source: event.source,
        slot: event.slot,
      });
      for (const cb of this.eventCallbacks) {
        cb({ lockId: watch.lockId, friendlyName, event });
      }
    };

    if (actionEvent !== undefined) {
      // Action style wins for this message (locks use one style or the other).
      emit(actionEvent);
    } else if (lastResult !== undefined) {
      for (const event of lastResult.events) {
        emit(event);
      }
    }

    if (lastResult !== undefined) {
      watch.lastBaseline = lastResult.baseline;
    }
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