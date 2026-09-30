import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [AuthModule],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
