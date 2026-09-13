import type { Logger } from '../logger.js';
import type { MqttConnection } from '../mqtt/client.js';

/**
 * Client for the Home Assistant Supervisor API.
 *
 * Only the endpoints this app needs are covered:
 * - `GET /services/mqtt` for broker credentials (requires `mqtt:want`)
 * - `POST /core/api/services/<domain>/<service>` for notifications (step 7;
 *   requires `homeassistant_api`)
 */

export interface SupervisorEnv {
  SUPERVISOR_TOKEN?: string;
}

export interface SupervisorServiceResponse {
  result: 'ok' | 'error';
  data?: {
    addon?: string;
    host?: string;
    port?: string | number;
    ssl?: boolean;
    username?: string;
    password?: string;
    protocol?: string;
  };
  message?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class SupervisorClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;

  constructor(
    env: SupervisorEnv = process.env,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly logger: Logger,
    baseUrl?: string,
  ) {
    this.token = env.SUPERVISOR_TOKEN;
    this.baseUrl = baseUrl ?? 'http://supervisor';
  }

  /** True when running inside the Supervisor (add-on mode). */
  get available(): boolean {
    return this.token !== undefined && this.token !== '';
  }

  private async get(path: string): Promise<SupervisorServiceResponse | undefined> {
    if (!this.available) {
      return undefined;
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token as string}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        this.logger.debug('supervisor request failed', { path, status: res.status });
        return undefined;
      }
      return (await res.json()) as SupervisorServiceResponse;
    } catch (err) {
      this.logger.debug('supervisor request error', { path, error: String(err) });
      return undefined;
    }
  }

  /**
   * Broker connection details from the Supervisor's MQTT service (provided by
   * e.g. the Mosquitto add-on). Undefined when unavailable.
   */
  async getMqttService(): Promise<MqttConnection | undefined> {
    const body = await this.get('/services/mqtt');
    const data = body?.data;
    if (body?.result !== 'ok' || data === undefined || !data.host) {
      return undefined;
    }
    const port = Number(data.port ?? 1883);
    return {
      host: data.host,
      port: Number.isFinite(port) && port > 0 ? port : 1883,
      ...(data.username ? { user: data.username } : {}),
      ...(data.password ? { password: data.password } : {}),
      ssl: data.ssl === true,
    };
  }
}