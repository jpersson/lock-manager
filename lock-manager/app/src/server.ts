import { loadOptions } from './config/options.js';
import { createLogger } from './logger.js';
import { buildApp } from './http/app.js';

async function main(): Promise<void> {
  const options = loadOptions();
  const logger = createLogger(options.logLevel);

  const app = await buildApp({ options, logger });
  const port = Number(process.env.PORT ?? 8099);

  await app.listen({ port, host: '0.0.0.0' });
  logger.info('Lock Manager listening', { port, dataDir: options.dataDir });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try {
      await app.close();
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