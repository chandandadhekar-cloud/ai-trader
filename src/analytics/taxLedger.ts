// Tax-aware P&L ledgers (plan §P2.18). Separate buckets because Indian tax
// treatment differs by activity. Estimates only — confirm with a chartered
// accountant under the Income-tax Act 2025 numbering.
//  - EQ_INTRADAY: speculative business income (losses set off only against speculative gains), slab rate
//  - FNO: non-speculative business income, slab rate (may trigger tax-audit thresholds)
//  - EQ_STCG: equity delivery held <= 12 months, 20% (since 23 Jul 2024)
//  - EQ_LTCG: equity delivery held > 12 months, 12.5% above ₹1.25 lakh exemption
//  - CRYPTO_VDA: 30% flat on each gain, only cost of acquisition deductible, no loss
//    set-off or carry-forward, 1% TDS on transfers (tracked as a credit)

import type { Db } from '../db/database.ts';
import type { Instrument } from '../core/types.ts';

export type TaxBucket = 'EQ_INTRADAY' | 'FNO' | 'EQ_STCG' | 'EQ_LTCG' | 'CRYPTO_VDA';

export function fyOf(ts: number): string {
  const d = new Date(ts + 330 * 60_000);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function bucketFor(inst: Instrument, product: 'I' | 'D' | 'MTF', holdingDays: number): TaxBucket {
  if (inst.venue === 'DELTA') return 'CRYPTO_VDA';
  if (inst.type === 'FUT' || inst.type === 'CE' || inst.type === 'PE') return 'FNO';
  if (product === 'I') return 'EQ_INTRADAY';
  return holdingDays > 365 ? 'EQ_LTCG' : 'EQ_STCG';
}

export interface TaxSummaryRow {
  bucket: TaxBucket;
  trades: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  estTax: number;
  tdsCredit: number;
  afterTax: number;
  note: string;
}

export interface TaxRates {
  slab: number; // marginal slab rate for business income
  cess: number;
  stcg: number;
  ltcg: number;
  ltcgExemption: number;
  vda: number;
}

export const DEFAULT_TAX_RATES: TaxRates = { slab: 0.3, cess: 0.04, stcg: 0.2, ltcg: 0.125, ltcgExemption: 125000, vda: 0.3 };

export class TaxLedger {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(e: { ts: number; bucket: TaxBucket; instrumentKey: string; qty: number; buyValue: number; sellValue: number; charges: number; tds?: number; strategyId: string; mode: string }): void {
    this.db.run(
      'INSERT INTO tax_ledger (ts, fy, bucket, instrument_key, qty, buy_value, sell_value, charges, gross_pnl, tds, strategy_id, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      e.ts, fyOf(e.ts), e.bucket, e.instrumentKey, e.qty, e.buyValue, e.sellValue, e.charges, e.sellValue - e.buyValue, e.tds ?? 0, e.strategyId, e.mode,
    );
  }

  summary(fy: string, mode: string, rates: TaxRates = DEFAULT_TAX_RATES): TaxSummaryRow[] {
    const rows = this.db.all<{ bucket: TaxBucket; gross_pnl: number; charges: number; tds: number }>('SELECT bucket, gross_pnl, charges, tds FROM tax_ledger WHERE fy = ? AND mode = ?', fy, mode);
    const buckets: TaxBucket[] = ['EQ_INTRADAY', 'FNO', 'EQ_STCG', 'EQ_LTCG', 'CRYPTO_VDA'];
    return buckets.map((b) => {
      const r = rows.filter((x) => x.bucket === b);
      const gross = r.reduce((a, x) => a + x.gross_pnl, 0);
      const charges = r.reduce((a, x) => a + x.charges, 0);
      const tds = r.reduce((a, x) => a + x.tds, 0);
      const net = gross - charges;
      let tax = 0;
      let note = '';
      const c = 1 + rates.cess;
      switch (b) {
        case 'EQ_INTRADAY':
          tax = Math.max(0, net) * rates.slab * c;
          note = 'Speculative; losses only offset speculative gains (4-year carry-forward).';
          break;
        case 'FNO':
          tax = Math.max(0, net) * rates.slab * c;
          note = 'Non-speculative business income; check tax-audit turnover thresholds.';
          break;
        case 'EQ_STCG':
          tax = Math.max(0, net) * rates.stcg * c;
          note = 'STCG on listed equity (STT paid).';
          break;
        case 'EQ_LTCG':
          tax = Math.max(0, net - rates.ltcgExemption) * rates.ltcg * c;
          note = `LTCG above ₹${rates.ltcgExemption.toLocaleString('en-IN')} exemption.`;
          break;
        case 'CRYPTO_VDA':
          // Each gain taxed separately; losses and fees are not deductible.
          tax = r.reduce((a, x) => a + Math.max(0, x.gross_pnl), 0) * rates.vda * c;
          note = '30% on each gain; no loss set-off; only cost of acquisition deductible; 1% TDS credit.';
          break;
      }
      return { bucket: b, trades: r.length, grossPnl: gross, charges, netPnl: net, estTax: tax, tdsCredit: tds, afterTax: net - tax, note };
    });
  }

  fys(): string[] {
    return this.db.all<{ fy: string }>('SELECT DISTINCT fy FROM tax_ledger ORDER BY fy DESC').map((r) => r.fy);
  }
}
