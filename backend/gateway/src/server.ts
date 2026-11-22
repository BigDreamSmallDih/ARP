import { createGateway } from './app';
import { ConfigError, loadConfig, type GatewayConfig } from './config';

let config: GatewayConfig;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const { app } = await createGateway(config);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start the gateway');
  process.exit(1);
}
