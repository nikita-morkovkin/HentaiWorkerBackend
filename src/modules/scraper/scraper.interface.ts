export interface ScrapedVideoQuality {
  quality: string;
  url: string;
  studio?: string;
  rawQuality?: string;
}

export interface ScrapedEpisodeStream {
  type: 'DUB' | 'SUB';
  qualities: ScrapedVideoQuality[];
}

export interface ScrapedEpisode {
  episodeNumber: number;
  title?: string;
  sourceEpisodeUrl: string;
  streams?: ScrapedEpisodeStream[];
}

export interface ScrapedAnime {
  russianTitle: string;
  englishTitle: string;
  originalTitle?: string;
  description?: string;
  tags: string[];
  genres: string[];
  sourceUrl: string;
  coverUrls: string[];
  episodes: ScrapedEpisode[];
}

export interface CatalogScrapeJobData {
  startPage?: number;
  maxPages?: number;
  catalogUrl?: string;
}

export interface AnimeScrapeJobData {
  animeUrl: string;
  animeId?: string;
}

export interface EpisodeScrapeJobData {
  animeId: string;
  episodeId: string;
  episodeUrl: string;
  episodeNumber: number;
}

export interface StreamDownloadJobData {
  animeId: string;
  episodeId: string;
  russianTitle: string;
  englishTitle: string;
  episodeNumber: number;
  type: 'DUB' | 'SUB';
  quality: string;
  sourceStreamUrl: string;
}

export interface CatalogPageScrapeResult {
  animeUrls: string[];
  hasNextPage: boolean;
}

export interface QueueJobSummary {
  id: string | undefined;
  name: string;
  data: any;
  progress?: any;
}

export interface QueueStatsResult {
  isPaused: boolean;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  activeJobs: QueueJobSummary[];
  waitingJobs: QueueJobSummary[];
}
