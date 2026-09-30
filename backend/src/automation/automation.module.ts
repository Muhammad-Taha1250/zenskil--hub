import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PaymentsModule } from '../payments/payments.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AdminAlertService } from './admin-alert.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [
    AuditModule,
    SettingsModule,
    WhatsappModule,
    NotificationsModule,
    SubscriptionsModule,
    KnowledgeModule,
    PaymentsModule,
    FulfillmentModule,
  ],
  controllers: [AutomationController],
  providers: [AutomationService, MaintenanceService, AdminAlertService],
  exports: [AutomationService, MaintenanceService, AdminAlertService],
})
export class AutomationModule {}
