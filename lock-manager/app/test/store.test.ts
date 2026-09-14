import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PinCrypto, loadOrCreateKey } from '../src/store/crypto.js';
import { Store } from '../src/store/store.js';
import { createLogger, type Logger } from '../src/logger.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const quietLogger: Logger = createLogger('error', () => {});

describe('PinCrypto', () => {
  it('round-trips a PIN', () => {
    const crypto = new PinCrypto(randomBytes(32));
    const enc = crypto.encrypt('123456');
    expect(enc).not.toContain('123456');
    expect(crypto.decrypt(enc)).toBe('123456');
  });

  it('produces unique ciphertexts for the same PIN (random IV)', () => {
    const crypto = new PinCrypto(randomBytes(32));
    expect(crypto.encrypt('1234')).not.toBe(crypto.encrypt('1234'));
  });

  it('rejects tampered ciphertext', () => {
    const crypto = new PinCrypto(randomBytes(32));
    const enc = crypto.encrypt('1234');
    const [iv, tag, data] = enc.split('.');
    const flipped = (tag.slice(0, -2) + (tag.endsWith('A') ? 'B' : 'A') + tag.slice(-1)).padEnd(
      tag.length,
      tag.endsWith('A') ? 'A' : 'B',
    );
    expect(() => crypto.decrypt([iv, flipped, data].join('.'))).toThrow(/authentication/i);
  });

  it('rejects ciphertext from a different key', () => {
    const enc = new PinCrypto(randomBytes(32)).encrypt('1234');
    expect(() => new PinCrypto(randomBytes(32)).decrypt(enc)).toThrow(/authentication/i);
  });

  it('rejects malformed payloads', () => {
    const crypto = new PinCrypto(randomBytes(32));
    expect(() => crypto.decrypt('garbage')).toThrow(/malformed/i);
    expect(() => crypto.decrypt('a.b.c')).toThrow(/malformed/i);
  });

  it('loads or creates the key file (and reuses it across opens)', () => {
    const dir = tempDir();
    const key1 = loadOrCreateKey(dir);
    const key2 = loadOrCreateKey(dir);
    expect(key1.equals(key2)).toBe(true);
    const pin = new PinCrypto(key1).encrypt('9999');
    expect(new PinCrypto(key2).decrypt(pin)).toBe('9999');
  });
});

describe('Store', () => {
  async function openStore(dir = tempDir()): Promise<Store> {
    return Store.open(dir, quietLogger);
  }

  it('starts with defaults, then persists and reloads state', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    expect(store.settings).toEqual({});
    expect(Object.keys(store.locks)).toHaveLength(0);

    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door', model: '910' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice', pin: '1234' });
    store.addActivity({ lockId: '0x001', lockName: 'front_door', type: 'keypad-unlock', slot: 1, userName: 'Alice' });
    store.flushNow();

    const reloaded = await Store.open(dir, quietLogger);
    expect(reloaded.getLock('0x001')?.friendlyName).toBe('front_door');
    expect(reloaded.getUser('0x001', 1)?.name).toBe('Alice');
    expect(reloaded.getPin('0x001', 1)).toBe('1234');
    expect(reloaded.getActivity(10).total).toBe(1);
  });

  it('never persists a plain PIN in store.json', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 2, name: 'Bob', pin: '43219876' });
    store.flushNow();
    const raw = readStoreJson(dir);
    expect(raw).not.toContain('43219876');
    const pinEnc = (raw.locks['0x001'].users[0] as { pinEnc: string }).pinEnc;
    expect(typeof pinEnc).toBe('string');
  });

  it('empty PIN keeps the existing PIN, new PIN replaces it', async () => {
    const store = await openStore();
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice', pin: '1111' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice' }); // edit without PIN
    expect(store.getPin('0x001', 1)).toBe('1111');
    store.upsertUser('0x001', { slot: 1, name: 'Alice', pin: '' });
    expect(store.getPin('0x001', 1)).toBe('1111');
    store.upsertUser('0x001', { slot: 1, name: 'Alice', pin: '2222' });
    expect(store.getPin('0x001', 1)).toBe('2222');
  });

  it('tracks pending → applied / → failed with error text and timestamp', async () => {
    const store = await openStore();
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 3, name: 'Cara', pin: '5555' });
    expect(store.getUser('0x001', 3)?.status).toBe('pending');

    store.setPinStatus('0x001', 3, 'failed', 'broker unreachable');
    expect(store.getUser('0x001', 3)?.status).toBe('failed');
    expect(store.getUser('0x001', 3)?.lastError).toBe('broker unreachable');

    store.setPinStatus('0x001', 3, 'applied');
    expect(store.getUser('0x001', 3)?.status).toBe('applied');
    expect(store.getUser('0x001', 3)?.lastError).toBeUndefined();
    expect(store.getUser('0x001', 3)?.lastAppliedAt).toBeDefined();
  });

  it('removing a user entry removes it and reports misses', async () => {
    const store = await openStore();
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice' });
    expect(store.removeUser('0x001', 1)).toBe(true);
    expect(store.removeUser('0x001', 1)).toBe(false);
    expect(store.removeUser('0x999', 1)).toBe(false);
  });

  it('atomic write leaves no tmp file behind', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice' });
    store.flushNow();
    expect(existsSync(join(dir, 'store.json'))).toBe(true);
    expect(existsSync(join(dir, 'store.json.tmp'))).toBe(false);
  });

  it('a flush against a vanished data dir never throws (debounce race regression)', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const store = await Store.open(dir, createLogger('error', (line) => lines.push(line)));
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    rmSync(dir, { recursive: true, force: true });
    // The debounced timer firing after the dir is gone must not crash.
    expect(() => store.flushNow()).not.toThrow();
    expect(lines.some((l) => l.includes('could not persist store'))).toBe(true);
  });

  it('recovers from a corrupt store.json by starting fresh (and backs it up)', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    store.addOrUpdateLock({ id: '0x001', friendlyName: 'front_door' });
    store.upsertUser('0x001', { slot: 1, name: 'Alice' });
    store.flushNow();

    writeFileSync(join(dir, 'store.json'), '{not json', 'utf8');
    const reopened = await Store.open(dir, createLogger('error', () => {}));
    expect(Object.keys(reopened.locks)).toHaveLength(0);
    const backups = readdirSync(dir).filter((f) => f.startsWith('store.json.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('purges activity entries older than the retention window', async () => {
    const store = await openStore();
    const now = new Date('2026-09-13T12:00:00Z');
    store.addActivity({ lockId: 'a', lockName: 'A', type: 'system', ts: '2026-06-01T00:00:00Z' }); // >90d
    store.addActivity({ lockId: 'a', lockName: 'A', type: 'system', ts: '2026-09-12T00:00:00Z' }); // recent
    store.addActivity({ lockId: 'a', lockName: 'A', type: 'system', ts: '2026-06-16T00:00:00.001Z' }); // 89d23h — kept
    const removed = store.purgeActivityOlderThan(90, now);
    expect(removed).toBe(1);
    const { entries, total } = store.getActivity(50);
    expect(total).toBe(2);
    expect(entries.map((e) => e.ts)).not.toContain('2026-06-01T00:00:00Z');
  });

  it('lists activity newest-first with limit/offset and optional lock filter', async () => {
    const store = await openStore();
    for (let i = 0; i < 5; i++) {
      store.addActivity({ lockId: i % 2 === 0 ? 'a' : 'b', lockName: 'L', type: 'system', ts: new Date(2026, 0, i + 1).toISOString() });
    }
    const page1 = store.getActivity(2, 0);
    const page2 = store.getActivity(2, 2);
    expect(page1.total).toBe(5);
    expect(page1.entries[0]?.ts).toBe(new Date(2026, 0, 5).toISOString());
    expect(page1.entries).toHaveLength(2);
    expect(page2.entries[0]?.ts).toBe(new Date(2026, 0, 3).toISOString());
    const onlyA = store.getActivity(50, 0, 'a');
    expect(onlyA.total).toBe(3);
    expect(onlyA.entries.every((e) => e.lockId === 'a')).toBe(true);
  });
});

function readStoreJson(dir: string): {
  locks: Record<string, { users: { pinEnc?: string }[] }>;
} {
  return JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as never;
}