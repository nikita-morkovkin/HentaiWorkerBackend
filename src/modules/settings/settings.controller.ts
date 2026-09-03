import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import {
  CreateProxyDto,
  TelegramLoginStartDto,
  TelegramLoginSubmitCodeDto,
  UpdateScraperSettingsDto,
  UpdateTelegramSettingsDto,
} from './dto/settings.dto';

@ApiTags('Settings & Credentials')
@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get masked system settings (credentials are masked for safety)' })
  public async getMaskedSettings() {
    return this.settingsService.getAllMaskedSettings();
  }

  @Put('telegram')
  @ApiOperation({ summary: 'Update Telegram Bot and MTProto credentials' })
  public async updateTelegramSettings(@Body() dto: UpdateTelegramSettingsDto) {
    return this.settingsService.updateTelegramSettings(dto);
  }

  @Post('telegram/auth/start')
  @ApiOperation({
    summary: 'Initiate Telegram MTProto login wizard by sending SMS/app verification code',
  })
  public async startTelegramAuth(@Body() dto: TelegramLoginStartDto) {
    return this.settingsService.startTelegramAuth(dto);
  }

  @Post('telegram/auth/submit')
  @ApiOperation({
    summary: 'Submit verification code and optional 2FA password to complete MTProto login',
  })
  public async submitTelegramAuth(@Body() dto: TelegramLoginSubmitCodeDto) {
    return this.settingsService.submitTelegramAuthCode(dto);
  }

  @Get('scraper')
  @ApiOperation({ summary: 'Get current scraper settings (delays, concurrency, proxy mode)' })
  public async getScraperSettings() {
    return this.settingsService.getScraperSettings();
  }

  @Put('scraper')
  @ApiOperation({ summary: 'Update scraper settings' })
  public async updateScraperSettings(@Body() dto: UpdateScraperSettingsDto) {
    return this.settingsService.updateScraperSettings(dto);
  }

  @Get('proxies')
  @ApiOperation({ summary: 'Get all configured proxies' })
  public async getProxies() {
    return this.settingsService.getProxies();
  }

  @Post('proxies')
  @ApiOperation({ summary: 'Add or update a proxy' })
  public async addProxy(@Body() dto: CreateProxyDto) {
    return this.settingsService.addProxy(dto);
  }

  @Delete('proxies/:id')
  @ApiOperation({ summary: 'Delete a proxy by ID' })
  public async deleteProxy(@Param('id') id: string) {
    return this.settingsService.deleteProxy(id);
  }

  @Post('proxies/:id/test')
  @ApiOperation({ summary: 'Test proxy latency and IP connectivity' })
  public async testProxy(@Param('id') id: string) {
    return this.settingsService.testProxy(id);
  }
}
