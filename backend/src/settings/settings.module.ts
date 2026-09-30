import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [AuthModule],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
