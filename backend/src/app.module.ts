import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { CatalogModule } from './catalog/catalog.module';
import { CouponsModule } from './coupons/coupons.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { SupportModule } from './support/support.module';
import { RefundsModule } from './refunds/refunds.module';
import { ProofsModule } from './proofs/proofs.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { SettingsModule } from './settings/settings.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AiModule } from './ai/ai.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ConversationsModule } from './conversations/conversations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AutomationModule } from './automation/automation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule, // global (PrismaService)
    AuditModule, // global
    HealthModule,
    AuthModule,
    CustomersModule,
    CatalogModule,
    CouponsModule,
    OrdersModule,
    PaymentsModule,
    FulfillmentModule,
    SubscriptionsModule,
    SupportModule,
    RefundsModule,
    ProofsModule,
    ApprovalsModule,
    SettingsModule,
    KnowledgeModule,
    AiModule,
    WhatsappModule,
    ConversationsModule,
    NotificationsModule,
    AnalyticsModule,
    SchedulerModule,
    AutomationModule,
  ],
  // Phase 10: without this, ThrottlerModule.forRoot() alone leaves every
  // @Throttle() decorator inert (v6 requires explicit guard registration).
  // AppThrottlerGuard buckets login attempts per (IP, email) so one
  // attacker's burst can't 429 innocent users behind the same NAT IP.
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
