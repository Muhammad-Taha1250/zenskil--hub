import { IsEnum, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class CreateDraftOrderDto {
  @IsString() planId!: string;
  @IsOptional() @IsString() couponCode?: string;
}

export class CancelOrderDto {
  @IsString() reason!: string;
}

export class ListOrdersQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsString() customerId?: string;
}
