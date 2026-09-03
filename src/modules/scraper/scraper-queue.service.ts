import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueStatsResult } from './scraper.interface';
import { QUEUE_NAMES } from '../../common/constants';

export const SCRAPER_QUEUE_NAME = QUEUE_NAMES.SCRAPER;

@Injectable()
export class ScraperQueueService {
  private readonly logger = new Logger(ScraperQueueService.name);
  private activeAbortController: AbortController | null = null;

  constructor(@InjectQueue(SCRAPER_QUEUE_NAME) private readonly queue: Queue) {}

  public getActiveSignal(): AbortSignal {
    if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
      this.activeAbortController = new AbortController();
    }

    return this.activeAbortController.signal;
  }

  public async startCatalogCrawl(startPage: number = 1, maxPages: number = 10) {
    const job = await this.queue.add('crawl-catalog', { startPage, maxPages }, { priority: 1 });
    return {
      success: true,
      jobId: job.id,
      message: `Catalog crawl queued (pages ${startPage}-${maxPages})`,
    };
  }

  public async scrapeAnimeUrl(animeUrl: string) {
    const job = await this.queue.add('scrape-anime', { animeUrl }, { priority: 2 });
    return { success: true, jobId: job.id, message: `Scraping queued for ${animeUrl}` };
  }

  public async getQueueStats(): Promise<QueueStatsResult> {
    const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
      this.queue.isPaused(),
    ]);

    const activeJobs = await this.queue.getActive(0, 10);
    const waitingJobs = await this.queue.getWaiting(0, 10);

    return {
      isPaused,
      counts: { waiting, active, completed, failed, delayed },
      activeJobs: activeJobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
        progress: j.progress,
      })),
      waitingJobs: waitingJobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
      })),
    };
  }

  public async pauseQueue() {
    this.logger.log('Pausing scraper queue and aborting active downloads...');
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort();
      this.logger.log('Abort signal sent to active download streams');
    }
    this.activeAbortController = new AbortController();
    await this.queue.pause();
    return {
      success: true,
      isPaused: true,
      message: 'Очередь парсера приостановлена, активные загрузки отменены',
    };
  }

  public async resumeQueue() {
    this.logger.log('Resuming scraper queue...');
    this.activeAbortController = new AbortController();
    await this.queue.resume();
    return { success: true, isPaused: false, message: 'Очередь парсера возобновлена' };
  }

  public async clearQueue() {
    this.logger.warn('Hard clearing scraper queue...');
    await this.queue.pause();
    await this.queue.drain(true);
    await this.queue.clean(0, 1000, 'wait');
    await this.queue.clean(0, 1000, 'active');
    await this.queue.clean(0, 1000, 'delayed');
    await this.queue.clean(0, 1000, 'failed');
    await this.queue.clean(0, 1000, 'completed');
    await this.queue.resume();
    return { success: true, message: 'Очередь полностью остановлена и очищена' };
  }
}
