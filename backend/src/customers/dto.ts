import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { CustomerState, Language } from '@prisma/client';

export class ListCustomersQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(CustomerState) state?: CustomerState;
  @IsOptional() @IsString() search?: string;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsEnum(Language) language?: Language;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() optedIn?: boolean;
}

export class TransitionStateDto {
  @IsEnum(CustomerState) to!: CustomerState;
}
