// Runtime-tunable configuration persisted in the DB and edited from the admin
// console. Every change is written to the hash-chained audit log.

import { z } from 'zod';
import type { Db } from '../db/database.ts';
import type { AuditLog } from '../governance/auditLog.ts';

export const RiskLimitsSchema = z.object({
  /** Fraction of equity risked per trade (entry-to-stop distance x qty). */
  riskPerTrade: z.number().min(0.0001).max(0.02).default(0.005),
  /** Drawdown from equity peak that halts all new entries (kill switch). */
  maxDrawdownHalt: z.number().min(0.01).max(0.5).default(0.10),
  /** Daily realized+unrealized loss that halts entries for the day. */
  dailyLossLimit: z.number().min(0.001).max(0.2).default(0.02),
  maxOpenPositions: z.number().int().min(0).max(100).default(8),
  /** Gross exposure cap as a multiple of equity. */
  maxGrossExposure: z.number().min(0).max(5).default(1.0),
  /** Max single-name notional as a fraction of equity. */
  maxPositionNotional: z.number().min(0).max(1).default(0.2),
  /** Max share of the instrument's 1-minute volume per order (plan: <= 1%). */
  maxParticipation: z.number().min(0).max(0.1).default(0.01),
  /** Refuse entries within this many ATRs of a price band. */
  bandBufferAtr: z.number().min(0).max(10).default(1.5),
  /** Max total open risk (sum of stop distances) as a fraction of equity. */
  maxOpenRisk: z.number().min(0).max(0.2).default(0.03),
  /** Max positions per sector. */
  maxPerSector: z.number().int().min(1).max(50).default(3),
  /** Pairwise return correlation above which two positions count as one bet. */
  correlationThreshold: z.number().min(0).max(1).default(0.8),
  /** Consecutive losing trades that pause a strategy for the day. */
  maxConsecutiveLosses: z.number().int().min(1).max(50).default(5),
  /** Minimum meta-label probability to take a trade (veto below). */
  minMetaProb: z.number().min(0).max(1).default(0.5),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export const ScannerConfigSchema = z.object({
  zThreshold: z.number().default(4),
  rvolThreshold: z.number().default(3),
  rvolMinZ: z.number().default(2),
  residualZThreshold: z.number().default(3.5),
  /** Opening gap (net of beta x index gap) in daily-sigma units. */
  gapZThreshold: z.number().default(2),
  debounceMin: z.number().default(7),
  indexExplainedSuppress: z.number().default(0.7),
  researchSeverityMin: z.number().default(60),
  oiZThreshold: z.number().default(3.5),
  ivZThreshold: z.number().default(3.5),
  uoaVolOiRatio: z.number().default(3),
});
export type ScannerConfig = z.infer<typeof ScannerConfigSchema>;

export const ResearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Downgrade REACT to IGNORE if more than this share of typical impact is already done. */
  pricedInFraction: z.number().default(0.7),
  /** Downgrade REACT to IGNORE if first publication is older than this. */
  maxNewsAgeMin: z.number().default(30),
  verdictTtlMin: z.number().default(30),
  deepSeverityMin: z.number().default(85),
});
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

// Trade settings: leverage and sizing mode. Leverage raises buying power; the
// stop-loss still bounds the loss on every trade (see risk/engine.ts).
export const TradingConfigSchema = z.object({
  /** Master switch: when off every trade uses 1x (cash) regardless of the values below. */
  leverageEnabled: z.boolean().default(false),
  /**
   * Equity intraday (MIS) leverage. Under SEBI peak-margin rules brokers allow at
   * most 5x on equity intraday; Upstox sets the exact per-stock figure.
   */
  equityIntradayLeverage: z.number().min(1).max(5).default(1),
  /** Crypto perpetuals on Delta Exchange India (set per product on the exchange). */
  cryptoLeverage: z.number().min(1).max(100).default(1),
  /**
   * risk   = size from the stop distance (risk-per-trade from Risk config); leverage only raises the ceiling.
   * margin = size = equity x marginPerTradePct x leverage, still capped by maxLossPerTradePct at the stop.
   */
  sizingMode: z.enum(['risk', 'margin']).default('risk'),
  /** Margin mode: share of equity committed as margin per trade. */
  marginPerTradePct: z.number().min(0.01).max(1).default(0.1),
  /** Hard cap on the loss at the stop for any single trade (both modes). */
  maxLossPerTradePct: z.number().min(0.001).max(0.05).default(0.02),
  /** Stop must sit at most 1/buffer of the way to the liquidation price. */
  liquidationBuffer: z.number().min(1.5).max(10).default(3),
  /** Maintenance margin rate used for the liquidation estimate. */
  maintenanceMargin: z.number().min(0).max(0.2).default(0.005),
});
export type TradingConfig = z.infer<typeof TradingConfigSchema>;

const DEFS = {
  trading: TradingConfigSchema,
  risk: RiskLimitsSchema,
  scanner: ScannerConfigSchema,
  research: ResearchConfigSchema,
} as const;
type Name = keyof typeof DEFS;
type ValueOf<N extends Name> = z.infer<(typeof DEFS)[N]>;

export class RuntimeConfig {
  private cache = new Map<Name, unknown>();
  private listeners = new Set<(name: Name) => void>();
  private db: Db;
  private audit: AuditLog;
  constructor(db: Db, audit: AuditLog) {
    this.db = db;
    this.audit = audit;
  }

  get<N extends Name>(name: N): ValueOf<N> {
    const c = this.cache.get(name);
    if (c) return c as ValueOf<N>;
    const row = this.db.get<{ value: string }>('SELECT value FROM kv_settings WHERE key = ?', name);
    const parsed = DEFS[name].parse(row ? JSON.parse(row.value) : {}) as ValueOf<N>;
    this.cache.set(name, parsed);
    return parsed;
  }

  update<N extends Name>(name: N, patch: Partial<ValueOf<N>>, actor: string): ValueOf<N> {
    const before = this.get(name);
    const next = DEFS[name].parse({ ...before, ...patch }) as ValueOf<N>;
    this.db.run(
      'INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
      name, JSON.stringify(next), Date.now(), actor,
    );
    this.cache.set(name, next);
    this.audit.append(actor, `config.update.${name}`, name, { before, after: next });
    for (const l of this.listeners) l(name);
    return next;
  }

  onChange(l: (name: Name) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  all(): Record<Name, unknown> {
    return { trading: this.get('trading'), risk: this.get('risk'), scanner: this.get('scanner'), research: this.get('research') };
  }
}
