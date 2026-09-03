import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GramjsService } from './gramjs.service';
import { TelegramBotService } from './telegram-bot.service';
import { DriveRouterService } from '../storage/drive-router.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PostSchedulerService, TELEGRAM_QUEUE_NAME } from './post-scheduler.service';
import { SYSTEM_SETTING_KEYS, TELEGRAM_TEMPLATES } from '../../common/constants';

export interface AutoPostStatus {
  isActive: boolean;
  intervalMinutes: number;
  nextPostAt: string | null;
  lastPostAt: string | null;
  stats: {
    totalCompleted: number;
    publishedCount: number;
    remainingCount: number;
  };
  currentTitle: {
    id: string;
    russianTitle: string;
    englishTitle: string;
  } | null;
}

@Injectable()
export class TelegramAutoPostService implements OnModuleInit {
  private readonly logger = new Logger(TelegramAutoPostService.name);

  private isActive: boolean = false;
  private intervalMinutes: number = 45;
  private nextPostAt: Date | null = null;
  private lastPostAt: Date | null = null;
  private isProcessing: boolean = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly gramjsService: GramjsService,
    private readonly botService: TelegramBotService,
    private readonly postScheduler: PostSchedulerService,
    private readonly driveRouter: DriveRouterService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue(TELEGRAM_QUEUE_NAME) private readonly telegramQueue: Queue,
  ) {}

  public async onModuleInit(): Promise<void> {
    try {
      const enabled = await this.settingsService.getDecrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_ENABLED,
      );
      const interval = await this.settingsService.getDecrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_INTERVAL_MIN,
      );

      if (interval) {
        const parsed = parseInt(interval, 10);
        if (!isNaN(parsed) && parsed > 0) {
          this.intervalMinutes = parsed;
        }
      }

      if (enabled === 'true') {
        this.logger.log(
          `Auto-posting is enabled on startup. Interval: ${this.intervalMinutes}m. Scheduling first run...`,
        );
        this.isActive = true;
        await this.scheduleNextTick(this.intervalMinutes);
      } else {
        this.isActive = false;
        this.logger.log(`Auto-posting is currently paused (disabled).`);
      }
    } catch (e: any) {
      this.logger.warn(`Could not load auto-post settings on startup: ${e.message}`);
    }
  }

  public async getStatus(): Promise<AutoPostStatus> {
    const totalCompleted = await this.prisma.animeTitle.count({
      where: { status: 'COMPLETED' },
    });

    const publishedCount = await this.prisma.animeTitle.count({
      where: {
        status: 'COMPLETED',
        telegramPosts: {
          some: { status: 'PUBLISHED' },
        },
      },
    });

    const remainingCount = Math.max(0, totalCompleted - publishedCount);

    const nextAnime = await this.prisma.animeTitle.findFirst({
      where: {
        status: 'COMPLETED',
        telegramPosts: {
          none: { status: 'PUBLISHED' },
        },
      },
      select: { id: true, russianTitle: true, englishTitle: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      isActive: this.isActive,
      intervalMinutes: this.intervalMinutes,
      nextPostAt: this.nextPostAt ? this.nextPostAt.toISOString() : null,
      lastPostAt: this.lastPostAt ? this.lastPostAt.toISOString() : null,
      stats: {
        totalCompleted,
        publishedCount,
        remainingCount,
      },
      currentTitle: nextAnime,
    };
  }

  public async start(): Promise<AutoPostStatus> {
    this.isActive = true;
    await this.settingsService.setEncrypted(
      SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_ENABLED,
      'true',
      'TELEGRAM',
      'Автоматический постинг аниме в каналы',
    );

    this.logger.log(`Auto-posting started. Interval: ${this.intervalMinutes} minutes.`);

    // If no next post is scheduled or it was in the past, schedule for right now or in 1 minute
    await this.clearPendingJobs();
    await this.scheduleNextTick(1); // Run first post in 1 minute

    this.realtime.emitLog(
      'TELEGRAM_PUBLISH',
      'INFO',
      `Авто-постинг запущен. Интервал: ${this.intervalMinutes} мин. Первый пост через 1 мин.`,
    );

    return this.getStatus();
  }

  public async pause(): Promise<AutoPostStatus> {
    this.isActive = false;
    this.nextPostAt = null;

    await this.settingsService.setEncrypted(
      SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_ENABLED,
      'false',
      'TELEGRAM',
      'Автоматический постинг аниме в каналы',
    );

    await this.clearPendingJobs();

    this.logger.log(`Auto-posting paused.`);
    this.realtime.emitLog('TELEGRAM_PUBLISH', 'WARN', `Авто-постинг поставлен на паузу.`);

    return this.getStatus();
  }

  public async setInterval(minutes: number): Promise<AutoPostStatus> {
    const valid = Math.max(1, Math.min(1440, Math.round(minutes)));
    this.intervalMinutes = valid;

    await this.settingsService.setEncrypted(
      SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_INTERVAL_MIN,
      String(valid),
      'TELEGRAM',
      'Интервал авто-постинга в минутах',
    );

    this.logger.log(`Auto-post interval updated to ${valid} minutes.`);

    if (this.isActive) {
      await this.clearPendingJobs();
      await this.scheduleNextTick(valid);
    }

    this.realtime.emitLog(
      'TELEGRAM_PUBLISH',
      'INFO',
      `Интервал авто-постинга изменен на ${valid} минут.`,
    );

    return this.getStatus();
  }

  public async triggerNextNow(): Promise<{ success: boolean; message: string }> {
    if (this.isProcessing) {
      return { success: false, message: 'Публикация уже выполняется в данный момент.' };
    }

    this.logger.log(`Manual trigger: publishing next anime now...`);
    this.processTick().catch((err) => {
      this.logger.error(`Error in manual trigger: ${err.message}`);
    });

    return { success: true, message: 'Запущена публикация следующего тайтла.' };
  }

  public async processTick(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug(`Already processing a post, skipping tick.`);
      return;
    }

    this.isProcessing = true;

    try {
      const anime = await this.prisma.animeTitle.findFirst({
        where: {
          status: 'COMPLETED',
          telegramPosts: {
            none: { status: 'PUBLISHED' },
          },
        },
        include: {
          episodes: {
            include: { files: true },
            orderBy: { episodeNumber: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!anime) {
        this.logger.log(`No more completed unpublished anime found! Pausing auto-posting.`);
        this.isActive = false;
        this.nextPostAt = null;
        await this.settingsService.setEncrypted(
          SYSTEM_SETTING_KEYS.TELEGRAM_AUTO_POST_ENABLED,
          'false',
          'TELEGRAM',
          'Автоматический постинг аниме в каналы',
        );

        await this.botService.sendAdminAlert(
          `🏁 <b>[АВТО-ПОСТИНГ ЗАВЕРШЕН]</b>\n\nВсе готовые тайтлы из хранилища успешно опубликованы в каналы!`,
        );
        return;
      }

      await this.publishAnimeToBothChannels(anime);

      this.lastPostAt = new Date();
    } catch (err: any) {
      this.logger.error(`Error during auto-post tick: ${err.message}`, err.stack);
      await this.botService.sendAdminAlert(
        `🚨 <b>[ОШИБКА АВТО-ПОСТИНГА]</b>\n\nПроизошла ошибка при публикации: <code>${err.message}</code>`,
        true,
      );
    } finally {
      this.isProcessing = false;

      // If still active, schedule next post
      if (this.isActive) {
        await this.scheduleNextTick(this.intervalMinutes);
      }
    }
  }

  private async publishAnimeToBothChannels(anime: any): Promise<void> {
    const config = await this.settingsService.getTelegramConfig();

    if (!config.publicChannelId && !config.vipChannelId) {
      throw new Error('Neither Public nor VIP channel is configured in Telegram settings');
    }

    const episode = anime.episodes && anime.episodes.length > 0 ? anime.episodes[0] : null;
    const cloudFiles = episode ? (episode.files || []).filter((f: any) => Boolean(f.driveFileId || f.driveViewLink)) : [];

    const publicResults: string[] = [];
    const vipResults: string[] = [];

    // --- 1. PUBLISH TO PUBLIC CHANNEL (480p) ---
    if (config.publicChannelId) {
      try {
        const publicFile =
          cloudFiles.find((f: any) => f.quality === '480p') ||
          cloudFiles.find((f: any) => f.quality === '360p') ||
          cloudFiles[0];

        const publicCaption = this.postScheduler.generatePostCaption(
          anime,
          episode,
          'PUBLIC',
        );

        const postRecord = await this.prisma.telegramPost.create({
          data: {
            animeTitleId: anime.id,
            episodeId: episode?.id,
            targetChannel: 'PUBLIC',
            status: 'PUBLISHING',
            caption: publicCaption,
            selectedQualities: publicFile ? [publicFile.quality] : ['480p'],
            selectedAudio: publicFile ? publicFile.type : 'DUB',
          },
        });

        await this.sendVideoFileToChannel(
          config.publicChannelId,
          publicFile,
          publicCaption,
          anime.russianTitle,
        );

        await this.prisma.telegramPost.update({
          where: { id: postRecord.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });

        publicResults.push(`480p [${publicFile ? publicFile.type : 'AUTO'}]`);
      } catch (err: any) {
        this.logger.error(`Failed to post to Public channel: ${err.message}`);
        publicResults.push(`Ошибка: ${err.message}`);
      }
    }

    // --- 2. PUBLISH TO VIP CHANNEL (720p / 1080p) ---
    if (config.vipChannelId) {
      try {
        const vipFile =
          cloudFiles.find((f: any) => f.quality === '1080p') ||
          cloudFiles.find((f: any) => f.quality === '720p') ||
          cloudFiles[0];

        const vipCaption = this.postScheduler.generatePostCaption(
          anime,
          episode,
          'VIP',
        );

        const postRecord = await this.prisma.telegramPost.create({
          data: {
            animeTitleId: anime.id,
            episodeId: episode?.id,
            targetChannel: 'VIP',
            status: 'PUBLISHING',
            caption: vipCaption,
            selectedQualities: vipFile ? [vipFile.quality] : ['1080p'],
            selectedAudio: vipFile ? vipFile.type : 'DUB',
          },
        });

        await this.sendVideoFileToChannel(
          config.vipChannelId,
          vipFile,
          vipCaption,
          anime.russianTitle,
        );

        await this.prisma.telegramPost.update({
          where: { id: postRecord.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });

        vipResults.push(`${vipFile ? vipFile.quality : '1080p'} [${vipFile ? vipFile.type : 'DUB'}]`);
      } catch (err: any) {
        this.logger.error(`Failed to post to VIP channel: ${err.message}`);
        vipResults.push(`Ошибка: ${err.message}`);
      }
    }

    // --- 3. SEND ADMIN ALERT FOR BOTH CHANNELS ---
    const epNum = episode ? episode.episodeNumber : 1;
    const adminMessage =
      `🚀 <b>[АВТО-ПОСТИНГ: УСПЕШНО]</b>\n\n` +
      `🎬 <b>Тайтл:</b> <i>${anime.russianTitle}</i>\n` +
      `📌 <b>Серия:</b> ${epNum}\n` +
      `📢 <b>Бесплатный канал:</b> ${publicResults.join(', ') || 'Пропущен'}\n` +
      `💎 <b>VIP-канал:</b> ${vipResults.join(', ') || 'Пропущен'}\n` +
      `⏱ <b>Следующий пост через:</b> ${this.intervalMinutes} мин.`;

    await this.botService.sendAdminAlert(adminMessage);

    this.realtime.emitLog(
      'TELEGRAM_PUBLISH',
      'SUCCESS',
      `Авто-постинг: опубликован тайтл "${anime.russianTitle}" (Эп. ${epNum}) в оба канала. Следующий через ${this.intervalMinutes} мин.`,
    );
  }

  private async sendVideoFileToChannel(
    channelId: string,
    file: any,
    caption: string,
    fallbackTitle: string,
  ): Promise<void> {
    if (!file) {
      await this.botService.sendMessage(channelId, caption);
      return;
    }

    let streamUrl = file.sourceStreamUrl;
    let downloadHeaders: Record<string, string> | undefined;

    if (!streamUrl && file.driveFileId && file.driveAccountId) {
      try {
        const driveInfo = await this.driveRouter.getDriveStreamInfo(
          file.driveFileId,
          file.driveAccountId,
        );
        streamUrl = driveInfo.url;
        downloadHeaders = {
          Authorization: driveInfo.authHeader.replace('Authorization: ', '').trim(),
        };
      } catch (e: any) {
        this.logger.warn(`Could not get stream info from Google Drive: ${e.message}`);
      }
    }

    if (streamUrl) {
      await this.gramjsService.uploadStreamingVideo({
        channelId,
        videoUrlOrPath: streamUrl,
        headers: downloadHeaders,
        caption,
        fileName: file.fileName || `${fallbackTitle}.mp4`,
      });
    } else {
      await this.botService.sendMessage(channelId, caption);
    }
  }

  private async scheduleNextTick(minutes: number): Promise<void> {
    const delayMs = Math.max(1000, minutes * 60 * 1000);
    this.nextPostAt = new Date(Date.now() + delayMs);

    await this.telegramQueue.add(
      'autopost-tick',
      { scheduledAt: this.nextPostAt.toISOString() },
      {
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.log(`Next auto-post tick scheduled for: ${this.nextPostAt.toLocaleTimeString()}`);
  }

  private async clearPendingJobs(): Promise<void> {
    try {
      const delayed = await this.telegramQueue.getDelayed();
      for (const job of delayed) {
        if (job.name === 'autopost-tick') {
          await job.remove();
        }
      }
    } catch (e: any) {
      this.logger.debug(`Could not clear pending autopost jobs: ${e.message}`);
    }
  }
}
