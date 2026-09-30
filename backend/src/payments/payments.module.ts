import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CustomersModule } from '../customers/customers.module';
import { ProofsModule } from '../proofs/proofs.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [AuthModule, CustomersModule, ProofsModule, SettingsModule],
  providers: [PaymentsService],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
