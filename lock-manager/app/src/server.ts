import { loadOptions } from './config/options.js';
import { createLogger } from './logger.js';
import { Store } from './store/store.js';
import { MqttService } from './mqtt/client.js';
import { DiscoveryService } from './mqtt/discovery.js';
import { SupervisorClient } from './ha/supervisor.js';
import { LockManager } from './domain/lockManager.js';
import { buildApp } from './http/app.js';

async function main(): Promise<void> {
  const options = loadOptions();
  const logger = createLogger(options.logLevel);

  const store = await Store.open(options.dataDir, logger);
  const supervisor = new SupervisorClient(process.env, (url, init) => fetch(url, init), logger);

  // Broker details: Supervisor MQTT service first (Mosquitto), manual fallback.
  const mqtt = new MqttService({
    logger,
    resolve: async () => {
      const service = await supervisor.getMqttService();
      if (service !== undefined) {
        return service;
      }
      const manual = options.mqttOverride;
      return manual === undefined
        ? undefined
        : { host: manual.host, port: manual.port ?? 1883, ...(manual.user ? { user: manual.user } : {}), ...(manual.password ? { password: manual.password } : {}) };
    },
    baseTopic: options.z2mBaseTopic,
  });
  const discovery = new DiscoveryService(mqtt, logger);
  const manager = new LockManager({
    store,
    mqtt,
    discovery,
    supervisor,
    options,
    logger,
  });

  await discovery.start();
  await mqtt.start();
  await manager.start();

  const app = await buildApp({ options, logger, store, manager, discovery, mqtt });
  const port = Number(process.env.PORT ?? 8099);

  await app.listen({ port, host: '0.0.0.0' });
  logger.info('Lock Manager listening', {
    port,
    dataDir: options.dataDir,
    baseTopic: options.z2mBaseTopic,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try {
      await app.close();
      await manager.stop();
      await mqtt.stop();
      store.flushNow();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});