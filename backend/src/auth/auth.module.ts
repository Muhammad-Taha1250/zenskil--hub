import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtConfig } from '../config/configuration';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const jwt = config.get<JwtConfig>('jwt')!;
        return { secret: jwt.secret, signOptions: { expiresIn: jwt.expiresIn as `${number}${'s' | 'm' | 'h' | 'd'}` } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
