import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GramjsService } from './gramjs.service';
import { DriveRouterService } from '../storage/drive-router.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.service';
import { Api } from 'telegram';
import { FileAudioType } from '@prisma/client';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { safeUnlink } from '../../common/helpers';

export interface ParsedTelegramCaption {
  russianTitle: string;
  englishTitle: string;
  episodeNumber: number;
  totalEpisodes?: number;
  audio: FileAudioType;
  quality: string;
  studio?: string;
  year?: number;
  code?: string;
  tags: string[];
}

export interface TelegramScrapeResult {
  success: boolean;
  messageId: number;
  animeId?: string;
  episodeId?: string;
  episodeNumber?: number;
  russianTitle?: string;
  englishTitle?: string;
  alreadyInDrive?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

@Injectable()
export class TelegramChannelScraperService {
  private readonly logger = new Logger(TelegramChannelScraperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gramjsService: GramjsService,
    private readonly driveRouter: DriveRouterService,
    private readonly realtime: RealtimeGateway,
    private readonly settingsService: SettingsService,
  ) {}

  public cleanChannelIdentifier(channel: string): string {
    let clean = channel.trim();
    clean = clean.replace(/^https?:\/\/t\.me\//i, '');
    clean = clean.replace(/^@/, '');
    clean = clean.split('/')[0];
    return clean;
  }

  public async resolveChannelEntity(client: any, channelInput: string): Promise<any> {
    const raw = channelInput.trim();

    // 1. If it's an invite link (e.g. t.me/+hash or t.me/joinchat/hash)
    const inviteMatch = raw.match(/(?:t\.me\/(?:\+|joinchat\/))([a-zA-Z0-9_-]+)/i);
    if (inviteMatch) {
      const hash = inviteMatch[1];
      try {
        try {
          const joined: any = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
          if (joined?.chats && joined.chats.length > 0) {
            return joined.chats[0];
          }
        } catch (joinErr: any) {
          if (
            joinErr.message?.includes('USER_ALREADY_PARTICIPANT') ||
            joinErr.errorMessage === 'USER_ALREADY_PARTICIPANT'
          ) {
            const checkRes: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
            if (checkRes?.chat) return checkRes.chat;
          } else {
            this.logger.warn(`Could not join invite link ${hash}: ${joinErr.message}`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`CheckChatInvite failed for ${hash}: ${err.message}`);
      }
    }

    // 2. If it's a numeric ID (e.g. -1001234567890 or 1234567890)
    const cleanNum = raw.replace(/^@/, '');
    if (/^-?\d+$/.test(cleanNum)) {
      try {
        const numId = parseInt(cleanNum, 10);
        return await client.getEntity(numId);
      } catch (err: any) {
        this.logger.warn(`getEntity by numeric ID ${cleanNum} failed: ${err.message}`);
        return cleanNum;
      }
    }

    // 3. Clean string username
    const cleanUsername = this.cleanChannelIdentifier(raw);
    try {
      return await client.getEntity(cleanUsername);
    } catch {
      return cleanUsername;
    }
  }

  public parseCaption(text: string): ParsedTelegramCaption | null {
    if (!text || typeof text !== 'string') return null;

    const lines = text.split('\n').map((l) => l.trim());

    let russianTitle = '';
    let englishTitle = '';
    let episodeNumber = 1;
    let totalEpisodes: number | undefined;
    let audio: FileAudioType = 'SUB';
    let quality = '720p';
    let studio: string | undefined;
    let year: number | undefined;
    let code: string | undefined;
    const rawTags: string[] = [];

    // 1. Parse Title
    const titleLineMatch = text.match(/(?:🌐\s*)?(?:Название|Title)\s*:\s*([^\n\r]+)/i);
    if (titleLineMatch) {
      const fullTitle = titleLineMatch[1].trim();
      if (fullTitle.includes('/')) {
        const parts = fullTitle.split('/').map((p) => p.trim());
        const part0HasCyrillic = /[а-яё]/i.test(parts[0]);
        const part1HasCyrillic = /[а-яё]/i.test(parts[1]);

        if (part0HasCyrillic && !part1HasCyrillic) {
          russianTitle = parts[0];
          englishTitle = parts[1];
        } else if (!part0HasCyrillic && part1HasCyrillic) {
          englishTitle = parts[0];
          russianTitle = parts[1];
        } else {
          englishTitle = parts[0];
          russianTitle = parts[1] || parts[0];
        }
      } else {
        if (/[а-яё]/i.test(fullTitle)) {
          russianTitle = fullTitle;
          englishTitle = fullTitle;
        } else {
          englishTitle = fullTitle;
          russianTitle = fullTitle;
        }
      }
    } else {
      // Fallback: Check header format like "Title / Title - 1-4 серии"
      const headerMatch = text.match(/^([^\n\r/]+)\s*\/\s*([^\n\r-]+)(?:\s*-\s*\d+.*)?/i);
      if (headerMatch) {
        const part1 = headerMatch[1].trim().replace(/^🇷🇺|🇬🇧|🎬|🍿/g, '').trim();
        const part2 = headerMatch[2].trim().replace(/^🇷🇺|🇬🇧|🎬|🍿/g, '').trim();
        if (/[а-яё]/i.test(part1)) {
          russianTitle = part1;
          englishTitle = part2;
        } else {
          englishTitle = part1;
          russianTitle = part2;
        }
      }
    }

    if (!russianTitle && !englishTitle) {
      return null;
    }

    // 2. Parse Episode Number
    const episodeMatch = text.match(/(?:🎨\s*)?(?:Эпизод|Серия|Episode)\s*:\s*(\d+)(?:\s*(?:из|\/)\s*(\d+))?/i);
    if (episodeMatch) {
      episodeNumber = parseInt(episodeMatch[1], 10);
      if (episodeMatch[2]) {
        totalEpisodes = parseInt(episodeMatch[2], 10);
      }
    }

    // 3. Parse Translation / Audio
    const audioMatch = text.match(/(?:🗣\s*)?(?:Перевод|Озвучка|Audio|Translation)\s*:\s*([^\n\r]+)/i);
    if (audioMatch) {
      const audioStr = audioMatch[1].toLowerCase();
      if (
        audioStr.includes('озвучк') ||
        audioStr.includes('дубляж') ||
        audioStr.includes('многоголос') ||
        audioStr.includes('dub') ||
        audioStr.includes('голос')
      ) {
        audio = 'DUB';
      } else {
        audio = 'SUB';
      }
    }

    // 4. Parse Studio
    const studioMatch = text.match(/(?:🎬\s*)?(?:Студия|Studio)\s*:\s*#?([^\n\r]+)/i);
    if (studioMatch) {
      studio = studioMatch[1].trim().replace(/^#/, '').replace(/_/g, ' ');
    }

    // 5. Parse Year
    const yearMatch = text.match(/(?:📅\s*)?(?:Год|Year)\s*:\s*#?(\d{4})/i);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
    }

    // 6. Parse Code / Slug
    const codeMatch = text.match(/(?:🆔\s*)?(?:КОД|Код|CODE|Code)\s*:\s*#?([a-zA-Z0-9_-]+)/i);
    if (codeMatch) {
      code = codeMatch[1].trim().replace(/^#/, '');
    }

    // 7. Parse Tags
    const tagsMatch = text.match(/(?:#️⃣\s*)?(?:Теги|Tags|Хэштеги|Жанры|Genres)\s*:\s*([^\n\r]+)/i);
    if (tagsMatch) {
      const tagStr = tagsMatch[1];
      const foundTags = tagStr.match(/#([a-zA-Z0-9_а-яА-ЯёЁ]+)/g);
      if (foundTags) {
        for (const t of foundTags) {
          const cleanTag = t.replace(/^#/, '').replace(/_/g, ' ').trim();
          if (
            cleanTag &&
            !cleanTag.toLowerCase().includes('mary_jane') &&
            cleanTag !== code &&
            String(year) !== cleanTag
          ) {
            rawTags.push(cleanTag);
          }
        }
      }
    }

    // Extract any additional hashtags in text that might be genres
    const allHashtags = text.match(/#([а-яА-ЯёЁa-zA-Z0-9_]+)/g) || [];
    for (const h of allHashtags) {
      const tag = h.replace(/^#/, '').replace(/_/g, ' ').trim();
      if (
        tag &&
        tag.length > 2 &&
        !rawTags.includes(tag) &&
        tag !== code &&
        tag !== studio &&
        String(year) !== tag
      ) {
        rawTags.push(tag);
      }
    }

    if (studio && !rawTags.includes(studio)) {
      rawTags.push(studio);
    }

    return {
      russianTitle,
      englishTitle,
      episodeNumber,
      totalEpisodes,
      audio,
      quality,
      studio,
      year,
      code,
      tags: Array.from(new Set(rawTags)),
    };
  }

  public async scrapeChannel(
    channelUsernameOrUrl: string,
    limit: number = 20,
    offsetId?: number,
  ): Promise<{ processed: number; successful: number; skipped: number; errors: number }> {
    const client = await this.gramjsService.getClient();
    const entity = await this.resolveChannelEntity(client, channelUsernameOrUrl);
    const channelDisplay =
      typeof entity === 'string'
        ? `@${entity}`
        : entity?.title || entity?.username || channelUsernameOrUrl;

    this.logger.log(`Starting Telegram channel scrape for: ${channelDisplay} (limit: ${limit})`);
    await this.realtime.emitLog(
      'SCRAPER',
      'INFO',
      `Запущен парсер Telegram-канала ${channelDisplay} (лимит сообщений: ${limit})`,
    );

    let messages: any[] = [];
    try {
      messages = await client.getMessages(entity, {
        limit,
        offsetId: offsetId || 0,
      });
    } catch (err: any) {
      this.logger.error(`Failed to fetch messages from channel ${channelDisplay}: ${err.message}`);
      await this.realtime.emitLog(
        'SCRAPER',
        'ERROR',
        `Ошибка доступа к каналу ${channelDisplay}: ${err.message}`,
      );
      throw err;
    }

    this.logger.log(`Retrieved ${messages.length} messages from ${channelDisplay}`);

    let processed = 0;
    let successful = 0;
    let skipped = 0;
    let errors = 0;

    for (const msg of messages) {
      if (!msg) continue;

      const hasVideo =
        msg.media instanceof Api.MessageMediaDocument &&
        msg.media.document &&
        (msg.media.document as any).mimeType?.startsWith('video/');

      const text = msg.message || '';
      const parsed = this.parseCaption(text);

      if (!hasVideo || !parsed) {
        skipped++;
        continue;
      }

      processed++;

      try {
        const cleanIdentifier =
          typeof entity === 'string'
            ? entity
            : entity?.username || String(entity?.id || channelUsernameOrUrl);
        const result = await this.processTelegramPost(msg, cleanIdentifier, parsed);
        if (result.success) {
          successful++;
        } else if (result.skipped) {
          skipped++;
        } else {
          errors++;
        }
      } catch (err: any) {
        errors++;
        this.logger.error(
          `Error processing post #${msg.id} in ${channelDisplay}: ${err.message}`,
        );
      }
    }

    await this.realtime.emitLog(
      'SCRAPER',
      'SUCCESS',
      `Парсинг канала ${channelDisplay} завершен: обработано ${processed}, успешно ${successful}, пропущено ${skipped}, ошибок ${errors}`,
    );

    return { processed, successful, skipped, errors };
  }

  public async processTelegramPost(
    message: any,
    channelUsername: string,
    parsedCaption?: ParsedTelegramCaption,
  ): Promise<TelegramScrapeResult> {
    const text = message.message || '';
    const parsed = parsedCaption || this.parseCaption(text);

    if (!parsed) {
      return {
        success: false,
        messageId: message.id,
        skipped: true,
        reason: 'Caption could not be parsed or is not an anime episode post',
      };
    }

    const hasVideo =
      message.media instanceof Api.MessageMediaDocument &&
      message.media.document &&
      (message.media.document as any).mimeType?.startsWith('video/');

    if (!hasVideo) {
      return {
        success: false,
        messageId: message.id,
        skipped: true,
        reason: 'Post has no video attachment',
      };
    }

    const doc = message.media.document as Api.Document;
    const videoAttr = doc.attributes?.find(
      (a) => a instanceof Api.DocumentAttributeVideo,
    ) as Api.DocumentAttributeVideo | undefined;

    let quality = '720p';
    if (videoAttr) {
      if (videoAttr.w >= 1920 || videoAttr.h >= 1080) quality = '1080p';
      else if (videoAttr.w >= 1280 || videoAttr.h >= 720) quality = '720p';
      else if (videoAttr.w >= 854 || videoAttr.h >= 480) quality = '480p';
      else quality = '360p';
    }

    const canonicalSourceUrl = `https://t.me/${channelUsername}/${message.id}`;

    // 1. Find or create AnimeTitle
    let anime = await this.prisma.animeTitle.findFirst({
      where: {
        OR: [
          { sourceUrl: canonicalSourceUrl },
          {
            englishTitle: {
              equals: parsed.englishTitle,
              mode: 'insensitive',
            },
          },
          {
            russianTitle: {
              equals: parsed.russianTitle,
              mode: 'insensitive',
            },
          },
        ],
      },
    });

    if (!anime) {
      anime = await this.prisma.animeTitle.create({
        data: {
          russianTitle: parsed.russianTitle,
          englishTitle: parsed.englishTitle,
          sourceUrl: canonicalSourceUrl,
          tags: parsed.tags,
          genres: parsed.tags,
          description: `Студия: ${parsed.studio || 'Неизвестно'}\nГод: ${parsed.year || 'Неизвестно'}\nКод: ${parsed.code || 'Неизвестно'}`,
          status: 'SCRAPING',
        },
      });
      await this.realtime.emitLog(
        'SCRAPER',
        'INFO',
        `Создан новый тайтл "${anime.russianTitle}" (${anime.englishTitle})`,
      );
    } else {
      // Merge tags
      const updatedTags = Array.from(new Set([...(anime.tags || []), ...parsed.tags]));
      await this.prisma.animeTitle.update({
        where: { id: anime.id },
        data: { tags: updatedTags, genres: updatedTags },
      });
    }

    // 2. Find or create AnimeEpisode
    let episode = await this.prisma.animeEpisode.findUnique({
      where: {
        animeTitleId_episodeNumber: {
          animeTitleId: anime.id,
          episodeNumber: parsed.episodeNumber,
        },
      },
      include: { files: true },
    });

    if (!episode) {
      episode = await this.prisma.animeEpisode.create({
        data: {
          animeTitleId: anime.id,
          episodeNumber: parsed.episodeNumber,
          title: `Серия ${parsed.episodeNumber}`,
          sourceEpisodeUrl: canonicalSourceUrl,
          status: 'PENDING',
        },
        include: { files: true },
      });
    }

    // 3. Check if file is already in Google Drive & Database
    const existingFile = episode.files.find(
      (f) => f.type === parsed.audio && f.quality === quality && f.driveFileId,
    );

    if (existingFile) {
      this.logger.log(
        `Video already exists in storage for ${anime.russianTitle} - Ep ${parsed.episodeNumber} [${parsed.audio} ${quality}]. Skipping download.`,
      );
      await this.realtime.emitLog(
        'DRIVE_UPLOAD',
        'INFO',
        `Файл для "${anime.russianTitle}" (серия ${parsed.episodeNumber}) уже загружен в Google Drive. Скачивание пропущено.`,
      );

      await this.prisma.animeEpisode.update({
        where: { id: episode.id },
        data: { status: 'UPLOADED' },
      });

      return {
        success: true,
        messageId: message.id,
        animeId: anime.id,
        episodeId: episode.id,
        episodeNumber: parsed.episodeNumber,
        russianTitle: anime.russianTitle,
        englishTitle: anime.englishTitle,
        alreadyInDrive: true,
      };
    }

    // 4. Download video from Telegram
    const client = await this.gramjsService.getClient();
    const tempDir = os.tmpdir();
    const tempFileName = `tg_dl_${Date.now()}_${message.id}.mp4`;
    const tempFilePath = path.join(tempDir, tempFileName);

    await this.realtime.emitLog(
      'SCRAPER',
      'INFO',
      `Скачивание видео из Telegram: "${anime.russianTitle}" (серия ${parsed.episodeNumber})...`,
    );

    await this.prisma.animeEpisode.update({
      where: { id: episode.id },
      data: { status: 'DOWNLOADING' },
    });

    try {
      await client.downloadMedia(message.media, {
        outputFile: tempFilePath,
        progressCallback: (downloaded: any, fullSize: any) => {
          const down = Number(downloaded);
          const total = Number(fullSize);
          const percent = total > 0 ? Math.min(100, Math.round((down / total) * 100)) : 0;
          this.realtime.emitUploadProgress({
            jobId: `tg-${message.id}`,
            animeId: anime.id,
            episodeId: episode.id,
            fileName: `${anime.russianTitle} - Серия ${parsed.episodeNumber}.mp4`,
            uploadedBytes: down,
            totalBytes: total,
            percent,
          });
        },
      });

      this.logger.log(`Downloaded Telegram video to temp file: ${tempFilePath}`);

      // 5. Extract screenshots using FFmpeg
      try {
        this.logger.log(`Extracting HD screenshots with FFmpeg for anime: ${anime.id}`);
        await this.driveRouter.extractMultipleScreenshotsFromFile(anime.id, tempFilePath, 6);
      } catch (err: any) {
        this.logger.warn(`Failed to extract screenshots from local video: ${err.message}`);
      }

      // 6. Upload local video file to Google Drive
      await this.realtime.emitLog(
        'DRIVE_UPLOAD',
        'INFO',
        `Загрузка видео в Google Drive: "${anime.russianTitle}" (серия ${parsed.episodeNumber})...`,
      );

      const uploadResult = await this.driveRouter.uploadLocalFileToDrive({
        animeTitleId: anime.id,
        episodeId: episode.id,
        russianTitle: anime.russianTitle,
        englishTitle: anime.englishTitle,
        episodeNumber: parsed.episodeNumber,
        type: parsed.audio,
        quality,
        localFilePath: tempFilePath,
        onProgress: (uploaded, total, percent) => {
          this.realtime.emitUploadProgress({
            jobId: `drive-up-${message.id}`,
            animeId: anime.id,
            episodeId: episode.id,
            fileName: `${anime.russianTitle} - Серия ${parsed.episodeNumber}.mp4`,
            uploadedBytes: uploaded,
            totalBytes: total,
            percent,
          });
        },
      });

      await this.prisma.animeEpisode.update({
        where: { id: episode.id },
        data: { status: 'UPLOADED' },
      });

      // Check if all episodes are uploaded
      const pendingEpisodes = await this.prisma.animeEpisode.count({
        where: {
          animeTitleId: anime.id,
          status: { in: ['PENDING', 'DOWNLOADING'] },
        },
      });

      if (pendingEpisodes === 0) {
        await this.prisma.animeTitle.update({
          where: { id: anime.id },
          data: { status: 'COMPLETED' },
        });
      }

      await this.realtime.emitLog(
        'DRIVE_UPLOAD',
        'SUCCESS',
        `Серия ${parsed.episodeNumber} тайтла "${anime.russianTitle}" успешно загружена в Google Drive!`,
      );

      return {
        success: true,
        messageId: message.id,
        animeId: anime.id,
        episodeId: episode.id,
        episodeNumber: parsed.episodeNumber,
        russianTitle: anime.russianTitle,
        englishTitle: anime.englishTitle,
        alreadyInDrive: false,
      };
    } catch (err: any) {
      this.logger.error(`Error processing Telegram video #${message.id}: ${err.message}`);
      await this.prisma.animeEpisode.update({
        where: { id: episode.id },
        data: { status: 'ERROR', errorMessage: err.message },
      });
      await this.realtime.emitLog(
        'SCRAPER',
        'ERROR',
        `Ошибка обработки серии ${parsed.episodeNumber} ("${anime.russianTitle}"): ${err.message}`,
      );
      throw err;
    } finally {
      if (fs.existsSync(tempFilePath)) {
        safeUnlink(tempFilePath);
      }
    }
  }
}
