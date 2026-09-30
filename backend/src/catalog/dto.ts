import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateProductDto {
  @IsString() slug!: string;
  @IsString() name!: string;
  @IsString() category!: string;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsString() longDescription?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsString() longDescription?: string;
  /** What the customer receives; shown in the admin fulfillment task queue. */
  @IsOptional() @IsString() fulfillmentNotes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class CreatePlanDto {
  @IsString() productId!: string;
  @IsString() name!: string;
  @IsInt() @Min(1) durationMonths!: number;
  @IsInt() @Min(1) durationDays!: number;
  @IsInt() @Min(1) pricePaisa!: number;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() @Min(1) durationMonths?: number;
  @IsOptional() @IsInt() @Min(1) durationDays?: number;
  /** Price changes create a PRICE_CHANGE approval instead of applying. */
  @IsOptional() @IsInt() @Min(1) pricePaisa?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class CreateCouponDto {
  @IsString() code!: string;
  @IsString() type!: 'PERCENT' | 'FIXED';
  @IsInt() @Min(1) @Max(100000000) value!: number;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @IsISO8601() validTo?: string;
}
