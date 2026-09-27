import { buildMcpApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildMcpApp(config, { level: config.logLevel });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
