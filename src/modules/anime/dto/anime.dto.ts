import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateAnimeMetadataDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public russianTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public englishTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public originalTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  public tags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  public genres?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  public coverUrls?: string[];
}
