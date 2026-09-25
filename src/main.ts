// Entry point: load settings (defaults < .env < console-saved values), start the
// runtime and the admin console. Settings saved from the console are applied by
// an in-process restart, so no file or code edits are ever required.
import { loadSettings, type Settings } from './config/settings.ts';
import { SettingsStore } from './config/settingsStore.ts';
import { Db } from './db/database.ts';
import { App } from './app.ts';
import { startServer } from './api/server.ts';
import { createLogger } from './core/logger.ts';

const log = createLogger('main');
let app: App | undefined;
let server: { close: () => Promise<void> } | undefined;
let restarting = false;

function resolveSettings(): Settings {
  const base = loadSettings();
  // DB_PATH itself comes from the environment (default data/tradeai.db).
  const db = new Db(base.DB_PATH);
  try {
    return loadSettings(process.env, undefined, new SettingsStore(db, base.DB_PATH).overrides());
  } finally {
    db.close();
  }
}

async function boot(): Promise<void> {
  const settings = resolveSettings();
  if (settings.MODE === 'live' && !settings.LIVE_TRADING_ENABLED) {
    log.warn('MODE=live but LIVE_TRADING_ENABLED=false: live orders stay blocked by the compliance gate');
  }
  app = new App(settings);
  await app.start();
  server = startServer(app, { restart });
}

async function restart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  log.info('restarting to apply settings');
  try {
    await server?.close();
    await app?.stop();
    await boot();
  } finally {
    restarting = false;
  }
}

async function main(): Promise<void> {
  await boot();
  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    await server?.close();
    await app?.stop();
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
