export interface TelegramUploadOptions {
  channelId: string;
  videoUrlOrPath: string;
  caption: string;
  fileName: string;
  onProgress?: (progress: number) => void;
}

export interface ThumbnailMetadataResult {
  thumbnailPath: string;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface TelegramPublishResult {
  success: boolean;
  message?: string;
  post?: any;
}
