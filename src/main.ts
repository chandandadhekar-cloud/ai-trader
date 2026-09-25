// Entry point: load settings, start the runtime and the admin console.
import { loadSettings } from './config/settings.ts';
import { App } from './app.ts';
import { startServer } from './api/server.ts';
import { createLogger } from './core/logger.ts';

const log = createLogger('main');

async function main(): Promise<void> {
  const settings = loadSettings();
  if (settings.MODE === 'live' && !settings.LIVE_TRADING_ENABLED) {
    log.warn('MODE=live but LIVE_TRADING_ENABLED=false: live orders stay blocked by the compliance gate');
  }
  const app = new App(settings);
  await app.start();
  const server = startServer(app);
  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    await server.close();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: String((e as Error)?.stack ?? e) }));
}

main().catch((e) => {
  log.error('fatal', { err: String(e?.stack ?? e) });
  process.exit(1);
});
