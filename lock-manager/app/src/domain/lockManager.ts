import type { Store } from '../store/store.js';
import type { ActivityEntry, ActivityType, ManagedLock } from '../store/types.js';
import type { TopicClient } from '../mqtt/client.js';
import type { DiscoveredLock, DiscoveryService } from '../mqtt/discovery.js';
import { LockDriver, type LockIdentity } from '../mqtt/lockDriver.js';
import { LockEventMonitor, type LockEventKind, type LockEventOccurrence } from '../mqtt/events.js';
import type { SupervisorClient } from '../ha/supervisor.js';
import type { AppOptions } from '../config/options.js';
import type { Logger } from '../logger.js';

/**
 * Domain orchestrator: wires discovery, the lock driver, the event pipeline,
 * notifications and persistence together.
 */

const RETENTION_DAYS = 90;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PinApplyResult {
  lockId: string;
  ok: boolean;
  error?: string;
}

export interface DomainDeps {
  store: Store;
  mqtt: TopicClient;
  discovery: DiscoveryService;
  supervisor: SupervisorClient;
  options: AppOptions;
  logger: Logger;
}

const KIND_TO_ACTIVITY: Record<LockEventKind, ActivityType> = {
  'keypad-unlock': 'keypad-unlock',
  'keypad-lock': 'keypad-lock',
  'keypad-failure': 'keypad-failure',
  manual: 'manual',
  other: 'other',
};

export class LockManager {
  private readonly driver: LockDriver;
  private readonly monitor: LockEventMonitor;
  private purgeTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: DomainDeps) {
    this.driver = new LockDriver(deps.mqtt, deps.logger);
    this.monitor = new LockEventMonitor(deps.mqtt, deps.logger);
    this.monitor.onEvent((occurrence) => this.handleEvent(occurrence));
  }

  async start(): Promise<void> {
    // Watch all managed locks (friendly names may have changed while offline).
    for (const lock of Object.values(this.deps.store.locks)) {
      this.monitor.watch(lock.id, lock.friendlyName);
    }
    // Keep managed locks in sync with discovery (renames).
    this.deps.discovery.onLocks((locks) => this.syncWithDiscovery(locks));
    this.purgeOldActivity();
    this.purgeTimer = setInterval(() => this.purgeOldActivity(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.purgeTimer !== undefined) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = undefined;
    }
    this.monitor.stop();
  }

  private purgeOldActivity(): void {
    const removed = this.deps.store.purgeActivityOlderThan(RETENTION_DAYS);
    if (removed > 0) {
      this.deps.logger.info('purged old activity entries', { removed });
    }
  }

  private syncWithDiscovery(discovered: DiscoveredLock[]): void {
    for (const lock of discovered) {
      const managed = this.deps.store.getLock(lock.id);
      if (managed === undefined) {
        continue;
      }
      if (managed.friendlyName !== lock.friendlyName) {
        this.deps.store.addOrUpdateLock({
          id: lock.id,
          friendlyName: lock.friendlyName,
          ...(lock.model ? { model: lock.model } : {}),
          ...(lock.vendor ? { vendor: lock.vendor } : {}),
        });
        this.monitor.watch(lock.id, lock.friendlyName);
        this.deps.logger.info('lock renamed in Zigbee2MQTT', {
          lock: lock.friendlyName,
          previous: managed.friendlyName,
        });
      }
    }
  }

  // ------------------------------------------------------------- lock mgmt

  manageLock(discovered: DiscoveredLock): ManagedLock {
    const lock = this.deps.store.addOrUpdateLock({
      id: discovered.id,
      friendlyName: discovered.friendlyName,
      ...(discovered.model ? { model: discovered.model } : {}),
      ...(discovered.vendor ? { vendor: discovered.vendor } : {}),
    });
    this.monitor.watch(lock.id, lock.friendlyName);
    return lock;
  }

  unmanageLock(lockId: string): boolean {
    this.monitor.unwatch(lockId);
    return this.deps.store.removeLock(lockId);
  }

  // ------------------------------------------------------------ PIN writes

  private lockIdentity(lockId: string): LockIdentity | undefined {
    const lock = this.deps.store.getLock(lockId);
    if (lock === undefined) {
      return undefined;
    }
    return {
      id: lock.id,
      friendlyName: lock.friendlyName,
      ...(lock.model ? { model: lock.model } : {}),
      ...(lock.vendor ? { vendor: lock.vendor } : {}),
    };
  }

  /**
   * Applies the stored PIN of a user to the owning lock and, optionally, to
   * the same slot on additional managed locks in one action.
   */
  async applyUserPin(
    lockId: string,
    slot: number,
    targetLockIds: string[] = [],
    byUser?: string,
  ): Promise<PinApplyResult[]> {
    const source = this.deps.store.getUser(lockId, slot);
    if (source === undefined) {
      throw new Error(`No user in slot ${slot} of this lock`);
    }
    const pin = this.deps.store.getPin(lockId, slot);
    if (pin === undefined) {
      throw new Error(`No PIN stored for ${source.name} (slot ${slot})`);
    }

    const targetIds = [...new Set([lockId, ...targetLockIds])];
    const results: PinApplyResult[] = [];
    for (const targetId of targetIds) {
      const target = this.lockIdentity(targetId);
      if (target === undefined) {
        results.push({ lockId: targetId, ok: false, error: 'Lock is not managed' });
        continue;
      }
      // Mirror the user (name + PIN) onto the target lock's list so its status
      // is tracked there too.
      this.deps.store.upsertUser(targetId, {
        slot,
        name: source.name,
        ...(targetId === lockId ? {} : { pin }),
      });
      try {
        await this.driver.applyPin(target, slot, pin);
        this.deps.store.setPinStatus(targetId, slot, 'applied');
        this.recordActivity({
          lockId: targetId,
          lockName: target.friendlyName,
          type: 'pin-apply',
          slot,
          userName: source.name,
          ...(byUser ? { byUser } : {}),
        });
        results.push({ lockId: targetId, ok: true });
      } catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        this.deps.store.setPinStatus(targetId, slot, 'failed', error);
        this.recordActivity({
          lockId: targetId,
          lockName: target.friendlyName,
          type: 'pin-failed',
          slot,
          userName: source.name,
          detail: error,
          ...(byUser ? { byUser } : {}),
        });
        results.push({ lockId: targetId, ok: false, error });
      }
    }
    return results;
  }

  /**
   * Clears the PIN on the lock and removes the user entry (per the spec, the
   * clear payload is always sent when removing an entry).
   */
  async clearUserPin(lockId: string, slot: number, byUser?: string): Promise<PinApplyResult> {
    const lock = this.lockIdentity(lockId);
    const entry = this.deps.store.getUser(lockId, slot);
    if (lock === undefined || entry === undefined) {
      throw new Error(`No user in slot ${slot} of this lock`);
    }
    try {
      await this.driver.clearPin(lock, slot);
      this.deps.store.removeUser(lockId, slot);
      this.recordActivity({
        lockId,
        lockName: lock.friendlyName,
        type: 'pin-clear',
        slot,
        userName: entry.name,
        ...(byUser ? { byUser } : {}),
      });
      return { lockId, ok: true };
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      if (entry.pinEnc !== undefined) {
        this.deps.store.setPinStatus(lockId, slot, 'failed', error);
      }
      this.recordActivity({
        lockId,
        lockName: lock.friendlyName,
        type: 'pin-failed',
        slot,
        userName: entry.name,
        detail: error,
        ...(byUser ? { byUser } : {}),
      });
      return { lockId, ok: false, error };
    }
  }

  // --------------------------------------------------------- event pipeline

  private handleEvent({ lockId, friendlyName, event }: LockEventOccurrence): void {
    const lock = this.deps.store.getLock(lockId);
    const lockName = lock?.friendlyName ?? friendlyName;
    const entry =
      event.slot !== undefined ? this.deps.store.getUser(lockId, event.slot) : undefined;

    this.recordActivity({
      lockId,
      lockName,
      type: KIND_TO_ACTIVITY[event.kind],
      action: event.action,
      ...(event.source ? { source: event.source } : {}),
      ...(event.slot !== undefined ? { slot: event.slot } : {}),
      ...(entry ? { userName: entry.name } : {}),
    });

    const recognized =
      entry !== undefined && (event.kind === 'keypad-unlock' || event.kind === 'keypad-lock');
    if (!recognized || !this.notificationsEnabled) {
      return;
    }

    const verb = event.kind === 'keypad-unlock' ? 'unlocked' : 'locked';
    const message = `${entry.name} ${verb} ${lockName}`;
    void this.deps.supervisor
      .callNotifyService(this.notifyTarget, 'Lock Manager', message)
      .then(() => {
        this.deps.logger.info('notification sent', { target: this.notifyTarget, message });
      })
      .catch((err: unknown) => {
        const error = String(err instanceof Error ? err.message : err);
        this.deps.logger.error('notification failed', { target: this.notifyTarget, error });
        this.recordActivity({
          lockId,
          lockName,
          type: 'notify-failed',
          detail: `notify ${this.notifyTarget}: ${error}`,
        });
      });
  }

  private recordActivity(entry: Omit<ActivityEntry, 'ts'>): void {
    this.deps.store.addActivity(entry);
  }

  // ------------------------------------------------------------- settings

  get notifyTarget(): string {
    return this.deps.store.settings.notifyTarget ?? this.deps.options.notifyTarget;
  }

  get notificationsEnabled(): boolean {
    return this.deps.store.settings.notificationsEnabled ?? this.deps.options.notificationsEnabled;
  }

  updateSettings(patch: { notifyTarget?: string | null; notificationsEnabled?: boolean | null }): void {
    const current = this.deps.store.settings;
    const next: { notifyTarget?: string; notificationsEnabled?: boolean } = {
      ...(current.notifyTarget !== undefined ? { notifyTarget: current.notifyTarget } : {}),
      ...(current.notificationsEnabled !== undefined
        ? { notificationsEnabled: current.notificationsEnabled }
        : {}),
    };
    if (patch.notifyTarget !== undefined && patch.notifyTarget !== null) {
      next.notifyTarget = patch.notifyTarget;
    } else if (patch.notifyTarget === null) {
      delete next.notifyTarget;
    }
    if (patch.notificationsEnabled !== undefined && patch.notificationsEnabled !== null) {
      next.notificationsEnabled = patch.notificationsEnabled;
    } else if (patch.notificationsEnabled === null) {
      delete next.notificationsEnabled;
    }
    this.deps.store.updateSettings(next);
  }
}