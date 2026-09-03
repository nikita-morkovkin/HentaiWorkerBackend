import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ScraperQueueService } from './scraper-queue.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ScrapeUrlDto, StartCrawlDto } from './dto/scraper.dto';

@ApiTags('Scraper Automation')
@Controller('api/scraper')
export class ScraperController {
  constructor(
    private readonly queueService: ScraperQueueService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('queue')
  @ApiOperation({ summary: 'Get current scraping queue status, active and waiting jobs count' })
  public async getQueueStats() {
    return this.queueService.getQueueStats();
  }

  @Get('logs')
  @ApiOperation({ summary: 'Get recent task and worker logs' })
  public async getRecentLogs(@Query('limit') limit?: number) {
    const logs = await this.prisma.taskLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit ? Number(limit) : 100,
    });
    return logs.map((l) => ({
      taskType: l.taskType,
      status: l.status,
      message: l.message,
      metadata: l.metadata,
      timestamp: l.createdAt.toISOString(),
    }));
  }

  @Post('crawl')
  @ApiOperation({ summary: 'Start background catalog crawling with anti-ban rate limiting' })
  public async startCrawl(@Body() dto: StartCrawlDto) {
    return this.queueService.startCatalogCrawl(dto.startPage, dto.maxPages);
  }

  @Post('url')
  @ApiOperation({ summary: 'Scrape a specific anime URL directly' })
  public async scrapeUrl(@Body() dto: ScrapeUrlDto) {
    return this.queueService.scrapeAnimeUrl(dto.animeUrl);
  }

  @Post('queue/pause')
  @ApiOperation({ summary: 'Pause the scraper queue' })
  public async pauseQueue() {
    return this.queueService.pauseQueue();
  }

  @Post('queue/resume')
  @ApiOperation({ summary: 'Resume the scraper queue' })
  public async resumeQueue() {
    return this.queueService.resumeQueue();
  }

  @Post('queue/clear')
  @ApiOperation({ summary: 'Clear all pending jobs in scraper queue' })
  public async clearQueue() {
    return this.queueService.clearQueue();
  }
}
