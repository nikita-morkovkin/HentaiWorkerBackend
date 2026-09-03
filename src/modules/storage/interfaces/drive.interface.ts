export interface UploadStreamOptions {
  animeTitleId: string;
  episodeId: string;
  russianTitle: string;
  englishTitle: string;
  episodeNumber: number;
  type: 'DUB' | 'SUB';
  quality: string;
  sourceStreamUrl: string;
  proxyUrl?: string;
  signal?: AbortSignal;
  onProgress?: (
    uploadedBytes: number,
    totalBytes: number,
    percent: number,
    statusText?: string,
  ) => void;
}

export interface UploadLocalFileOptions {
  animeTitleId: string;
  episodeId: string;
  russianTitle: string;
  englishTitle: string;
  episodeNumber: number;
  type: 'DUB' | 'SUB';
  quality: string;
  localFilePath: string;
  signal?: AbortSignal;
  onProgress?: (
    uploadedBytes: number,
    totalBytes: number,
    percent: number,
    statusText?: string,
  ) => void;
}

export interface DriveUploadResult {
  fileId: string;
  viewLink: string;
  downloadLink: string;
  fileSize: number;
  fileName: string;
  accountId: string;
}

export interface DriveStreamInfo {
  url: string;
  authHeader: string;
}

export interface PurgeStorageResult {
  success: boolean;
  deletedCount: number;
  message: string;
}

export interface DriveAccountListItem {
  id: string;
  name: string;
  email: string | null;
  isActive: boolean;
  isQuotaExceeded: boolean;
  statusMessage: string | null;
  usedStorageBytes: string;
  totalStorageBytes: string;
  dailyUploadedBytes: string;
  dailyLimitBytes: string;
  usedStoragePercent: number;
  dailyUploadedPercent: number;
  dailyResetAt: Date;
  createdAt: Date;
}
