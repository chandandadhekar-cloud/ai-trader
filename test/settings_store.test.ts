import { memDb } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, FIELDS } from '../src/config/settingsStore.ts';
import { SecretBox } from '../src/config/secretStore.ts';
import { Schema, loadSettings } from '../src/config/settings.ts';

const tmpDbPath = () => join(mkdtempSync(join(tmpdir(), 'tradeai-set-')), 't.db');

test('every setting except DB path / password hash / NODE_ENV is editable from the console', () => {
  const editable = new Set(FIELDS.map((f) => f.key));
  const all = Object.keys(Schema.shape);
  const missing = all.filter((k) => !editable.has(k as never) && !['DB_PATH', 'ADMIN_PASSWORD_HASH', 'NODE_ENV'].includes(k));
  assert.deepEqual(missing, []);
});

test('secret box: AES-GCM round trip, key file created with 0600, tamper detected', () => {
  const p = tmpDbPath();
  const box = new SecretBox(p, undefined);
  const enc = box.encrypt('sk-test-123');
  assert.notEqual(enc, 'sk-test-123');
  assert.equal(box.decrypt(enc), 'sk-test-123');
  assert.equal(new SecretBox(p, undefined).decrypt(enc), 'sk-test-123'); // same key file reused
  assert.equal(statSync(join(p, '..', '.master.key')).mode & 0o777, 0o600);
  const parts = enc.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => box.decrypt(parts.join(':')));
});

test('saved values override .env; secrets are encrypted at rest and never exposed in the view', () => {
  const { db, audit } = memDb();
  const p = tmpDbPath();
  const store = new SettingsStore(db, p, audit);
  store.save({ OPENAI_API_KEY: 'sk-live-secret', LLM_DEEP_MODEL: 'gpt-6-astra', DATA_SOURCE: 'upstox' }, 'tester', undefined, {}, '/nonexistent');
  const rawRow = db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'app_settings'")!.value;
  assert.ok(!rawRow.includes('sk-live-secret'));
  const eff = loadSettings({ LLM_DEEP_MODEL: 'gpt-6-sol' }, '/nonexistent', store.overrides());
  assert.equal(eff.OPENAI_API_KEY, 'sk-live-secret');
  assert.equal(eff.LLM_DEEP_MODEL, 'gpt-6-astra');
  const view = store.view({}, '/nonexistent');
  const key = view.find((f) => f.key === 'OPENAI_API_KEY')!;
  assert.equal(key.isSet, true);
  assert.equal(key.value, undefined);
  assert.equal(key.source, 'console');
  assert.ok(!JSON.stringify(view).includes('sk-live-secret'));
  const auditRow = audit.list({ action: 'settings.update' })[0];
  assert.ok(!auditRow.payload.includes('sk-live-secret'));
  assert.match(auditRow.payload, /secret updated/);
  // Clearing falls back to env / default.
  store.save({ LLM_DEEP_MODEL: null }, 'tester', undefined, {}, '/nonexistent');
  assert.equal(loadSettings({}, '/nonexistent', store.overrides()).LLM_DEEP_MODEL, 'gpt-6-sol');
  void readFileSync;
});

test('validation: bad values, OPS limit >= 10 and unconfirmed live switch are rejected', () => {
  const { db, audit } = memDb();
  const store = new SettingsStore(db, tmpDbPath(), audit);
  assert.throws(() => store.save({ OPS_HARD_LIMIT: 12 }, 't', undefined, {}, '/nonexistent'), /below 10/);
  assert.throws(() => store.save({ MODE: 'yolo' }, 't', undefined, {}, '/nonexistent'), /invalid settings/);
  assert.throws(() => store.save({ NOT_A_SETTING: 1 }, 't', undefined, {}, '/nonexistent'), /unknown setting/);
  assert.throws(() => store.save({ MODE: 'live', LIVE_TRADING_ENABLED: true }, 't', undefined, {}, '/nonexistent'), /ENABLE LIVE/);
  const r = store.save({ MODE: 'live', LIVE_TRADING_ENABLED: true }, 't', 'ENABLE LIVE', {}, '/nonexistent');
  assert.deepEqual(r.changed.sort(), ['LIVE_TRADING_ENABLED', 'MODE']);
  // Saving the same value again is a no-op.
  assert.deepEqual(store.save({ MODE: 'live' }, 't', undefined, {}, '/nonexistent').changed, []);
});
