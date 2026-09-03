import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SettingsService } from '../settings/settings.service';
import {
  ScrapedAnime,
  ScrapedEpisode,
  ScrapedEpisodeStream,
  ScrapedVideoQuality,
  CatalogPageScrapeResult,
} from './scraper.interface';
import {
  createProxyAgent,
  createHttpAgents,
  isJunkCoverImage,
  normalizeVideoQuality,
  detectVideoQualityFromUrl,
  deduplicateVideoQualities,
} from '../../common/helpers';
import { HTTP_CONSTANTS, SCRAPER_CONSTANTS } from '../../common/constants';

@Injectable()
export class CheerioScraperService {
  private readonly logger = new Logger(CheerioScraperService.name);
  private readonly baseUrl = SCRAPER_CONSTANTS.BASE_URL;
  private sessionCookies: Record<string, string> = {};
  private sessionAuthenticatedAt: number = 0;

  constructor(private readonly settingsService: SettingsService) {}

  public async randomDelay(): Promise<void> {
    const settings = await this.settingsService.getScraperSettings();
    const min = settings.minDelayMs || SCRAPER_CONSTANTS.DEFAULT_MIN_DELAY_MS;
    const max = settings.maxDelayMs || SCRAPER_CONSTANTS.DEFAULT_MAX_DELAY_MS;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    this.logger.debug(`Applying anti-ban delay: ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }

  public async bypassAgeVerification(
    initialHtml: string,
    proxyUrl?: string | null,
  ): Promise<boolean> {
    this.logger.log(
      '🛡️ Age verification gate detected. Automatically solving captcha challenge...',
    );

    let pattern = [7, 2, 9, 4];
    if (this.sessionCookies['pattern_id']) {
      try {
        pattern = JSON.parse(decodeURIComponent(this.sessionCookies['pattern_id']));
      } catch {}
    }

    const chkMatch = initialHtml.match(/id="(chk_[^"]+)"/i);
    const checkboxId = chkMatch ? chkMatch[1] : 'chk_default';

    this.logger.log(
      `Simulating realistic human interaction time (3.2s) for checkbox ${checkboxId}...`,
    );
    await new Promise((r) => setTimeout(r, 3200));

    const verifyUrl = `${this.baseUrl}/engine/mods/ajax_age_verifite.php`;
    const { httpAgent, httpsAgent } = createHttpAgents(proxyUrl);

    const config: AxiosRequestConfig = {
      headers: {
        'User-Agent': HTTP_CONSTANTS.DEFAULT_USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Connection: 'close',
        Referer: this.baseUrl,
        Origin: this.baseUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        Cookie: this.getCookieString(),
      },
      timeout: 25000,
      httpAgent,
      httpsAgent,
    };

    try {
      const res = await axios.post(
        verifyUrl,
        {
          action: 'verify',
          captchaType: 'pattern',
          touchEvents: 42,
          scrollEvents: 4,
          timeSpent: 3.2,
          clickDelay: 2.1,
          checkboxId,
          isChecked: true,
          pattern,
        },
        config,
      );

      this.updateCookies(res.headers['set-cookie']);

      if (res.data?.success) {
        this.sessionAuthenticatedAt = Date.now();
        this.logger.log('✅ Age verification successfully passed! Session cookie saved.');
        return true;
      } else {
        this.logger.warn(
          `Age verification challenge rejected: ${res.data?.error || 'Unknown error'}`,
        );
        return false;
      }
    } catch (e: any) {
      this.logger.error(`Failed to submit age verification: ${e.message}`);
      return false;
    }
  }

  public async fetchHtml(url: string, referer?: string, attempt: number = 1): Promise<string> {
    const maxRetries = SCRAPER_CONSTANTS.MAX_RETRIES;
    await this.randomDelay();

    const proxyUrl = await this.settingsService.getRotatingProxy();
    const { httpAgent, httpsAgent } = createHttpAgents(proxyUrl);

    const config: AxiosRequestConfig = {
      headers: this.getBrowserHeaders(referer),
      timeout: HTTP_CONSTANTS.DEFAULT_TIMEOUT_MS,
      httpAgent,
      httpsAgent,
    };

    try {
      const response = await axios.get(url, config);
      this.updateCookies(response.headers['set-cookie']);

      const html = response.data;

      if (
        typeof html === 'string' &&
        (html.includes('Подтвердите возраст') ||
          html.includes('ajax_age_verifite.php') ||
          html.includes('ageDisclaimer'))
      ) {
        const bypassed = await this.bypassAgeVerification(html, proxyUrl);
        if (bypassed) {
          config.headers = this.getBrowserHeaders(referer);
          const authedResponse = await axios.get(url, config);
          this.updateCookies(authedResponse.headers['set-cookie']);
          return authedResponse.data;
        }
      }

      return html;
    } catch (error: any) {
      const isRecoverable =
        error.code === 'ECONNABORTED' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'EAI_AGAIN' ||
        (error.message &&
          (error.message.includes('socket hang up') ||
            error.message.includes('aborted') ||
            error.message.includes('timeout')));

      if (isRecoverable && attempt < maxRetries) {
        const retryDelayMs = attempt * 3000;
        this.logger.warn(
          `[Scraper] Fetch failed for ${url} (Attempt ${attempt}/${maxRetries}: ${error.message}). Retrying in ${retryDelayMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
        return this.fetchHtml(url, referer, attempt + 1);
      }

      this.logger.error(
        `Failed to fetch HTML from ${url} (Final attempt ${attempt}/${maxRetries}): ${error.message}`,
      );
      throw error;
    }
  }

  public async scrapeCatalogPage(page: number = 1): Promise<CatalogPageScrapeResult> {
    const targetUrl =
      page === 1
        ? `${this.baseUrl}/hentai/qqfilter/sort=date/order=desc/`
        : `${this.baseUrl}/hentai/qqfilter/sort=date/order=desc/page/${page}/`;

    this.logger.log(`Scraping catalog page ${page}: ${targetUrl}`);

    const html = await this.fetchHtml(targetUrl);
    const $ = cheerio.load(html);
    const animeUrls: string[] = [];

    $('a[href*="/hentai/"], a[href*="/amateur/"]').each((_, el) => {
      let href = $(el).attr('href');
      if (href) {
        if (!href.startsWith('http')) {
          href = new URL(href, this.baseUrl).toString();
        }
        if (/\/(?:hentai|amateur)\/\d+-[^"]+\.html/i.test(href) && !animeUrls.includes(href)) {
          animeUrls.push(href);
        }
      }
    });

    if (animeUrls.length === 0) {
      const matches = Array.from(
        html.matchAll(
          /href="(https:\/\/v4\.hentai-hub\.net\/(?:hentai|amateur)\/\d+-[^"]+\.html)"/gi,
        ),
      );
      for (const m of matches) {
        if (!animeUrls.includes(m[1])) {
          animeUrls.push(m[1]);
        }
      }
    }

    this.logger.log(`Catalog page ${page} discovered ${animeUrls.length} anime entries`);
    const hasNextPage = animeUrls.length > 0 && page < 100;

    return { animeUrls, hasNextPage };
  }

  public async scrapeAnimeDetails(animeUrl: string): Promise<ScrapedAnime> {
    this.logger.log(`Scraping anime details: ${animeUrl}`);
    const html = await this.fetchHtml(animeUrl);
    const $ = cheerio.load(html);

    const h1Title =
      $('h1').first().text().trim() ||
      $('title').first().text().replace(' - v4.hentai-hub.net', '').trim();
    let russianTitle = h1Title;
    let englishTitle = '';
    let originalTitle = '';

    $('.official-title, .anime-titles .info-item').each((_, el) => {
      const header = $(el).find('.info-item-header').text().trim();
      const text = $(el).clone().children().remove().end().text().trim();
      if (header.includes('Официальное') || header.includes('Official')) {
        originalTitle = text || $(el).text().replace(header, '').trim();
      } else if (header.includes('Русское') || header.includes('Russian')) {
        russianTitle = text || $(el).text().replace(header, '').trim();
      } else if (header.includes('Английское') || header.includes('English')) {
        englishTitle = text || $(el).text().replace(header, '').trim();
      }
    });

    if (!englishTitle) {
      if (h1Title.includes('/')) {
        const parts = h1Title.split('/');
        russianTitle = parts[0].trim().replace(/^Смотреть\s+/i, '');
        englishTitle = parts[1]?.trim() || russianTitle;
      } else {
        russianTitle = h1Title.replace(/^Смотреть\s+/i, '').replace(/\s+бесплатно.*$/i, '');
        englishTitle =
          $('.orig-title, .en-title, .subtitle, .alternative-title').first().text().trim() ||
          russianTitle;
      }
    }

    const description = $(
      '.description, .story, .entry-content, .anime-description, .full-story, [itemprop="description"]',
    )
      .first()
      .text()
      .trim();

    const tags: string[] = [];
    const genres: string[] = [];

    $(
      'a[href*="/hentai_tags/"], a[data-hentai_tags], .tag_selector a, .genres_descript a, .hentai_sorted_block a, .tags a, .genres a',
    ).each((_, el) => {
      let val = $(el)
        .text()
        .trim()
        .replace(/\u00a0/g, ' ');
      const dataTag = $(el).attr('data-hentai_tags');
      if (dataTag) {
        try {
          const parsed = JSON.parse(dataTag);
          if (Array.isArray(parsed) && parsed[0]) {
            val = String(parsed[0]).replace(/\u00a0/g, ' ');
          }
        } catch {}
      }

      if (
        val &&
        !val.startsWith('+') &&
        val.toLowerCase() !== 'добавить тег' &&
        !tags.includes(val)
      ) {
        tags.push(val);
      }
    });

    $('.info-item').each((_, el) => {
      const header = $(el).find('.info-item-header').text().trim();
      if (header.includes('Студия')) {
        const studio =
          $(el).find('a').first().text().trim() ||
          $(el).clone().children().remove().end().text().trim();
        if (studio && !genres.includes(studio)) genres.push(`Студия: ${studio}`);
      }
      if (header.includes('Год')) {
        const year =
          $(el).find('a').first().text().trim() ||
          $(el).clone().children().remove().end().text().trim();
        if (year && !genres.includes(year)) genres.push(`Год: ${year}`);
      }
    });

    const coverUrls: string[] = [];
    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content');
    if (ogImage && !isJunkCoverImage(ogImage)) {
      const fullOg = ogImage.startsWith('http')
        ? ogImage
        : new URL(ogImage, this.baseUrl).toString();
      coverUrls.push(fullOg);
    }

    const clean$ = cheerio.load(html);
    clean$(
      '#dle-comments, .comments, .comment, #comments, .comments-tree, .user-decorations, .avatar-frame, .user-avatar, .sidebar, footer, header, .nav, .menu, .login-block, [class*="comment"], [class*="avatar"], [class*="frame"], [class*="decor"], [class*="sticker"]',
    ).remove();

    clean$(
      '.poster img, .mov-desc .poster img, .anime-poster img, .cover img, [itemprop="image"], .full-story img, .full-text img, a[href*="/uploads/images/posts/"] img',
    ).each((_, el) => {
      let src =
        clean$(el).attr('src') ||
        clean$(el).attr('data-src') ||
        clean$(el).attr('srcset') ||
        clean$(el).parent('a').attr('href');
      if (src) {
        if (src.includes(',')) src = src.split(',')[0].trim().split(' ')[0];
        if (!src.startsWith('http')) src = new URL(src, this.baseUrl).toString();

        if (
          !isJunkCoverImage(src) &&
          !coverUrls.includes(src) &&
          /\.(webp|jpg|jpeg|png)$/i.test(src.split('?')[0])
        ) {
          coverUrls.push(src);
        }
      }
    });

    const episodes: ScrapedEpisode[] = [];
    const episodeElements = $(
      '.episodes-list a, .series-item a, .ep-item, a[href*="episode"], a[href*="seriya"]',
    );

    if (episodeElements.length > 0) {
      episodeElements.each((idx, el) => {
        let epHref = $(el).attr('href');
        if (epHref) {
          if (!epHref.startsWith('http')) epHref = new URL(epHref, this.baseUrl).toString();
          const epText = $(el).text().trim();
          const numMatch = epText.match(/\d+/) || epHref.match(/(?:episode|seriya|ep)[^\d]*(\d+)/i);
          const episodeNumber = numMatch ? parseInt(numMatch[1], 10) : idx + 1;

          if (!episodes.some((e) => e.episodeNumber === episodeNumber)) {
            episodes.push({
              episodeNumber,
              title: epText || `Серия ${episodeNumber}`,
              sourceEpisodeUrl: epHref,
            });
          }
        }
      });
    } else {
      episodes.push({
        episodeNumber: 1,
        title: russianTitle,
        sourceEpisodeUrl: animeUrl,
      });
    }

    episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

    return {
      russianTitle,
      englishTitle: englishTitle || russianTitle,
      originalTitle,
      description,
      tags,
      genres,
      sourceUrl: animeUrl,
      coverUrls,
      episodes,
    };
  }

  public async scrapeEpisodeStreams(episodeUrl: string): Promise<ScrapedEpisodeStream[]> {
    this.logger.log(`Scraping episode video streams: ${episodeUrl}`);
    const html = await this.fetchHtml(episodeUrl);
    const dubQualities: ScrapedVideoQuality[] = [];
    const subQualities: ScrapedVideoQuality[] = [];

    // 1. Extract from all JSON & JS configs in script blocks
    this.extractStreamsFromHtmlScripts(html, dubQualities, subQualities);

    // 2. Extract from embedded iframe players
    await this.extractStreamsFromIframes(html, episodeUrl, dubQualities, subQualities);

    // 3. Extract direct mp4 links from HTML attributes & text
    this.extractDirectMp4FromHtml(html, dubQualities, subQualities);

    // 4. Extract from HTML5 video & source tags & data-attributes
    const $ = cheerio.load(html);
    $(
      'video source, source, video, [data-src], [data-file], [data-video], [data-url], [data-player]',
    ).each((_, el) => {
      const src =
        $(el).attr('src') ||
        $(el).attr('data-src') ||
        $(el).attr('data-file') ||
        $(el).attr('data-video') ||
        $(el).attr('data-url') ||
        $(el).attr('data-player');
      const res =
        $(el).attr('res') || $(el).attr('size') || $(el).attr('title') || $(el).attr('label') || '';
      if (
        src &&
        !src.includes('gifpacks') &&
        !src.includes('preview') &&
        !src.includes('trailer')
      ) {
        let fullSrc = src;
        if (fullSrc.startsWith('//')) fullSrc = 'https:' + fullSrc;
        else if (fullSrc.startsWith('/')) fullSrc = new URL(fullSrc, this.baseUrl).toString();

        if (fullSrc.startsWith('http')) {
          const quality = res ? normalizeVideoQuality(res) : detectVideoQualityFromUrl(fullSrc);
          const lower = (fullSrc + ' ' + res).toLowerCase();
          if (lower.includes('sub') || lower.includes('суб') || lower.includes('саб')) {
            subQualities.push({ quality, url: fullSrc });
          } else {
            dubQualities.push({ quality, url: fullSrc });
          }
        }
      }
    });

    // Label studios if multiple studios exist
    this.labelDistinctStudios(dubQualities);
    this.labelDistinctStudios(subQualities);

    let streams: ScrapedEpisodeStream[] = [];
    const dedupDub = deduplicateVideoQualities(dubQualities);
    const dedupSub = deduplicateVideoQualities(subQualities);

    if (dedupDub.length > 0) {
      streams.push({ type: 'DUB', qualities: dedupDub });
    }
    if (dedupSub.length > 0) {
      streams.push({ type: 'SUB', qualities: dedupSub });
    }

    // 5. Intelligent CDN Quality & Voice Probing
    const proxyUrl = await this.settingsService.getRotatingProxy();
    streams = await this.expandAndProbeStreams(streams, proxyUrl);

    this.logger.log(
      `Extracted all stream variants: DUB (${streams.find((s) => s.type === 'DUB')?.qualities.length || 0} qualities), SUB (${streams.find((s) => s.type === 'SUB')?.qualities.length || 0} qualities)`,
    );
    return streams;
  }

  public async probeUrl(url: string, proxyUrl?: string | null): Promise<boolean> {
    try {
      const agent = createProxyAgent(proxyUrl, url.startsWith('https'));

      const res = await axios.get(url, {
        headers: {
          'User-Agent': HTTP_CONSTANTS.DEFAULT_USER_AGENT,
          Referer: `${this.baseUrl}/`,
          Range: 'bytes=0-1024',
        },
        timeout: HTTP_CONSTANTS.PROBE_TIMEOUT_MS,
        httpAgent: agent,
        httpsAgent: agent,
        validateStatus: (s) => (s >= 200 && s < 300) || s === 206,
      });

      const contentType = String(res.headers['content-type'] || '');
      return res.status === 200 || res.status === 206 || contentType.includes('video');
    } catch {
      return false;
    }
  }

  private labelDistinctStudios(list: ScrapedVideoQuality[]): void {
    const studios = new Set(list.map((q) => q.studio).filter(Boolean));
    if (studios.size > 1) {
      let unnamedIndex = 1;
      for (const q of list) {
        const rawQ = q.rawQuality || normalizeVideoQuality(q.quality);
        const studioName = q.studio || `Озвучка ${unnamedIndex++}`;
        if (!q.quality.includes('[')) {
          q.quality = `${rawQ} [${studioName}]`;
        }
      }
    } else {
      for (const q of list) {
        if (!q.quality.includes('[')) {
          q.quality = q.rawQuality || normalizeVideoQuality(q.quality);
        }
      }
    }
  }

  private extractCleanStudioName(context: string): string | undefined {
    if (!context) return undefined;
    const cleaned = context
      .replace(
        /voice|dub|sub|playlist|folder|sources|qualities|playerparams|plyrjson|items|levels|video_config/gi,
        '',
      )
      .replace(/^(?:озвучка|перевод|дубляж|голос|от|by)\s*/i, '')
      .replace(/[\[\]\(\)\{\}:"']/g, '')
      .trim();
    if (cleaned.length >= 2 && !/^\d+p?$/i.test(cleaned)) {
      return cleaned;
    }
    return undefined;
  }

  private extractStreamsFromHtmlScripts(
    html: string,
    dubQualities: ScrapedVideoQuality[],
    subQualities: ScrapedVideoQuality[],
  ): void {
    const jsonPatterns = [
      /window\.plyrJson\s*=\s*(\{[\s\S]*?\})\s*;/gi,
      /plyrJson\s*=\s*(\{[\s\S]*?\})/gi,
      /window\.playerParams\s*=\s*(\{[\s\S]*?\})\s*;/gi,
      /var\s+playerParams\s*=\s*(\{[\s\S]*?\})\s*;/gi,
      /window\.playlist\s*=\s*(\[[\s\S]*?\])\s*;/gi,
      /playlist\s*:\s*(\[[\s\S]*?\])/gi,
      /sources\s*:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/gi,
      /file\s*:\s*["'](\[[\s\S]*?\]|https?:\/\/[^"']+)["']/gi,
      /video_config\s*=\s*(\{[\s\S]*?\})\s*;/gi,
      /data-sources=['"](\{[\s\S]*?\}|\[[\s\S]*?\])['"]/gi,
    ];

    for (const pattern of jsonPatterns) {
      const matches = Array.from(html.matchAll(pattern));
      for (const match of matches) {
        if (match && match[1]) {
          try {
            const raw = match[1].trim();
            if (raw.startsWith('{') || raw.startsWith('[')) {
              const parsed = JSON.parse(raw);
              this.traverseAndCollectStreams(parsed, dubQualities, subQualities);
            } else if (raw.includes('[') && raw.includes('http')) {
              this.parsePlayerJsString(raw, dubQualities, subQualities);
            }
          } catch {}
        }
      }
    }

    const playerJsMatches = html.matchAll(/Playerjs\s*\(\s*(\{[\s\S]*?\})\s*\)/gi);
    for (const pMatch of playerJsMatches) {
      try {
        const parsed = JSON.parse(pMatch[1]);
        this.traverseAndCollectStreams(parsed, dubQualities, subQualities);
      } catch {}
    }
  }

  private traverseAndCollectStreams(
    obj: any,
    dubQualities: ScrapedVideoQuality[],
    subQualities: ScrapedVideoQuality[],
    parentKey: string = '',
    currentStudio?: string,
  ): void {
    if (!obj) return;
    const studio = currentStudio || this.extractCleanStudioName(parentKey);

    if (typeof obj === 'string') {
      if (
        obj.includes('http') &&
        (obj.includes('.mp4') || obj.includes('.m3u8') || obj.includes('playlist'))
      ) {
        if (obj.includes('[') && obj.includes(']')) {
          this.parsePlayerJsString(obj, dubQualities, subQualities, parentKey, studio);
        } else {
          const quality = detectVideoQualityFromUrl(obj);
          const isSub =
            (parentKey + ' ' + obj).toLowerCase().includes('sub') ||
            (parentKey + ' ' + obj).toLowerCase().includes('саб');
          if (isSub) {
            subQualities.push({ quality, url: obj, studio, rawQuality: quality });
          } else {
            dubQualities.push({ quality, url: obj, studio, rawQuality: quality });
          }
        }
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'string') {
          this.traverseAndCollectStreams(item, dubQualities, subQualities, parentKey, studio);
        } else if (typeof item === 'object' && item !== null) {
          const itemStudio = item.title || item.name || item.label || studio;
          const url =
            item.source ||
            item.file ||
            item.url ||
            item.src ||
            item.link ||
            item.stream ||
            item.video ||
            item.video_url;
          const qual =
            item.quality ||
            item.res ||
            item.height ||
            (item.title && /^\d+p?$/i.test(item.title) ? item.title : '');
          if (typeof url === 'string') {
            if (url.includes('[') && url.includes(']')) {
              this.parsePlayerJsString(
                url,
                dubQualities,
                subQualities,
                parentKey + ' ' + (item.title || ''),
                this.extractCleanStudioName(String(itemStudio)) || studio,
              );
            } else if (url.startsWith('http') || url.startsWith('//')) {
              const fullUrl = url.startsWith('//') ? 'https:' + url : url;
              const quality = qual
                ? normalizeVideoQuality(String(qual))
                : detectVideoQualityFromUrl(fullUrl);

              const isSub =
                (parentKey + ' ' + (item.title || '') + ' ' + fullUrl)
                  .toLowerCase()
                  .includes('sub') ||
                (parentKey + ' ' + (item.title || '') + ' ' + fullUrl)
                  .toLowerCase()
                  .includes('саб');

              const finalStudio = this.extractCleanStudioName(String(itemStudio)) || studio;

              if (isSub) {
                subQualities.push({
                  quality,
                  url: fullUrl,
                  studio: finalStudio,
                  rawQuality: quality,
                });
              } else {
                dubQualities.push({
                  quality,
                  url: fullUrl,
                  studio: finalStudio,
                  rawQuality: quality,
                });
              }
            }
          }
          this.traverseAndCollectStreams(
            item.folder ||
              item.playlist ||
              item.sources ||
              item.qualities ||
              item.items ||
              item.levels,
            dubQualities,
            subQualities,
            parentKey + ' ' + (item.title || ''),
            this.extractCleanStudioName(String(itemStudio)) || studio,
          );
        }
      }
      return;
    }

    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        const nextParent = `${parentKey} ${lowerKey}`;
        const keyStudio = this.extractCleanStudioName(key) || studio;
        this.traverseAndCollectStreams(value, dubQualities, subQualities, nextParent, keyStudio);
      }
    }
  }

  private parsePlayerJsString(
    str: string,
    dubQualities: ScrapedVideoQuality[],
    subQualities: ScrapedVideoQuality[],
    context: string = '',
    studio?: string,
  ): void {
    const parts = str.split(',').map((p) => p.trim());
    for (const part of parts) {
      const match = part.match(/\[([0-9]+p?)\](.*)/i) || part.match(/\{([0-9]+p?)\}(.*)/i);
      let quality = '720p';
      let url = part;
      if (match) {
        quality = normalizeVideoQuality(match[1]);
        url = match[2].trim();
      } else {
        quality = detectVideoQualityFromUrl(url);
      }

      if (url.startsWith('//')) {
        url = 'https:' + url;
      }

      if (url.startsWith('http')) {
        const isSub =
          (context + ' ' + url).toLowerCase().includes('sub') ||
          (context + ' ' + url).toLowerCase().includes('саб');
        if (isSub) {
          subQualities.push({ quality, url, studio, rawQuality: quality });
        } else {
          dubQualities.push({ quality, url, studio, rawQuality: quality });
        }
      }
    }
  }

  private async extractStreamsFromIframes(
    html: string,
    baseUrl: string,
    dubQualities: ScrapedVideoQuality[],
    subQualities: ScrapedVideoQuality[],
  ): Promise<void> {
    const $ = cheerio.load(html);
    const iframeUrls: string[] = [];

    $('iframe[src]').each((_, el) => {
      let src = $(el).attr('src');
      if (src) {
        if (src.startsWith('//')) src = 'https:' + src;
        else if (src.startsWith('/')) src = new URL(src, baseUrl).toString();
        if (src.startsWith('http') && !iframeUrls.includes(src)) {
          iframeUrls.push(src);
        }
      }
    });

    for (const iframeUrl of iframeUrls.slice(0, 3)) {
      try {
        this.logger.log(`Fetching embedded player iframe: ${iframeUrl}`);
        const iframeHtml = await this.fetchHtml(iframeUrl, baseUrl);
        this.extractStreamsFromHtmlScripts(iframeHtml, dubQualities, subQualities);
        this.extractDirectMp4FromHtml(iframeHtml, dubQualities, subQualities);
      } catch (e: any) {
        this.logger.debug(`Could not inspect iframe ${iframeUrl}: ${e.message}`);
      }
    }
  }

  private extractDirectMp4FromHtml(
    html: string,
    dubQualities: ScrapedVideoQuality[],
    subQualities: ScrapedVideoQuality[],
  ): void {
    const mp4Matches = Array.from(
      html.matchAll(/(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/gi),
    ).map((m) => m[1]);

    for (const url of mp4Matches) {
      if (url.includes('gifpacks') || url.includes('preview') || url.includes('trailer')) continue;

      const quality = detectVideoQualityFromUrl(url);
      const lower = url.toLowerCase();
      if (lower.includes('sub') || lower.includes('саб')) {
        if (!subQualities.some((sq) => sq.url === url)) {
          subQualities.push({ quality, url, rawQuality: quality });
        }
      } else {
        if (!dubQualities.some((dq) => dq.url === url)) {
          dubQualities.push({ quality, url, rawQuality: quality });
        }
      }
    }
  }

  private async expandAndProbeStreams(
    streams: ScrapedEpisodeStream[],
    proxyUrl?: string | null,
  ): Promise<ScrapedEpisodeStream[]> {
    const targetQualities = SCRAPER_CONSTANTS.TARGET_QUALITIES;
    const resultStreams: ScrapedEpisodeStream[] = [];

    const dubGroup = streams.find((s) => s.type === 'DUB') || {
      type: 'DUB' as const,
      qualities: [],
    };

    const subGroup = streams.find((s) => s.type === 'SUB') || {
      type: 'SUB' as const,
      qualities: [],
    };

    const allExistingUrls = [...dubGroup.qualities, ...subGroup.qualities].map((q) => q.url);
    const probeCandidates: { type: 'DUB' | 'SUB'; quality: string; url: string }[] = [];

    const generateQualityCandidates = (baseQuality: ScrapedVideoQuality, type: 'DUB' | 'SUB') => {
      const base = baseQuality.url;
      const baseRaw = baseQuality.rawQuality || detectVideoQualityFromUrl(base);
      for (const targetQ of targetQualities) {
        if (targetQ === baseRaw) continue;
        const qNum = targetQ.replace('p', '');
        const baseNum = baseRaw.replace('p', '');

        const candidates = [
          base.replace(new RegExp(`${baseRaw}`, 'gi'), targetQ),
          base.replace(new RegExp(`_${baseNum}`, 'gi'), `_${qNum}`),
          base.replace(new RegExp(`-${baseNum}`, 'gi'), `-${qNum}`),
          base.replace(new RegExp(`/${baseNum}\\.`, 'gi'), `/${qNum}.`),
          base.replace(new RegExp(`/${baseRaw}\\.`, 'gi'), `/${targetQ}.`),
          base.replace(new RegExp(`/${baseNum}/`, 'gi'), `/${qNum}/`),
        ];

        for (const cand of candidates) {
          if (
            cand !== base &&
            !allExistingUrls.includes(cand) &&
            !probeCandidates.some((c) => c.url === cand)
          ) {
            const finalQuality = baseQuality.studio
              ? `${targetQ} [${baseQuality.studio}]`
              : targetQ;
            probeCandidates.push({ type, quality: finalQuality, url: cand });
          }
        }
      }
    };

    // 1. Generate quality candidates for DUB
    for (const q of [...dubGroup.qualities]) {
      generateQualityCandidates(q, 'DUB');
    }

    // 2. Generate quality candidates for SUB
    for (const q of [...subGroup.qualities]) {
      generateQualityCandidates(q, 'SUB');
    }

    // 3. Generate cross-audio candidates
    if (dubGroup.qualities.length > 0 && subGroup.qualities.length === 0) {
      for (const q of dubGroup.qualities) {
        const base = q.url;
        const subCandidates = [
          base.replace(/dub/gi, 'sub'),
          base.replace(/_rus/gi, '_sub'),
          base.replace(/-rus/gi, '-sub'),
          base.replace(/\.mp4/i, '_sub.mp4'),
          base.replace(/\.mp4/i, '-sub.mp4'),
        ];
        for (const cand of subCandidates) {
          if (cand !== base && !probeCandidates.some((c) => c.url === cand)) {
            probeCandidates.push({ type: 'SUB', quality: q.quality, url: cand });
          }
        }
      }
    } else if (subGroup.qualities.length > 0 && dubGroup.qualities.length === 0) {
      for (const q of subGroup.qualities) {
        const base = q.url;
        const dubCandidates = [
          base.replace(/sub/gi, 'dub'),
          base.replace(/_sub/gi, '_dub'),
          base.replace(/-sub/gi, '-dub'),
        ];
        for (const cand of dubCandidates) {
          if (cand !== base && !probeCandidates.some((c) => c.url === cand)) {
            probeCandidates.push({ type: 'DUB', quality: q.quality, url: cand });
          }
        }
      }
    }

    // Probe candidates concurrently in chunks
    if (probeCandidates.length > 0) {
      this.logger.log(
        `Probing ${probeCandidates.length} candidate stream qualities & audio tracks on CDN...`,
      );
      const chunkSize = 6;
      for (let i = 0; i < probeCandidates.length; i += chunkSize) {
        const chunk = probeCandidates.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (cand) => {
            const exists = await this.probeUrl(cand.url, proxyUrl);
            if (exists) {
              this.logger.log(
                `Found verified stream on CDN: [${cand.type} ${cand.quality}] ${cand.url}`,
              );
              if (cand.type === 'DUB') {
                dubGroup.qualities.push({ quality: cand.quality, url: cand.url });
              } else {
                subGroup.qualities.push({ quality: cand.quality, url: cand.url });
              }
            }
          }),
        );
      }
    }

    if (dubGroup.qualities.length > 0) {
      resultStreams.push({
        type: 'DUB',
        qualities: deduplicateVideoQualities(dubGroup.qualities),
      });
    }

    if (subGroup.qualities.length > 0) {
      resultStreams.push({
        type: 'SUB',
        qualities: deduplicateVideoQualities(subGroup.qualities),
      });
    }

    return resultStreams;
  }

  private getBrowserHeaders(referer?: string): Record<string, string> {
    const cookieString = this.getCookieString();
    return {
      ...HTTP_CONSTANTS.DEFAULT_BROWSER_HEADERS,
      Referer: referer || `${this.baseUrl}/`,
      ...(cookieString ? { Cookie: cookieString } : {}),
    };
  }

  private getCookieString(): string {
    return Object.entries(this.sessionCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private updateCookies(setCookieHeader?: string | string[]): void {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of headers) {
      if (!raw) continue;
      const [pair] = raw.split(';');
      const [k, v] = pair.split('=');

      if (k) {
        if (v === 'deleted') {
          delete this.sessionCookies[k.trim()];
        } else {
          this.sessionCookies[k.trim()] = v ? v.trim() : '';
        }
      }
    }
  }
}
