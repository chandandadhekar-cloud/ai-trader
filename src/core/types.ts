// Shared domain types. Everything that crosses a module boundary is defined here
// so backtest, paper and live share one code path.

export type Venue = 'NSE' | 'BSE' | 'DELTA';
export type Segment = 'NSE_EQ' | 'BSE_EQ' | 'NSE_FO' | 'BSE_FO' | 'NSE_INDEX' | 'BSE_INDEX' | 'DELTA_PERP' | 'DELTA_FUT' | 'DELTA_OPT';
export type InstrumentType = 'EQ' | 'INDEX' | 'FUT' | 'CE' | 'PE' | 'PERP';
export type Side = 'BUY' | 'SELL';
export type RunMode = 'backtest' | 'paper' | 'live';

/** Per-strategy deployment stage. `shadow` computes signals but never sends orders. */
export type StrategyStage = 'disabled' | 'shadow' | 'paper' | 'live';

export interface Instrument {
  /** Broker instrument key, e.g. `NSE_EQ|INE002A01018` for Upstox, `BTCUSD` for Delta. */
  key: string;
  symbol: string;
  isin?: string;
  name?: string;
  venue: Venue;
  segment: Segment;
  type: InstrumentType;
  lotSize: number;
  tickSize: number;
  /** Underlying symbol for derivatives. */
  underlying?: string;
  expiry?: string; // YYYY-MM-DD
  strike?: number;
  sector?: string;
  /** Exchange series, e.g. EQ, BE (T2T), SM (SME). */
  series?: string;
  isFnO?: boolean;
  casEligible?: boolean;
}

export interface Tick {
  key: string;
  ltp: number;
  /** Exchange last-trade time, epoch ms. */
  ltt: number;
  /** Local receive time, epoch ms. */
  recvTs: number;
  ltq?: number;
  /** Previous close. */
  cp?: number;
  /** Cumulative volume traded today (Full mode / REST only). */
  vtt?: number;
  oi?: number;
  iv?: number;
  atp?: number;
  tbq?: number;
  tsq?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  /** Top-5 depth when available. */
  depth?: { bidQ: number; bidP: number; askQ: number; askP: number }[];
  /** Indicative equilibrium price (pre-open / closing auction). */
  iep?: number;
  source: 'ws_full' | 'ws_ltpc' | 'rest' | 'synthetic' | 'backtest' | 'delta_ws';
}

export interface Bar {
  key: string;
  /** Bar open time, epoch ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  /** True when the bar was synthesised from backfill rather than live ticks. */
  backfilled?: boolean;
}

export type OrderType = 'LIMIT' | 'MARKET' | 'SL' | 'SL-M';
export type ProductType = 'I' | 'D' | 'MTF'; // Upstox: Intraday, Delivery, MTF

export interface OrderRequest {
  /** Idempotency key; the same key never produces two broker orders. */
  clientOrderId: string;
  instrumentKey: string;
  side: Side;
  qty: number;
  type: OrderType;
  price?: number;
  triggerPrice?: number;
  product: ProductType;
  validity: 'DAY' | 'IOC';
  strategyId: string;
  /** Short tag forwarded to the broker for audit. */
  tag?: string;
  /** Reduce-only orders may bypass entry gates (F&O ban allows only reducing trades). */
  reduceOnly?: boolean;
}

export type OrderStatus =
  | 'PENDING_NEW'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PENDING_CANCEL'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface Fill {
  clientOrderId: string;
  brokerOrderId: string;
  instrumentKey: string;
  side: Side;
  qty: number;
  price: number;
  ts: number;
  fees: number;
}

export interface Position {
  instrumentKey: string;
  qty: number; // signed: + long, - short
  avgPrice: number;
  realizedPnl: number;
  strategyId: string;
  openedAt: number;
  stopPrice?: number;
  targetPrice?: number;
  /** Broker-side protective order id; a trade is not "open" until this is confirmed. */
  protectiveOrderId?: string;
  protectiveConfirmed?: boolean;
}

export interface Signal {
  strategyId: string;
  instrumentKey: string;
  side: Side;
  /** 0..1 strength before meta-labeling. */
  strength: number;
  entry: number;
  stop: number;
  target?: number;
  /** Time stop in minutes. */
  timeStopMin?: number;
  reason: string;
  ts: number;
  /** Set by the ensemble / meta-labeler. */
  metaProb?: number;
  /** Research verdict id that allowed this signal, when required. */
  verdictId?: string;
}

export type AnomalyType =
  | 'RETURN_SHOCK'
  | 'RVOL'
  | 'RESIDUAL'
  | 'GAP'
  | 'BAND_PROXIMITY'
  | 'BAND_HIT'
  | 'OI_SPIKE'
  | 'IV_JUMP'
  | 'UOA'
  | 'IMBALANCE'
  | 'CHANGEPOINT'
  | 'FUNDING_JUMP'
  | 'INDEX_SHOCK';

export interface Anomaly {
  id: string;
  key: string;
  symbol: string;
  type: AnomalyType;
  ts: number;
  severity: number; // 0..100
  z?: number;
  rvol?: number;
  residualZ?: number;
  ret?: number;
  price: number;
  tier: 'A' | 'B' | 'C' | 'D' | 'CRYPTO';
  details: Record<string, unknown>;
  /** True when the index explained most of the move; logged but not researched. */
  suppressed?: boolean;
  researched?: boolean;
}

export type Verdict = 'REACT' | 'FADE' | 'PROTECT' | 'IGNORE' | 'BLOCK' | 'UNCERTAIN';

export interface ResearchVerdict {
  id: string;
  key: string;
  symbol: string;
  anomalyId?: string;
  ts: number;
  path: 'fast' | 'deep' | 'deterministic';
  /** Label proposed by the LLM (or deterministic rules). */
  proposed: Verdict;
  /** Label after code-side verification and mapping; this is what strategies read. */
  final: Verdict;
  causeCategory: string;
  causeSummary: string;
  citedSourceIds: string[];
  droppedClaims: number;
  isNewInformation: boolean;
  direction: 'UP' | 'DOWN' | 'NONE';
  confidence: number;
  calibratedConfidence: number;
  expectedPersistence: 'minutes' | 'hours' | 'days';
  unknowns: string[];
  reasons: string[];
  latencyMs: number;
  model?: string;
  costUsd?: number;
  expiresAt: number;
}
