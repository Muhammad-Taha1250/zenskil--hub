import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';

@Module({
  imports: [AuthModule],
  providers: [RefundsService],
  controllers: [RefundsController],
  exports: [RefundsService],
})
export class RefundsModule {}
