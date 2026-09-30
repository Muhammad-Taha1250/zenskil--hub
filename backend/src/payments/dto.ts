import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaymentStatus } from '@prisma/client';

export class ListPaymentsQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
}

export class SubmitProofDto {
  @IsString() proofUrl!: string;
  @IsOptional() @IsString() proofHash?: string;
}

export class DecideManualPaymentDto {
  @IsEnum(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @IsString() reason!: string;
}
