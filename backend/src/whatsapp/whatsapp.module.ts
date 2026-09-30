import { Module, forwardRef } from '@nestjs/common';
import { BaileysClient } from './baileys.client';
import { WhatsappService } from './whatsapp.service';
import { WhatsappAdminController } from './whatsapp-admin.controller';
import { WhatsappSupportController } from './whatsapp-support.controller';
import { ConversationsModule } from '../conversations/conversations.module';
import { SupportModule } from '../support/support.module';
import { AuthModule } from '../auth/auth.module';

// Inbound arrives over the Baileys WebSocket (no Meta webhook controller):
// BaileysClient normalizes socket events and WhatsappService wires them
// into ConversationsService.handleInbound on module init.
@Module({
  imports: [forwardRef(() => ConversationsModule), SupportModule, AuthModule],
  providers: [BaileysClient, WhatsappService],
  controllers: [WhatsappAdminController, WhatsappSupportController],
  exports: [WhatsappService, BaileysClient],
})
export class WhatsappModule {}
