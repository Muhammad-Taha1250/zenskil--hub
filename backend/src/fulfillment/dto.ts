import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FulfillmentStatus } from '@prisma/client';

export class ListTasksQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(FulfillmentStatus) status?: FulfillmentStatus;
}

export class CompleteTaskDto {
  @IsOptional() @IsString() note?: string;
}

export class FailTaskDto {
  @IsString() error!: string;
}

export class ManualReviewDto {
  @IsString() note!: string;
}
