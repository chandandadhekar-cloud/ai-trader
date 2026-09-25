// Position monitor: exits that are not resting at the broker.
//  - target reached → exit
//  - time stop → exit
//  - intraday square-off before the broker/exchange cut-off (earlier for CAS stocks,
//    whose stop orders the exchange cancels at 15:15)
//  - PROTECT verdict → move stop to breakeven, or exit if already past 0.5R adverse
//  - protective-order maintenance (resize / replace missing stops)
//  - stale quotes → no discretionary exits on stale prices; rely on the broker-side stop and alert

import type { Oms } from '../oms/oms.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { EventBus } from '../core/events.ts';
import type { ResearchService } from '../research/service.ts';
import type { StalenessMonitor } from '../marketdata/staleness.ts';
import { intradayCutoffs, type InstrumentClass } from '../config/calendar.ts';
import { istParts } from '../core/clock.ts';
import type { Instrument } from '../core/types.ts';

export function instrumentClass(i: Instrument): InstrumentClass {
  if (i.type === 'INDEX') return 'INDEX';
  if (i.type === 'FUT' || i.type === 'CE' || i.type === 'PE') return 'FO';
  return i.casEligible || i.isFnO ? 'EQ_CAS' : 'EQ_NON_CAS';
}

export class PositionMonitor {
  private oms: Oms;
  private refdata: InstrumentRegistry;
  private quotes: QuoteBook;
  private bus: EventBus;
  private research?: ResearchService;
  private staleness: StalenessMonitor;
  private exiting = new Map<string, number>();
  private protectedByVerdict = new Set<string>();
  private alwaysOpen: boolean;
  private now: () => number;

  constructor(opts: { oms: Oms; refdata: InstrumentRegistry; quotes: QuoteBook; bus: EventBus; research?: ResearchService; staleness: StalenessMonitor; alwaysOpen: boolean; now?: () => number }) {
    this.oms = opts.oms;
    this.refdata = opts.refdata;
    this.quotes = opts.quotes;
    this.bus = opts.bus;
    this.research = opts.research;
    this.staleness = opts.staleness;
    this.alwaysOpen = opts.alwaysOpen;
    this.now = opts.now ?? Date.now;
    this.bus.on('research.verdict', (v) => {
      if (v.final === 'PROTECT') void this.protect(v.key, v.id);
    });
  }

  private async exitOnce(key: string, strategyId: string, reason: string): Promise<void> {
    const k = `${key}::${strategyId}`;
    const last = this.exiting.get(k);
    if (last && this.now() - last < 15_000) return; // an exit is already working
    this.exiting.set(k, this.now());
    await this.oms.exitPosition(key, strategyId, reason);
  }

  async protect(key: string, verdictId: string): Promise<void> {
    for (const p of this.oms.portfolio.byInstrument(key)) {
      const ltp = this.quotes.ltp(key);
      if (!ltp) continue;
      const risk = p.stopPrice !== undefined ? Math.abs(p.avgPrice - p.stopPrice) : undefined;
      const adverse = (p.avgPrice - ltp) * Math.sign(p.qty);
      const tag = `${key}::${p.strategyId}::${verdictId}`;
      if (this.protectedByVerdict.has(tag)) continue;
      this.protectedByVerdict.add(tag);
      if (risk && adverse > 0.5 * risk) {
        await this.exitOnce(key, p.strategyId, `PROTECT verdict ${verdictId}: adverse ${(adverse / risk).toFixed(2)}R`);
      } else {
        // Tighten to breakeven (or current price if already in profit by less than breakeven room).
        const be = p.avgPrice;
        const better = p.qty > 0 ? Math.max(p.stopPrice ?? -Infinity, Math.min(be, ltp * 0.998)) : Math.min(p.stopPrice ?? Infinity, Math.max(be, ltp * 1.002));
        await this.oms.modifyStop(key, p.strategyId, better, `PROTECT verdict ${verdictId}`);
      }
      this.bus.publish('risk.event', { kind: 'protect', severity: 'warn', message: `PROTECT applied to ${key} (${p.strategyId})`, data: { verdictId } });
    }
  }

  async tick(): Promise<void> {
    const now = this.now();
    const mod = istParts(now).minuteOfDay;
    for (const p of this.oms.portfolio.open()) {
      const inst = this.refdata.byKey(p.instrumentKey);
      if (!inst) continue;
      const ltp = this.quotes.ltp(p.instrumentKey);

      if (!this.alwaysOpen && inst.venue !== 'DELTA' && p.product === 'I') {
        const cut = intradayCutoffs(istParts(now).date, instrumentClass(inst));
        if (mod >= cut.squareOff) {
          await this.exitOnce(p.instrumentKey, p.strategyId, 'intraday square-off');
          continue;
        }
      }
      if (p.timeStopAt && now >= p.timeStopAt) {
        await this.exitOnce(p.instrumentKey, p.strategyId, 'time stop');
        continue;
      }
      if (ltp && p.targetPrice !== undefined && ((p.qty > 0 && ltp >= p.targetPrice) || (p.qty < 0 && ltp <= p.targetPrice))) {
        await this.exitOnce(p.instrumentKey, p.strategyId, 'target reached');
        continue;
      }
      if (this.staleness.isStale(p.instrumentKey, now)) {
        this.bus.publish('risk.event', { kind: 'stale_position', severity: 'warn', message: `stale quotes on open position ${p.instrumentKey}; relying on broker-side stop` });
      }
      // Keep the broker-side stop in sync with the position (resize / replace).
      await this.oms.ensureProtective(p.instrumentKey, p.strategyId, 0);
    }
  }
}
