import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GramjsService } from './gramjs.service';
import { TelegramBotService } from './telegram-bot.service';
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
    if (!anime) throw new Error('Anime title not found');

    const episode = dto.episodeId
      ? anime.episodes.find((e) => e.id === dto.episodeId)
      : anime.episodes[0];

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

      let targetFile = post.episode?.files.find(
        (f) =>
          (post.selectedAudio === 'BOTH' || f.type === post.selectedAudio) &&
          post.selectedQualities.includes(f.quality),
      );

      if (!targetFile && post.episode?.files.length) {
        targetFile = post.episode.files[0];
      }

      for (const channelId of channelsToPost) {
        if (targetFile && targetFile.sourceStreamUrl) {
          await this.gramjsService.uploadStreamingVideo({
            channelId,
            videoUrlOrPath: targetFile.sourceStreamUrl,
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
