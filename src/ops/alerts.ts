// Alert routing (plan §P2.14): every alert is kept for the admin console; P0/P1
// also go to Telegram, and P0 additionally to a phone/SMS webhook. Duplicate
// alerts are rate-limited per title.

import type { EventBus } from '../core/events.ts';
import type { Settings } from '../config/settings.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('alerts');

export class AlertRouter {
  private s: Settings;
  private lastSent = new Map<string, number>();
  sent = 0;
  failed = 0;

  constructor(bus: EventBus, s: Settings) {
    this.s = s;
    bus.on('alert', (a) => void this.route(a));
  }

  private async route(a: { severity: string; title: string; message: string; ts: number }): Promise<void> {
    (a.severity === 'P0' ? log.error : a.severity === 'P1' ? log.warn : log.info)(`ALERT ${a.severity}: ${a.title}`, { message: a.message });
    if (a.severity !== 'P0' && a.severity !== 'P1') return;
    const k = `${a.severity}:${a.title}`;
    const last = this.lastSent.get(k) ?? 0;
    if (Date.now() - last < (a.severity === 'P0' ? 60_000 : 300_000)) return;
    this.lastSent.set(k, Date.now());
    const text = `[TradeAI ${a.severity}] ${a.title}\n${a.message}`;
    if (this.s.TELEGRAM_BOT_TOKEN && this.s.TELEGRAM_CHAT_ID) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.s.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.s.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.sent++;
      } catch (e) {
        this.failed++;
        log.warn('telegram send failed', { err: String(e) });
      }
    }
    if (a.severity === 'P0' && this.s.P0_WEBHOOK_URL) {
      try {
        await fetch(this.s.P0_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title, message: a.message, ts: a.ts }), signal: AbortSignal.timeout(5000) });
      } catch (e) {
        this.failed++;
        log.warn('P0 webhook failed', { err: String(e) });
      }
    }
  }
}
