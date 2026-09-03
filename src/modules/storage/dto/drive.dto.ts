import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDriveAccountDto {
  @ApiProperty({ description: 'Friendly name for the Google Drive account' })
  @IsString()
  @IsNotEmpty()
  public name: string;

  @ApiPropertyOptional({ description: 'Account email address' })
  @IsString()
  @IsOptional()
  public email?: string;

  @ApiProperty({ description: 'Google Cloud OAuth Client ID' })
  @IsString()
  @IsNotEmpty()
  public clientId: string;

  @ApiProperty({ description: 'Google Cloud OAuth Client Secret' })
  @IsString()
  @IsNotEmpty()
  public clientSecret: string;

  @ApiProperty({ description: 'OAuth Refresh Token' })
  @IsString()
  @IsNotEmpty()
  public refreshToken: string;
}

export class GenerateAuthUrlDto {
  @ApiProperty({ description: 'Google Cloud Client ID' })
  @IsString()
  @IsNotEmpty()
  public clientId: string;

  @ApiProperty({ description: 'Google Cloud Client Secret' })
  @IsString()
  @IsNotEmpty()
  public clientSecret: string;

  @ApiProperty({ description: 'Redirect URI matching Google Cloud console' })
  @IsString()
  @IsNotEmpty()
  public redirectUri: string;
}

export class ExchangeAuthCodeDto {
  @ApiProperty({ description: 'Google Cloud Client ID' })
  @IsString()
  @IsNotEmpty()
  public clientId: string;

  @ApiProperty({ description: 'Google Cloud Client Secret' })
  @IsString()
  @IsNotEmpty()
  public clientSecret: string;

  @ApiProperty({ description: 'Redirect URI matching Google Cloud console' })
  @IsString()
  @IsNotEmpty()
  public redirectUri: string;

  @ApiProperty({ description: 'Authorization Code from Google OAuth consent screen' })
  @IsString()
  @IsNotEmpty()
  public code: string;

  @ApiPropertyOptional({ description: 'Friendly Account Name' })
  @IsString()
  @IsOptional()
  public name?: string;
}
