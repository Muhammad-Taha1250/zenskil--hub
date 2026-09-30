import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JsonLogger } from '../common/logger/json-logger.service';

// Single PrismaClient for the process. Connects on boot, disconnects on
// shutdown. All domain services inject this — never construct ad-hoc clients.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new JsonLogger();

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL', PrismaService.name);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Liveness probe used by GET /ready. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
