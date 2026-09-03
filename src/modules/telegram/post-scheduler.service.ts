import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GramjsService } from './gramjs.service';
import { TelegramBotService } from './telegram-bot.service';
import { DriveRouterService } from '../storage/drive-router.service';
import { CreateTelegramPostDto } from './dto/telegram.dto';
import { TelegramPublishResult } from './interfaces/telegram.interface';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, TELEGRAM_TEMPLATES } from '../../common/constants';

export const TELEGRAM_QUEUE_NAME = QUEUE_NAMES.TELEGRAM;

@Injectable()
export class PostSchedulerService {
  private readonly logger = new Logger(PostSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly gramjsService: GramjsService,
    private readonly botService: TelegramBotService,
    private readonly driveRouter: DriveRouterService,
    @InjectQueue(TELEGRAM_QUEUE_NAME) private readonly telegramQueue: Queue,
  ) {}

  public generatePostCaption(
    anime: any,
    episode?: any,
    targetChannel: string = 'PUBLIC',
    customCaption?: string,
  ): string {
    if (customCaption && customCaption.trim()) {
      return customCaption;
    }

    const titleHeader = `🎬 <b>${anime.russianTitle}</b>\n<i>${anime.englishTitle}</i>`;
    const epLine = episode ? `\n\n📌 <b>Серия: ${episode.episodeNumber}</b>` : '';
    const desc = anime.description
      ? `\n\n📖 <b>Описание:</b>\n${anime.description.slice(0, 400)}...`
      : '';

    const hashtags = (anime.tags || [])
      .slice(0, 8)
      .map((t: string) => `#${t.replace(/[\s-]+/g, '_').replace(/[^a-zA-Z0-9_а-яА-ЯёЁ]/g, '')}`)
      .join(' ');

    const tagsLine = hashtags ? `\n\n🏷 ${hashtags}` : '';
    const ctaLine =
      targetChannel === 'PUBLIC' ? TELEGRAM_TEMPLATES.PUBLIC_CTA : TELEGRAM_TEMPLATES.VIP_CTA;

    return `${titleHeader}${epLine}${desc}${tagsLine}${ctaLine}`;
  }

  public async createPost(dto: CreateTelegramPostDto): Promise<TelegramPublishResult> {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: dto.animeTitleId },
      include: { episodes: { include: { files: true } } },
    });
    if (!anime) throw new NotFoundException('Anime title not found');

    const episode = dto.episodeId
      ? anime.episodes.find((e) => e.id === dto.episodeId)
      : anime.episodes[0];

    if (!episode) {
      throw new BadRequestException('Серия не найдена у данного аниме');
    }

    const cloudFiles = (episode.files || []).filter(
      (f) => Boolean(f.driveFileId || f.driveViewLink)
    );

    if (cloudFiles.length === 0) {
      throw new BadRequestException(
        `Для серии ${episode.episodeNumber} в Google Drive нет загруженных видеофайлов`
      );
    }

    // Validate selectedAudio against cloud files
    const hasDub = cloudFiles.some((f) => f.type === 'DUB');
    const hasSub = cloudFiles.some((f) => f.type === 'SUB');

    if (dto.selectedAudio === 'DUB' && !hasDub) {
      throw new BadRequestException(
        `В облаке Google Drive отсутствует русская озвучка (DUB) для серии ${episode.episodeNumber}`
      );
    }
    if (dto.selectedAudio === 'SUB' && !hasSub) {
      throw new BadRequestException(
        `В облаке Google Drive отсутствуют субтитры (SUB) для серии ${episode.episodeNumber}`
      );
    }

    // Validate selectedQualities against cloud files
    let relevantFiles = cloudFiles;
    if (dto.selectedAudio === 'DUB') {
      relevantFiles = cloudFiles.filter((f) => f.type === 'DUB');
    } else if (dto.selectedAudio === 'SUB') {
      relevantFiles = cloudFiles.filter((f) => f.type === 'SUB');
    }

    const availableQualities = Array.from(new Set(relevantFiles.map((f) => f.quality)));

    if (dto.selectedQualities && dto.selectedQualities.length > 0) {
      const missingQualities = dto.selectedQualities.filter(
        (q) => !availableQualities.includes(q)
      );
      if (missingQualities.length > 0) {
        throw new BadRequestException(
          `Качество ${missingQualities.join(', ')} отсутствует в облаке Google Drive для выбранной озвучки (доступно: ${availableQualities.join(', ') || 'нет'})`
        );
      }
    }

    const caption = this.generatePostCaption(anime, episode, dto.targetChannel, dto.caption);
    const isScheduled = dto.scheduledAt && new Date(dto.scheduledAt).getTime() > Date.now();

    const post = await this.prisma.telegramPost.create({
      data: {
        animeTitleId: dto.animeTitleId,
        episodeId: dto.episodeId || null,
        targetChannel: dto.targetChannel,
        caption,
        selectedAudio: dto.selectedAudio || 'BOTH',
        selectedQualities: dto.selectedQualities || ['720p'],
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: isScheduled ? 'SCHEDULED' : 'PUBLISHING',
      },
    });

    if (isScheduled) {
      const delayMs = new Date(dto.scheduledAt!).getTime() - Date.now();
      await this.telegramQueue.add(
        'publish-post',
        { postId: post.id },
        { delay: delayMs, removeOnComplete: true },
      );
      this.logger.log(
        `Scheduled post ${post.id} for ${dto.scheduledAt} (in ${Math.round(delayMs / 1000)}s)`,
      );
      return { success: true, post, message: `Post scheduled for ${dto.scheduledAt}` };
    } else {
      await this.telegramQueue.add('publish-post', { postId: post.id }, { removeOnComplete: true });
      return { success: true, post, message: 'Post publication queued immediately' };
    }
  }

  public async executePublish(postId: string): Promise<{ success: boolean }> {
    const post = await this.prisma.telegramPost.findUnique({
      where: { id: postId },
      include: {
        animeTitle: true,
        episode: { include: { files: true } },
      },
    });
    if (!post) throw new Error(`Post ${postId} not found`);

    try {
      await this.prisma.telegramPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHING' },
      });

      const config = await this.settingsService.getTelegramConfig();

      const channelsToPost: string[] = [];
      if (post.targetChannel === 'PUBLIC' || post.targetChannel === 'BOTH') {
        if (config.publicChannelId) channelsToPost.push(config.publicChannelId);
      }
      if (post.targetChannel === 'VIP' || post.targetChannel === 'BOTH') {
        if (config.vipChannelId) channelsToPost.push(config.vipChannelId);
      }

      if (channelsToPost.length === 0) {
        throw new Error('No target channel IDs configured in Telegram settings');
      }

      const cloudFiles = (post.episode?.files || []).filter(
        (f) => Boolean(f.driveFileId || f.driveViewLink)
      );

      let targetFile = cloudFiles.find(
        (f) =>
          (post.selectedAudio === 'BOTH' || f.type === post.selectedAudio) &&
          post.selectedQualities.includes(f.quality),
      );

      if (!targetFile && cloudFiles.length > 0) {
        targetFile = cloudFiles[0];
      }

      if (!targetFile) {
        throw new Error(
          `В Google Drive не найдены видеофайлы для серии ${post.episode?.episodeNumber || ''}`
        );
      }

      for (const channelId of channelsToPost) {
        let streamUrl = targetFile.sourceStreamUrl;
        let downloadHeaders: Record<string, string> | undefined;

        if (!streamUrl && targetFile.driveFileId && targetFile.driveAccountId) {
          try {
            const driveInfo = await this.driveRouter.getDriveStreamInfo(
              targetFile.driveFileId,
              targetFile.driveAccountId,
            );
            streamUrl = driveInfo.url;
            downloadHeaders = {
              Authorization: driveInfo.authHeader.replace('Authorization: ', '').trim(),
            };
          } catch (e: any) {
            this.logger.warn(`Failed to obtain Google Drive stream: ${e.message}`);
          }
        }

        if (streamUrl) {
          await this.gramjsService.uploadStreamingVideo({
            channelId,
            videoUrlOrPath: streamUrl,
            headers: downloadHeaders,
            caption: post.caption,
            fileName: targetFile.fileName || `${post.animeTitle.russianTitle}.mp4`,
          });
        } else {
          await this.botService.sendMessage(channelId, post.caption);
        }
      }

      await this.prisma.telegramPost.update({
        where: { id: postId },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });

      await this.botService.sendAdminAlert(
        `🎉 <b>Post successfully published!</b>\n` +
          `Title: <i>${post.animeTitle.russianTitle}</i>\n` +
          `Episode: ${post.episode?.episodeNumber || 'All'}\n` +
          `Channels: ${channelsToPost.join(', ')}`,
      );

      this.logger.log(`Post ${postId} successfully published to ${channelsToPost.join(', ')}`);
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Failed to publish post ${postId}: ${err.message}`);
      await this.prisma.telegramPost.update({
        where: { id: postId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
        },
      });

      await this.botService.sendAdminAlert(
        `❌ <b>Failed to publish post!</b>\n` +
          `Post ID: <code>${postId}</code>\n` +
          `Error: <code>${err.message}</code>`,
        true,
      );
      throw err;
    }
  }

  public async getPosts(limit: number = 50) {
    return this.prisma.telegramPost.findMany({
      include: {
        animeTitle: true,
        episode: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
