import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuthModule],
  providers: [SubscriptionsService],
  controllers: [SubscriptionsController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
