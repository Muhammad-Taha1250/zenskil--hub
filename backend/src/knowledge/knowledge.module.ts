import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [AuthModule],
  providers: [KnowledgeService],
  controllers: [KnowledgeController],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
