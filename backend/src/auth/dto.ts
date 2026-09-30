import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  /** Required when the admin has 2FA enabled. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'totpCode must be 6 digits' })
  totpCode?: string;
}

export class TotpEnableDto {
  @IsString()
  @IsNotEmpty()
  secret!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class TotpDisableDto {
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class BootstrapAdminDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  password!: string;
}
