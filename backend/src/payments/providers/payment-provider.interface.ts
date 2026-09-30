// Payment provider abstraction. Day one ships the manual-transfer provider
// (bank/JazzCash/Easypaisa + screenshot review). Gateway providers implement
// the same interface later without touching the order/fulfillment core.

export type ProviderPaymentState = 'SUCCEEDED' | 'PENDING' | 'FAILED';

export interface ProviderPaymentEvent {
  /** Provider-side transaction/reference id (dedupe key). */
  providerPaymentId: string;
  /** Our order number or id the provider echoes back. */
  orderReference: string;
  amountPaisa: number;
  currency: string;
  state: ProviderPaymentState;
  rawPayload: unknown;
}

/** Input for starting a payment against an order. */
export interface CreatePaymentInput {
  orderId: string;
  orderNumber: string;
  amountPaisa: number;
  currency: string;
  paymentExpiresAt: Date | null;
}

/** What the customer must do to pay. Gateway providers return a checkout
 *  URL/session here later; the manual provider returns transfer details. */
export interface PaymentInstructions {
  provider: string;
  amountPaisa: number;
  currency: string;
  deadline: Date | null;
  /** Human-readable receiving account/wallet lines (D6: owner-configured). */
  transferDetails: string;
  /** What proof the customer should send back. */
  proofGuidance: string;
}

/** How a refund is executed for this provider. */
export interface RefundDescriptor {
  mode: 'manual' | 'api';
  detail: string;
}

export const TRANSFER_DETAILS_DRAFT =
  '[DRAFT — HUMAN ACTION REQUIRED (D6): set payment.instructions in settings]';

export interface PaymentProvider {
  readonly name: string;

  /**
   * Start a payment for an order. For the manual provider this returns the
   * transfer instructions (no external call); gateway providers will create
   * a checkout session / payment intent here.
   */
  createPayment(input: CreatePaymentInput): Promise<PaymentInstructions>;

  /**
   * Execute (or describe how to execute) a refund. The manual provider is
   * 'manual': a human moves the money through the bank/wallet and records
   * the provider reference via the refunds module (markExecuted).
   */
  refundPayment(paymentId: string): Promise<RefundDescriptor>;

  /**
   * HMAC/shared-secret verification of the raw webhook body.
   *
   * Secret-rotation convention (Phase 10, T1) for gateway providers:
   * verify with verifyHmacSha256(rawBody, signature,
   * [process.env.PAYMENT_WEBHOOK_SECRET, process.env.PAYMENT_WEBHOOK_SECRET_PREVIOUS])
   * from '../../common/utils/webhook-hmac.util'. Rotate by setting the new
   * secret as PAYMENT_WEBHOOK_SECRET, moving the old one to
   * PAYMENT_WEBHOOK_SECRET_PREVIOUS, rolling-restarting, then clearing
   * _PREVIOUS. Full procedure: /tmp/rotation-note.md.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean;

  /** Normalize a provider webhook payload. Throws on malformed payloads. */
  parseWebhook(payload: unknown): ProviderPaymentEvent;

  /**
   * Independent status check with the provider. The webhook claim alone is
   * NEVER trusted (spec §16 step 7).
   */
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentState>;
}

// -----------------------------------------------------------------------------
// Manual transfer provider (day-one path): no webhooks, no API.
// Money moves via bank/JazzCash/Easypaisa; the customer uploads proof and an
// authorized admin approves or rejects it with a mandatory reason.
// -----------------------------------------------------------------------------

export class ManualTransferProvider implements PaymentProvider {
  readonly name = 'manual_transfer';

  /**
   * Source of the owner-configured receiving account/wallet lines
   * (the `payment.instructions` setting, D6). Injected by PaymentsService;
   * absent in bare unit use, where the DRAFT placeholder is returned.
   */
  constructor(private readonly detailsSource?: () => Promise<string>) {}

  async createPayment(input: CreatePaymentInput): Promise<PaymentInstructions> {
    const transferDetails = this.detailsSource
      ? await this.detailsSource()
      : TRANSFER_DETAILS_DRAFT;
    return {
      provider: this.name,
      amountPaisa: input.amountPaisa,
      currency: input.currency,
      deadline: input.paymentExpiresAt,
      transferDetails,
      proofGuidance:
        'Transfer the exact amount to the account above, then send a screenshot of the transfer receipt here. Our team verifies it manually.',
    };
  }

  async refundPayment(): Promise<RefundDescriptor> {
    return {
      mode: 'manual',
      detail:
        'A human executes the refund through the bank/wallet and records the provider reference via the refunds module (markExecuted).',
    };
  }

  verifyWebhookSignature(): boolean {
    // There are no webhooks for manual transfers.
    return false;
  }

  parseWebhook(): ProviderPaymentEvent {
    throw new Error('manual_transfer has no webhooks');
  }

  async getPaymentStatus(): Promise<ProviderPaymentState> {
    // Nothing to query — status comes from human review.
    return 'PENDING';
  }
}
