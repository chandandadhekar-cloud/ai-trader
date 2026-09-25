// Freak-trade filter (plan §P1.8): drop prints more than k x ATR away from the
// session VWAP when the print's quantity is tiny relative to typical trade size.
// Such prints must not trigger stops, anomalies or signals.

export interface FreakTradeParams {
  k: number;
  /** Quantity below this fraction of the median trade size is "tiny". */
  tinyQtyFraction: number;
}

export const DEFAULT_FREAK: FreakTradeParams = { k: 4, tinyQtyFraction: 0.1 };

export function isFreakTrade(price: number, qty: number | undefined, vwap: number | undefined, atr: number | undefined, medianTradeQty: number | undefined, p: FreakTradeParams = DEFAULT_FREAK): boolean {
  if (!vwap || !atr || atr <= 0) return false;
  const far = Math.abs(price - vwap) > p.k * atr;
  if (!far) return false;
  if (qty === undefined || !medianTradeQty) return false; // cannot judge size: do not drop
  return qty < p.tinyQtyFraction * medianTradeQty;
}
