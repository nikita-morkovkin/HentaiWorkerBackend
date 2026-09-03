import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CheerioScraperService } from './cheerio-scraper.service';
import { ScraperProcessor, SCRAPER_QUEUE_NAME } from './scraper.processor';
import { ScraperQueueService } from './scraper-queue.service';
import { ScraperController } from './scraper.controller';

@Module({
  imports: [
    BullModule.registerQueue({
      name: SCRAPER_QUEUE_NAME,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
  ],
  controllers: [ScraperController],
  providers: [CheerioScraperService, ScraperProcessor, ScraperQueueService],
  exports: [CheerioScraperService, ScraperQueueService],
})
export class ScraperModule {}
