import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [AuthModule],
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
