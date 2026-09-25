import type { Fill, OrderRequest, OrderStatus, Side } from '../core/types.ts';

export interface BrokerOrderState {
  brokerOrderId: string;
  clientOrderId?: string;
  instrumentKey: string;
  side: Side;
  qty: number;
  filledQty: number;
  avgPrice: number;
  status: OrderStatus;
  type: OrderRequest['type'];
  price?: number;
  triggerPrice?: number;
  reason?: string;
  tag?: string;
  ts: number;
}

export interface BrokerPositionState {
  instrumentKey: string;
  qty: number;
  avgPrice: number;
  product?: string;
}

export interface Broker {
  readonly name: string;
  /** True when orders reach a real exchange. */
  readonly live: boolean;
  placeOrder(req: OrderRequest): Promise<{ brokerOrderId: string }>;
  modifyOrder(brokerOrderId: string, patch: { qty?: number; price?: number; triggerPrice?: number }): Promise<void>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  getOrders(): Promise<BrokerOrderState[]>;
  getPositions(): Promise<BrokerPositionState[]>;
  onOrderUpdate(cb: (u: BrokerOrderState) => void): void;
  onFill(cb: (f: Omit<Fill, 'fees'>) => void): void;
  /** Optional dead-man heartbeat (Delta cancel-after). */
  heartbeat?(): Promise<void>;
  /** Last request headers, kept for compliance verification in paper mode. */
  lastOrderHeaders?(): Record<string, string> | undefined;
}

export class BrokerError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, code: string, retryable: boolean, status?: number) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}
