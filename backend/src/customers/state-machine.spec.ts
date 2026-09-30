import { CustomerState } from '@prisma/client';
import {
  ALL_CUSTOMER_STATES,
  IllegalStateTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
} from '../customers/state-machine';

// Mirrors the authoritative table; the test fails loudly if the module drifts.
const EXPECTED: Record<CustomerState, CustomerState[]> = {
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

describe('customer state machine', () => {
  it('covers exactly the 19 spec states', () => {
    expect(ALL_CUSTOMER_STATES).toHaveLength(19);
    expect(new Set(ALL_CUSTOMER_STATES).size).toBe(19);
  });

  it('matches the authoritative transition table for every state', () => {
    for (const state of ALL_CUSTOMER_STATES) {
      expect(allowedTransitions(state).sort()).toEqual([...EXPECTED[state]].sort());
    }
  });

  it('allows the critical order/payment/fulfillment happy path', () => {
    const path: CustomerState[] = [
      'NEW', 'BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN',
      'WAITING_FOR_CUSTOMER_DETAILS', 'ORDER_CREATED', 'AWAITING_PAYMENT',
      'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED', 'FULFILLMENT_PENDING',
      'FULFILLMENT_PROCESSING', 'FULFILLED', 'ACTIVE',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('permits SELECTING_PLAN -> ORDER_CREATED and ORDER_CREATED -> CANCELLED (deterministic flow)', () => {
    expect(canTransition('SELECTING_PLAN', 'ORDER_CREATED')).toBe(true);
    expect(canTransition('ORDER_CREATED', 'CANCELLED')).toBe(true);
  });

  it('supports the provider payment-confirmation walk AWAITING_PAYMENT -> PAYMENT_PROCESSING -> PAYMENT_CONFIRMED -> FULFILLMENT_PENDING', () => {
    expect(canTransition('AWAITING_PAYMENT', 'PAYMENT_PROCESSING')).toBe(true);
    expect(canTransition('PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED')).toBe(true);
    expect(canTransition('PAYMENT_CONFIRMED', 'FULFILLMENT_PENDING')).toBe(true);
  });

  it('rejects illegal transitions and assertTransition throws IllegalStateTransitionError', () => {
    const illegal: [CustomerState, CustomerState][] = [
      ['NEW', 'ACTIVE'],
      ['BROWSING', 'PAYMENT_CONFIRMED'],
      ['ORDER_CREATED', 'FULFILLED'],
      ['AWAITING_PAYMENT', 'FULFILLMENT_PENDING'],
      ['ACTIVE', 'NEW'],
      ['CANCELLED', 'ACTIVE'],
      ['PAYMENT_CONFIRMED', 'CANCELLED'], // refunds go via REFUND_REQUESTED
      ['FULFILLED', 'FULFILLMENT_PROCESSING'],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(IllegalStateTransitionError);
    }
  });

  it('has no self-loops except SELECTING_PLAN (plan re-selection)', () => {
    for (const state of ALL_CUSTOMER_STATES) {
      if (state === 'SELECTING_PLAN') continue;
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('terminal-ish states can only go back via BROWSING or the renewal loop', () => {
    expect(allowedTransitions('REFUNDED')).toEqual(['BROWSING']);
    expect(allowedTransitions('CANCELLED')).toEqual(['BROWSING']);
    expect(canTransition('EXPIRED', 'SELECTING_PLAN')).toBe(true); // renewal
  });
});
