import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';

// Static configuration. Precedence: schema defaults < .env / environment < values
// saved from the admin console (Settings page, stored in the DB with secrets
// encrypted — see settingsStore.ts). Changes apply through an in-app restart.
// Runtime-tunable limits (risk, scanner, research) live in runtime.ts.

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const num = (d: number) => z.coerce.number().default(d);

export const Schema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: num(8080),
  DB_PATH: z.string().default('data/tradeai.db'),
  MODE: z.enum(['paper', 'live']).default('paper'),
  /** Hard second key for live trading; MODE=live alone is not enough. */
  LIVE_TRADING_ENABLED: bool.default(false),
  DATA_SOURCE: z.enum(['synthetic', 'upstox']).default('synthetic'),
  CRYPTO_ENABLED: bool.default(false),

  // Admin console
  ADMIN_USER: z.string().default('admin'),
  /** scrypt hash produced by `npm run admin:passwd`. */
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_TTL_HOURS: num(12),

  // Upstox
  UPSTOX_API_KEY: z.string().optional(),
  UPSTOX_API_SECRET: z.string().optional(),
  UPSTOX_REDIRECT_URI: z.string().optional(),
  UPSTOX_ACCESS_TOKEN: z.string().optional(),
  /** Must exactly match the Algo Name configured on the Upstox Algo Trading App. */
  UPSTOX_ALGO_NAME: z.string().optional(),
  UPSTOX_SANDBOX: bool.default(false),

  // Static-IP egress (SEBI/NSE retail-algo framework, mandatory from 1 Apr 2026)
  STATIC_IP_PRIMARY: z.string().optional(),
  STATIC_IP_SECONDARY: z.string().optional(),
  EGRESS_IP_CHECK_URL: z.string().default('https://api.ipify.org'),

  // Order throttle: exchange threshold is 10 OPS per exchange/segment; stay well under.
  OPS_HARD_LIMIT: num(6),
  OPS_ALERT_AT: num(5),
  /** Upstox general limits per API per user. */
  UPSTOX_REQ_PER_SEC: num(25),
  UPSTOX_REQ_PER_MIN: num(250),
  UPSTOX_REQ_PER_30MIN: num(1000),
  /** Multi-order cap is documented inconsistently (10 vs 25); 10 is the safe value. */
  UPSTOX_MULTI_ORDER_MAX: num(10),

  // Delta Exchange India
  DELTA_API_KEY: z.string().optional(),
  DELTA_API_SECRET: z.string().optional(),
  DELTA_BASE_URL: z.string().default('https://cdn-ind.testnet.deltaex.org'),
  DELTA_WS_URL: z.string().default('wss://socket-ind.testnet.deltaex.org'),
  DELTA_DEADMAN_MS: num(60000),

  // LLM research (OpenAI). Cascade: rules → cheap fast model → strong judge only when needed.
  OPENAI_API_KEY: z.string().optional(),
  LLM_FAST_MODEL: z.string().default('gpt-6-luna'),
  LLM_DEEP_MODEL: z.string().default('gpt-6-sol'),
  LLM_FAST_EFFORT: z.enum(['none', 'low', 'medium', 'high']).default('low'),
  LLM_DEEP_EFFORT: z.enum(['none', 'low', 'medium', 'high']).default('medium'),
  /** Fast-path confidence inside [LOW, HIGH] counts as unsure and escalates to the strong model. */
  LLM_UNSURE_LOW: num(0.35),
  LLM_UNSURE_HIGH: num(0.75),
  /** Daily spend cap in USD (all models). */
  LLM_MAX_USD_PER_DAY: num(5),
  LLM_FAST_TIMEOUT_MS: num(20000),
  LLM_DEEP_TIMEOUT_MS: num(180000),
  LLM_MAX_CALLS_PER_DAY: num(400),
  LLM_MAX_DEEP_PER_HOUR: num(6),
  /** Model training cutoff (YYYY-MM-DD). LLM features before this date are contaminated. */
  LLM_TRAINING_CUTOFF: z.string().default('2026-01-01'),

  // Alerts
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** Webhook for P0 escalation (phone/SMS provider). */
  P0_WEBHOOK_URL: z.string().optional(),
  WATCHDOG_URL: z.string().optional(),

  // Capital (initial defaults; editable at runtime)
  CAPITAL_INR: num(1_000_000),
  CAPITAL_CRYPTO_INR: num(0),
});

export type Settings = z.infer<typeof Schema>;

/** Minimal .env loader (KEY=VALUE, # comments, optional quotes). */
function loadDotEnv(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function loadSettings(env: Record<string, string | undefined> = process.env, dotenvPath?: string, overrides: Record<string, string> = {}): Settings {
  const merged: Record<string, string | undefined> = { ...loadDotEnv(dotenvPath), ...env, ...overrides };
  // Treat empty strings as unset so optional secrets are not "configured but blank".
  for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k];
  return Schema.parse(merged);
}

/** Settings view safe to show in the admin UI (secrets redacted). */
export function redactedSettings(s: Settings): Record<string, unknown> {
  const secret = /(KEY|SECRET|TOKEN|HASH|PASSWORD)/;
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, secret.test(k) ? (v ? '•••• set' : 'not set') : v]),
  );
}
