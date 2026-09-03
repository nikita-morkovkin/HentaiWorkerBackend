import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum TargetChannelEnum {
  PUBLIC = 'PUBLIC',
  VIP = 'VIP',
  BOTH = 'BOTH',
}

export enum AudioTypeEnum {
  DUB = 'DUB',
  SUB = 'SUB',
  BOTH = 'BOTH',
}

export class CreateTelegramPostDto {
  @ApiProperty({ description: 'Anime Title ID' })
  @IsString()
  @IsNotEmpty()
  public animeTitleId: string;

  @ApiPropertyOptional({ description: 'Specific Episode ID (if posting single episode)' })
  @IsString()
  @IsOptional()
  public episodeId?: string;

  @ApiProperty({ enum: TargetChannelEnum, default: TargetChannelEnum.PUBLIC })
  @IsEnum(TargetChannelEnum)
  public targetChannel: TargetChannelEnum;

  @ApiPropertyOptional({ description: 'Post caption / text' })
  @IsString()
  @IsOptional()
  public caption?: string;

  @ApiPropertyOptional({ enum: AudioTypeEnum, default: AudioTypeEnum.BOTH })
  @IsEnum(AudioTypeEnum)
  @IsOptional()
  public selectedAudio?: AudioTypeEnum = AudioTypeEnum.BOTH;

  @ApiPropertyOptional({ description: 'Selected video qualities to attach', default: ['720p'] })
  @IsOptional()
  public selectedQualities?: string[] = ['720p'];

  @ApiPropertyOptional({ description: 'Scheduled publication date (ISO String)' })
  @IsDateString()
  @IsOptional()
  public scheduledAt?: string;
}

export class SendDirectMessageDto {
  @ApiProperty({ description: 'Chat ID or Channel Username' })
  @IsString()
  @IsNotEmpty()
  public chatId: string;

  @ApiProperty({ description: 'Message text' })
  @IsString()
  @IsNotEmpty()
  public text: string;
}
