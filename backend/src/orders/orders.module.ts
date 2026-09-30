import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { CatalogModule } from '../catalog/catalog.module';
import { CouponsModule } from '../coupons/coupons.module';

@Module({
  imports: [AuthModule, CatalogModule, CouponsModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
