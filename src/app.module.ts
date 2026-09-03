import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StorageModule } from './modules/storage/storage.module';
import { ScraperModule } from './modules/scraper/scraper.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { AnimeModule } from './modules/anime/anime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        if (redisUrl) {
          const parsed = new URL(redisUrl);
          const isTls = parsed.protocol === 'rediss:';
          return {
            connection: {
              host: parsed.hostname,
              port: Number(parsed.port) || 6379,
              username: parsed.username || undefined,
              password: parsed.password || undefined,
              tls: isTls ? {} : undefined,
              maxRetriesPerRequest: null,
            },
          };
        }
        return {
          connection: {
            host: config.get<string>('REDIS_HOST', '127.0.0.1'),
            port: Number(config.get<number>('REDIS_PORT', 6379)),
            password: config.get<string>('REDIS_PASSWORD') || undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    PrismaModule,
    RealtimeModule,
    SettingsModule,
    StorageModule,
    ScraperModule,
    TelegramModule,
    AnimeModule,
  ],
})
export class AppModule {}
