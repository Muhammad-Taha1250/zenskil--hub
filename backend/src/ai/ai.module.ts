import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SupportModule } from '../support/support.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [
    CustomersModule,
    OrdersModule,
    CatalogModule,
    PaymentsModule,
    SubscriptionsModule,
    SupportModule,
    KnowledgeModule,
  ],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
