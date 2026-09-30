import { FulfillmentStatus } from '@prisma/client';

// Fulfillment task status machine. Separate domain from the 19 customer
// states: a FAILED task retries while the customer session stays in
// FULFILLMENT_PROCESSING; only COMPLETED moves the customer to FULFILLED.

type F = FulfillmentStatus;

const TRANSITIONS: Record<F, F[]> = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['COMPLETED', 'FAILED', 'MANUAL_REVIEW'],
  COMPLETED: [],
  FAILED: ['PENDING'], // idempotent retry
  MANUAL_REVIEW: ['COMPLETED'],
};

export function canTransitionTask(from: F, to: F): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class IllegalTaskTransitionError extends Error {
  constructor(from: F, to: F) {
    super(`Illegal fulfillment-task transition: ${from} → ${to}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

export function assertTaskTransition(from: F, to: F): void {
  if (!canTransitionTask(from, to)) throw new IllegalTaskTransitionError(from, to);
}
