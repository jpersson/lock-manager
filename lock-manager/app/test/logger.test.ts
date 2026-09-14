import { describe, expect, it } from 'vitest';
import { createLogger, scrub, type LogFields } from '../src/logger.js';

function collect(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger('trace', (line) => lines.push(line)) };
}

describe('secret scrubbing', () => {
  it('redacts PIN-like and credential-like keys at any depth', () => {
    const fields: LogFields = {
      pin: '1234',
      pin_code: '1234',
      pincode: '1234',
      pinEnc: 'base64==',
      pin_enc: 'base64==',
      encryptedPin: 'abc',
      last_used_pin_code: '1234',
      password: 'hunter2',
      mqtt_password: 'hunter2',
      secret: 's',
      secretKey: 's',
      token: 't',
      nested: { last_used_pin_code: '1234', list: [{ pin: '1234' }] },
      safe: 'visible',
    };
    const scrubbed = JSON.stringify(scrub(fields));
    expect(scrubbed).not.toContain('1234');
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('visible');
    expect(scrubbed).toContain('[redacted]');
  });

  it('keeps non-secret fields intact (PIN-related fields are redacted deliberately)', () => {
    expect(scrub({ slot: 3, name: 'Alice', pinSet: true })).toEqual({
      slot: 3,
      name: 'Alice',
      pinSet: '[redacted]',
    });
  });
});

describe('logger', () => {
  it('never writes a PIN to the output', () => {
    const { lines, logger } = collect();
    logger.info('applying PIN', { lock: 'front_door', pin_code: '987654', slot: 2 });
    const output = lines.join('\n');
    expect(output).toContain('front_door');
    expect(output).not.toContain('987654');
    expect(output).toContain('[redacted]');
  });

  it('respects the level threshold', () => {
    const { lines, logger } = createLoggerAndCollect('info');
    logger.debug('hidden', { pin: '1234' });
    logger.info('shown');
    expect(lines.some((l) => l.includes('hidden'))).toBe(false);
    expect(lines.some((l) => l.includes('shown'))).toBe(true);
  });

  it('renders nested objects as JSON', () => {
    const { lines, logger } = collect();
    logger.info('event', { payload: { action: 'unlock', pin_code: '1234' } });
    const output = lines.join('\n');
    expect(output).not.toContain('1234');
    expect(output).toContain('"action":"unlock"');
  });
});

function createLoggerAndCollect(level: 'info') {
  const lines: string[] = [];
  return { lines, logger: createLogger(level, (line) => lines.push(line)) };
}