import { Module, forwardRef } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { SupportModule } from '../support/support.module';
import { AiModule } from '../ai/ai.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ProofsModule } from '../proofs/proofs.module';

@Module({
  imports: [
    CustomersModule,
    OrdersModule,
    CatalogModule,
    PaymentsModule,
    SupportModule,
    AiModule,
    ProofsModule,
    forwardRef(() => WhatsappModule),
  ],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
