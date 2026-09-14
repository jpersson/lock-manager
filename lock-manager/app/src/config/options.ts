import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error';

export interface MqttOverride {
  host: string;
  port?: number;
  user?: string;
  password?: string;
}

export interface AppOptions {
  logLevel: LogLevel;
  notificationsEnabled: boolean;
  notifyTarget: string;
  /** After a keypad unlock, wait this many seconds for the lock to re-lock
   *  and send one combined notification; 0 = send immediately */
  notifyCoalesceSeconds: number;
  /** Zigbee2MQTT base topic; confirmed/corrected from bridge/info when connected */
  z2mBaseTopic: string;
  /** Manual MQTT settings; fallback when the Supervisor MQTT service is unavailable */
  mqttOverride?: MqttOverride;
  /** Directory for persistent state (add-on: /data) */
  dataDir: string;
}

interface OptionsFile {
  log_level?: string;
  notifications_enabled?: boolean;
  notify_target?: string;
  notify_coalesce_seconds?: number | string;
  z2m_base_topic?: string;
  mqtt_host?: string;
  mqtt_port?: number | string;
  mqtt_user?: string;
  mqtt_password?: string;
}

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error'];

function normalizeLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.toLowerCase();
  return LOG_LEVELS.includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : 'info';
}

/**
 * Loads the app configuration.
 *
 * In production (add-on) the Supervisor writes /data/options.json. For local
 * development the same values can come from LM_* environment variables.
 */
export function loadOptions(env: NodeJS.ProcessEnv = process.env): AppOptions {
  const dataDir = env.LM_DATA_DIR ?? '/data';
  const optionsPath = join(dataDir, 'options.json');

  let file: OptionsFile = {};
  if (existsSync(optionsPath)) {
    try {
      file = JSON.parse(readFileSync(optionsPath, 'utf8')) as OptionsFile;
    } catch (err) {
      console.warn(`Could not parse ${optionsPath}: ${String(err)}`);
    }
  }

  const host = env.LM_MQTT_HOST || file.mqtt_host || '';
  const portRaw = env.LM_MQTT_PORT || file.mqtt_port;
  const port = portRaw === undefined || portRaw === '' ? undefined : Number(portRaw);
  const user = env.LM_MQTT_USER || file.mqtt_user;
  const password = env.LM_MQTT_PASSWORD || file.mqtt_password;

  const mqttOverride =
    host !== ''
      ? {
          host,
          ...(port !== undefined && !Number.isNaN(port) ? { port } : {}),
          ...(user ? { user } : {}),
          ...(password ? { password } : {}),
        }
      : undefined;

  const coalesceRaw =
    env.LM_NOTIFY_COALESCE_SECONDS ?? file.notify_coalesce_seconds ?? 15;
  const coalesce = Number(coalesceRaw);

  return {
    logLevel: normalizeLogLevel(env.LM_LOG_LEVEL || file.log_level),
    notificationsEnabled:
      (env.LM_NOTIFICATIONS_ENABLED ?? file.notifications_enabled?.toString()) !==
      'false',
    notifyTarget: env.LM_NOTIFY_TARGET || file.notify_target || 'notify.notify',
    notifyCoalesceSeconds:
      Number.isFinite(coalesce) && coalesce >= 0 && coalesce <= 120
        ? coalesce
        : 15,
    z2mBaseTopic: env.LM_Z2M_BASE_TOPIC || file.z2m_base_topic || 'zigbee2mqtt',
    ...(mqttOverride ? { mqttOverride } : {}),
    dataDir,
  };
}