export const QUEUE_NAMES = {
  SCRAPER: 'scraper-queue',
  TELEGRAM: 'telegram-queue',
} as const;

export const SYSTEM_SETTING_KEYS = {
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_APP_ID: 'TELEGRAM_APP_ID',
  TELEGRAM_APP_HASH: 'TELEGRAM_APP_HASH',
  TELEGRAM_PUBLIC_CHANNEL_ID: 'TELEGRAM_PUBLIC_CHANNEL_ID',
  TELEGRAM_VIP_CHANNEL_ID: 'TELEGRAM_VIP_CHANNEL_ID',
  TELEGRAM_ADMIN_CHAT_ID: 'TELEGRAM_ADMIN_CHAT_ID',
  TELEGRAM_SESSION_STRING: 'TELEGRAM_SESSION_STRING',
  TELEGRAM_AUTO_POST_ENABLED: 'TELEGRAM_AUTO_POST_ENABLED',
  TELEGRAM_AUTO_POST_INTERVAL_MIN: 'TELEGRAM_AUTO_POST_INTERVAL_MIN',
  TELEGRAM_AUTO_POST_LAST_TITLE_ID: 'TELEGRAM_AUTO_POST_LAST_TITLE_ID',

  SCRAPER_MIN_DELAY_MS: 'SCRAPER_MIN_DELAY_MS',
  SCRAPER_MAX_DELAY_MS: 'SCRAPER_MAX_DELAY_MS',
  SCRAPER_CONCURRENCY: 'SCRAPER_CONCURRENCY',
  SCRAPER_AUTO_SYNC: 'SCRAPER_AUTO_SYNC',
} as const;

export type SystemSettingKey = keyof typeof SYSTEM_SETTING_KEYS;

export const HTTP_CONSTANTS = {
  DEFAULT_USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  DEFAULT_BROWSER_HEADERS: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    Connection: 'close',
  },
  DEFAULT_TIMEOUT_MS: 35000,
  PROBE_TIMEOUT_MS: 5000,
  STREAM_DOWNLOAD_TIMEOUT_MS: 120000,
} as const;

export const SCRAPER_CONSTANTS = {
  BASE_URL: 'https://v4.hentai-hub.net',
  DEFAULT_MIN_DELAY_MS: 2000,
  DEFAULT_MAX_DELAY_MS: 5000,
  DEFAULT_CONCURRENCY: 3,
  MAX_RETRIES: 3,
  TARGET_QUALITIES: ['1080p', '720p', '480p', '360p'] as const,
  JUNK_IMAGE_KEYWORDS: [
    'noavatar',
    'avatar',
    'frame',
    'decor',
    'sticker',
    'emoji',
    'smile',
    'badge',
    'rank',
    'icon',
    'logo',
    'exp.png',
    'captcha',
    'preview_pack',
    'gifpack',
    'gifpacks',
    '/templates/',
    '/engine/',
    '/themes/',
  ] as const,
} as const;

export const STORAGE_CONSTANTS = {
  MASTER_FOLDER_NAME: 'HentaiWorker',
  GOOGLE_DAILY_UPLOAD_LIMIT_BYTES: BigInt(750) * BigInt(1024 * 1024 * 1024),
  GOOGLE_ACCOUNT_MAX_STORAGE_BYTES: BigInt(5) * BigInt(1024 * 1024 * 1024) * BigInt(1024),
  COVERS_DIR_REL: 'uploads/covers',
  METADATA_FILENAME: 'metadata.json',
} as const;

export const FFMPEG_CONSTANTS = {
  UPSCALE_VF: 'scale=1920:-1:flags=lanczos,unsharp=5:5:0.6:3:3:0.4',
  DEFAULT_SCREENSHOT_TIMESTAMPS: [120, 300, 480, 600, 720, 840],
  THUMBNAIL_SIZE: '640x?',
  THUMBNAIL_QUALITY_OPTS: ['-q:v 4', '-vframes 1'],
} as const;

export const TELEGRAM_TEMPLATES = {
  PUBLIC_CTA:
    '\n\n💎 <b>Хотите смотреть без цензуры в 1080p и раньше всех?</b>\n👉 Вступайте в наш закрытый <b>VIP-канал</b> всего за 250₽/мес!',
  VIP_CTA: '\n\n✨ <i>Приятного просмотра в VIP-клубе!</i>',
  ALERT_HEADER_ERROR: '🚨 <b>[ALERT - ERROR]</b>',
  ALERT_HEADER_SUCCESS: '✅ <b>[SYSTEM REPORT]</b>',
} as const;
