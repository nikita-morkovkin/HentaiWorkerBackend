import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class StartCrawlDto {
  @ApiPropertyOptional({ default: 1, description: 'Starting catalog page' })
  @IsOptional()
  @IsNumber()
  public startPage?: number = 1;

  @ApiPropertyOptional({ default: 10, description: 'Number of pages to crawl' })
  @IsOptional()
  @IsNumber()
  public maxPages?: number = 10;
}

export class ScrapeUrlDto {
  @ApiProperty({ description: 'URL of the anime on v4.hentai-hub.net' })
  @IsString()
  @IsNotEmpty()
  public animeUrl: string;
}
