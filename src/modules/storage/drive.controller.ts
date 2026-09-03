import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DrivePoolService } from './drive-pool.service';
import { DriveRouterService } from './drive-router.service';
import { CreateDriveAccountDto, ExchangeAuthCodeDto, GenerateAuthUrlDto } from './dto/drive.dto';

@ApiTags('Google Drive Storage Pool')
@Controller('api/storage')
export class DriveController {
  constructor(
    private readonly poolService: DrivePoolService,
    private readonly driveRouter: DriveRouterService,
  ) {}

  @Get('accounts')
  @ApiOperation({
    summary:
      'List all Google Drive accounts in the pool with real-time storage & 750GB daily quotas',
  })
  public async listAccounts() {
    return this.poolService.listAccounts();
  }

  @Post('accounts')
  @ApiOperation({ summary: 'Add a new Google Drive account with refresh token' })
  public async addAccount(@Body() dto: CreateDriveAccountDto) {
    return this.poolService.createAccount(dto);
  }

  @Post('oauth/url')
  @ApiOperation({ summary: 'Generate Google OAuth2 authorization URL' })
  public generateAuthUrl(@Body() dto: GenerateAuthUrlDto) {
    const url = this.poolService.generateAuthUrl(dto);
    return { url };
  }

  @Post('oauth/exchange')
  @ApiOperation({ summary: 'Exchange OAuth authorization code for tokens and register account' })
  public async exchangeAuthCode(@Body() dto: ExchangeAuthCodeDto) {
    return this.poolService.exchangeAuthCode(dto);
  }

  @Post('accounts/:id/sync')
  @ApiOperation({ summary: 'Sync quota and usage for a specific Google Drive account' })
  public async syncAccount(@Param('id') id: string) {
    return this.poolService.syncAccountStats(id);
  }

  @Delete('accounts/:id')
  @ApiOperation({ summary: 'Delete a Google Drive account from the pool' })
  public async deleteAccount(@Param('id') id: string) {
    return this.poolService.deleteAccount(id);
  }

  @Post('purge')
  @ApiOperation({
    summary:
      'Purge all video files and folders from Google Drive master folder and reset DB storage',
  })
  public async purgeAllStorage(@Body() body: { accountId?: string }) {
    return this.driveRouter.purgeAllStorage(body?.accountId);
  }
}
