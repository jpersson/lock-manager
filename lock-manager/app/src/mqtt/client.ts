import { connect as mqttConnect } from 'mqtt';
import type { Logger } from '../logger.js';

/**
 * MQTT connectivity built on mqtt.js.
 *
 * Subscriptions and publishes are expressed *relative to the Zigbee2MQTT base
 * topic* (e.g. `bridge/devices`). The base topic starts from the configured
 * default and is corrected from `bridge/info` once connected — never hardcoded.
 */

export interface MqttConnection {
  host: string;
  port: number;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface MqttMessageMeta {
  topic: string;
  retain: boolean;
}

export type MqttMessageHandler = (payload: unknown, meta: MqttMessageMeta) => void;

export interface MqttLike {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'reconnect', listener: () => void): unknown;
  on(
    event: 'message',
    listener: (topic: string, payload: Buffer, packet: { retain?: boolean }) => void,
  ): unknown;
  publishAsync(topic: string, message: string, opts?: { qos?: number }): Promise<unknown>;
  subscribeAsync(topic: string, opts?: { qos?: number }): Promise<unknown>;
  unsubscribeAsync(topic: string): Promise<unknown>;
  endAsync(force?: boolean): Promise<unknown>;
}

export type ConnectFactory = (url: string, opts: Record<string, unknown>) => MqttLike;

export const defaultConnectFactory: ConnectFactory = (url, opts) =>
  mqttConnect(url, opts) as unknown as MqttLike;

export function tryParseJson(payload: string | Buffer): unknown {
  const text = payload.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > 0 ? text : undefined;
  }
}

/** The surface other modules use for MQTT (implemented by MqttService). */
export interface TopicClient {
  readonly connected: boolean;
  readonly currentBaseTopic: string;
  subscribe(relativeTopic: string, handler: MqttMessageHandler, qos?: number): void;
  publish(relativeTopic: string, payload: unknown, qos?: number): Promise<void>;
  setBaseTopic(base: string): Promise<void>;
  onConnected(cb: () => void): void;
  onDisconnected(cb: () => void): void;
  onBaseTopicChanged(cb: (base: string) => void): void;
}

export interface MqttServiceOptions {
  logger: Logger;
  /** Resolves broker details; polled until it succeeds. */
  resolve: () => Promise<MqttConnection | undefined>;
  baseTopic: string;
  connectFactory?: ConnectFactory;
  retryDelayMs?: number;
}

interface Registration {
  relativeTopic: string;
  qos: number;
  handler: MqttMessageHandler;
}

export class MqttService implements TopicClient {
  private client: MqttLike | undefined;
  private pendingClient: MqttLike | undefined;
  private baseTopic: string;
  private readonly registrations = new Map<string, Registration>();
  private readonly connectCallbacks: Array<() => void> = [];
  private readonly disconnectCallbacks: Array<() => void> = [];
  private readonly baseTopicCallbacks: Array<(base: string) => void> = [];
  private stopping = false;
  private connectLoop: Promise<void> | undefined;

  constructor(private readonly opts: MqttServiceOptions) {
    this.baseTopic = opts.baseTopic;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  get currentBaseTopic(): string {
    return this.baseTopic;
  }

  onConnected(cb: () => void): void {
    this.connectCallbacks.push(cb);
  }

  onDisconnected(cb: () => void): void {
    this.disconnectCallbacks.push(cb);
  }

  onBaseTopicChanged(cb: (base: string) => void): void {
    this.baseTopicCallbacks.push(cb);
  }

  /** Registers a handler for a base-topic-relative topic (idempotent). */
  subscribe(relativeTopic: string, handler: MqttMessageHandler, qos = 0): void {
    this.registrations.set(relativeTopic, { relativeTopic, qos, handler });
    if (this.client !== undefined) {
      void this.client.subscribeAsync(this.absolute(relativeTopic), { qos });
    }
  }

  /**
   * Corrects the Zigbee2MQTT base topic (e.g. learned from bridge/info) and
   * re-subscribes everything under it.
   */
  async setBaseTopic(base: string): Promise<void> {
    const clean = base.replace(/\/+$/, '');
    if (clean === '' || clean === this.baseTopic) {
      return;
    }
    this.opts.logger.info('Zigbee2MQTT base topic corrected', {
      from: this.baseTopic,
      to: clean,
    });
    this.baseTopic = clean;
    if (this.client !== undefined) {
      for (const reg of this.registrations.values()) {
        await this.client.subscribeAsync(this.absolute(reg.relativeTopic), { qos: reg.qos });
      }
    }
    for (const cb of this.baseTopicCallbacks) {
      cb(clean);
    }
  }

  /** Publishes a JSON payload to a base-topic-relative topic (QoS 1 by default). */
  async publish(relativeTopic: string, payload: unknown, qos = 1): Promise<void> {
    if (this.client === undefined) {
      throw new Error('MQTT client not connected');
    }
    await this.client.publishAsync(this.absolute(relativeTopic), JSON.stringify(payload), { qos });
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.connectLoop = this.connectForever();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const clients = [this.client, this.pendingClient].filter(
      (c): c is MqttLike => c !== undefined,
    );
    this.client = undefined;
    this.pendingClient = undefined;
    for (const client of clients) {
      await client.endAsync(true).catch(() => undefined);
    }
    await this.connectLoop;
    this.connectLoop = undefined;
  }

  private absolute(relativeTopic: string): string {
    return `${this.baseTopic}/${relativeTopic}`;
  }

  private async connectForever(): Promise<void> {
    const retryDelay = this.opts.retryDelayMs ?? 5000;
    while (!this.stopping) {
      if (this.client === undefined && this.pendingClient === undefined) {
        const conn = await this.opts.resolve();
        if (conn === undefined) {
          this.opts.logger.warn('no MQTT broker configured yet; retrying', {
            retryDelayMs: retryDelay,
          });
        } else {
          const url = `${conn.ssl === true ? 'mqtts' : 'mqtt'}://${conn.host}:${conn.port}`;
          this.opts.logger.info('connecting to MQTT broker', { url });
          this.createClient(url, conn);
        }
      }
      await sleep(retryDelay);
    }
  }

  private createClient(url: string, conn: MqttConnection): MqttLike {
    const connectFactory = this.opts.connectFactory ?? defaultConnectFactory;
    const client = connectFactory(url, {
      clientId: `lock-manager-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
      ...(conn.user ? { username: conn.user } : {}),
      ...(conn.password ? { password: conn.password } : {}),
    });
    this.pendingClient = client;

    client.on('connect', () => {
      this.opts.logger.info('MQTT connected', { url });
      this.pendingClient = undefined;
      this.client = client;
      // Re-subscribe on every (re)connect: clean sessions drop subscriptions.
      for (const reg of this.registrations.values()) {
        void this.client?.subscribeAsync(this.absolute(reg.relativeTopic), { qos: reg.qos });
      }
      for (const cb of this.connectCallbacks) {
        cb();
      }
    });
    client.on('close', () => {
      if (this.client === client) {
        this.client = undefined;
        for (const cb of this.disconnectCallbacks) {
          cb();
        }
        this.opts.logger.warn('MQTT connection lost; reconnecting');
      }
      if (this.pendingClient === client) {
        this.pendingClient = undefined;
      }
    });
    client.on('error', (err) => {
      this.opts.logger.warn('MQTT client error', { error: String(err) });
    });
    client.on(
      'message',
      (topic: string, payload: Buffer, packet: { retain?: boolean }) => {
        const relative = topic.startsWith(`${this.baseTopic}/`)
          ? topic.slice(this.baseTopic.length + 1)
          : undefined;
        const reg = relative !== undefined ? this.registrations.get(relative) : undefined;
        if (reg === undefined) {
          return;
        }
        reg.handler(tryParseJson(payload), { topic, retain: packet?.retain === true });
      },
    );
    return client;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}