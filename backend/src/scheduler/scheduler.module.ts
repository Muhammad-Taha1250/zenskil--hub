import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PaymentsModule } from '../payments/payments.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';

@Module({
  imports: [ScheduleModule.forRoot(), SubscriptionsModule, WhatsappModule, PaymentsModule, FulfillmentModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
