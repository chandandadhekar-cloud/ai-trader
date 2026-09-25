// External heartbeat watchdog (plan §P2.14). Run on a SEPARATE host from the
// trading node. It polls the main node's /api/health; if the node is silent for
// `WATCHDOG_SILENCE_SEC`, it alerts (Telegram / P0 webhook) and, when broker
// credentials are provided, calls Upstox exit-all so no position is left
// unmanaged. Broker-side stops placed at entry remain the first line of defence.
//
//   TRADEAI_HEALTH_URL=https://node:8080/api/health WATCHDOG_SILENCE_SEC=60 \
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node src/ops/watchdog.ts
//
// Set WATCHDOG_EXIT_ALL=true plus UPSTOX_ACCESS_TOKEN and UPSTOX_ALGO_NAME to allow
// the emergency flatten. The watchdog host must itself be on a registered static IP
// (the secondary IP is intended for this / the warm standby).

const url = process.env.TRADEAI_HEALTH_URL ?? 'http://127.0.0.1:8080/api/health';
const silenceMs = Number(process.env.WATCHDOG_SILENCE_SEC ?? 60) * 1000;
const pollMs = 5000;
let lastOk = Date.now();
let fired = false;

async function notify(text: string): Promise<void> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat) {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }).catch(() => {});
  }
  if (process.env.P0_WEBHOOK_URL) {
    await fetch(process.env.P0_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'TradeAI watchdog', message: text }) }).catch(() => {});
  }
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

async function exitAll(): Promise<void> {
  if (process.env.WATCHDOG_EXIT_ALL !== 'true') return;
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  const algo = process.env.UPSTOX_ALGO_NAME;
  if (!token || !algo) return notify('Watchdog: exit-all skipped (UPSTOX_ACCESS_TOKEN / UPSTOX_ALGO_NAME missing)');
  try {
    const res = await fetch('https://api.upstox.com/v2/order/positions/exit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Algo-Name': algo, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    await notify(`Watchdog: Upstox exit-all → HTTP ${res.status}`);
  } catch (e) {
    await notify(`Watchdog: exit-all FAILED: ${String(e)} — flatten manually via the broker app`);
  }
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      if (fired) await notify('Watchdog: trading node is healthy again');
      lastOk = Date.now();
      fired = false;
      return;
    }
  } catch {
    /* counted as silence */
  }
  if (!fired && Date.now() - lastOk > silenceMs) {
    fired = true;
    await notify(`P0 Watchdog: trading node silent for ${Math.round((Date.now() - lastOk) / 1000)}s (${url})`);
    await exitAll();
  }
}

setInterval(() => void poll(), pollMs);
void poll();
