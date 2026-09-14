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

export interface DirectionEvent {
  event: NormalizedLockEvent;
  /** True when detected from a last_* tuple change; false for the state-transition fallback */
  viaTupleChange: boolean;
}

export interface LastStyleResult {
  /** At most one event per direction */
  unlock?: DirectionEvent;
  lock?: DirectionEvent;
  baseline: LastStyleBaseline;
}

/**
 * Turns a new state message into events by diffing it against the baseline.
 *
 * A direction (unlock/lock) counts as an event when its last_* tuple is
 * present and changed, or — as a fallback for repeated activity by the same
 * user (e.g. the same slot unlocking twice in a row) — when the lock state
 * transitioned. Absent tuples are not treated as changes: partial payloads
 * must not produce false events.
 *
 * The fallback events are weaker: on locks that report the state change and
 * the last_* update in separate messages, the fallback fires first with the
 * previous (stale) tuple and the tuple change supersedes it moments later —
 * the monitor handles that by holding fallback events briefly.
 */
export function lastStyleEvents(
  prev: LastStyleBaseline | undefined,
  cur: LastStyleSnapshot,
): LastStyleResult {
  if (prev === undefined) {
    // First message after (re)watching a lock only establishes the baseline;
    // its content is history, not a fresh event.
    return { baseline: { ...cur } };
  }

  const unlockChanged = cur.unlock !== undefined && !sourceUserEqual(prev.unlock, cur.unlock);
  const unlockByState = prev.state !== 'UNLOCK' && cur.state === 'UNLOCK';

  const lockChanged = cur.lock !== undefined && !sourceUserEqual(prev.lock, cur.lock);
  const lockByState = prev.state !== 'LOCK' && cur.state === 'LOCK';

  return {
    ...(unlockChanged || unlockByState
      ? {
          unlock: {
            event: classifyLast('unlock', cur.unlock),
            viaTupleChange: unlockChanged,
          },
        }
      : {}),
    ...(lockChanged || lockByState
      ? {
          lock: {
            event: classifyLast('lock', cur.lock),
            viaTupleChange: lockChanged,
          },
        }
      : {}),
    baseline: { ...cur },
  };
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
  /** Held state-transition fallback events, per direction, pending their brief grace period */
  held: Map<'unlock' | 'lock', { event: NormalizedLockEvent; timer: NodeJS.Timeout }>;
}

/** How long a state-transition fallback event is held before it is emitted.
 *  If the real last_* tuple change arrives within this window (locks that
 *  report state and source/user in separate messages), it supersedes it. */
const FALLBACK_HOLD_MS = 1500;

/**
 * Subscribes to the state topics of managed locks and emits normalized events.
 */
export class LockEventMonitor {
  private readonly watches = new Map<string, Watch>();
  private readonly eventCallbacks: Array<(occurrence: LockEventOccurrence) => void> = [];

  constructor(
    private readonly mqtt: TopicClient,
    private readonly logger: Logger,
    private readonly fallbackHoldMs: number = FALLBACK_HOLD_MS,
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
    const watch: Watch = { lockId, topic, held: new Map() };
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

    if (actionEvent !== undefined) {
      // Action style wins for this message (locks use one style or the other).
      this.emit(watch, friendlyName, actionEvent);
    } else if (lastResult !== undefined) {
      // Tuple-change events carry the real source/user and fire immediately,
      // superseding any held fallback for that direction.
      for (const direction of ['unlock', 'lock'] as const) {
        const result = lastResult[direction];
        if (result === undefined) {
          continue;
        }
        if (result.viaTupleChange) {
          this.clearHeld(watch, direction);
          this.emit(watch, friendlyName, result.event);
        } else {
          // State-transition fallback: hold briefly in case the real tuple
          // change (with the correct source/user) follows.
          this.clearHeld(watch, direction);
          const timer = setTimeout(() => {
            watch.held.delete(direction);
            this.emit(watch, friendlyName, result.event);
          }, this.fallbackHoldMs);
          timer.unref?.();
          watch.held.set(direction, { event: result.event, timer });
        }
      }
    }

    if (lastResult !== undefined) {
      watch.lastBaseline = lastResult.baseline;
    }
  }

  private emit(watch: Watch, friendlyName: string, event: NormalizedLockEvent): void {
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
  }

  private clearHeld(watch: Watch, direction: 'unlock' | 'lock'): void {
    const held = watch.held.get(direction);
    if (held !== undefined) {
      clearTimeout(held.timer);
      watch.held.delete(direction);
    }
  }

  unwatch(lockId: string): void {
    const existing = this.watches.get(lockId);
    if (existing !== undefined) {
      this.mqtt.unsubscribe(existing.topic);
      this.clearAllHeld(existing);
      this.watches.delete(lockId);
    }
  }

  stop(): void {
    for (const watch of this.watches.values()) {
      this.mqtt.unsubscribe(watch.topic);
      this.clearAllHeld(watch);
    }
    this.watches.clear();
  }

  private clearAllHeld(watch: Watch): void {
    for (const direction of watch.held.keys()) {
      this.clearHeld(watch, direction);
    }
  }
}