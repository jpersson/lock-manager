import { describe, expect, it } from 'vitest';
import { LockDriver, variantFor } from '../src/mqtt/lockDriver.js';
import type { TopicClient, MqttMessageHandler } from '../src/mqtt/client.js';
import { createLogger, type Logger } from '../src/logger.js';

const quietLogger: Logger = createLogger('error', () => {});

class RecordingTopicClient implements TopicClient {
  connected = true;
  currentBaseTopic = 'zigbee2mqtt';
  published: Array<{ topic: string; payload: unknown; qos?: number }> = [];
  publishShouldFail = false;

  subscribe(_topic: string, _handler: MqttMessageHandler): void {}
  unsubscribe(): void {}
  setBaseTopic(): Promise<void> {
    return Promise.resolve();
  }
  onConnected(): void {}
  onDisconnected(): void {}
  onBaseTopicChanged(): void {}

  publish(topic: string, payload: unknown, qos?: number): Promise<void> {
    if (this.publishShouldFail) {
      return Promise.reject(new Error('broker unreachable'));
    }
    this.published.push({ topic, payload, qos });
    return Promise.resolve();
  }
}

const kwikset = {
  id: '0x286d97000113d867',
  friendlyName: 'front_door',
  model: '910',
  vendor: 'Kwikset',
};

const danalock = {
  id: '0x00158d0005fbd7c2',
  friendlyName: 'garage/back_door',
  model: 'V3-BTZB/V3-BTZBE',
  vendor: 'Danalock',
};

describe('payload variants', () => {
  it('default variant builds the standard pin_code composite set payload', () => {
    expect(variantFor(kwikset).buildSet(3, '1234')).toEqual({
      pin_code: { user: 3, user_type: 'unrestricted', user_enabled: true, pin_code: '1234' },
    });
  });

  it('default variant clears by omitting pin_code (documented remove form)', () => {
    expect(variantFor(kwikset).buildClear(3)).toEqual({ pin_code: { user: 3 } });
  });

  it('Danalock variant matches by vendor and by model prefix', () => {
    expect(variantFor(danalock).id).toBe('danalock');
    expect(variantFor({ ...kwikset, vendor: 'Danalock' }).id).toBe('danalock');
    expect(variantFor({ ...kwikset, model: 'V3-BTZBE' }).id).toBe('danalock');
    expect(variantFor(kwikset).id).toBe('default');
  });

  it('Danalock set payload carries user_status in the same message', () => {
    expect(variantFor(danalock).buildSet(0, '123456')).toEqual({
      pin_code: { user: 0, user_type: 'unrestricted', user_enabled: true, pin_code: '123456' },
      user_status: { user: 0, status: 'enabled' },
    });
    expect(variantFor(danalock).buildClear(0)).toEqual({ pin_code: { user: 0 } });
  });
});

describe('LockDriver', () => {
  it('publishes the set payload to <friendly_name>/set with QoS 1', async () => {
    const mqtt = new RecordingTopicClient();
    const driver = new LockDriver(mqtt, quietLogger);
    await driver.applyPin(kwikset, 2, '998877');
    expect(mqtt.published).toEqual([
      {
        topic: 'front_door/set',
        payload: {
          pin_code: { user: 2, user_type: 'unrestricted', user_enabled: true, pin_code: '998877' },
        },
        qos: 1,
      },
    ]);
  });

  it('publishes the clear payload to <friendly_name>/set', async () => {
    const mqtt = new RecordingTopicClient();
    const driver = new LockDriver(mqtt, quietLogger);
    await driver.clearPin(danalock, 5);
    expect(mqtt.published).toEqual([
      { topic: 'garage/back_door/set', payload: { pin_code: { user: 5 } }, qos: 1 },
    ]);
  });

  it('surfaces publish failures so the caller can mark the slot failed', async () => {
    const mqtt = new RecordingTopicClient();
    mqtt.publishShouldFail = true;
    const driver = new LockDriver(mqtt, quietLogger);
    await expect(driver.applyPin(kwikset, 2, '1234')).rejects.toThrow(/broker unreachable/);
    await expect(driver.clearPin(kwikset, 2)).rejects.toThrow(/broker unreachable/);
  });

  it('the same PIN can be written to multiple locks (fan-out)', async () => {
    const mqtt = new RecordingTopicClient();
    const driver = new LockDriver(mqtt, quietLogger);
    await Promise.all([
      driver.applyPin(kwikset, 1, '445566'),
      driver.applyPin(danalock, 1, '445566'),
    ]);
    expect(mqtt.published.map((p) => p.topic).sort()).toEqual([
      'front_door/set',
      'garage/back_door/set',
    ]);
    expect(new Set(mqtt.published.map((p) => JSON.stringify((p.payload as { pin_code: { pin_code: string } }).pin_code.pin_code)))).toEqual(
      new Set(['"445566"']),
    );
  });
});