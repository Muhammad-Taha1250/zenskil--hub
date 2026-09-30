import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';

@Module({
  imports: [AuthModule],
  providers: [SupportService],
  controllers: [SupportController],
  exports: [SupportService],
})
export class SupportModule {}
