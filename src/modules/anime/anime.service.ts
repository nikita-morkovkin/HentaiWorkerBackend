import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto, PaginatedResponseDto } from '../../common/dto/pagination.dto';
import { UpdateAnimeMetadataDto } from './dto/anime.dto';
import { AnimeStatus, Prisma } from '@prisma/client';
import { DriveRouterService } from '../storage/drive-router.service';
import { CheerioScraperService } from '../scraper/cheerio-scraper.service';
import { SettingsService } from '../settings/settings.service';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import axios from 'axios';
import {
  UploadedFileDto,
  TagsAndGenresResult,
  CatalogClearResult,
} from './interfaces/anime.interface';
import {
  createProxyAgent,
  isJunkCoverImage,
  getCoversDirectory,
  safeUnlink,
  isSafeExternalUrl,
} from '../../common/helpers';
import { FFMPEG_CONSTANTS, HTTP_CONSTANTS, SCRAPER_CONSTANTS } from '../../common/constants';

import { ScraperQueueService } from '../scraper/scraper-queue.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export { UploadedFileDto, TagsAndGenresResult, CatalogClearResult };

@Injectable()
export class AnimeService {
  private readonly logger = new Logger(AnimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly driveRouter: DriveRouterService,
    private readonly scraperService: CheerioScraperService,
    private readonly settingsService: SettingsService,
    private readonly scraperQueueService: ScraperQueueService,
    private readonly realtime: RealtimeGateway,
  ) {}

  public async findAll(query: PaginationQueryDto): Promise<PaginatedResponseDto<any>> {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 24;
    const skip = (page - 1) * limit;

    const where: Prisma.AnimeTitleWhereInput = {};
    const andConditions: Prisma.AnimeTitleWhereInput[] = [];

    if (query.status && query.status !== 'ALL') {
      if (query.status === 'ERROR') {
        andConditions.push({
          OR: [
            { status: 'ERROR' },
            { episodes: { some: { status: 'ERROR' } } },
          ],
        });
      } else if (query.status === 'COMPLETED') {
        andConditions.push({
          status: 'COMPLETED',
        });
      } else if (
        query.status === 'SCRAPING' ||
        query.status === 'PENDING' ||
        query.status === 'IN_PROGRESS'
      ) {
        andConditions.push({
          OR: [
            { status: 'SCRAPING' },
            { status: 'PENDING' },
            { episodes: { some: { status: { in: ['PENDING', 'DOWNLOADING'] } } } },
          ],
        });
      } else {
        andConditions.push({
          status: query.status as AnimeStatus,
        });
      }
    }

    if (query.tag) {
      andConditions.push({
        OR: [{ tags: { has: query.tag } }, { genres: { has: query.tag } }],
      });
    }

    if (query.search && query.search.trim()) {
      const s = query.search.trim();
      andConditions.push({
        OR: [
          { russianTitle: { contains: s, mode: 'insensitive' } },
          { englishTitle: { contains: s, mode: 'insensitive' } },
          { description: { contains: s, mode: 'insensitive' } },
          { tags: { has: s } },
          { genres: { has: s } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const [total, items] = await Promise.all([
      this.prisma.animeTitle.count({ where }),
      this.prisma.animeTitle.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          episodes: {
            include: {
              files: true,
            },
            orderBy: { episodeNumber: 'asc' },
          },
          driveAccount: {
            select: { id: true, name: true, email: true },
          },
          telegramPosts: {
            where: { status: 'PUBLISHED' },
            select: {
              id: true,
              targetChannel: true,
              episodeId: true,
              scheduledAt: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    const formatted = items.map((anime) => {
      const totalEpisodes = anime.episodes.length;
      const uploadedEpisodes = anime.episodes.filter((e) => e.status === 'UPLOADED').length;
      const hasDub = anime.episodes.some((e) => e.files.some((f) => f.type === 'DUB'));
      const hasSub = anime.episodes.some((e) => e.files.some((f) => f.type === 'SUB'));

      const isPublishedToTelegram = anime.telegramPosts && anime.telegramPosts.length > 0;
      const publishedChannels = Array.from(
        new Set(anime.telegramPosts.map((p) => p.targetChannel)),
      );
      const episodePublishedMap = new Set(
        anime.telegramPosts.map((p) => p.episodeId).filter(Boolean),
      );

      const availableQualities = Array.from(
        new Set(anime.episodes.flatMap((e) => e.files.map((f) => f.quality))),
      );

      const formattedEpisodes = anime.episodes.map((ep) => ({
        ...ep,
        isPublishedToTelegram:
          episodePublishedMap.has(ep.id) || (isPublishedToTelegram && anime.episodes.length === 1),
        files: ep.files.map((f) => ({
          ...f,
          fileSizeBytes: f.fileSizeBytes ? f.fileSizeBytes.toString() : '0',
        })),
      }));

      return {
        ...anime,
        coverUrls: this.cleanCoverUrls(anime.coverUrls),
        isPublishedToTelegram,
        publishedChannels,
        episodes: formattedEpisodes,
        totalEpisodes,
        uploadedEpisodes,
        hasDub,
        hasSub,
        availableQualities,
      };
    });

    return {
      items: formatted,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  public cleanCoverUrls(covers?: string[] | null): string[] {
    if (!covers || !Array.isArray(covers)) return [];
    return covers.filter((url) => {
      if (!url || typeof url !== 'string') return false;
      if (url.startsWith('/api/') || url.startsWith('data:')) return true;
      return !isJunkCoverImage(url);
    });
  }

  public async findOne(id: string) {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id },
      include: {
        episodes: {
          include: {
            files: true,
          },
          orderBy: { episodeNumber: 'asc' },
        },
        driveAccount: true,
        telegramPosts: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!anime) {
      throw new NotFoundException(`Anime with ID ${id} not found`);
    }

    const publishedPosts = anime.telegramPosts.filter((p) => p.status === 'PUBLISHED');
    const isPublishedToTelegram = publishedPosts.length > 0;
    const publishedChannels = Array.from(new Set(publishedPosts.map((p) => p.targetChannel)));
    const episodePublishedMap = new Set(publishedPosts.map((p) => p.episodeId).filter(Boolean));

    const formattedEpisodes = anime.episodes.map((ep) => ({
      ...ep,
      isPublishedToTelegram:
        episodePublishedMap.has(ep.id) || (isPublishedToTelegram && anime.episodes.length === 1),
      files: ep.files.map((f) => ({
        ...f,
        fileSizeBytes: f.fileSizeBytes ? f.fileSizeBytes.toString() : '0',
      })),
    }));

    return {
      ...anime,
      coverUrls: this.cleanCoverUrls(anime.coverUrls),
      isPublishedToTelegram,
      publishedChannels,
      episodes: formattedEpisodes,
      driveAccount: anime.driveAccount
        ? {
            ...anime.driveAccount,
            totalStorageBytes: anime.driveAccount.totalStorageBytes?.toString(),
            usedStorageBytes: anime.driveAccount.usedStorageBytes?.toString(),
            dailyUploadedBytes: anime.driveAccount.dailyUploadedBytes?.toString(),
          }
        : null,
    };
  }

  public async upscaleImageWithFFmpeg(inputPath: string, outputPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i',
        inputPath,
        '-vf',
        FFMPEG_CONSTANTS.UPSCALE_VF,
        '-q:v',
        '2',
        '-y',
        outputPath,
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          this.logger.log(`✅ Upscaled & sharpened image successfully: ${outputPath}`);
          resolve(true);
        } else {
          resolve(false);
        }
      });

      ffmpeg.on('error', (err) => {
        this.logger.warn(`FFmpeg image upscale failed: ${err.message}`);
        resolve(false);
      });
    });
  }

  public async generateScreenshots(id: string): Promise<string[]> {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id },
      include: {
        episodes: {
          include: { files: true },
          orderBy: { episodeNumber: 'asc' },
        },
      },
    });

    if (!anime) throw new NotFoundException(`Anime with ID ${id} not found`);

    let streamUrl = anime.episodes
      .flatMap((e) => e.files)
      .find((f) => f.sourceStreamUrl)?.sourceStreamUrl;

    if (!streamUrl && anime.episodes.length > 0) {
      const ep = anime.episodes[0];
      const streams = await this.scraperService.scrapeEpisodeStreams(ep.sourceEpisodeUrl);
      for (const group of streams) {
        if (group.qualities && group.qualities.length > 0) {
          streamUrl = group.qualities[0].url;
          break;
        }
      }
    }

    if (!streamUrl) {
      throw new BadRequestException('Не удалось получить поток видео для генерации скриншотов');
    }

    return this.driveRouter.extractMultipleScreenshots(id, streamUrl, 6);
  }

  public async uploadCover(id: string, file: UploadedFileDto): Promise<string> {
    const anime = await this.prisma.animeTitle.findUnique({ where: { id } });

    if (!anime) {
      throw new NotFoundException(`Anime with ID ${id} not found`);
    }

    if (!file || !file.buffer) {
      throw new BadRequestException('Файл изображения не передан');
    }

    const coversDir = getCoversDirectory();
    const tempFileName = `temp_${id}_${Date.now()}.jpg`;
    const tempFilePath = path.join(coversDir, tempFileName);
    const finalFileName = `user_${id}_${Date.now()}.jpg`;
    const finalFilePath = path.join(coversDir, finalFileName);

    try {
      fs.writeFileSync(tempFilePath, file.buffer);

      const upscaled = await this.upscaleImageWithFFmpeg(tempFilePath, finalFilePath);

      if (!upscaled || !fs.existsSync(finalFilePath)) {
        fs.copyFileSync(tempFilePath, finalFilePath);
      }

      const publicUrl = `/api/anime/covers/${finalFileName}`;
      const currentCovers = anime.coverUrls || [];
      const updatedCovers = [publicUrl, ...currentCovers.filter((c) => c !== publicUrl)];

      await this.prisma.animeTitle.update({
        where: { id },
        data: { coverUrls: updatedCovers },
      });

      return publicUrl;
    } finally {
      safeUnlink(tempFilePath);
    }
  }

  public async updateMetadata(id: string, dto: UpdateAnimeMetadataDto) {
    const existing = await this.prisma.animeTitle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Anime with ID ${id} not found`);

    const updated = await this.prisma.animeTitle.update({
      where: { id },
      data: {
        ...(dto.russianTitle ? { russianTitle: dto.russianTitle } : {}),
        ...(dto.englishTitle ? { englishTitle: dto.englishTitle } : {}),
        ...(dto.originalTitle ? { originalTitle: dto.originalTitle } : {}),
        ...(dto.description ? { description: dto.description } : {}),
        ...(dto.tags ? { tags: dto.tags } : {}),
        ...(dto.genres ? { genres: dto.genres } : {}),
        ...(dto.coverUrls ? { coverUrls: dto.coverUrls } : {}),
      },
      include: {
        episodes: {
          include: { files: true },
        },
      },
    });

    return {
      ...updated,
      episodes: updated.episodes.map((ep) => ({
        ...ep,
        files: ep.files.map((f) => ({
          ...f,
          fileSizeBytes: f.fileSizeBytes ? f.fileSizeBytes.toString() : '0',
        })),
      })),
    };
  }

  public async getAllTagsAndGenres(): Promise<TagsAndGenresResult> {
    const titles = await this.prisma.animeTitle.findMany({
      select: { tags: true, genres: true },
    });

    const tagsSet = new Set<string>();
    const genresSet = new Set<string>();

    for (const t of titles) {
      t.tags.forEach((tag) => tagsSet.add(tag));
      t.genres.forEach((genre) => genresSet.add(genre));
    }

    return {
      tags: Array.from(tagsSet).sort(),
      genres: Array.from(genresSet).sort(),
    };
  }

  public async delete(id: string) {
    await this.prisma.episodeFile.deleteMany({
      where: { episode: { animeTitleId: id } },
    });
    await this.prisma.telegramPost.deleteMany({
      where: { animeTitleId: id },
    });
    await this.prisma.animeEpisode.deleteMany({
      where: { animeTitleId: id },
    });

    try {
      const coversDir = getCoversDirectory();
      if (fs.existsSync(coversDir)) {
        const files = fs.readdirSync(coversDir).filter((f) => f.includes(id));
        for (const f of files) {
          safeUnlink(path.join(coversDir, f));
        }
      }
    } catch {}

    return this.prisma.animeTitle.delete({ where: { id } });
  }

  public async clearAllCatalog(): Promise<CatalogClearResult> {
    this.logger.warn('Clearing all catalog and purging scraper queues...');
    try {
      await this.scraperQueueService.clearQueue();
    } catch (e: any) {
      this.logger.warn(`Could not clear scraper queue: ${e.message}`);
    }

    await this.prisma.episodeFile.deleteMany({});
    await this.prisma.telegramPost.deleteMany({});
    await this.prisma.animeEpisode.deleteMany({});
    const count = await this.prisma.animeTitle.deleteMany({});

    try {
      const coversDir = getCoversDirectory();
      if (fs.existsSync(coversDir)) {
        const files = fs.readdirSync(coversDir);
        for (const f of files) {
          safeUnlink(path.join(coversDir, f));
        }
      }
    } catch {}

    await this.realtime.emitLog(
      'SCRAPER',
      'SUCCESS',
      `Каталог полностью очищен (удалено ${count.count} тайтлов), все очереди задач сброшены.`,
    );

    return {
      success: true,
      deletedCount: count.count,
      message: `Успешно удалено ${count.count} тайтлов аниме и полностью сброшены очереди задач.`,
    };
  }

  public async proxyImage(imageUrl: string, res: Response) {
    if (!imageUrl || !imageUrl.startsWith('http')) {
      throw new BadRequestException('Некорректный URL изображения');
    }

    if (!isSafeExternalUrl(imageUrl)) {
      this.logger.warn(`Blocked suspicious SSRF request to internal URL: ${imageUrl}`);
      throw new BadRequestException('Disallowed or private image URL target');
    }

    try {
      const proxyUrl = await this.settingsService.getRotatingProxy();
      const agent = createProxyAgent(proxyUrl, imageUrl.startsWith('https'));

      const response = await axios.get(imageUrl, {
        responseType: 'stream',
        headers: {
          'User-Agent': HTTP_CONSTANTS.DEFAULT_USER_AGENT,
          Referer: `${SCRAPER_CONSTANTS.BASE_URL}/`,
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        timeout: 20000,
        httpAgent: agent,
        httpsAgent: agent,
      });

      const contentType = String(response.headers['content-type'] || 'image/jpeg');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return response.data.pipe(res);
    } catch (e: any) {
      this.logger.warn(`Failed to proxy image ${imageUrl}: ${e.message}`);
      res.status(404).send('Image could not be retrieved');
    }
  }
}
