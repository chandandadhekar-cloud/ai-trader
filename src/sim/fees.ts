// Transaction-cost models (plan §P1.11). Statutory rates are effective-dated so a
// backtest in 2024 uses 2024 rates. Brokerage depends on your plan: override it.
//
// Sources (verify periodically against your broker's contract notes):
//  - STT: Finance Act 2024 (effective 1 Oct 2024) and Finance Act 2026 (effective
//    1 Apr 2026): futures 0.05% sell, options 0.15% of premium on sell, exercised 0.15%.
//  - NSE transaction charges: uniform slab from 1 Oct 2024.
//  - Stamp duty: Indian Stamp Act unified rates (1 Jul 2020), buy side only.
//  - SEBI turnover fee ₹10/crore; GST 18% on brokerage + exchange + SEBI fee.

export type IndianSegment = 'EQ_INTRADAY' | 'EQ_DELIVERY' | 'FUT' | 'OPT';

interface StatutoryRates {
  from: string; // inclusive YYYY-MM-DD
  stt: { EQ_INTRADAY_SELL: number; EQ_DELIVERY_BOTH: number; FUT_SELL: number; OPT_SELL_PREMIUM: number; OPT_EXERCISE: number };
  nseTxn: { EQ: number; FUT: number; OPT: number };
}

const STATUTORY: StatutoryRates[] = [
  {
    from: '2000-01-01',
    stt: { EQ_INTRADAY_SELL: 0.00025, EQ_DELIVERY_BOTH: 0.001, FUT_SELL: 0.000125, OPT_SELL_PREMIUM: 0.000625, OPT_EXERCISE: 0.00125 },
    nseTxn: { EQ: 0.0000322, FUT: 0.000019, OPT: 0.0005 },
  },
  {
    from: '2024-10-01',
    stt: { EQ_INTRADAY_SELL: 0.00025, EQ_DELIVERY_BOTH: 0.001, FUT_SELL: 0.0002, OPT_SELL_PREMIUM: 0.001, OPT_EXERCISE: 0.00125 },
    nseTxn: { EQ: 0.0000297, FUT: 0.0000173, OPT: 0.0003503 },
  },
  {
    from: '2026-04-01',
    stt: { EQ_INTRADAY_SELL: 0.00025, EQ_DELIVERY_BOTH: 0.001, FUT_SELL: 0.0005, OPT_SELL_PREMIUM: 0.0015, OPT_EXERCISE: 0.0015 },
    nseTxn: { EQ: 0.0000297, FUT: 0.0000173, OPT: 0.0003503 },
  },
];

const STAMP_BUY: Record<IndianSegment, number> = { EQ_DELIVERY: 0.00015, EQ_INTRADAY: 0.00003, FUT: 0.00002, OPT: 0.00003 };
const SEBI_FEE = 10 / 1e7; // ₹10 per crore
const GST = 0.18;

export interface BrokeragePlan {
  /** Brokerage per executed order = min(flat, pct * turnover); pct=Infinity means flat only. */
  EQ_INTRADAY: { flat: number; pct: number };
  EQ_DELIVERY: { flat: number; pct: number };
  FUT: { flat: number; pct: number };
  OPT: { flat: number; pct: number };
  /** Depository charge per scrip on delivery sells (incl. GST). */
  dpChargePerSell: number;
}

export const DEFAULT_BROKERAGE: BrokeragePlan = {
  EQ_INTRADAY: { flat: 20, pct: 0.0005 },
  EQ_DELIVERY: { flat: 20, pct: 0.025 },
  FUT: { flat: 20, pct: 0.0005 },
  OPT: { flat: 20, pct: Infinity },
  dpChargePerSell: 20,
};

export interface ChargeBreakdown {
  turnover: number;
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  dp: number;
  total: number;
}

export function statutoryRatesOn(date: string): StatutoryRates {
  let r = STATUTORY[0];
  for (const s of STATUTORY) if (date >= s.from) r = s;
  return r;
}

/**
 * Charges for ONE executed order leg. For options, `price` is the premium.
 * `exercised` applies option-exercise STT on intrinsic value (pass intrinsic as price).
 */
export function indianCharges(
  seg: IndianSegment,
  side: 'BUY' | 'SELL',
  price: number,
  qty: number,
  date: string,
  plan: BrokeragePlan = DEFAULT_BROKERAGE,
  opts: { exercised?: boolean } = {},
): ChargeBreakdown {
  const turnover = Math.abs(price * qty);
  const r = statutoryRatesOn(date);
  const b = plan[seg];
  const brokerage = turnover === 0 ? 0 : Math.min(b.flat, Number.isFinite(b.pct) ? b.pct * turnover : b.flat);

  let stt = 0;
  if (seg === 'EQ_DELIVERY') stt = r.stt.EQ_DELIVERY_BOTH * turnover;
  else if (seg === 'EQ_INTRADAY' && side === 'SELL') stt = r.stt.EQ_INTRADAY_SELL * turnover;
  else if (seg === 'FUT' && side === 'SELL') stt = r.stt.FUT_SELL * turnover;
  else if (seg === 'OPT') {
    if (opts.exercised) stt = r.stt.OPT_EXERCISE * turnover;
    else if (side === 'SELL') stt = r.stt.OPT_SELL_PREMIUM * turnover;
  }

  const txnRate = seg === 'FUT' ? r.nseTxn.FUT : seg === 'OPT' ? r.nseTxn.OPT : r.nseTxn.EQ;
  const exchange = txnRate * turnover;
  const sebi = SEBI_FEE * turnover;
  const stamp = side === 'BUY' ? STAMP_BUY[seg] * turnover : 0;
  const gst = GST * (brokerage + exchange + sebi);
  const dp = seg === 'EQ_DELIVERY' && side === 'SELL' ? plan.dpChargePerSell : 0;
  // STT is rounded to the rupee on contract notes; keep paise precision here for
  // aggregation and round only in reports.
  const total = brokerage + stt + exchange + sebi + stamp + gst + dp;
  return { turnover, brokerage, stt, exchange, sebi, stamp, gst, dp, total };
}

// ---------------------------------------------------------------------------
// Delta Exchange India

export interface DeltaFeePlan {
  makerFutures: number;
  takerFutures: number;
  gst: number;
  /** Apply 1% TDS on the sell leg (conservative VDA treatment; confirm with your CA). */
  applyTds: boolean;
  tdsRate: number;
}

export const DEFAULT_DELTA_FEES: DeltaFeePlan = {
  makerFutures: 0.0002,
  takerFutures: 0.0005,
  gst: 0.18,
  applyTds: true,
  tdsRate: 0.01,
};

export interface DeltaCharges {
  notional: number;
  fee: number;
  gst: number;
  /** TDS is a tax credit, not a cost, but it locks up cash until filing. */
  tds: number;
  total: number;
}

export function deltaCharges(notional: number, liquidity: 'maker' | 'taker', side: 'BUY' | 'SELL', plan: DeltaFeePlan = DEFAULT_DELTA_FEES): DeltaCharges {
  const n = Math.abs(notional);
  const fee = n * (liquidity === 'maker' ? plan.makerFutures : plan.takerFutures);
  const gst = fee * plan.gst;
  const tds = plan.applyTds && side === 'SELL' ? n * plan.tdsRate : 0;
  return { notional: n, fee, gst, tds, total: fee + gst };
}

/** Funding payment for a perp position over one funding interval (positive = you pay). */
export function fundingPayment(positionNotional: number, fundingRate: number): number {
  return positionNotional * fundingRate;
}
