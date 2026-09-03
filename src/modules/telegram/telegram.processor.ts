import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PostSchedulerService, TELEGRAM_QUEUE_NAME } from './post-scheduler.service';
import { TelegramChannelScraperService } from './telegram-channel-scraper.service';
import { GramjsService } from './gramjs.service';
import { TelegramAutoPostService } from './telegram-autopost.service';

@Processor(TELEGRAM_QUEUE_NAME, {
  concurrency: 1,
})
export class TelegramProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramProcessor.name);

  constructor(
    private readonly autoPostService: TelegramAutoPostService,
    private readonly postScheduler: PostSchedulerService,
    private readonly telegramScraper: TelegramChannelScraperService,
    private readonly gramjsService: GramjsService,
  ) {
    super();
  }

  public async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing telegram job [${job.name}] #${job.id}`);

    switch (job.name) {
      case 'autopost-tick':
        return this.autoPostService.processTick();

      case 'publish-post':
        return this.postScheduler.executePublish(job.data.postId);

      case 'crawl-telegram-channel': {
        const { channel, limit, offsetId } = job.data;
        return this.telegramScraper.scrapeChannel(channel, limit || 20, offsetId);
      }

      case 'scrape-telegram-post': {
        const { channel, messageId } = job.data;
        const client = await this.gramjsService.getClient();
        const cleanChannel = this.telegramScraper.cleanChannelIdentifier(channel);
        const messages = await client.getMessages(cleanChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0]) {
          throw new Error(`Message #${messageId} not found in channel @${cleanChannel}`);
        }
        return this.telegramScraper.processTelegramPost(messages[0], cleanChannel);
      }

      default:
        this.logger.warn(`Unknown telegram job: ${job.name}`);
        return null;
    }
  }
}

