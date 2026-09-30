import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CouponsService } from './coupons.service';
import { CouponsController } from './coupons.controller';

@Module({
  imports: [AuthModule],
  providers: [CouponsService],
  controllers: [CouponsController],
  exports: [CouponsService],
})
export class CouponsModule {}
