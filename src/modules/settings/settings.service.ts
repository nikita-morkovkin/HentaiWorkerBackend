import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import {
  CreateProxyDto,
  TelegramLoginStartDto,
  TelegramLoginSubmitCodeDto,
  UpdateScraperSettingsDto,
  UpdateTelegramSettingsDto,
} from './dto/settings.dto';
import {
  TelegramConfigResult,
  ScraperSettingsResult,
  MaskedSettingsMap,
  ProxyTestResult,
  TelegramAuthStartResult,
} from './interfaces/settings.interface';
import { SYSTEM_SETTING_KEYS, SCRAPER_CONSTANTS } from '../../common/constants';
import { createProxyAgent } from '../../common/helpers';
import axios from 'axios';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

export {
  TelegramConfigResult,
  ScraperSettingsResult,
  MaskedSettingsMap,
  ProxyTestResult,
  TelegramAuthStartResult,
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  public async getDecrypted(key: string, defaultValue: string = ''): Promise<string> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key },
      });
      if (!setting) return defaultValue;
      return this.encryption.decrypt(setting.encryptedValue);
    } catch (e: any) {
      this.logger.error(`Error fetching setting ${key}: ${e.message}`);
      return defaultValue;
    }
  }

  public async setEncrypted(
    key: string,
    value: string,
    category: string = 'GENERAL',
    description?: string,
  ) {
    const encryptedValue = this.encryption.encrypt(value);
    return this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        encryptedValue,
        category,
        description,
      },
      update: {
        encryptedValue,
        category,
        description,
      },
    });
  }

  public async getAllMaskedSettings(): Promise<MaskedSettingsMap> {
    const settings = await this.prisma.systemSetting.findMany();
    const result: MaskedSettingsMap = {};

    for (const s of settings) {
      const decrypted = this.encryption.decrypt(s.encryptedValue);
      const isSet = decrypted.length > 0;
      let masked = '';
      if (isSet) {
        if (decrypted.length > 8) {
          masked = decrypted.slice(0, 4) + '••••••••' + decrypted.slice(-4);
        } else {
          masked = '••••••••';
        }
      }
      result[s.key] = {
        masked,
        isSet,
        category: s.category,
        description: s.description || '',
      };
    }
    return result;
  }

  public async updateTelegramSettings(dto: UpdateTelegramSettingsDto) {
    if (dto.botToken !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_BOT_TOKEN,
        dto.botToken,
        'TELEGRAM',
        'Telegram Bot Token',
      );
    }
    if (dto.appId !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_APP_ID,
        dto.appId,
        'TELEGRAM',
        'Telegram App ID',
      );
    }
    if (dto.appHash !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_APP_HASH,
        dto.appHash,
        'TELEGRAM',
        'Telegram App Hash',
      );
    }
    if (dto.publicChannelId !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_PUBLIC_CHANNEL_ID,
        dto.publicChannelId,
        'TELEGRAM',
        'Public Channel ID',
      );
    }
    if (dto.vipChannelId !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_VIP_CHANNEL_ID,
        dto.vipChannelId,
        'TELEGRAM',
        'VIP Channel ID',
      );
    }
    if (dto.adminChatId !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_ADMIN_CHAT_ID,
        dto.adminChatId,
        'TELEGRAM',
        'Admin Chat ID',
      );
    }
    if (dto.sessionString !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_SESSION_STRING,
        dto.sessionString,
        'TELEGRAM',
        'GramJS Session String',
      );
    }
    return { success: true, message: 'Telegram settings updated securely' };
  }

  public async getTelegramConfig(): Promise<TelegramConfigResult> {
    return {
      botToken: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_BOT_TOKEN),
      appId: Number(await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_ID)) || 0,
      appHash: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_HASH),
      publicChannelId: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_PUBLIC_CHANNEL_ID),
      vipChannelId: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_VIP_CHANNEL_ID),
      adminChatId: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_ADMIN_CHAT_ID),
      sessionString: await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_SESSION_STRING),
    };
  }

  public async startTelegramAuth(dto: TelegramLoginStartDto): Promise<TelegramAuthStartResult> {
    const appId = Number(await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_ID));
    const appHash = await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_HASH);

    if (!appId || !appHash) {
      throw new BadRequestException('Please configure TELEGRAM_APP_ID and TELEGRAM_APP_HASH first');
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, appId, appHash, {
      connectionRetries: 5,
    });

    await client.connect();
    const result = await client.sendCode(
      {
        apiId: appId,
        apiHash: appHash,
      },
      dto.phoneNumber,
    );

    await client.disconnect();

    return {
      success: true,
      phoneCodeHash: result.phoneCodeHash,
      isCodeViaApp: result.isCodeViaApp,
      message: 'Confirmation code sent to Telegram app / SMS',
    };
  }

  public async submitTelegramAuthCode(dto: TelegramLoginSubmitCodeDto) {
    const appId = Number(await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_ID));
    const appHash = await this.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_APP_HASH);

    if (!appId || !appHash) {
      throw new BadRequestException('Please configure TELEGRAM_APP_ID and TELEGRAM_APP_HASH first');
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, appId, appHash, {
      connectionRetries: 5,
    });

    await client.connect();

    try {
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: dto.phoneNumber,
            phoneCodeHash: dto.phoneCodeHash,
            phoneCode: dto.phoneCode,
          }),
        );
      } catch (signInErr: any) {
        if (signInErr.message?.includes('SESSION_PASSWORD_NEEDED') && dto.password) {
          await (client as any).signInWithPassword({
            password: dto.password,
          });
        } else {
          throw signInErr;
        }
      }

      const sessionString = client.session.save() as unknown as string;
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.TELEGRAM_SESSION_STRING,
        sessionString,
        'TELEGRAM',
        'MTProto User Session',
      );
      await client.disconnect();

      return {
        success: true,
        message: 'GramJS MTProto session successfully created and stored encrypted',
      };
    } catch (e: any) {
      await client.disconnect();
      throw new BadRequestException(`Telegram authentication failed: ${e.message}`);
    }
  }

  public async updateScraperSettings(dto: UpdateScraperSettingsDto) {
    if (dto.minDelayMs !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.SCRAPER_MIN_DELAY_MS,
        String(dto.minDelayMs),
        'SCRAPER',
      );
    }
    if (dto.maxDelayMs !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.SCRAPER_MAX_DELAY_MS,
        String(dto.maxDelayMs),
        'SCRAPER',
      );
    }
    if (dto.concurrency !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.SCRAPER_CONCURRENCY,
        String(dto.concurrency),
        'SCRAPER',
      );
    }
    if (dto.autoSync !== undefined) {
      await this.setEncrypted(
        SYSTEM_SETTING_KEYS.SCRAPER_AUTO_SYNC,
        String(dto.autoSync),
        'SCRAPER',
      );
    }
    return { success: true, message: 'Scraper settings updated' };
  }

  public async getScraperSettings(): Promise<ScraperSettingsResult> {
    return {
      minDelayMs: Number(
        await this.getDecrypted(
          SYSTEM_SETTING_KEYS.SCRAPER_MIN_DELAY_MS,
          String(SCRAPER_CONSTANTS.DEFAULT_MIN_DELAY_MS),
        ),
      ),
      maxDelayMs: Number(
        await this.getDecrypted(
          SYSTEM_SETTING_KEYS.SCRAPER_MAX_DELAY_MS,
          String(SCRAPER_CONSTANTS.DEFAULT_MAX_DELAY_MS),
        ),
      ),
      concurrency: Number(
        await this.getDecrypted(
          SYSTEM_SETTING_KEYS.SCRAPER_CONCURRENCY,
          String(SCRAPER_CONSTANTS.DEFAULT_CONCURRENCY),
        ),
      ),
      autoSync:
        (await this.getDecrypted(SYSTEM_SETTING_KEYS.SCRAPER_AUTO_SYNC, 'false')) === 'true',
    };
  }

  public async getProxies() {
    return this.prisma.proxy.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  public async addProxy(dto: CreateProxyDto) {
    const protocol = dto.protocol || (dto.url.startsWith('socks5') ? 'socks5' : 'http');
    return this.prisma.proxy.upsert({
      where: { url: dto.url },
      create: {
        url: dto.url,
        protocol,
        isActive: true,
      },
      update: {
        protocol,
        isActive: true,
      },
    });
  }

  public async deleteProxy(id: string) {
    return this.prisma.proxy.delete({ where: { id } });
  }

  public async testProxy(id: string): Promise<ProxyTestResult> {
    const proxy = await this.prisma.proxy.findUnique({ where: { id } });
    if (!proxy) throw new BadRequestException('Proxy not found');

    const startTime = Date.now();
    try {
      const agent = createProxyAgent(proxy.url, true);

      const res = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 10000,
      });

      const latencyMs = Date.now() - startTime;
      await this.prisma.proxy.update({
        where: { id },
        data: {
          isActive: true,
          failCount: 0,
          latencyMs,
          lastUsedAt: new Date(),
        },
      });

      return {
        success: true,
        latencyMs,
        detectedIp: res.data?.ip,
      };
    } catch (e: any) {
      await this.prisma.proxy.update({
        where: { id },
        data: {
          failCount: { increment: 1 },
          isActive: proxy.failCount >= 3 ? false : true,
        },
      });
      return {
        success: false,
        error: e.message,
      };
    }
  }

  public async getRotatingProxy(): Promise<string | null> {
    const proxies = await this.prisma.proxy.findMany({
      where: { isActive: true },
      orderBy: { lastUsedAt: 'asc' },
      take: 5,
    });
    if (!proxies.length) return null;

    const chosen = proxies[Math.floor(Math.random() * proxies.length)];
    await this.prisma.proxy.update({
      where: { id: chosen.id },
      data: { lastUsedAt: new Date() },
    });
    return chosen.url;
  }
}
