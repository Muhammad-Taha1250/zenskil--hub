import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AuthModule, forwardRef(() => WhatsappModule)],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
