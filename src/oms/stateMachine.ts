// Order state machine. Only these transitions are legal; anything else is a bug
// or an out-of-order broker message and is logged, not applied.

import type { OrderStatus } from '../core/types.ts';

const T: Record<OrderStatus, OrderStatus[]> = {
  PENDING_NEW: ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'PENDING_CANCEL'],
  NEW: ['PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED', 'EXPIRED', 'REJECTED', 'NEW'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED', 'EXPIRED'],
  PENDING_CANCEL: ['CANCELLED', 'FILLED', 'PARTIALLY_FILLED', 'NEW'],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
};

export const TERMINAL: ReadonlySet<OrderStatus> = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || T[from].includes(to);
}

export function isOpenStatus(s: OrderStatus): boolean {
  return !TERMINAL.has(s);
}
