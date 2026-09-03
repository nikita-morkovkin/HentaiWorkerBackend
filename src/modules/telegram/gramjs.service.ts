import { Injectable, Logger } from '@nestjs/common';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { SettingsService } from '../settings/settings.service';
import { FFmpegThumbnailService } from './ffmpeg-thumbnail.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TelegramUploadOptions } from './interfaces/telegram.interface';
import { safeUnlink } from '../../common/helpers';
import { HTTP_CONSTANTS } from '../../common/constants';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';

export { TelegramUploadOptions };

@Injectable()
export class GramjsService {
  private readonly logger = new Logger(GramjsService.name);
  private client: TelegramClient | null = null;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly thumbnailService: FFmpegThumbnailService,
    private readonly realtime: RealtimeGateway,
  ) {}

  public async getClient(): Promise<TelegramClient> {
    if (this.client && this.client.connected) {
      return this.client;
    }

    const config = await this.settingsService.getTelegramConfig();
    if (!config.appId || !config.appHash || !config.sessionString) {
      throw new Error(
        'Telegram MTProto credentials (App ID, App Hash, Session String) are not fully configured in Settings',
      );
    }

    const session = new StringSession(config.sessionString);
    this.client = new TelegramClient(session, config.appId, config.appHash, {
      connectionRetries: 5,
      useWSS: false,
    });

    await this.client.connect();
    this.logger.log('Connected to Telegram MTProto via GramJS');
    return this.client;
  }

  public async uploadStreamingVideo(options: TelegramUploadOptions): Promise<any> {
    const client = await this.getClient();
    let localFilePath = options.videoUrlOrPath;
    let isTemp = false;

    if (options.videoUrlOrPath.startsWith('http')) {
      this.logger.log(`Downloading stream to temp file for MTProto upload: ${options.fileName}`);
      isTemp = true;
      const tempPath = path.join(os.tmpdir(), `tg_${Date.now()}_${options.fileName}`);
      const writer = fs.createWriteStream(tempPath);

      try {
        const res = await axios.get(options.videoUrlOrPath, {
          responseType: 'stream',
          headers: options.headers,
          timeout: HTTP_CONSTANTS.STREAM_DOWNLOAD_TIMEOUT_MS,
        });

        res.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
          writer.on('finish', () => resolve());
          writer.on('error', (err) => {
            writer.close();
            reject(err);
          });
          res.data.on('error', (err: any) => {
            writer.close();
            reject(err);
          });
        });

        localFilePath = tempPath;
      } catch (err) {
        writer.close();
        safeUnlink(tempPath);
        throw err;
      }
    }

    const meta = await this.thumbnailService.generateThumbnailAndMetadata(localFilePath);

    try {
      const stats = fs.statSync(localFilePath);
      const fileSize = stats.size;
      const fileName = path.basename(options.fileName);

      this.logger.log(
        `Starting MTProto sendFile: ${fileName} (${Math.round(fileSize / (1024 * 1024))} MB) to ${options.channelId}`,
      );

      const result = await client.sendFile(options.channelId, {
        file: localFilePath,
        caption: options.caption,
        parseMode: 'html',
        thumb:
          meta.thumbnailPath && fs.existsSync(meta.thumbnailPath) ? meta.thumbnailPath : undefined,
        supportsStreaming: true,
        attributes: [
          new Api.DocumentAttributeVideo({
            duration: meta.durationSeconds,
            w: meta.width,
            h: meta.height,
            supportsStreaming: true,
          }),
          new Api.DocumentAttributeFilename({
            fileName,
          }),
        ],
        progressCallback: (progress: number) => {
          const percent = Math.round(progress * 100);
          if (options.onProgress) options.onProgress(percent);
          this.realtime.emitTelegramProgress({
            fileName,
            percent,
            channelId: options.channelId,
          });
        },
      });

      this.logger.log(`Successfully uploaded ${fileName} to Telegram channel ${options.channelId}`);
      return result;
    } finally {
      if (meta.thumbnailPath) {
        this.thumbnailService.cleanupFile(meta.thumbnailPath);
      }
      if (isTemp) {
        safeUnlink(localFilePath);
      }
    }
  }
}
