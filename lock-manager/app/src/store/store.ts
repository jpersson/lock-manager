import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateKey, PinCrypto } from './crypto.js';
import {
  defaultState,
  type ActivityEntry,
  type AppState,
  type ManagedLock,
  type PinStatus,
  type Settings,
  type UserEntry,
} from './types.js';
import type { Logger } from '../logger.js';

const STORE_FILE = 'store.json';
const FLUSH_DELAY_MS = 250;

export interface UpsertUser {
  slot: number;
  name: string;
  /** Plain PIN to store (encrypted at rest). Empty/undefined keeps the existing PIN. */
  pin?: string;
}

export interface NewLock {
  id: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
}

/**
 * Persistent app state with atomic writes and PIN encryption.
 *
 * The in-memory state is authoritative; changes are debounced-flushed to
 * `<dataDir>/store.json` via a tmp file + rename so a crash can never leave
 * a half-written store behind.
 */
export class Store {
  private state: AppState;
  private crypto: PinCrypto;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly file: string;

  private constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
    state: AppState,
    crypto: PinCrypto,
  ) {
    this.state = state;
    this.crypto = crypto;
    this.file = join(dataDir, STORE_FILE);
  }

  static async open(dataDir: string, logger: Logger): Promise<Store> {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, STORE_FILE);
    let state: AppState | undefined;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as AppState;
        if (parsed.version !== 1) {
          throw new Error(`unsupported state version ${String(parsed.version)}`);
        }
        state = parsed;
      } catch (err) {
        const backup = join(dataDir, `store.json.corrupt-${Date.now()}`);
        logger.error('store.json unreadable; starting fresh', { error: String(err), backup });
        try {
          renameSync(file, backup);
        } catch {
          /* best effort */
        }
      }
    }
    const crypto = new PinCrypto(loadOrCreateKey(dataDir));
    const store = new Store(dataDir, logger, state ?? defaultState(), crypto);
    // Migrate any settings that were later made configurable through options.
    return store;
  }

  // ---------------------------------------------------------------- settings

  get settings(): Readonly<Settings> {
    return this.state.settings;
  }

  /** Replaces the settings object (the domain layer builds the complete value). */
  updateSettings(settings: Settings): void {
    this.state.settings = { ...settings };
    this.scheduleFlush();
  }

  // ------------------------------------------------------------------- locks

  get locks(): Readonly<Record<string, ManagedLock>> {
    return this.state.locks;
  }

  getLock(id: string): ManagedLock | undefined {
    return this.state.locks[id];
  }

  /** Adds or refreshes a lock; user entries and settings are preserved. */
  addOrUpdateLock(lock: NewLock): ManagedLock {
    const existing = this.state.locks[lock.id];
    if (existing) {
      existing.friendlyName = lock.friendlyName;
      existing.model = lock.model ?? existing.model;
      existing.vendor = lock.vendor ?? existing.vendor;
      this.scheduleFlush();
      return existing;
    }
    const created: ManagedLock = {
      id: lock.id,
      friendlyName: lock.friendlyName,
      ...(lock.model ? { model: lock.model } : {}),
      ...(lock.vendor ? { vendor: lock.vendor } : {}),
      addedAt: new Date().toISOString(),
      users: [],
    };
    this.state.locks[lock.id] = created;
    this.scheduleFlush();
    return created;
  }

  removeLock(id: string): boolean {
    if (this.state.locks[id] === undefined) {
      return false;
    }
    delete this.state.locks[id];
    this.scheduleFlush();
    return true;
  }

  // ------------------------------------------------------------------- users

  getUsers(lockId: string): UserEntry[] {
    return this.state.locks[lockId]?.users ?? [];
  }

  getUser(lockId: string, slot: number): UserEntry | undefined {
    return this.getUsers(lockId).find((u) => u.slot === slot);
  }

  /**
   * Creates or updates a user entry. An empty/omitted PIN keeps the existing
   * encrypted PIN (UI: "leave empty to keep").
   */
  upsertUser(lockId: string, user: UpsertUser): UserEntry {
    const lock = this.state.locks[lockId];
    if (lock === undefined) {
      throw new Error(`Unknown lock ${lockId}`);
    }
    if (!Number.isInteger(user.slot) || user.slot < 0) {
      throw new Error(`Invalid slot ${String(user.slot)}`);
    }
    if (user.name.trim() === '') {
      throw new Error('User name must not be empty');
    }

    const existing = lock.users.find((u) => u.slot === user.slot);
    const newPinProvided = user.pin !== undefined && user.pin !== '';

    if (existing === undefined) {
      const entry: UserEntry = {
        slot: user.slot,
        name: user.name.trim(),
        ...(newPinProvided
          ? { pinEnc: this.crypto.encrypt(user.pin as string), status: 'pending' as PinStatus }
          : {}),
      };
      lock.users.push(entry);
      lock.users.sort((a, b) => a.slot - b.slot);
      this.scheduleFlush();
      return entry;
    }

    existing.name = user.name.trim();
    if (newPinProvided) {
      existing.pinEnc = this.crypto.encrypt(user.pin as string);
      existing.status = 'pending';
      delete existing.lastError;
    }
    this.scheduleFlush();
    return existing;
  }

  removeUser(lockId: string, slot: number): boolean {
    const lock = this.state.locks[lockId];
    if (lock === undefined) {
      return false;
    }
    const index = lock.users.findIndex((u) => u.slot === slot);
    if (index === -1) {
      return false;
    }
    lock.users.splice(index, 1);
    this.scheduleFlush();
    return true;
  }

  /** Decrypts and returns the stored PIN for a slot (transient use only). */
  getPin(lockId: string, slot: number): string | undefined {
    const entry = this.getUser(lockId, slot);
    if (entry?.pinEnc === undefined) {
      return undefined;
    }
    return this.crypto.decrypt(entry.pinEnc);
  }

  /** True when a PIN is stored for the slot (does not decrypt it). */
  hasPin(lockId: string, slot: number): boolean {
    return this.getUser(lockId, slot)?.pinEnc !== undefined;
  }

  setPinStatus(lockId: string, slot: number, status: PinStatus, error?: string): void {
    const entry = this.getUser(lockId, slot);
    if (entry === undefined) {
      return;
    }
    entry.status = status;
    if (error !== undefined) {
      entry.lastError = error;
    } else {
      delete entry.lastError;
    }
    if (status === 'applied') {
      entry.lastAppliedAt = new Date().toISOString();
    }
    this.scheduleFlush();
  }

  // ---------------------------------------------------------------- activity

  addActivity(entry: Omit<ActivityEntry, 'ts'> & { ts?: string }): ActivityEntry {
    const full: ActivityEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    this.state.activity.push(full);
    this.scheduleFlush();
    return full;
  }

  /** Drops entries older than `days`; returns how many were removed. */
  purgeActivityOlderThan(days: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    const before = this.state.activity.length;
    this.state.activity = this.state.activity.filter((e) => {
      const ts = Date.parse(e.ts);
      return Number.isNaN(ts) || ts >= cutoff;
    });
    const removed = before - this.state.activity.length;
    if (removed > 0) {
      this.scheduleFlush();
    }
    return removed;
  }

  getActivity(limit = 100, offset = 0, lockId?: string): { entries: ActivityEntry[]; total: number } {
    const all = lockId
      ? this.state.activity.filter((e) => e.lockId === lockId)
      : this.state.activity;
    const entries = [...all].reverse().slice(offset, offset + limit);
    return { entries, total: all.length };
  }

  // ------------------------------------------------------------ persistence

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushNow();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Writes the state atomically (tmp file + rename). Never throws. */
  flushNow(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      // A failed flush must never crash the process; state stays in memory
      // and the next change retries the write.
      this.logger.error('could not persist store', { error: String(err) });
    }
  }

  /** Cancels pending flushes and writes the state one final time. */
  close(): void {
    this.flushNow();
  }
}