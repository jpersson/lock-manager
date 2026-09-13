/** Persistent state shapes (store.json in the add-on /data volume). */

export interface Settings {
  /** HA notify action to call, e.g. notify.notify */
  notifyTarget: string;
  notificationsEnabled: boolean;
}

/** Apply status of a user's PIN on the owning lock, based on the last MQTT write. */
export type PinStatus = 'pending' | 'applied' | 'failed';

export interface UserEntry {
  /** Zigbee2MQTT user/slot number, stored verbatim (no renumbering) */
  slot: number;
  name: string;
  /** AES-256-GCM encrypted PIN; absent when no PIN is managed for this slot */
  pinEnc?: string;
  /** Present only when a PIN is managed */
  status?: PinStatus;
  lastAppliedAt?: string;
  lastError?: string;
}

export interface ManagedLock {
  /** Zigbee2MQTT device IEEE address — stable identifier */
  id: string;
  /** Current Zigbee2MQTT friendly name (used in MQTT topics) */
  friendlyName: string;
  model?: string;
  vendor?: string;
  addedAt: string;
  users: UserEntry[];
}

export type ActivityType =
  | 'keypad-unlock'
  | 'keypad-lock'
  | 'keypad-failure'
  | 'manual'
  | 'other'
  | 'pin-apply'
  | 'pin-clear'
  | 'pin-failed'
  | 'notify-failed'
  | 'system';

export interface ActivityEntry {
  /** ISO timestamp */
  ts: string;
  lockId: string;
  lockName: string;
  type: ActivityType;
  /** Raw Zigbee2MQTT action string, e.g. unlock_failure_invalid_pin_or_id */
  action?: string;
  /** action_source_name, e.g. keypad, manual, rf */
  source?: string;
  /** action_user (Z2M slot number) */
  slot?: number;
  /** Resolved user name for recognized keypad users */
  userName?: string;
  /** Free-form details (error text, etc.) */
  detail?: string;
  /** HA user that performed a mutation (from Ingress X-Remote-User-Name) */
  byUser?: string;
}

export interface AppState {
  version: 1;
  settings: Settings;
  /** keyed by lock id (IEEE address) */
  locks: Record<string, ManagedLock>;
  activity: ActivityEntry[];
}

export function defaultState(): AppState {
  return {
    version: 1,
    settings: {
      notifyTarget: 'notify.notify',
      notificationsEnabled: true,
    },
    locks: {},
    activity: [],
  };
}