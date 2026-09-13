import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PIN encryption: AES-256-GCM with a random key that only ever lives in the
 * add-on's /data volume. Ciphertext format: `<iv>.<tag>.<data>` (base64url).
 */

const KEY_FILE = 'secret.key';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;

export class PinCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Expected a ${KEY_BYTES}-byte key, got ${key.length}`);
    }
  }

  encrypt(pin: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, data].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted PIN');
    }
    const iv = Buffer.from(parts[0] as string, 'base64url');
    const tag = Buffer.from(parts[1] as string, 'base64url');
    const data = Buffer.from(parts[2] as string, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new Error('Malformed encrypted PIN');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Encrypted PIN failed authentication (tampered or wrong key)');
    }
  }
}

/**
 * Loads the PIN encryption key from `<dataDir>/secret.key`, creating it with
 * restrictive permissions on first use.
 */
export function loadOrCreateKey(dataDir: string): Buffer {
  const keyPath = join(dataDir, KEY_FILE);
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(`Corrupt key file ${keyPath}`);
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}