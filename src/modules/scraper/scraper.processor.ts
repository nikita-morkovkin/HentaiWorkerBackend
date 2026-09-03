import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { CheerioScraperService } from './cheerio-scraper.service';
import { DriveRouterService } from '../storage/drive-router.service';
import { SettingsService } from '../settings/settings.service';
import { ScraperQueueService, SCRAPER_QUEUE_NAME } from './scraper-queue.service';
import {
  AnimeScrapeJobData,
  CatalogScrapeJobData,
  EpisodeScrapeJobData,
  StreamDownloadJobData,
} from './scraper.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export { SCRAPER_QUEUE_NAME } from './scraper-queue.service';

@Processor(SCRAPER_QUEUE_NAME, {
  concurrency: 2,
})
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);

  constructor(
    @InjectQueue(SCRAPER_QUEUE_NAME) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly scraperService: CheerioScraperService,
    private readonly driveRouter: DriveRouterService,
    private readonly settingsService: SettingsService,
    private readonly realtime: RealtimeGateway,
    private readonly queueService: ScraperQueueService,
  ) {
    super();
  }

  public async process(job: Job<any, any, string>): Promise<any> {
    if (await this.queue.isPaused()) {
      this.logger.log(`Queue is paused, skipping job execution #${job.id}`);
      return { skipped: true, reason: 'Queue paused' };
    }

    this.logger.log(`Processing scraper job [${job.name}] #${job.id}`);

    switch (job.name) {
      case 'crawl-catalog':
        return this.handleCrawlCatalog(job);
      case 'scrape-anime':
        return this.handleScrapeAnime(job);
      case 'scrape-episode':
        return this.handleScrapeEpisode(job);
      case 'download-stream':
        return this.handleDownloadStream(job);
      default:
        this.logger.warn(`Unknown job type: ${job.name}`);
        return null;
    }
  }

  private async handleCrawlCatalog(job: Job<CatalogScrapeJobData>) {
    const startPage = job.data.startPage || 1;
    const maxPages = job.data.maxPages || 5;

    this.realtime.emitLog(
      'SCRAPER',
      'INFO',
      `Started catalog crawl from page ${startPage} up to ${maxPages}`,
    );

    for (let p = startPage; p <= maxPages; p++) {
      if (await this.queue.isPaused()) {
        this.logger.log(`Queue paused during crawl at page ${p}`);
        this.realtime.emitLog(
          'SCRAPER',
          'WARN',
          `Парсинг каталога остановлен на паузу на странице ${p}`,
        );
        return { paused: true, stoppedAtPage: p };
      }

      try {
        const { animeUrls, hasNextPage } = await this.scraperService.scrapeCatalogPage(p);
        this.logger.log(`Page ${p} found ${animeUrls.length} anime entries`);

        for (const url of animeUrls) {
          if (await this.queue.isPaused()) {
            this.logger.log('Queue paused, aborting item enqueue');
            return { paused: true };
          }

          const existing = await this.prisma.animeTitle.findUnique({
            where: { sourceUrl: url },
          });

          if (!existing) {
            await this.queue.add('scrape-anime', { animeUrl: url }, { priority: 2 });
          }
        }

        if (!hasNextPage) {
          this.logger.log(`Reached end of catalog at page ${p}`);
          break;
        }
      } catch (err: any) {
        this.logger.error(`Error on catalog page ${p}: ${err.message}`);
      }
    }

    this.realtime.emitLog('SCRAPER', 'SUCCESS', `Catalog crawl completed up to page ${maxPages}`);
    return { success: true };
  }

  private async handleScrapeAnime(job: Job<AnimeScrapeJobData>) {
    if (await this.queue.isPaused()) {
      return { paused: true };
    }

    const { animeUrl } = job.data;
    this.logger.log(`Scraping anime page: ${animeUrl}`);

    const details = await this.scraperService.scrapeAnimeDetails(animeUrl);

    const anime = await this.prisma.animeTitle.upsert({
      where: { sourceUrl: animeUrl },
      create: {
        russianTitle: details.russianTitle,
        englishTitle: details.englishTitle,
        originalTitle: details.originalTitle,
        description: details.description,
        tags: details.tags,
        genres: details.genres,
        sourceUrl: animeUrl,
        coverUrls: details.coverUrls,
        status: 'SCRAPING',
      },
      update: {
        russianTitle: details.russianTitle,
        englishTitle: details.englishTitle,
        originalTitle: details.originalTitle,
        description: details.description,
        tags: details.tags,
        genres: details.genres,
        coverUrls: details.coverUrls,
      },
    });

    this.realtime.emitLog(
      'SCRAPER',
      'INFO',
      `Собраны метаданные для "${anime.russianTitle}" (Тегов: ${details.tags.length}, Серий: ${details.episodes.length})`,
    );

    for (const ep of details.episodes) {
      if (await this.queue.isPaused()) break;

      const episode = await this.prisma.animeEpisode.upsert({
        where: {
          animeTitleId_episodeNumber: {
            animeTitleId: anime.id,
            episodeNumber: ep.episodeNumber,
          },
        },
        create: {
          animeTitleId: anime.id,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
          sourceEpisodeUrl: ep.sourceEpisodeUrl,
          status: 'PENDING',
        },
        update: {
          sourceEpisodeUrl: ep.sourceEpisodeUrl,
        },
      });

      await this.queue.add(
        'scrape-episode',
        {
          animeId: anime.id,
          episodeId: episode.id,
          episodeUrl: ep.sourceEpisodeUrl,
          episodeNumber: ep.episodeNumber,
        },
        { priority: 3 },
      );
    }

    return { animeId: anime.id, episodesCount: details.episodes.length };
  }

  private async handleScrapeEpisode(job: Job<EpisodeScrapeJobData>) {
    if (await this.queue.isPaused()) {
      return { paused: true };
    }

    const { animeId, episodeId, episodeUrl, episodeNumber } = job.data;

    const anime = await this.prisma.animeTitle.findUnique({ where: { id: animeId } });
    if (!anime) return;

    this.logger.log(
      `Extracting stream links for episode ${episodeNumber} of "${anime.russianTitle}"`,
    );

    const streams = await this.scraperService.scrapeEpisodeStreams(episodeUrl);

    if (streams.length === 0) {
      this.logger.warn(`No video streams found for episode ${episodeNumber} (${episodeUrl})`);
      await this.prisma.animeEpisode.update({
        where: { id: episodeId },
        data: { status: 'ERROR', errorMessage: 'No video streams found' },
      });
      await this.prisma.animeTitle.update({
        where: { id: anime.id },
        data: { status: 'ERROR' },
      });
      await this.realtime.emitLog(
        'SCRAPER',
        'WARN',
        `Не найдены видео-потоки для серии ${episodeNumber} "${anime.russianTitle}"`,
      );
      return;
    }

    for (const streamGroup of streams) {
      for (const q of streamGroup.qualities) {
        if (await this.queue.isPaused()) break;

        await this.queue.add(
          'download-stream',
          {
            animeId: anime.id,
            episodeId,
            russianTitle: anime.russianTitle,
            englishTitle: anime.englishTitle,
            episodeNumber,
            type: streamGroup.type,
            quality: q.quality,
            sourceStreamUrl: q.url,
          },
          {
            priority: 4,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
      }
    }

    await this.prisma.animeEpisode.update({
      where: { id: episodeId },
      data: { status: 'DOWNLOADING' },
    });

    return { streamsCount: streams.length };
  }

  private async handleDownloadStream(job: Job<StreamDownloadJobData>) {
    if (await this.queue.isPaused()) {
      return { paused: true };
    }

    const data = job.data;

    // Validate stream URL before processing to prevent ENOTFOUND crashes
    try {
      const parsed = new URL(data.sourceStreamUrl);
      const host = parsed.hostname;
      if (
        !host.includes('.') ||
        /^[\w-]+\.(mp4|mkv|avi|m3u8|ts|webm|mov|flv)$/i.test(host) ||
        !['http:', 'https:'].includes(parsed.protocol)
      ) {
        this.logger.error(
          `Invalid stream URL for ${data.russianTitle} - Ep ${data.episodeNumber}: "${data.sourceStreamUrl}" — skipping`,
        );
        await this.realtime.emitLog(
          'DRIVE_UPLOAD',
          'ERROR',
          `Невалидный URL стрима (hostname не является доменом): ${data.sourceStreamUrl}`,
        );
        await this.prisma.animeEpisode.update({
          where: { id: data.episodeId },
          data: { status: 'ERROR', errorMessage: `Invalid stream URL: ${data.sourceStreamUrl}` },
        });
        await this.prisma.animeTitle.update({
          where: { id: data.animeId },
          data: { status: 'ERROR' },
        });
        this.realtime.emitFailedFile({
          episodeId: data.episodeId,
          animeTitleId: data.animeId,
          animeTitle: data.russianTitle,
          englishTitle: data.englishTitle,
          episodeNumber: data.episodeNumber,
          errorMessage: `Invalid stream URL: ${data.sourceStreamUrl}`,
          updatedAt: new Date().toISOString(),
        });
        return { error: 'invalid_url', skipped: true };
      }
    } catch {
      this.logger.error(
        `Unparseable stream URL for ${data.russianTitle} Ep ${data.episodeNumber}: ${data.sourceStreamUrl}`,
      );
      await this.prisma.animeEpisode.update({
        where: { id: data.episodeId },
        data: { status: 'ERROR', errorMessage: `Unparseable stream URL: ${data.sourceStreamUrl}` },
      });
      await this.prisma.animeTitle.update({
        where: { id: data.animeId },
        data: { status: 'ERROR' },
      });
      this.realtime.emitFailedFile({
        episodeId: data.episodeId,
        animeTitleId: data.animeId,
        animeTitle: data.russianTitle,
        englishTitle: data.englishTitle,
        episodeNumber: data.episodeNumber,
        errorMessage: `Unparseable stream URL: ${data.sourceStreamUrl}`,
        updatedAt: new Date().toISOString(),
      });
      return { error: 'unparseable_url', skipped: true };
    }

    const proxyUrl = await this.settingsService.getRotatingProxy();
    const signal = this.queueService.getActiveSignal();

    this.realtime.emitLog(
      'DRIVE_UPLOAD',
      'INFO',
      `Starting stream upload to Drive: ${data.russianTitle} - Ep ${data.episodeNumber} [${data.type} ${data.quality}]`,
    );

    try {
      const result = await this.driveRouter.streamVideoToDrive({
        animeTitleId: data.animeId,
        episodeId: data.episodeId,
        russianTitle: data.russianTitle,
        englishTitle: data.englishTitle,
        episodeNumber: data.episodeNumber,
        type: data.type,
        quality: data.quality,
        sourceStreamUrl: data.sourceStreamUrl,
        proxyUrl: proxyUrl || undefined,
        signal,
        onProgress: (uploaded, total, percent, statusText) => {
          const epPad = String(data.episodeNumber).padStart(2, '0');
          this.realtime.emitUploadProgress({
            jobId: job.id!,
            animeId: data.animeId,
            episodeId: data.episodeId,
            fileName: `${data.russianTitle} - Ep ${epPad} [${data.type} ${data.quality}].mp4`,
            uploadedBytes: uploaded,
            totalBytes: total,
            percent,
            statusText,
          });
        },
      });

      const epPad = String(data.episodeNumber).padStart(2, '0');
      this.realtime.emitUploadProgress({
        jobId: job.id!,
        animeId: data.animeId,
        episodeId: data.episodeId,
        fileName: `${data.russianTitle} - Ep ${epPad} [${data.type} ${data.quality}].mp4`,
        uploadedBytes: 100,
        totalBytes: 100,
        percent: 100,
        statusText: 'Сохранено в Google Drive',
      });

      await this.prisma.animeEpisode.update({
        where: { id: data.episodeId },
        data: { status: 'UPLOADED' },
      });

      const pendingEpisodes = await this.prisma.animeEpisode.count({
        where: {
          animeTitleId: data.animeId,
          status: { in: ['PENDING', 'DOWNLOADING'] },
        },
      });

      if (pendingEpisodes === 0) {
        await this.prisma.animeTitle.update({
          where: { id: data.animeId },
          data: { status: 'COMPLETED' },
        });
        this.realtime.emitLog(
          'SCRAPER',
          'SUCCESS',
          `Все серии загружены в облако для "${data.russianTitle}"`,
        );
      }

      return result;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.code === 'ERR_CANCELED' || signal.aborted) {
        this.logger.warn(
          `Download cancelled for ${data.russianTitle} - Ep ${data.episodeNumber} [${data.type} ${data.quality}] (queue paused)`,
        );
        this.realtime.emitLog(
          'DRIVE_UPLOAD',
          'WARN',
          `Загрузка отменена: ${data.russianTitle} - Серия ${data.episodeNumber} [${data.type} ${data.quality}]`,
        );
        await this.prisma.animeEpisode.update({
          where: { id: data.episodeId },
          data: { status: 'PENDING' },
        });
        return { cancelled: true };
      }

      this.logger.error(
        `Failed to download stream for ${data.russianTitle} - Ep ${data.episodeNumber}: ${err.message}`,
      );
      this.realtime.emitLog(
        'DRIVE_UPLOAD',
        'ERROR',
        `Ошибка загрузки видео для "${data.russianTitle}" (серия ${data.episodeNumber}): ${err.message}`,
      );

      try {
        const failedEp = await this.prisma.animeEpisode.update({
          where: { id: data.episodeId },
          data: { status: 'ERROR', errorMessage: err.message },
          include: { animeTitle: { select: { russianTitle: true, englishTitle: true } } },
        });
        await this.prisma.animeTitle.update({
          where: { id: data.animeId },
          data: { status: 'ERROR' },
        });

        this.realtime.emitFailedFile({
          episodeId: data.episodeId,
          animeTitleId: data.animeId,
          animeTitle: failedEp.animeTitle.russianTitle,
          englishTitle: failedEp.animeTitle.englishTitle,
          episodeNumber: data.episodeNumber,
          errorMessage: err.message,
          updatedAt: failedEp.updatedAt.toISOString(),
        });
      } catch {}

      throw err;
    }
  }
}
