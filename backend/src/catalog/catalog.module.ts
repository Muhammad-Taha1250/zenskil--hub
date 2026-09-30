import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

@Module({
  imports: [AuthModule],
  providers: [CatalogService],
  controllers: [CatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
