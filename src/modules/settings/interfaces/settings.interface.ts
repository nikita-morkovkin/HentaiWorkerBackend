export interface TelegramConfigResult {
  botToken: string;
  appId: number;
  appHash: string;
  publicChannelId: string;
  vipChannelId: string;
  adminChatId: string;
  sessionString: string;
}

export interface ScraperSettingsResult {
  minDelayMs: number;
  maxDelayMs: number;
  concurrency: number;
  autoSync: boolean;
}

export interface MaskedSettingDetail {
  masked: string;
  isSet: boolean;
  category: string;
  description: string;
}

export type MaskedSettingsMap = Record<string, MaskedSettingDetail>;

export interface ProxyTestResult {
  success: boolean;
  latencyMs?: number;
  detectedIp?: string;
  error?: string;
}

export interface TelegramAuthStartResult {
  success: boolean;
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  message: string;
}
