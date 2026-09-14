import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOptions } from '../src/config/options.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-options-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('options loader', () => {
  it('reads options from /data/options.json format', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'options.json'),
      JSON.stringify({
        log_level: 'debug',
        notifications_enabled: false,
        notify_target: 'notify.mobile_app_pixel',
        z2m_base_topic: 'z2m',
        notify_coalesce_seconds: 3,
        mqtt_host: 'broker.local',
        mqtt_port: 1884,
        mqtt_user: 'user',
        mqtt_password: 'pass',
      }),
    );
    const options = loadOptions({ LM_DATA_DIR: dir });
    expect(options).toEqual({
      logLevel: 'debug',
      notificationsEnabled: false,
      notifyTarget: 'notify.mobile_app_pixel',
      notifyCoalesceSeconds: 3,
      z2mBaseTopic: 'z2m',
      mqttOverride: { host: 'broker.local', port: 1884, user: 'user', password: 'pass' },
      dataDir: dir,
    });
  });

  it('falls back to defaults when no options file exists', () => {
    const dir = tempDir();
    const options = loadOptions({ LM_DATA_DIR: dir });
    expect(options.logLevel).toBe('info');
    expect(options.notificationsEnabled).toBe(true);
    expect(options.notifyTarget).toBe('notify.notify');
    expect(options.notifyCoalesceSeconds).toBe(15);
    expect(options.z2mBaseTopic).toBe('zigbee2mqtt');
    expect(options.mqttOverride).toBeUndefined();
  });

  it('clamps the coalesce window to 0..120 seconds', () => {
    const options = loadOptions({ LM_DATA_DIR: tempDir(), LM_NOTIFY_COALESCE_SECONDS: '999' });
    expect(options.notifyCoalesceSeconds).toBe(15);
    const zero = loadOptions({ LM_DATA_DIR: tempDir(), LM_NOTIFY_COALESCE_SECONDS: '0' });
    expect(zero.notifyCoalesceSeconds).toBe(0);
  });

  it('LM_* env vars override file values (dev mode)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'options.json'), JSON.stringify({ log_level: 'info' }));
    const options = loadOptions({
      LM_DATA_DIR: dir,
      LM_LOG_LEVEL: 'trace',
      LM_Z2M_BASE_TOPIC: 'custom',
      LM_MQTT_HOST: 'h',
      LM_MQTT_PORT: '1883',
    });
    expect(options.logLevel).toBe('trace');
    expect(options.z2mBaseTopic).toBe('custom');
    expect(options.mqttOverride).toEqual({ host: 'h', port: 1883 });
  });

  it('normalizes unknown log levels to info', () => {
    const options = loadOptions({ LM_DATA_DIR: tempDir(), LM_LOG_LEVEL: 'loud' });
    expect(options.logLevel).toBe('info');
  });
});