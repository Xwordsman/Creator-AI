import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { readEnvironment, type Environment } from './config/environment';
import { createDataSource } from './database/data-source';
import { assertDatabaseReady } from './database/readiness';

@Global()
@Module({
  providers: [
    { provide: 'ENV', useFactory: readEnvironment },
    {
      provide: DataSource,
      inject: ['ENV'],
      useFactory: async (env: Environment) => {
        const db = await createDataSource(env.databaseUrl).initialize();
        try {
          await assertDatabaseReady(db);
          return db;
        } catch (error) {
          await db.destroy();
          throw error;
        }
      },
    },
    {
      provide: Redis,
      inject: ['ENV'],
      useFactory: async (env: Environment) => {
        const redis = new Redis(env.redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          commandTimeout: 5000,
          lazyConnect: true,
        });
        redis.on('error', () => undefined);
        await redis.connect();
        return redis;
      },
    },
  ],
  exports: ['ENV', DataSource, Redis],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(Redis) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown() {
    this.redis.disconnect();
    if (this.db.isInitialized) await this.db.destroy();
  }
}
