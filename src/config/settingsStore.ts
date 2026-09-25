// Console-managed settings: every environment setting (including API keys) can be
// set from the admin Settings page instead of editing files. Values are stored in
// the DB (`kv_settings.app_settings`); secrets are encrypted with SecretBox and
// never returned to the browser. Saved values take precedence over .env.
// Changes are validated against the settings schema, audited (key names only for
// secrets), and applied by an in-app restart.

import type { Db } from '../db/database.ts';
import type { AuditLog } from '../governance/auditLog.ts';
import { Schema, loadSettings, type Settings } from './settings.ts';
import { SecretBox } from './secretStore.ts';

export type FieldType = 'text' | 'number' | 'bool' | 'select' | 'secret' | 'url';

export interface FieldDef {
  key: keyof Settings & string;
  group: string;
  label: string;
  help: string;
  type: FieldType;
  options?: string[];
  /** Extra confirmation required when changing (dangerous settings). */
  confirm?: string;
}

const G = {
  run: 'Trading mode & data',
  upstox: 'Upstox broker',
  compliance: 'Static IP & order limits',
  delta: 'Delta Exchange India (crypto)',
  ai: 'AI research (OpenAI)',
  alerts: 'Alerts & monitoring',
  capital: 'Capital',
  server: 'Server',
};

export const FIELDS: FieldDef[] = [
  { key: 'MODE', group: G.run, label: 'Mode', help: 'paper = simulated fills; live = real orders (also needs the switch below and a clean Compliance page).', type: 'select', options: ['paper', 'live'], confirm: 'ENABLE LIVE' },
  { key: 'LIVE_TRADING_ENABLED', group: G.run, label: 'Live trading switch', help: 'Second key for real orders. Keep off until paper trading and validation gates are passed.', type: 'bool', confirm: 'ENABLE LIVE' },
  { key: 'DATA_SOURCE', group: G.run, label: 'Market data source', help: 'synthetic = built-in demo market; upstox = real NSE/BSE data (needs Upstox keys and the daily login).', type: 'select', options: ['synthetic', 'upstox'] },
  { key: 'CRYPTO_ENABLED', group: G.run, label: 'Enable crypto (Delta)', help: 'Adds Delta Exchange India perpetuals.', type: 'bool' },

  { key: 'UPSTOX_API_KEY', group: G.upstox, label: 'API key', help: 'From your Upstox Algo Trading App.', type: 'secret' },
  { key: 'UPSTOX_API_SECRET', group: G.upstox, label: 'API secret', help: 'From your Upstox Algo Trading App.', type: 'secret' },
  { key: 'UPSTOX_REDIRECT_URI', group: G.upstox, label: 'Redirect URI', help: 'Must match the app registration exactly, e.g. https://your-host/api/upstox/callback', type: 'url' },
  { key: 'UPSTOX_ALGO_NAME', group: G.upstox, label: 'Algo Name (X-Algo-Name)', help: 'Exactly as registered on the Upstox app; orders are rejected if it does not match.', type: 'text' },
  { key: 'UPSTOX_ACCESS_TOKEN', group: G.upstox, label: 'Access token (optional)', help: 'Normally obtained by the daily login on the Compliance page; paste one here only if needed.', type: 'secret' },
  { key: 'UPSTOX_SANDBOX', group: G.upstox, label: 'Use Upstox sandbox', help: 'Send orders to the Upstox sandbox instead of the exchange.', type: 'bool' },

  { key: 'STATIC_IP_PRIMARY', group: G.compliance, label: 'Primary static IP', help: 'The IP registered with Upstox; live orders are blocked unless the server egress matches.', type: 'text' },
  { key: 'STATIC_IP_SECONDARY', group: G.compliance, label: 'Secondary static IP', help: 'Optional backup IP (warm standby / watchdog host).', type: 'text' },
  { key: 'EGRESS_IP_CHECK_URL', group: G.compliance, label: 'Egress IP check URL', help: 'Service that echoes the public IP of this server.', type: 'url' },
  { key: 'OPS_HARD_LIMIT', group: G.compliance, label: 'Max orders per second', help: 'Hard cap; must stay below the exchange threshold of 10.', type: 'number' },
  { key: 'OPS_ALERT_AT', group: G.compliance, label: 'Alert at orders per second', help: 'Raise an alert at this rate.', type: 'number' },
  { key: 'UPSTOX_REQ_PER_SEC', group: G.compliance, label: 'Upstox requests / second', help: 'Upstox API limit per user.', type: 'number' },
  { key: 'UPSTOX_REQ_PER_MIN', group: G.compliance, label: 'Upstox requests / minute', help: 'Upstox API limit per user.', type: 'number' },
  { key: 'UPSTOX_REQ_PER_30MIN', group: G.compliance, label: 'Upstox requests / 30 min', help: 'Upstox API limit per user.', type: 'number' },
  { key: 'UPSTOX_MULTI_ORDER_MAX', group: G.compliance, label: 'Multi-order batch size', help: 'Documented as 10 or 25; 10 is safe.', type: 'number' },

  { key: 'DELTA_API_KEY', group: G.delta, label: 'API key', help: 'Use a withdrawal-disabled, IP-whitelisted key.', type: 'secret' },
  { key: 'DELTA_API_SECRET', group: G.delta, label: 'API secret', help: '', type: 'secret' },
  { key: 'DELTA_BASE_URL', group: G.delta, label: 'REST base URL', help: 'Testnet: https://cdn-ind.testnet.deltaex.org · Production: https://api.india.delta.exchange', type: 'url' },
  { key: 'DELTA_WS_URL', group: G.delta, label: 'WebSocket URL', help: '', type: 'url' },
  { key: 'DELTA_DEADMAN_MS', group: G.delta, label: 'Dead-man timer (ms)', help: 'Venue cancels open orders if the node stops refreshing within this time.', type: 'number' },

  { key: 'OPENAI_API_KEY', group: G.ai, label: 'OpenAI API key', help: 'Without a key the deterministic rule-based researcher is used.', type: 'secret' },
  { key: 'LLM_FAST_MODEL', group: G.ai, label: 'Fast / triage model', help: 'Cheap model that reads every researched move (default gpt-6-luna).', type: 'text' },
  { key: 'LLM_DEEP_MODEL', group: G.ai, label: 'Judge model', help: 'Strong model used only for actionable or unsure calls (default gpt-6-sol; gpt-6-astra is ~5x the price).', type: 'text' },
  { key: 'LLM_FAST_EFFORT', group: G.ai, label: 'Fast reasoning effort', help: 'Lower is cheaper and faster.', type: 'select', options: ['none', 'low', 'medium', 'high'] },
  { key: 'LLM_DEEP_EFFORT', group: G.ai, label: 'Judge reasoning effort', help: '', type: 'select', options: ['none', 'low', 'medium', 'high'] },
  { key: 'LLM_UNSURE_LOW', group: G.ai, label: 'Escalate if fast confidence ≥', help: 'Lower bound of the "unsure" band that escalates to the judge.', type: 'number' },
  { key: 'LLM_UNSURE_HIGH', group: G.ai, label: '… and ≤', help: 'Upper bound of the "unsure" band.', type: 'number' },
  { key: 'LLM_MAX_USD_PER_DAY', group: G.ai, label: 'Daily spend cap (USD)', help: 'Above this the rule-based researcher takes over for the day.', type: 'number' },
  { key: 'LLM_MAX_CALLS_PER_DAY', group: G.ai, label: 'Daily call cap', help: '', type: 'number' },
  { key: 'LLM_MAX_DEEP_PER_HOUR', group: G.ai, label: 'Judge runs per hour', help: '', type: 'number' },
  { key: 'LLM_FAST_TIMEOUT_MS', group: G.ai, label: 'Fast timeout (ms)', help: '', type: 'number' },
  { key: 'LLM_DEEP_TIMEOUT_MS', group: G.ai, label: 'Judge timeout (ms)', help: '', type: 'number' },
  { key: 'LLM_TRAINING_CUTOFF', group: G.ai, label: 'Model training cutoff', help: 'YYYY-MM-DD. LLM results on news before this date are treated as contaminated in research.', type: 'text' },

  { key: 'TELEGRAM_BOT_TOKEN', group: G.alerts, label: 'Telegram bot token', help: 'P0/P1 alerts are sent to Telegram.', type: 'secret' },
  { key: 'TELEGRAM_CHAT_ID', group: G.alerts, label: 'Telegram chat id', help: '', type: 'text' },
  { key: 'P0_WEBHOOK_URL', group: G.alerts, label: 'P0 escalation webhook', help: 'Phone call / SMS provider endpoint for critical alerts.', type: 'secret' },
  { key: 'WATCHDOG_URL', group: G.alerts, label: 'Watchdog heartbeat URL', help: 'Optional: heartbeat receiver on a separate host.', type: 'url' },

  { key: 'CAPITAL_INR', group: G.capital, label: 'Equity capital (₹)', help: 'Starting capital for the equity book (paper reset uses it).', type: 'number' },
  { key: 'CAPITAL_CRYPTO_INR', group: G.capital, label: 'Crypto capital (₹)', help: '', type: 'number' },

  { key: 'SESSION_TTL_HOURS', group: G.server, label: 'Login session length (hours)', help: '', type: 'number' },
  { key: 'ADMIN_USER', group: G.server, label: 'Admin user name', help: 'Changing it signs everyone out after restart.', type: 'text' },
  { key: 'HOST', group: G.server, label: 'Listen address', help: '127.0.0.1 = this machine only (recommended behind a TLS proxy); 0.0.0.0 = all interfaces.', type: 'text' },
  { key: 'PORT', group: G.server, label: 'Port', help: 'The console moves to this port after restart.', type: 'number' },
];

const KEY = 'app_settings';
const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));

type Stored = Record<string, { v: string; secret?: boolean }>;

export interface FieldView extends FieldDef {
  /** Current effective value (never for secrets). */
  value?: string | number | boolean;
  /** For secrets: whether a value is configured. */
  isSet?: boolean;
  source: 'default' | 'env' | 'console';
}

export class SettingsStore {
  private db: Db;
  private box: SecretBox;
  private audit?: AuditLog;

  constructor(db: Db, dbPath: string, audit?: AuditLog) {
    this.db = db;
    this.box = new SecretBox(dbPath);
    this.audit = audit;
  }

  private read(): Stored {
    const r = this.db.get<{ value: string }>('SELECT value FROM kv_settings WHERE key = ?', KEY);
    return r ? (JSON.parse(r.value) as Stored) : {};
  }

  /** Decrypted overrides to merge over the environment. Undecryptable secrets are skipped. */
  overrides(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, e] of Object.entries(this.read())) {
      if (!FIELD_MAP.has(k as keyof Settings)) continue;
      try {
        out[k] = e.secret ? this.box.decrypt(e.v) : e.v;
      } catch {
        /* key rotated or file lost: the value must be re-entered */
      }
    }
    return out;
  }

  /** Field list with current values for the console (secrets redacted). */
  view(env: Record<string, string | undefined> = process.env, dotenvPath?: string): FieldView[] {
    const stored = this.read();
    const eff = loadSettings(env, dotenvPath, this.overrides()) as Record<string, unknown>;
    const envOnly = loadSettings(env, dotenvPath) as Record<string, unknown>;
    const defaults = Schema.parse({}) as Record<string, unknown>;
    return FIELDS.map((f) => {
      const source: FieldView['source'] = stored[f.key] ? 'console' : envOnly[f.key] !== defaults[f.key] ? 'env' : 'default';
      if (f.type === 'secret') return { ...f, isSet: !!eff[f.key], source };
      return { ...f, value: eff[f.key] as string | number | boolean | undefined, source };
    });
  }

  /**
   * Apply a patch. `null` or '' clears a console value (falls back to .env/default);
   * secrets left undefined are kept. Returns the keys that changed.
   */
  save(patch: Record<string, unknown>, actor: string, confirmation?: string, env: Record<string, string | undefined> = process.env, dotenvPath?: string): { changed: string[] } {
    const stored = this.read();
    const next: Stored = { ...stored };
    const changed: string[] = [];
    for (const [k, raw] of Object.entries(patch)) {
      const f = FIELD_MAP.get(k as keyof Settings);
      if (!f) throw new Error(`unknown setting ${k}`);
      if (raw === undefined) continue;
      if (raw === null || raw === '') {
        if (next[k]) { delete next[k]; changed.push(k); }
        continue;
      }
      const v = typeof raw === 'boolean' ? String(raw) : String(raw).trim();
      const prev = stored[k] ? (stored[k].secret ? safeDecrypt(this.box, stored[k].v) : stored[k].v) : undefined;
      if (prev === v) continue;
      next[k] = f.type === 'secret' ? { v: this.box.encrypt(v), secret: true } : { v };
      changed.push(k);
    }
    if (!changed.length) return { changed };

    // Validate the resulting configuration as a whole before persisting.
    const decrypted: Record<string, string> = {};
    for (const [k, e] of Object.entries(next)) decrypted[k] = e.secret ? safeDecrypt(this.box, e.v) ?? '' : e.v;
    let eff: Settings;
    try {
      eff = loadSettings(env, dotenvPath, decrypted);
    } catch (e) {
      throw new Error(`invalid settings: ${String((e as Error).message).slice(0, 400)}`);
    }
    if (eff.OPS_HARD_LIMIT >= 10) throw new Error('Max orders per second must stay below 10 (exchange threshold for unregistered algos)');
    if (eff.OPS_ALERT_AT > eff.OPS_HARD_LIMIT) throw new Error('Alert rate must not exceed the max orders per second');
    if (eff.LLM_UNSURE_LOW > eff.LLM_UNSURE_HIGH) throw new Error('Escalation band: lower bound must not exceed upper bound');
    const dangerous = changed.filter((k) => FIELD_MAP.get(k as keyof Settings)?.confirm);
    const turningLive = dangerous.length > 0 && eff.MODE === 'live' && eff.LIVE_TRADING_ENABLED;
    if (turningLive && confirmation !== 'ENABLE LIVE') throw new Error('Type ENABLE LIVE to confirm switching to live trading');

    this.db.run(
      'INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
      KEY, JSON.stringify(next), Date.now(), actor,
    );
    // Audit key names and non-secret values only.
    const detail = Object.fromEntries(changed.map((k) => [k, FIELD_MAP.get(k as keyof Settings)?.type === 'secret' ? (next[k] ? '(secret updated)' : '(secret cleared)') : next[k]?.v ?? '(cleared)']));
    this.audit?.append(actor, 'settings.update', null, detail);
    return { changed };
  }
}

function safeDecrypt(box: SecretBox, v: string): string | undefined {
  try {
    return box.decrypt(v);
  } catch {
    return undefined;
  }
}
