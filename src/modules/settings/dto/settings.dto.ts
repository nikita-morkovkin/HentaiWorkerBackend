import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateGoogleSettingsDto {
  @ApiProperty({ description: 'Google Cloud Client ID' })
  @IsString()
  @IsNotEmpty()
  public clientId: string;

  @ApiProperty({ description: 'Google Cloud Client Secret' })
  @IsString()
  @IsNotEmpty()
  public clientSecret: string;

  @ApiPropertyOptional({ description: 'Google OAuth Redirect URI' })
  @IsString()
  @IsOptional()
  public redirectUri?: string;

  @ApiPropertyOptional({ description: 'Refresh Token' })
  @IsString()
  @IsOptional()
  public refreshToken?: string;
}

export class AddDriveAccountDto {
  @ApiProperty({ description: 'Account Name or Label' })
  @IsString()
  @IsNotEmpty()
  public name: string;

  @ApiPropertyOptional({ description: 'Account Email' })
  @IsString()
  @IsOptional()
  public email?: string;

  @ApiProperty({ description: 'Google Client ID' })
  @IsString()
  @IsNotEmpty()
  public clientId: string;

  @ApiProperty({ description: 'Google Client Secret' })
  @IsString()
  @IsNotEmpty()
  public clientSecret: string;

  @ApiProperty({ description: 'OAuth Refresh Token' })
  @IsString()
  @IsNotEmpty()
  public refreshToken: string;

  @ApiPropertyOptional({
    description: 'Total storage in bytes (default 5TB)',
    default: 5497558138880,
  })
  @IsOptional()
  public totalStorageBytes?: string | number;
}

export class UpdateTelegramSettingsDto {
  @ApiPropertyOptional({ description: 'Telegram Bot Token (BotFather)' })
  @IsString()
  @IsOptional()
  public botToken?: string;

  @ApiPropertyOptional({ description: 'Telegram App ID (my.telegram.org)' })
  @IsString()
  @IsOptional()
  public appId?: string;

  @ApiPropertyOptional({ description: 'Telegram App Hash' })
  @IsString()
  @IsOptional()
  public appHash?: string;

  @ApiPropertyOptional({ description: 'Public Funnel Channel ID' })
  @IsString()
  @IsOptional()
  public publicChannelId?: string;

  @ApiPropertyOptional({ description: 'VIP Paid Channel ID' })
  @IsString()
  @IsOptional()
  public vipChannelId?: string;

  @ApiPropertyOptional({ description: 'Admin Chat ID for notifications and alerts' })
  @IsString()
  @IsOptional()
  public adminChatId?: string;

  @ApiPropertyOptional({ description: 'GramJS MTProto Session String' })
  @IsString()
  @IsOptional()
  public sessionString?: string;
}

export class TelegramLoginStartDto {
  @ApiProperty({ description: 'Phone number in international format (+1234567890)' })
  @IsString()
  @IsNotEmpty()
  public phoneNumber: string;
}

export class TelegramLoginSubmitCodeDto {
  @ApiProperty({ description: 'Phone number' })
  @IsString()
  @IsNotEmpty()
  public phoneNumber: string;

  @ApiProperty({ description: 'Phone Code Hash returned from start step' })
  @IsString()
  @IsNotEmpty()
  public phoneCodeHash: string;

  @ApiProperty({ description: 'Code received via Telegram SMS or app' })
  @IsString()
  @IsNotEmpty()
  public phoneCode: string;

  @ApiPropertyOptional({ description: '2FA password if enabled' })
  @IsString()
  @IsOptional()
  public password?: string;
}

export class CreateProxyDto {
  @ApiProperty({
    description: 'Proxy URL (e.g. http://user:pass@1.2.3.4:8080 or socks5://1.2.3.4:1080)',
  })
  @IsString()
  @IsNotEmpty()
  public url: string;

  @ApiPropertyOptional({ description: 'Protocol: http, https, socks5' })
  @IsString()
  @IsOptional()
  public protocol?: string;
}

export class UpdateScraperSettingsDto {
  @ApiPropertyOptional({ description: 'Min delay between series in ms (default 2000)' })
  @IsNumber()
  @IsOptional()
  public minDelayMs?: number;

  @ApiPropertyOptional({ description: 'Max delay between series in ms (default 5000)' })
  @IsNumber()
  @IsOptional()
  public maxDelayMs?: number;

  @ApiPropertyOptional({ description: 'Concurrency limit for streaming' })
  @IsNumber()
  @IsOptional()
  public concurrency?: number;

  @ApiPropertyOptional({ description: 'Auto-sync new titles interval' })
  @IsBoolean()
  @IsOptional()
  public autoSync?: boolean;
}
