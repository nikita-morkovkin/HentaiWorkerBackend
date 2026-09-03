import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GramjsService } from './gramjs.service';
import { TelegramBotService } from './telegram-bot.service';
import { FFmpegThumbnailService } from './ffmpeg-thumbnail.service';
import { PostSchedulerService, TELEGRAM_QUEUE_NAME } from './post-scheduler.service';
import { TelegramChannelScraperService } from './telegram-channel-scraper.service';
import { TelegramProcessor } from './telegram.processor';
import { TelegramAutoPostService } from './telegram-autopost.service';
import { TelegramController } from './telegram.controller';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: TELEGRAM_QUEUE_NAME,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
  ],
  controllers: [TelegramController],
  providers: [
    TelegramAutoPostService,
    GramjsService,
    TelegramBotService,
    FFmpegThumbnailService,
    PostSchedulerService,
    TelegramChannelScraperService,
    TelegramProcessor,
  ],
  exports: [
    TelegramAutoPostService,
    GramjsService,
    TelegramBotService,
    FFmpegThumbnailService,
    PostSchedulerService,
    TelegramChannelScraperService,
  ],
})
export class TelegramModule {}

