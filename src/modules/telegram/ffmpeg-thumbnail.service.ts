import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegStatic from 'ffmpeg-static';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ThumbnailMetadataResult } from './interfaces/telegram.interface';
import { FFMPEG_CONSTANTS } from '../../common/constants';
import { safeUnlink } from '../../common/helpers';

export { ThumbnailMetadataResult };

@Injectable()
export class FFmpegThumbnailService {
  private readonly logger = new Logger(FFmpegThumbnailService.name);

  constructor() {
    try {
      if (ffmpegStatic && typeof ffmpegStatic === 'string') {
        ffmpeg.setFfmpegPath(ffmpegStatic);
      } else if (ffmpegStatic && (ffmpegStatic as any).path) {
        ffmpeg.setFfmpegPath((ffmpegStatic as any).path);
      }
    } catch {
      this.logger.warn('ffmpeg-static not found or error loading, using system ffmpeg');
    }
  }

  public async generateThumbnailAndMetadata(
    videoInputPathOrUrl: string,
  ): Promise<ThumbnailMetadataResult> {
    const tempDir = os.tmpdir();
    const thumbnailPath = path.join(
      tempDir,
      `thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`,
    );

    return new Promise((resolve) => {
      let durationSeconds = 0;
      let width = 1280;
      let height = 720;

      ffmpeg.ffprobe(videoInputPathOrUrl, (err, metadata) => {
        if (!err && metadata) {
          durationSeconds = Math.round(metadata.format?.duration || 0);
          const videoStream = metadata.streams?.find((s) => s.codec_type === 'video');
          if (videoStream) {
            width = videoStream.width || 1280;
            height = videoStream.height || 720;
          }
        }

        const seekTime = durationSeconds > 10 ? '00:00:03' : '00:00:01';

        ffmpeg(videoInputPathOrUrl)
          .seekInput(seekTime)
          .frames(1)
          .size(FFMPEG_CONSTANTS.THUMBNAIL_SIZE)
          .outputOptions([...FFMPEG_CONSTANTS.THUMBNAIL_QUALITY_OPTS])
          .output(thumbnailPath)
          .on('end', () => {
            if (fs.existsSync(thumbnailPath)) {
              try {
                const stats = fs.statSync(thumbnailPath);
                this.logger.log(
                  `Generated thumbnail: ${thumbnailPath} (${Math.round(stats.size / 1024)} KB)`,
                );
              } catch {}
            }
            resolve({
              thumbnailPath,
              durationSeconds,
              width,
              height,
            });
          })
          .on('error', (ffmpegErr) => {
            this.logger.warn(
              `FFmpeg thumbnail generation failed: ${ffmpegErr.message}. Proceeding without thumb.`,
            );
            resolve({
              thumbnailPath: '',
              durationSeconds: durationSeconds || 1200,
              width: 1280,
              height: 720,
            });
          })
          .run();
      });
    });
  }

  public cleanupFile(filePath: string): void {
    if (filePath) {
      safeUnlink(filePath);
    }
  }
}
