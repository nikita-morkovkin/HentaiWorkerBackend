import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DrivePoolService } from './drive-pool.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  UploadStreamOptions,
  UploadLocalFileOptions,
  DriveUploadResult,
  DriveStreamInfo,
  PurgeStorageResult,
} from './interfaces/drive.interface';
import { google } from 'googleapis';
import { Readable, PassThrough } from 'stream';
import axios from 'axios';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  createProxyAgent,
  sanitizeFilename,
  getCoversDirectory,
  safeUnlink,
} from '../../common/helpers';
import {
  STORAGE_CONSTANTS,
  FFMPEG_CONSTANTS,
  HTTP_CONSTANTS,
  SCRAPER_CONSTANTS,
} from '../../common/constants';

export {
  UploadStreamOptions,
  UploadLocalFileOptions,
  DriveUploadResult,
  DriveStreamInfo,
  PurgeStorageResult,
};

@Injectable()
export class DriveRouterService {
  private readonly logger = new Logger(DriveRouterService.name);
  private readonly masterFolderName = STORAGE_CONSTANTS.MASTER_FOLDER_NAME;

  constructor(
    private readonly prisma: PrismaService,
    private readonly poolService: DrivePoolService,
    private readonly realtime: RealtimeGateway,
  ) {}

  public sanitizeName(name: string): string {
    return sanitizeFilename(name);
  }

  public async getOrCreateMasterFolder(accountId: string): Promise<string> {
    const auth = await this.poolService.getAuthenticatedClient(accountId);
    const drive = google.drive({ version: 'v3', auth });

    const query = `name = '${this.masterFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const searchRes = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (searchRes.data.files && searchRes.data.files.length > 0) {
      return searchRes.data.files[0].id!;
    }

    const createRes = await drive.files.create({
      requestBody: {
        name: this.masterFolderName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    this.logger.log(
      `Created master root folder "${this.masterFolderName}" in Drive: ${createRes.data.id}`,
    );
    return createRes.data.id!;
  }

  public async getOrCreateAnimeFolder(animeTitleId: string, accountId: string): Promise<string> {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: animeTitleId },
    });
    if (!anime) throw new Error(`Anime ${animeTitleId} not found`);

    if (anime.driveFolderId && anime.driveAccountId === accountId) {
      return anime.driveFolderId;
    }

    const masterFolderId = await this.getOrCreateMasterFolder(accountId);
    const folderName = this.sanitizeName(`${anime.russianTitle} - ${anime.englishTitle}`);
    const auth = await this.poolService.getAuthenticatedClient(accountId);
    const drive = google.drive({ version: 'v3', auth });

    const query = `name = '${folderName.replace(/'/g, "\\'")}' and '${masterFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const searchRes = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    let folderId: string;
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      folderId = searchRes.data.files[0].id!;
      this.logger.log(`Found existing Drive folder for ${folderName}: ${folderId}`);
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: folderName,
          parents: [masterFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      });
      folderId = createRes.data.id!;
      this.logger.log(
        `Created new Drive folder for ${folderName} inside "${this.masterFolderName}": ${folderId}`,
      );
    }

    await this.prisma.animeTitle.update({
      where: { id: animeTitleId },
      data: {
        driveFolderId: folderId,
        driveAccountId: accountId,
      },
    });

    await this.uploadOrUpdateMetadata(animeTitleId, folderId, accountId);

    return folderId;
  }

  public async uploadOrUpdateMetadata(animeTitleId: string, folderId: string, accountId: string) {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: animeTitleId },
      include: { episodes: true },
    });
    if (!anime) return;

    const metadataContent = JSON.stringify(
      {
        id: anime.id,
        russianTitle: anime.russianTitle,
        englishTitle: anime.englishTitle,
        originalTitle: anime.originalTitle,
        description: anime.description,
        tags: anime.tags,
        genres: anime.genres,
        sourceUrl: anime.sourceUrl,
        coverUrls: anime.coverUrls,
        episodesCount: anime.episodes.length,
        updatedAt: anime.updatedAt,
      },
      null,
      2,
    );

    const auth = await this.poolService.getAuthenticatedClient(accountId);
    const drive = google.drive({ version: 'v3', auth });

    const searchRes = await drive.files.list({
      q: `name = '${STORAGE_CONSTANTS.METADATA_FILENAME}' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id)',
    });

    const stream = Readable.from([metadataContent]);

    if (searchRes.data.files && searchRes.data.files.length > 0) {
      await drive.files.update({
        fileId: searchRes.data.files[0].id!,
        media: {
          mimeType: 'application/json',
          body: stream,
        },
      });
    } else {
      await drive.files.create({
        requestBody: {
          name: STORAGE_CONSTANTS.METADATA_FILENAME,
          parents: [folderId],
          mimeType: 'application/json',
        },
        media: {
          mimeType: 'application/json',
          body: stream,
        },
        fields: 'id',
      });
    }
  }

  public async getOrCreateEpisodeFolder(
    episodeId: string,
    parentFolderId: string,
    episodeNumber: number,
    accountId: string,
  ): Promise<string> {
    const episode = await this.prisma.animeEpisode.findUnique({
      where: { id: episodeId },
    });
    if (!episode) throw new Error(`Episode ${episodeId} not found`);

    if (episode.driveFolderId && episode.driveAccountId === accountId) {
      return episode.driveFolderId;
    }

    const folderName = `Серия ${episodeNumber}`;
    const auth = await this.poolService.getAuthenticatedClient(accountId);
    const drive = google.drive({ version: 'v3', auth });

    const query = `name = '${folderName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const searchRes = await drive.files.list({
      q: query,
      fields: 'files(id)',
    });

    let episodeFolderId: string;
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      episodeFolderId = searchRes.data.files[0].id!;
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: folderName,
          parents: [parentFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      });
      episodeFolderId = createRes.data.id!;
    }

    await this.prisma.animeEpisode.update({
      where: { id: episodeId },
      data: {
        driveFolderId: episodeFolderId,
        driveAccountId: accountId,
      },
    });

    return episodeFolderId;
  }

  public async extractMultipleScreenshots(
    animeTitleId: string,
    videoUrl: string,
    count: number = 4,
  ): Promise<string[]> {
    const coversDir = getCoversDirectory();

    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: animeTitleId },
      select: { coverUrls: true },
    });

    if (anime && anime.coverUrls) {
      const oldFrames = anime.coverUrls.filter((u) => u.includes('_frame_'));

      for (const frame of oldFrames) {
        const fileName = path.basename(frame);
        safeUnlink(path.join(coversDir, fileName));
      }
      anime.coverUrls = anime.coverUrls.filter((u) => !u.includes('_frame_'));
    }

    const timestamps = FFMPEG_CONSTANTS.DEFAULT_SCREENSHOT_TIMESTAMPS;
    const pickedTimestamps = timestamps.slice(0, count);
    const extractedUrls: string[] = [];

    for (let i = 0; i < pickedTimestamps.length; i++) {
      const sec = pickedTimestamps[i];
      const fileName = `${animeTitleId}_frame_${Date.now()}_${i + 1}.jpg`;
      const filePath = path.join(coversDir, fileName);

      await new Promise<void>((resolve) => {
        const ffmpegArgs = [
          '-headers',
          `User-Agent: ${HTTP_CONSTANTS.DEFAULT_USER_AGENT}\r\nReferer: ${SCRAPER_CONSTANTS.BASE_URL}/\r\n`,
          '-user_agent',
          HTTP_CONSTANTS.DEFAULT_USER_AGENT,
          '-referer',
          `${SCRAPER_CONSTANTS.BASE_URL}/`,
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5',
          '-ss',
          String(sec),
          '-i',
          videoUrl,
          '-vframes',
          '1',
          '-q:v',
          '2',
          '-vf',
          FFMPEG_CONSTANTS.UPSCALE_VF,
          '-y',
          filePath,
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(filePath)) {
            const publicUrl = `/api/anime/covers/${fileName}`;
            extractedUrls.push(publicUrl);
          }
          resolve();
        });

        ffmpegProcess.on('error', (err) => {
          this.logger.warn(`FFmpeg frame extraction error at ${sec}s: ${err.message}`);
          resolve();
        });
      });
    }

    if (extractedUrls.length > 0) {
      try {
        const freshAnime = await this.prisma.animeTitle.findUnique({
          where: { id: animeTitleId },
          select: { coverUrls: true },
        });

        if (freshAnime) {
          const currentCovers = freshAnime.coverUrls || [];
          const combined = Array.from(new Set([...extractedUrls, ...currentCovers])).slice(0, 10);
          await this.prisma.animeTitle.update({
            where: { id: animeTitleId },
            data: { coverUrls: combined },
          });
          this.logger.log(
            `Added ${extractedUrls.length} new diverse screenshots for anime ${animeTitleId}`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`Could not update coverUrls for anime ${animeTitleId}: ${err.message}`);
      }
    }

    return extractedUrls;
  }

  public async extractMultipleScreenshotsFromFile(
    animeTitleId: string,
    localFilePath: string,
    count: number = 4,
  ): Promise<string[]> {
    const coversDir = getCoversDirectory();

    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: animeTitleId },
      select: { coverUrls: true },
    });

    if (anime && anime.coverUrls) {
      const oldFrames = anime.coverUrls.filter((u) => u.includes('_frame_'));
      for (const frame of oldFrames) {
        const fileName = path.basename(frame);
        safeUnlink(path.join(coversDir, fileName));
      }
      anime.coverUrls = anime.coverUrls.filter((u) => !u.includes('_frame_'));
    }

    const timestamps = FFMPEG_CONSTANTS.DEFAULT_SCREENSHOT_TIMESTAMPS;
    const pickedTimestamps = timestamps.slice(0, count);
    const extractedUrls: string[] = [];

    for (let i = 0; i < pickedTimestamps.length; i++) {
      const sec = pickedTimestamps[i];
      const fileName = `${animeTitleId}_frame_${Date.now()}_${i + 1}.jpg`;
      const filePath = path.join(coversDir, fileName);

      await new Promise<void>((resolve) => {
        const ffmpegArgs = [
          '-ss',
          String(sec),
          '-i',
          localFilePath,
          '-vframes',
          '1',
          '-q:v',
          '2',
          '-vf',
          FFMPEG_CONSTANTS.UPSCALE_VF,
          '-y',
          filePath,
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(filePath)) {
            const publicUrl = `/api/anime/covers/${fileName}`;
            extractedUrls.push(publicUrl);
          }
          resolve();
        });

        ffmpegProcess.on('error', (err) => {
          this.logger.warn(`FFmpeg local frame extraction error at ${sec}s: ${err.message}`);
          resolve();
        });
      });
    }

    if (extractedUrls.length > 0) {
      try {
        const freshAnime = await this.prisma.animeTitle.findUnique({
          where: { id: animeTitleId },
          select: { coverUrls: true },
        });

        if (freshAnime) {
          const currentCovers = freshAnime.coverUrls || [];
          const combined = Array.from(new Set([...extractedUrls, ...currentCovers])).slice(0, 10);
          await this.prisma.animeTitle.update({
            where: { id: animeTitleId },
            data: { coverUrls: combined },
          });
          this.logger.log(
            `Added ${extractedUrls.length} new diverse screenshots for anime ${animeTitleId} from local file`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`Could not update coverUrls for anime ${animeTitleId}: ${err.message}`);
      }
    }

    return extractedUrls;
  }

  public async extractAndSaveRandomCover(
    animeTitleId: string,
    videoUrl: string,
  ): Promise<string | null> {
    const anime = await this.prisma.animeTitle.findUnique({
      where: { id: animeTitleId },
      select: { coverUrls: true },
    });

    if (!anime) return null;

    if (
      anime.coverUrls &&
      anime.coverUrls.some((url) => url.includes('_frame_') || url.includes('/covers/'))
    ) {
      this.logger.log(`Anime ${animeTitleId} already has screenshots. Skipping auto-extraction.`);
      return anime.coverUrls[0] || null;
    }

    const urls = await this.extractMultipleScreenshots(animeTitleId, videoUrl, 4);
    return urls[0] || null;
  }

  public async streamVideoToDrive(options: UploadStreamOptions): Promise<DriveUploadResult> {
    const epPad = String(options.episodeNumber).padStart(2, '0');
    const typeLabel = options.type.toLowerCase();
    const fileName = this.sanitizeName(
      `${options.russianTitle} - ${options.englishTitle} - ${epPad} - ${typeLabel} - ${options.quality}.mp4`,
    );

    this.extractAndSaveRandomCover(options.animeTitleId, options.sourceStreamUrl).catch((err) =>
      this.logger.warn(`Failed to extract random frame: ${err.message}`),
    );

    let retries = 3;
    let lastError: any = null;

    while (retries > 0) {
      try {
        const account = await this.poolService.getBestAvailableAccount();
        const accountId = account.id;

        const animeFolderId = await this.getOrCreateAnimeFolder(options.animeTitleId, accountId);
        const episodeFolderId = await this.getOrCreateEpisodeFolder(
          options.episodeId,
          animeFolderId,
          options.episodeNumber,
          accountId,
        );

        const auth = await this.poolService.getAuthenticatedClient(accountId);
        const drive = google.drive({ version: 'v3', auth });

        const checkQuery = `name = '${fileName.replace(/'/g, "\\'")}' and '${episodeFolderId}' in parents and trashed = false`;
        const checkRes = await drive.files.list({
          q: checkQuery,
          fields: 'files(id, name, size, webViewLink, webContentLink)',
        });

        if (checkRes.data.files && checkRes.data.files.length > 0) {
          const existing = checkRes.data.files[0];
          this.logger.log(`File already exists in Drive: ${fileName} (${existing.id})`);
          await this.realtime.emitLog(
            'DRIVE_UPLOAD',
            'INFO',
            `Файл уже есть в Google Drive: ${fileName}`,
          );

          await this.prisma.episodeFile.upsert({
            where: {
              episodeId_type_quality: {
                episodeId: options.episodeId,
                type: options.type,
                quality: options.quality,
              },
            },
            create: {
              episodeId: options.episodeId,
              type: options.type,
              quality: options.quality,
              fileName,
              fileSizeBytes: BigInt(existing.size || '0'),
              driveFileId: existing.id,
              driveAccountId: accountId,
              driveViewLink:
                existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
              driveDownloadLink:
                existing.webContentLink ||
                `https://drive.google.com/uc?id=${existing.id}&export=download`,
              sourceStreamUrl: options.sourceStreamUrl,
            },
            update: {
              driveFileId: existing.id,
              driveAccountId: accountId,
              driveViewLink:
                existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
              driveDownloadLink:
                existing.webContentLink ||
                `https://drive.google.com/uc?id=${existing.id}&export=download`,
            },
          });

          return {
            fileId: existing.id!,
            viewLink: existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
            downloadLink:
              existing.webContentLink ||
              `https://drive.google.com/uc?id=${existing.id}&export=download`,
            fileSize: Number(existing.size || 0),
            fileName,
            accountId,
          };
        }

        await this.realtime.emitLog(
          'DRIVE_UPLOAD',
          'INFO',
          `Выбран Google Drive аккаунт "${account.name}". Подготовка стрима: ${fileName}`,
        );

        const agent = createProxyAgent(options.proxyUrl, true);

        const sourceResponse = await axios.get(options.sourceStreamUrl, {
          responseType: 'stream',
          httpsAgent: agent,
          httpAgent: agent,
          headers: {
            'User-Agent': HTTP_CONSTANTS.DEFAULT_USER_AGENT,
            Referer: `${SCRAPER_CONSTANTS.BASE_URL}/`,
            Accept: '*/*',
          },
          timeout: 120000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          signal: options.signal,
        });

        const totalBytes = Number(sourceResponse.headers['content-length'] || 0);
        let uploadedBytes = 0;

        await this.realtime.emitLog(
          'DRIVE_UPLOAD',
          'INFO',
          `Начата прямая трансляция видео в облако: ${fileName} (${totalBytes > 0 ? Math.round(totalBytes / (1024 * 1024)) + ' MB' : 'поток'})`,
        );

        const passThrough = new PassThrough();

        if (options.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              sourceResponse.data.destroy();
              passThrough.destroy(new Error('AbortError'));
            },
            { once: true },
          );
        }

        sourceResponse.data.on('data', (chunk: Buffer) => {
          uploadedBytes += chunk.length;
          if (options.onProgress && totalBytes > 0) {
            const rawPercent = Math.round((uploadedBytes / totalBytes) * 100);
            const percent = Math.min(99, rawPercent);
            const statusText = percent >= 98 ? 'Финализация в Google Drive...' : undefined;
            options.onProgress(uploadedBytes, totalBytes, percent, statusText);
          }
        });

        sourceResponse.data.pipe(passThrough);

        this.logger.log(`Starting stream upload for ${fileName} to Drive account ${accountId}`);

        const uploadRes = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [episodeFolderId],
            mimeType: 'video/mp4',
          },
          media: {
            mimeType: 'video/mp4',
            body: passThrough,
          },
          fields: 'id, name, size, webViewLink, webContentLink',
        });

        const fileId = uploadRes.data.id!;
        const finalSize = Number(uploadRes.data.size || uploadedBytes);

        if (options.onProgress) {
          options.onProgress(finalSize, finalSize, 100, 'Сохранено в Google Drive');
        }

        await this.poolService.recordUploadedBytes(accountId, finalSize);

        const viewLink =
          uploadRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const downloadLink =
          uploadRes.data.webContentLink ||
          `https://drive.google.com/uc?id=${fileId}&export=download`;

        await this.prisma.episodeFile.upsert({
          where: {
            episodeId_type_quality: {
              episodeId: options.episodeId,
              type: options.type,
              quality: options.quality,
            },
          },
          create: {
            episodeId: options.episodeId,
            type: options.type,
            quality: options.quality,
            fileName,
            fileSizeBytes: BigInt(finalSize),
            driveFileId: fileId,
            driveAccountId: accountId,
            driveViewLink: viewLink,
            driveDownloadLink: downloadLink,
            sourceStreamUrl: options.sourceStreamUrl,
          },
          update: {
            fileName,
            fileSizeBytes: BigInt(finalSize),
            driveFileId: fileId,
            driveAccountId: accountId,
            driveViewLink: viewLink,
            driveDownloadLink: downloadLink,
            sourceStreamUrl: options.sourceStreamUrl,
          },
        });

        this.logger.log(`Successfully uploaded ${fileName} to Google Drive (${finalSize} bytes)`);

        return {
          fileId,
          viewLink,
          downloadLink,
          fileSize: finalSize,
          fileName,
          accountId,
        };
      } catch (err: any) {
        lastError = err;
        const isTimeout =
          err.code === 'ECONNABORTED' ||
          err.code === 'ETIMEDOUT' ||
          err.status === 408 ||
          err.message?.includes('408') ||
          err.message?.includes('Request Timeout') ||
          err.message?.includes('timeout');

        const isRateLimit =
          err.code === 403 ||
          err.status === 403 ||
          err.message?.includes('rateLimitExceeded') ||
          err.message?.includes('userRateLimitExceeded');

        if (isRateLimit) {
          this.logger.warn(
            'Google Drive 403 rate limit exceeded. Switching account with exponential backoff.',
          );
          await this.realtime.emitLog(
            'DRIVE_UPLOAD',
            'WARN',
            'Превышен суточный лимит Google Drive (403). Переключение на резервный аккаунт...',
          );
          const delay = Math.pow(2, 4 - retries) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        } else if (isTimeout) {
          this.logger.warn(
            `Google Drive timeout (408). Waiting before retry (attempt ${4 - retries}/3)...`,
          );
          await this.realtime.emitLog(
            'DRIVE_UPLOAD',
            'WARN',
            `Сетевой таймаут Google Drive (408). Повторный перезапуск потока (попытка ${4 - retries}/3)...`,
          );
          const delay = (4 - retries) * 2000;
          await new Promise((r) => setTimeout(r, delay));
        } else {
          this.logger.error(`Error uploading stream (attempt ${4 - retries}): ${err.message}`);
          await new Promise((r) => setTimeout(r, 1500));
        }

        retries--;
      }
    }

    throw new Error(`Failed to upload ${fileName} to Google Drive: ${lastError?.message}`);
  }

  public async uploadLocalFileToDrive(options: UploadLocalFileOptions): Promise<DriveUploadResult> {
    const epPad = String(options.episodeNumber).padStart(2, '0');
    const typeLabel = options.type.toLowerCase();
    const fileName = this.sanitizeName(
      `${options.russianTitle} - ${options.englishTitle} - ${epPad} - ${typeLabel} - ${options.quality}.mp4`,
    );

    let retries = 3;
    let lastError: any = null;

    while (retries > 0) {
      try {
        const account = await this.poolService.getBestAvailableAccount();
        const accountId = account.id;

        const animeFolderId = await this.getOrCreateAnimeFolder(options.animeTitleId, accountId);
        const episodeFolderId = await this.getOrCreateEpisodeFolder(
          options.episodeId,
          animeFolderId,
          options.episodeNumber,
          accountId,
        );

        const auth = await this.poolService.getAuthenticatedClient(accountId);
        const drive = google.drive({ version: 'v3', auth });

        const checkQuery = `name = '${fileName.replace(/'/g, "\\'")}' and '${episodeFolderId}' in parents and trashed = false`;
        const checkRes = await drive.files.list({
          q: checkQuery,
          fields: 'files(id, name, size, webViewLink, webContentLink)',
        });

        if (checkRes.data.files && checkRes.data.files.length > 0) {
          const existing = checkRes.data.files[0];
          this.logger.log(`File already exists in Drive: ${fileName} (${existing.id})`);

          await this.prisma.episodeFile.upsert({
            where: {
              episodeId_type_quality: {
                episodeId: options.episodeId,
                type: options.type,
                quality: options.quality,
              },
            },
            create: {
              episodeId: options.episodeId,
              type: options.type,
              quality: options.quality,
              fileName,
              fileSizeBytes: BigInt(existing.size || '0'),
              driveFileId: existing.id,
              driveAccountId: accountId,
              driveViewLink:
                existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
              driveDownloadLink:
                existing.webContentLink ||
                `https://drive.google.com/uc?id=${existing.id}&export=download`,
            },
            update: {
              driveFileId: existing.id,
              driveAccountId: accountId,
              driveViewLink:
                existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
              driveDownloadLink:
                existing.webContentLink ||
                `https://drive.google.com/uc?id=${existing.id}&export=download`,
            },
          });

          return {
            fileId: existing.id!,
            viewLink: existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
            downloadLink:
              existing.webContentLink ||
              `https://drive.google.com/uc?id=${existing.id}&export=download`,
            fileSize: Number(existing.size || 0),
            fileName,
            accountId,
          };
        }

        if (!fs.existsSync(options.localFilePath)) {
          throw new Error(`Local file not found at path: ${options.localFilePath}`);
        }

        const stats = fs.statSync(options.localFilePath);
        const totalBytes = stats.size;
        let uploadedBytes = 0;

        const readStream = fs.createReadStream(options.localFilePath);
        const passThrough = new PassThrough();

        if (options.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              readStream.destroy();
              passThrough.destroy(new Error('AbortError'));
            },
            { once: true },
          );
        }

        readStream.on('data', (chunk: Buffer) => {
          uploadedBytes += chunk.length;
          if (options.onProgress && totalBytes > 0) {
            const rawPercent = Math.round((uploadedBytes / totalBytes) * 100);
            const percent = Math.min(99, rawPercent);
            const statusText = percent >= 98 ? 'Финализация в Google Drive...' : undefined;
            options.onProgress(uploadedBytes, totalBytes, percent, statusText);
          }
        });

        readStream.pipe(passThrough);

        this.logger.log(
          `Starting local file upload for ${fileName} (${totalBytes} bytes) to Drive account ${accountId}`,
        );

        const uploadRes = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [episodeFolderId],
            mimeType: 'video/mp4',
          },
          media: {
            mimeType: 'video/mp4',
            body: passThrough,
          },
          fields: 'id, name, size, webViewLink, webContentLink',
        });

        const fileId = uploadRes.data.id!;
        const finalSize = Number(uploadRes.data.size || totalBytes);

        if (options.onProgress) {
          options.onProgress(finalSize, finalSize, 100, 'Сохранено в Google Drive');
        }

        await this.poolService.recordUploadedBytes(accountId, finalSize);

        const viewLink =
          uploadRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const downloadLink =
          uploadRes.data.webContentLink ||
          `https://drive.google.com/uc?id=${fileId}&export=download`;

        await this.prisma.episodeFile.upsert({
          where: {
            episodeId_type_quality: {
              episodeId: options.episodeId,
              type: options.type,
              quality: options.quality,
            },
          },
          create: {
            episodeId: options.episodeId,
            type: options.type,
            quality: options.quality,
            fileName,
            fileSizeBytes: BigInt(finalSize),
            driveFileId: fileId,
            driveAccountId: accountId,
            driveViewLink: viewLink,
            driveDownloadLink: downloadLink,
          },
          update: {
            fileName,
            fileSizeBytes: BigInt(finalSize),
            driveFileId: fileId,
            driveAccountId: accountId,
            driveViewLink: viewLink,
            driveDownloadLink: downloadLink,
          },
        });

        this.logger.log(
          `Successfully uploaded local file ${fileName} to Google Drive (${finalSize} bytes)`,
        );

        return {
          fileId,
          viewLink,
          downloadLink,
          fileSize: finalSize,
          fileName,
          accountId,
        };
      } catch (err: any) {
        lastError = err;
        const isTimeout =
          err.code === 'ECONNABORTED' ||
          err.code === 'ETIMEDOUT' ||
          err.status === 408 ||
          err.message?.includes('408') ||
          err.message?.includes('Request Timeout') ||
          err.message?.includes('timeout');

        const isRateLimit =
          err.code === 403 ||
          err.status === 403 ||
          err.message?.includes('rateLimitExceeded') ||
          err.message?.includes('userRateLimitExceeded');

        if (isRateLimit) {
          this.logger.warn(
            'Google Drive 403 rate limit exceeded. Switching account with exponential backoff.',
          );
          await this.realtime.emitLog(
            'DRIVE_UPLOAD',
            'WARN',
            'Превышен суточный лимит Google Drive (403). Переключение на резервный аккаунт...',
          );
          const delay = Math.pow(2, 4 - retries) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        } else if (isTimeout) {
          this.logger.warn(
            `Google Drive timeout (408). Waiting before retry (attempt ${4 - retries}/3)...`,
          );
          await this.realtime.emitLog(
            'DRIVE_UPLOAD',
            'WARN',
            `Сетевой таймаут Google Drive (408). Повторный перезапуск загрузки файла (попытка ${4 - retries}/3)...`,
          );
          const delay = (4 - retries) * 2000;
          await new Promise((r) => setTimeout(r, delay));
        } else {
          this.logger.error(`Error uploading local file (attempt ${4 - retries}): ${err.message}`);
          await new Promise((r) => setTimeout(r, 1500));
        }

        retries--;
      }
    }

    throw new Error(
      `Failed to upload local file ${fileName} to Google Drive: ${lastError?.message}`,
    );
  }

  public async purgeAllStorage(accountId?: string): Promise<PurgeStorageResult> {
    this.logger.warn(
      '⚠️ Initiating full storage purge across Google Drive accounts and database...',
    );

    const accounts = accountId
      ? await this.prisma.driveAccount.findMany({ where: { id: accountId } })
      : await this.prisma.driveAccount.findMany({ where: { isActive: true } });

    let deletedFoldersCount = 0;

    for (const acc of accounts) {
      try {
        const auth = await this.poolService.getAuthenticatedClient(acc.id);
        const drive = google.drive({ version: 'v3', auth });

        const searchRes = await drive.files.list({
          q: `name = '${this.masterFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id, name)',
        });

        if (searchRes.data.files && searchRes.data.files.length > 0) {
          for (const folder of searchRes.data.files) {
            this.logger.log(
              `Deleting master folder ${folder.name} (${folder.id}) on account ${acc.name}...`,
            );
            await drive.files.delete({ fileId: folder.id! });
            deletedFoldersCount++;
          }
        }

        await this.prisma.driveAccount.update({
          where: { id: acc.id },
          data: {
            usedStorageBytes: BigInt(0),
            dailyUploadedBytes: BigInt(0),
            isQuotaExceeded: false,
          },
        });
      } catch (err: any) {
        this.logger.error(`Error purging Drive account ${acc.name}: ${err.message}`);
      }
    }

    await this.prisma.episodeFile.deleteMany({});

    await this.prisma.telegramPost.deleteMany({
      where: {
        status: { in: ['DRAFT', 'SCHEDULED', 'FAILED'] },
      },
    });

    await this.prisma.animeEpisode.updateMany({
      data: {
        driveFolderId: null,
        driveAccountId: null,
        status: 'PENDING',
        errorMessage: null,
      },
    });

    await this.prisma.animeTitle.updateMany({
      data: {
        driveFolderId: null,
        driveAccountId: null,
        status: 'PENDING',
        errorMessage: null,
      },
    });

    try {
      const coversDir = getCoversDirectory();
      if (fs.existsSync(coversDir)) {
        const files = fs.readdirSync(coversDir);
        for (const f of files) {
          safeUnlink(path.join(coversDir, f));
        }
      }
    } catch (e: any) {
      this.logger.warn(`Could not clear local covers folder: ${e.message}`);
    }

    this.logger.log(
      `✅ Full storage purge completed. Deleted ${deletedFoldersCount} master folders and cleaned database records.`,
    );
    return {
      success: true,
      deletedCount: deletedFoldersCount,
      message: `Успешно удалены все файлы из Google Drive (папка "${this.masterFolderName}") и полностью очищена база данных видеофайлов.`,
    };
  }

  public async getDriveStreamInfo(
    driveFileId: string,
    driveAccountId: string,
  ): Promise<DriveStreamInfo> {
    const auth = await this.poolService.getAuthenticatedClient(driveAccountId);
    const tokenResponse = await auth.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) throw new Error('Failed to obtain Google Drive access token');

    return {
      url: `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      authHeader: `Authorization: Bearer ${accessToken}\r\n`,
    };
  }

  public async resolveDriveRedirect(url: string, authHeader: string): Promise<string> {
    try {
      const token = authHeader.replace('Authorization: Bearer ', '').trim();
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        return response.headers.location;
      }
      return url;
    } catch (e: any) {
      if (
        e.response &&
        e.response.status >= 300 &&
        e.response.status < 400 &&
        e.response.headers.location
      ) {
        return e.response.headers.location;
      }
      this.logger.warn(`Failed to resolve Drive redirect: ${e.message}`);
      return url;
    }
  }
}
