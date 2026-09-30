import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { RefundsModule } from '../refunds/refunds.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [AuthModule, RefundsModule, SettingsModule],
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
