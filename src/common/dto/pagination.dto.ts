import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number = 1;

  @ApiPropertyOptional({ default: 24, description: 'Items per page (24 or 48)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number = 24;

  @ApiPropertyOptional({ description: 'Search term for title, description or tags' })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({ description: 'Filter by status: PENDING, SCRAPING, COMPLETED, ERROR' })
  @IsOptional()
  @IsString()
  public status?: string;

  @ApiPropertyOptional({ description: 'Filter by genre or tag' })
  @IsOptional()
  @IsString()
  public tag?: string;
}

export class PaginatedResponseDto<T> {
  public items: T[];
  public total: number;
  public page: number;
  public limit: number;
  public totalPages: number;
}
