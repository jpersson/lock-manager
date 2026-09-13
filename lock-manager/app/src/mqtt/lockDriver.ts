import type { TopicClient } from './client.js';
import type { Logger } from '../logger.js';

/**
 * Zigbee2MQTT lock PIN writes.
 *
 * Payload shapes are taken from the Zigbee2MQTT device documentation:
 * - Default set (Weiser/Kwikset/Datek/ShinaSystem…): the `pin_code` composite
 *   on `<friendly_name>/set`
 * - Default clear: `pin_code` with the value omitted (documented remove form)
 * - Danalock V3: set additionally carries `user_status` in the same message
 *   (the PIN does not work without it; user_type/user_enabled are unused)
 *
 * The app is write-only: PINs are never read back from the lock.
 */

export interface LockIdentity {
  id: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
}

export interface PayloadVariant {
  id: string;
  matches(lock: LockIdentity): boolean;
  buildSet(slot: number, pin: string): Record<string, unknown>;
  buildClear(slot: number): Record<string, unknown>;
}

const DEFAULT_SET_KEYS = { user_type: 'unrestricted', user_enabled: true } as const;

const defaultVariant: PayloadVariant = {
  id: 'default',
  matches: () => true,
  buildSet: (slot, pin) => ({
    pin_code: { user: slot, ...DEFAULT_SET_KEYS, pin_code: pin },
  }),
  buildClear: (slot) => ({ pin_code: { user: slot } }),
};

const danalockVariant: PayloadVariant = {
  id: 'danalock',
  matches: (lock) =>
    /danalock/i.test(lock.vendor ?? '') || /^V3-BTZB/i.test(lock.model ?? ''),
  buildSet: (slot, pin) => ({
    pin_code: { user: slot, user_type: 'unrestricted', user_enabled: true, pin_code: pin },
    user_status: { user: slot, status: 'enabled' },
  }),
  buildClear: (slot) => ({ pin_code: { user: slot } }),
};

const VARIANTS: PayloadVariant[] = [danalockVariant, defaultVariant];

/** Resolves the payload variant for a lock (first match wins; default last). */
export function variantFor(lock: LockIdentity): PayloadVariant {
  return VARIANTS.find((variant) => variant.matches(lock)) ?? defaultVariant;
}

export class LockDriver {
  constructor(
    private readonly mqtt: TopicClient,
    private readonly logger: Logger,
  ) {}

  /** Publishes the set payload for a slot; resolves when the broker acks (QoS 1). */
  async applyPin(lock: LockIdentity, slot: number, pin: string): Promise<void> {
    const variant = variantFor(lock);
    const payload = variant.buildSet(slot, pin);
    await this.mqtt.publish(`${lock.friendlyName}/set`, payload, 1);
    this.logger.info('PIN written to lock', {
      lock: lock.friendlyName,
      slot,
      variant: variant.id,
    });
  }

  /** Publishes the clear payload for a slot (disables/removes the PIN). */
  async clearPin(lock: LockIdentity, slot: number): Promise<void> {
    const variant = variantFor(lock);
    const payload = variant.buildClear(slot);
    await this.mqtt.publish(`${lock.friendlyName}/set`, payload, 1);
    this.logger.info('PIN cleared on lock', {
      lock: lock.friendlyName,
      slot,
      variant: variant.id,
    });
  }
}