// Instrument master with point-in-time (PIT) history (plan §P1.7).
// ISIN is the stable identity; symbols change. History rows record which symbol
// an ISIN traded under from a given date, and universe membership (NIFTY 50/500,
// F&O list) is stored by date so backtests use the universe as it was, including
// names that were later delisted (survivorship-free).

import type { Instrument } from '../core/types.ts';

export interface SymbolHistory {
  isin: string;
  symbol: string;
  from: string; // YYYY-MM-DD inclusive
}

export class InstrumentRegistry {
  private byKeyMap = new Map<string, Instrument>();
  private bySymbolMap = new Map<string, Instrument>();
  private history: SymbolHistory[] = [];
  private universes = new Map<string, { from: string; to?: string; key: string }[]>();

  upsert(i: Instrument): void {
    this.byKeyMap.set(i.key, i);
    // Prefer the cash instrument for plain symbol lookups.
    const cur = this.bySymbolMap.get(i.symbol);
    if (!cur || (i.type === 'EQ' && cur.type !== 'EQ') || i.type === 'INDEX') this.bySymbolMap.set(i.symbol, i);
  }

  byKey(key: string): Instrument | undefined {
    return this.byKeyMap.get(key);
  }

  bySymbol(sym: string): Instrument | undefined {
    return this.bySymbolMap.get(sym);
  }

  all(): Instrument[] {
    return [...this.byKeyMap.values()];
  }

  size(): number {
    return this.byKeyMap.size;
  }

  addSymbolHistory(h: SymbolHistory): void {
    this.history.push(h);
    this.history.sort((a, b) => (a.isin === b.isin ? a.from.localeCompare(b.from) : a.isin.localeCompare(b.isin)));
  }

  /** Symbol an ISIN traded under on `date`. */
  symbolOn(isin: string, date: string): string | undefined {
    let s: string | undefined;
    for (const h of this.history) if (h.isin === isin && h.from <= date) s = h.symbol;
    return s;
  }

  setMembership(universe: string, key: string, from: string, to?: string): void {
    let l = this.universes.get(universe);
    if (!l) this.universes.set(universe, (l = []));
    l.push({ key, from, to });
  }

  /** Members of `universe` on `date` (inclusive from, exclusive to). */
  universeOn(universe: string, date: string): string[] {
    return (this.universes.get(universe) ?? []).filter((m) => m.from <= date && (!m.to || date < m.to)).map((m) => m.key);
  }

  /**
   * Load Upstox's instrument master (BOD JSON from
   * https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz).
   * Upstox publishes `tick_size` in paise for NSE/BSE instruments.
   */
  loadUpstoxMaster(rows: Record<string, unknown>[]): number {
    let n = 0;
    for (const r of rows) {
      const segment = String(r.segment ?? '');
      const itype = String(r.instrument_type ?? '');
      const key = String(r.instrument_key ?? '');
      if (!key || !segment) continue;
      const type: Instrument['type'] =
        itype === 'FUT' ? 'FUT' : itype === 'CE' ? 'CE' : itype === 'PE' ? 'PE' : itype === 'INDEX' || segment.endsWith('INDEX') ? 'INDEX' : 'EQ';
      const rawTick = Number(r.tick_size ?? 5);
      const tick = rawTick >= 1 ? rawTick / 100 : rawTick;
      const expiryMs = r.expiry !== undefined ? Number(r.expiry) : undefined;
      this.upsert({
        key,
        symbol: String(r.trading_symbol ?? r.tradingsymbol ?? key),
        isin: r.isin ? String(r.isin) : undefined,
        name: r.name ? String(r.name) : undefined,
        venue: segment.startsWith('BSE') ? 'BSE' : 'NSE',
        segment: segment as Instrument['segment'],
        type,
        lotSize: Number(r.lot_size ?? 1) || 1,
        tickSize: tick || 0.05,
        underlying: r.underlying_symbol ? String(r.underlying_symbol) : undefined,
        expiry: expiryMs && Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString().slice(0, 10) : undefined,
        strike: r.strike_price !== undefined ? Number(r.strike_price) : undefined,
        isFnO: segment === 'NSE_FO' || segment === 'BSE_FO',
      });
      n++;
    }
    return n;
  }
}
