import type { LogLevel } from './config/options.js';

/**
 * Minimal structured logger for Home Assistant add-on logs.
 *
 * Anything that looks like a PIN, password or secret is scrubbed recursively
 * from every log record, so a PIN can never end up in the log output.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warning: 40,
  error: 50,
};

export type LogFields = Record<string, unknown>;

const SECRET_KEY =
  /^(pin|pincode|pin_code|pinenc|pin_enc|encryptedpin|encrypted_pin|password|passwd|mqttpassword|mqtt_password|secret|secretkey|secret_key|token)$/i;

/** Replaces secret-looking values (deep) with a placeholder. */
export function scrub(value: unknown, keyHint?: string): unknown {
  if (keyHint !== undefined && SECRET_KEY.test(keyHint)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = scrub(item, key);
    }
    return out;
  }
  return value;
}

function formatFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(scrub(fields) as LogFields)) {
    const rendered =
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(' ');
}

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Logger {
  const threshold = LEVEL_ORDER[level];

  function write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const ts = now().toISOString();
    const suffix = fields !== undefined ? ` ${formatFields(fields)}` : '';
    sink(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`);
  }

  return {
    trace: (msg, fields) => write('trace', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warning', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}