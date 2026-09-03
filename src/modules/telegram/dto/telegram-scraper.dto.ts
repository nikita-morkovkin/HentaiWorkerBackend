import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ScrapeTelegramChannelDto {
  @ApiProperty({
    description: 'Telegram channel username (e.g. @hentai_channel or hentai_channel) or invite link',
    example: '@hentai_channel',
  })
  @IsString()
  @IsNotEmpty()
  channel: string;

  @ApiPropertyOptional({
    description: 'Max number of messages to scan',
    default: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Offset message ID to start scanning from',
  })
  @IsOptional()
  @IsNumber()
  offsetId?: number;
}

export class ScrapeTelegramPostDto {
  @ApiProperty({
    description: 'Telegram channel username or ID',
    example: '@hentai_channel',
  })
  @IsString()
  @IsNotEmpty()
  channel: string;

  @ApiProperty({
    description: 'Telegram message ID of the post to scrape',
    example: 1234,
  })
  @IsNumber()
  @IsNotEmpty()
  messageId: number;
}
