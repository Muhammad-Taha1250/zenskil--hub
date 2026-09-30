import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceTokenGuard } from '../common/guards/service-token.guard';
import { Throttle } from '@nestjs/throttler';
import { AutomationService } from './automation.service';
import { AdminAlertService } from './admin-alert.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MaintenanceService } from './maintenance.service';

// Machine-to-machine endpoints for the n8n automation layer (Phase 5).
//
// Authenticated ONLY by the automation service token (x-service-token header);
// never by admin JWT. n8n workflows are thin dispatchers — they fire on
// schedule and call these endpoints; every business decision lives in
// AutomationService / the domain services, where it is tested.
@Controller('automation')
@UseGuards(ServiceTokenGuard)
// Phase 10: explicit per-endpoint ceiling on top of the service-token guard.
// n8n fires these on schedule; 120/min is far above any legitimate cadence
// and bounds the blast radius of a misconfigured/rogue dispatcher.
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly maintenance: MaintenanceService,
    private readonly alerts: AdminAlertService,
    private readonly knowledge: KnowledgeService,
  ) {}

  // ------------------------------------------------------------ dispatcher
  @Get('notifications/pending')
  pendingNotifications(@Query('limit') limit?: string) {
    return this.automation.pendingNotifications(limit ? parseInt(limit, 10) : 50);
  }

  @Post('notifications/:id/dispatch')
  dispatchNotification(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.dispatchNotification(id);
  }

  // ------------------------------------------------------------- abandoned
  @Get('orders/abandoned')
  abandonedCandidates(@Query('limit') limit?: string) {
    return this.automation.findAbandonmentCandidates(
      new Date(), limit ? parseInt(limit, 10) : 100,
    );
  }

  @Post('orders/:id/abandonment-reminder')
  abandonmentReminder(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.sendAbandonmentReminder(id);
  }

  // --------------------------------------------------------------- renewal
  @Get('subscriptions/renewal-candidates')
  renewalCandidates(@Query('limit') limit?: string) {
    return this.automation.findRenewalCandidates(
      new Date(), limit ? parseInt(limit, 10) : 200,
    );
  }

  @Post('subscriptions/:id/renewal-reminder')
  renewalReminder(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.sendRenewalReminder(id);
  }

  @Post('subscriptions/sweeper/run')
  runSweeper() {
    return this.automation.runExpirySweeper();
  }

  // ---------------------------------------------------------------- payments

  /** Payment-window expiry sweeper (Phase 7): expire unpaid PENDING payments. */
  @Post('payments/expire')
  expirePayments() {
    return this.automation.runPaymentExpirySweeper();
  }

  // -------------------------------------------------------------- fulfillment

  /** Fulfillment worker (Phase 8): run PENDING tasks through the provider. */
  @Post('fulfillment/process')
  processFulfillment(@Query('limit') limit?: string) {
    return this.automation.processFulfillmentTasks(limit ? parseInt(limit, 10) : 25);
  }

  // ---------------------------------------------------------------- tickets
  @Get('support/tickets/alerts')
  ticketAlerts(@Query('limit') limit?: string) {
    return this.automation.findUnalertedTickets(limit ? parseInt(limit, 10) : 50);
  }

  @Post('support/tickets/:id/alert')
  claimTicketAlert(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.claimTicketAlert(id);
  }

  // Admin alert outbox (Phase 6): durable delivery of claimed ticket alerts.
  // The in-process cron also runs this every minute; n8n calls it after the
  // claim loop so delivery starts immediately.
  @Post('support/alerts/process')
  processAlertOutbox(@Query('limit') limit?: string) {
    return this.alerts.processOutbox(limit ? parseInt(limit, 10) : 50);
  }

  @Get('support/alerts/outbox')
  alertOutboxStatus() {
    return this.alerts.outboxStatus();
  }

  // ------------------------------------------------------- knowledge base
  // Backfill vector embeddings for KB chunks (Phase 6). No-op unless
  // AI_EMBEDDING_API_KEY is configured; safe to call on a schedule.
  @Post('kb/reindex-embeddings')
  reindexEmbeddings(@Query('limit') limit?: string) {
    return this.knowledge.reindexEmbeddings(limit ? parseInt(limit, 10) : 200);
  }

  @Get('kb/embeddings-status')
  embeddingsStatus() {
    return { enabled: this.knowledge.embeddingsEnabled };
  }

  // ----------------------------------------------------------- maintenance
  @Post('maintenance/db-backup')
  dbBackup() {
    return this.maintenance.runDbBackup();
  }
}
