import { Controller, Get, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { ApiError, Public } from './common/http';
import { assertDatabaseReady } from './database/readiness';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(Redis) private readonly redis: Redis,
  ) {}
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }
  @Public()
  @Get('ready')
  async ready() {
    try {
      await assertDatabaseReady(this.db);
      await this.redis.ping();
    } catch {
      throw new ApiError(503, 'NOT_READY', '服务依赖尚未就绪。', true);
    }
    return { status: 'ok', modelMode: process.env.MODEL_MODE ?? 'mock' };
  }
}
