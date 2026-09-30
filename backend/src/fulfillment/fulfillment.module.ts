import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentController } from './fulfillment.controller';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [AuthModule, CustomersModule, NotificationsModule, SettingsModule],
  providers: [FulfillmentService],
  controllers: [FulfillmentController],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
