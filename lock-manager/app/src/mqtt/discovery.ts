import type { TopicClient } from './client.js';
import type { Logger } from '../logger.js';

/**
 * Zigbee2MQTT discovery.
 *
 * Reads the retained `bridge/devices` payload to find locks that support PIN
 * codes, and `bridge/info` to confirm the actual base topic.
 */

export interface DiscoveredLock {
  /** IEEE address — stable identifier */
  id: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
  description?: string;
}

interface Expose {
  type?: string;
  name?: string;
  property?: string;
  features?: Expose[];
}

interface BridgeDevice {
  ieee_address?: string;
  friendly_name?: string;
  supported?: boolean;
  disabled?: boolean;
  interview_state?: string;
  definition?: {
    model?: string;
    vendor?: string;
    description?: string;
    exposes?: Expose[];
  } | null;
}

function hasPinCodeComposite(exposes: Expose[] | undefined): boolean {
  if (!Array.isArray(exposes)) {
    return false;
  }
  return exposes.some(
    (expose) =>
      (expose.type === 'composite' &&
        (expose.property === 'pin_code' || expose.name === 'pin_code')) ||
      (expose.type === 'lock' && expose.property === 'pin_code'),
  );
}

/** Extracts PIN-capable locks from a `bridge/devices` payload. */
export function parseBridgeDevices(payload: unknown): DiscoveredLock[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const locks: DiscoveredLock[] = [];
  for (const device of payload as BridgeDevice[]) {
    if (device.supported !== true || device.disabled === true) {
      continue;
    }
    if (!device.ieee_address || !device.friendly_name || !device.definition) {
      continue;
    }
    // Skip devices that are still being interviewed; exposes may be incomplete.
    if (device.interview_state === 'PENDING' || device.interview_state === 'IN_PROGRESS') {
      continue;
    }
    if (!hasPinCodeComposite(device.definition.exposes)) {
      continue;
    }
    const def = device.definition;
    locks.push({
      id: device.ieee_address,
      friendlyName: device.friendly_name,
      ...(def.model ? { model: def.model } : {}),
      ...(def.vendor ? { vendor: def.vendor } : {}),
      ...(def.description ? { description: def.description } : {}),
    });
  }
  return locks;
}

/**
 * Extracts the configured base topic from a `bridge/info` payload
 * (`config.mqtt.base_topic`), if present.
 */
export function extractBaseTopicFromBridgeInfo(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const config = (payload as { config?: unknown }).config;
  if (config === null || typeof config !== 'object') {
    return undefined;
  }
  const mqtt = (config as { mqtt?: unknown }).mqtt;
  if (mqtt === null || typeof mqtt !== 'object') {
    return undefined;
  }
  const base = (mqtt as { base_topic?: unknown }).base_topic;
  return typeof base === 'string' && base !== '' ? base : undefined;
}

/**
 * Subscribes to the Z2M bridge topics and keeps a live list of discovered
 * PIN-capable locks.
 */
export class DiscoveryService {
  private discovered: DiscoveredLock[] = [];
  private readonly locksCallbacks: Array<(locks: DiscoveredLock[]) => void> = [];

  constructor(
    private readonly mqtt: TopicClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.mqtt.subscribe('bridge/devices', (payload) => {
      const locks = parseBridgeDevices(payload);
      this.discovered = locks;
      for (const cb of this.locksCallbacks) {
        cb(locks);
      }
    });
    this.mqtt.subscribe('bridge/info', (payload) => {
      const base = extractBaseTopicFromBridgeInfo(payload);
      if (base !== undefined && base !== this.mqtt.currentBaseTopic) {
        void this.mqtt.setBaseTopic(base).then(() => {
          // After the base topic changed, retained bridge/devices arrives again
          // under the new base; nothing else to do.
        });
      }
    });
    // Re-emit the last known list on reconnects so subscribers can re-render.
    this.mqtt.onConnected(() => {
      for (const cb of this.locksCallbacks) {
        cb(this.discovered);
      }
    });
  }

  onLocks(cb: (locks: DiscoveredLock[]) => void): void {
    this.locksCallbacks.push(cb);
    cb(this.discovered);
  }

  getDiscovered(): DiscoveredLock[] {
    return this.discovered;
  }

  /** Friendly name for a lock id from the last discovery snapshot. */
  friendlyNameOf(id: string): string | undefined {
    return this.discovered.find((l) => l.id === id)?.friendlyName;
  }
}