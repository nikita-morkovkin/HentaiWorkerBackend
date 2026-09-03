import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PostSchedulerService, TELEGRAM_QUEUE_NAME } from './post-scheduler.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramChannelScraperService } from './telegram-channel-scraper.service';
import { CreateTelegramPostDto, SendDirectMessageDto } from './dto/telegram.dto';
import { ScrapeTelegramChannelDto, ScrapeTelegramPostDto } from './dto/telegram-scraper.dto';

@ApiTags('Telegram Publishing & Bot')
@Controller('api/telegram')
export class TelegramController {
  constructor(
    private readonly postScheduler: PostSchedulerService,
    private readonly botService: TelegramBotService,
    private readonly scraperService: TelegramChannelScraperService,
    @InjectQueue(TELEGRAM_QUEUE_NAME) private readonly telegramQueue: Queue,
  ) {}

  @Post('posts')
  @ApiOperation({ summary: 'Create and schedule or immediately publish a Telegram video post' })
  public async createPost(@Body() dto: CreateTelegramPostDto) {
    return this.postScheduler.createPost(dto);
  }

  @Get('posts')
  @ApiOperation({ summary: 'List recent and scheduled posts' })
  public async getPosts(@Query('limit') limit?: number) {
    return this.postScheduler.getPosts(limit ? Number(limit) : 50);
  }

  @Post('message')
  @ApiOperation({ summary: 'Send direct text message via Telegram Bot' })
  public async sendMessage(@Body() dto: SendDirectMessageDto) {
    return this.botService.sendMessage(dto.chatId, dto.text);
  }

  @Post('scraper/channel')
  @ApiOperation({ summary: 'Queue parsing of anime episodes from a Telegram channel' })
  public async scrapeChannel(@Body() dto: ScrapeTelegramChannelDto) {
    const clean = this.scraperService.cleanChannelIdentifier(dto.channel);
    const job = await this.telegramQueue.add(
      'crawl-telegram-channel',
      {
        channel: clean,
        limit: dto.limit || 20,
        offsetId: dto.offsetId,
      },
      { priority: 1, removeOnComplete: true },
    );
    return {
      success: true,
      jobId: job.id,
      message: `Парсинг канала @${clean} добавлен в очередь (до ${dto.limit || 20} постов)`,
    };
  }

  @Post('scraper/post')
  @ApiOperation({ summary: 'Scrape a single specific post with video from a Telegram channel' })
  public async scrapePost(@Body() dto: ScrapeTelegramPostDto) {
    const clean = this.scraperService.cleanChannelIdentifier(dto.channel);
    const job = await this.telegramQueue.add(
      'scrape-telegram-post',
      {
        channel: clean,
        messageId: dto.messageId,
      },
      { priority: 2, removeOnComplete: true },
    );
    return {
      success: true,
      jobId: job.id,
      message: `Парсинг поста #${dto.messageId} из канала @${clean} добавлен в очередь`,
    };
  }
}

