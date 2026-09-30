import { CustomerState } from '@prisma/client';

// The complete 19-state customer transition table (spec §6, analysis 03 §1).
// Any transition not listed here is rejected and logged. This is a pure
// function module — no DB, no side effects — so it is exhaustively unit-tested.
//
// NOTE: FAILED and MANUAL_REVIEW are fulfillment-*task* statuses, not
// customer states. A failed fulfillment task retries while the customer
// session stays in FULFILLMENT_PROCESSING; only task completion moves the
// customer to FULFILLED.

type S = CustomerState;

const TRANSITIONS: Record<S, S[]> = {
  NEW: ['BROWSING'],
  BROWSING: ['SELECTING_PRODUCT', 'SUPPORT_REQUIRED'],
  SELECTING_PRODUCT: ['SELECTING_PLAN', 'BROWSING', 'SUPPORT_REQUIRED'],
  SELECTING_PLAN: ['WAITING_FOR_CUSTOMER_DETAILS', 'ORDER_CREATED', 'SELECTING_PLAN', 'SUPPORT_REQUIRED', 'CANCELLED'],
  WAITING_FOR_CUSTOMER_DETAILS: ['ORDER_CREATED', 'SELECTING_PLAN'],
  ORDER_CREATED: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAYMENT_PROCESSING', 'CANCELLED', 'SUPPORT_REQUIRED'],
  PAYMENT_PROCESSING: ['PAYMENT_CONFIRMED', 'AWAITING_PAYMENT'],
  PAYMENT_CONFIRMED: ['FULFILLMENT_PENDING', 'REFUND_REQUESTED'],
  FULFILLMENT_PENDING: ['FULFILLMENT_PROCESSING'],
  FULFILLMENT_PROCESSING: ['FULFILLED'],
  FULFILLED: ['ACTIVE'],
  ACTIVE: ['EXPIRING_SOON', 'EXPIRED', 'SUPPORT_REQUIRED'],
  EXPIRING_SOON: ['EXPIRED', 'SELECTING_PLAN'],
  EXPIRED: ['SELECTING_PLAN', 'BROWSING'],
  SUPPORT_REQUIRED: ['BROWSING', 'SELECTING_PLAN', 'AWAITING_PAYMENT'],
  CANCELLED: ['BROWSING'],
  REFUND_REQUESTED: ['REFUNDED', 'PAYMENT_CONFIRMED'],
  REFUNDED: ['BROWSING'],
};

export function allowedTransitions(from: S): S[] {
  return [...(TRANSITIONS[from] ?? [])];
}

export function canTransition(from: S, to: S): boolean {
  return allowedTransitions(from).includes(to);
}

export class IllegalStateTransitionError extends Error {
  readonly from: S;
  readonly to: S;
  constructor(from: S, to: S) {
    super(`Illegal customer-state transition: ${from} → ${to}`);
    this.name = 'IllegalStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: S, to: S): void {
  if (!canTransition(from, to)) throw new IllegalStateTransitionError(from, to);
}

/** All 19 states, for validation and tests. */
export const ALL_CUSTOMER_STATES: S[] = [
  'NEW',
  'BROWSING',
  'SELECTING_PRODUCT',
  'SELECTING_PLAN',
  'WAITING_FOR_CUSTOMER_DETAILS',
  'ORDER_CREATED',
  'AWAITING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAYMENT_CONFIRMED',
  'FULFILLMENT_PENDING',
  'FULFILLMENT_PROCESSING',
  'FULFILLED',
  'ACTIVE',
  'EXPIRING_SOON',
  'EXPIRED',
  'SUPPORT_REQUIRED',
  'CANCELLED',
  'REFUND_REQUESTED',
  'REFUNDED',
];
