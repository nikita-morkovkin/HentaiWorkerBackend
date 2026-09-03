import { SCRAPER_CONSTANTS } from '../constants';

export interface BaseVideoQualityItem {
  quality: string;
  url: string;
  studio?: string;
  rawQuality?: string;
}

/**
 * Checks whether an image URL points to a junk asset (avatar, badge, template, icon)
 */
export function isJunkCoverImage(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return true;
  const lower = url.toLowerCase();
  return SCRAPER_CONSTANTS.JUNK_IMAGE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Normalizes video quality string (e.g. "1080", "hd 720p" -> "1080p", "720p")
 */
export function normalizeVideoQuality(raw: string): string {
  if (!raw) return '720p';
  const lower = raw.toLowerCase().trim();
  if (lower.includes('1080')) return '1080p';
  if (lower.includes('720')) return '720p';
  if (lower.includes('480')) return '480p';
  if (lower.includes('360')) return '360p';
  return '720p';
}

/**
 * Detects video quality from URL string
 */
export function detectVideoQualityFromUrl(url: string): string {
  if (!url) return '720p';
  if (url.includes('1080')) return '1080p';
  if (url.includes('720')) return '720p';
  if (url.includes('480')) return '480p';
  if (url.includes('360')) return '360p';
  return '720p';
}

/**
 * Deduplicates and sorts video qualities list by resolution (1080p -> 720p -> 480p -> 360p)
 */
export function deduplicateVideoQualities<T extends BaseVideoQualityItem>(list: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of list) {
    const key = `${item.quality}-${item.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  const order: readonly string[] = SCRAPER_CONSTANTS.TARGET_QUALITIES;
  return result.sort((a, b) => {
    const aNorm = a.rawQuality || normalizeVideoQuality(a.quality);
    const bNorm = b.rawQuality || normalizeVideoQuality(b.quality);
    return order.indexOf(aNorm) - order.indexOf(bNorm);
  });
}
