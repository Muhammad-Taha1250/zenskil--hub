import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PaymentsService } from '../payments/payments.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';

// In-process scheduler (spec §47). Runs the background sweepers that Phase 3
// exposed as manual admin triggers:
// - subscription expiry (every 15 min)
// - WhatsApp failed-send retries (every 2 min)
// - payment-window expiry (every 15 min, Phase 7)
// - fulfillment worker: picks up PENDING tasks and runs the provider
//   (every 5 min, Phase 8). The manual provider defers to the admin queue;
//   API providers execute automatically.
// Every job is idempotent and logs failures without crashing the process.
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly subs: SubscriptionsService,
    private readonly whatsapp: WhatsappService,
    private readonly payments: PaymentsService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  @Cron('*/15 * * * *')
  async subscriptionExpiry(): Promise<void> {
    try {
      const r = await this.subs.runExpirySweeper();
      if (r.expired > 0 || r.expiringSoon > 0) {
        this.logger.log(`subscription sweeper: ${r.expiringSoon} expiring soon, ${r.expired} expired`);
      }
    } catch (err) {
      this.logger.error(`subscription sweeper failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Cron('*/15 * * * *')
  async paymentExpiry(): Promise<void> {
    try {
      const r = await this.payments.runPaymentExpirySweeper();
      if (r.expired > 0) {
        this.logger.log(`payment expiry sweeper: ${r.expired} expired`);
      }
    } catch (err) {
      this.logger.error(`payment expiry sweeper failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Cron('*/2 * * * *')
  async whatsappOutboundRetry(): Promise<void> {
    try {
      const r = await this.whatsapp.retryFailedOutbound();
      if (r.retried > 0) {
        this.logger.log(`whatsapp retry sweeper: ${r.retried} due, ${r.sent} sent, ${r.dead} dead-lettered`);
      }
    } catch (err) {
      this.logger.error(`whatsapp retry sweeper failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Fulfillment worker (Phase 8): run PENDING tasks through the provider. */
  @Cron('*/5 * * * *')
  async fulfillmentWorker(): Promise<void> {
    try {
      const r = await this.fulfillment.processPendingTasks();
      if (r.processed > 0) {
        this.logger.log(`fulfillment worker: ${r.processed} processed, ${r.deferred} deferred to admins`);
      }
    } catch (err) {
      this.logger.error(`fulfillment worker failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
