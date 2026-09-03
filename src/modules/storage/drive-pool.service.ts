import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { CreateDriveAccountDto, ExchangeAuthCodeDto, GenerateAuthUrlDto } from './dto/drive.dto';
import { DriveAccountListItem } from './interfaces/drive.interface';
import { STORAGE_CONSTANTS } from '../../common/constants';

export const GOOGLE_DAILY_UPLOAD_LIMIT_BYTES = STORAGE_CONSTANTS.GOOGLE_DAILY_UPLOAD_LIMIT_BYTES;
export const GOOGLE_ACCOUNT_MAX_STORAGE_BYTES = STORAGE_CONSTANTS.GOOGLE_ACCOUNT_MAX_STORAGE_BYTES;

@Injectable()
export class DrivePoolService {
  private readonly logger = new Logger(DrivePoolService.name);
  private authClients: Map<string, OAuth2Client> = new Map();

  constructor(private readonly prisma: PrismaService) {}

  public generateAuthUrl(dto: GenerateAuthUrlDto): string {
    const oauth2Client = new google.auth.OAuth2(dto.clientId, dto.clientSecret, dto.redirectUri);
    const scopes = ['https://www.googleapis.com/auth/drive'];
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
    });
  }

  public async exchangeAuthCode(dto: ExchangeAuthCodeDto) {
    const oauth2Client = new google.auth.OAuth2(dto.clientId, dto.clientSecret, dto.redirectUri);
    const { tokens } = await oauth2Client.getToken(dto.code);

    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Google did not return a refresh token. Make sure prompt=consent was used and app is approved.',
      );
    }

    oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const about = await drive.about.get({ fields: 'user, storageQuota' });

    const email = about.data.user?.emailAddress || 'unknown@gmail.com';
    const name = dto.name || `Drive Account (${email})`;
    const usedStorage = BigInt(about.data.storageQuota?.usage || '0');
    const totalStorage = about.data.storageQuota?.limit
      ? BigInt(about.data.storageQuota.limit)
      : STORAGE_CONSTANTS.GOOGLE_ACCOUNT_MAX_STORAGE_BYTES;

    const account = await this.prisma.driveAccount.create({
      data: {
        name,
        email,
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token || null,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        usedStorageBytes: usedStorage,
        totalStorageBytes: totalStorage,
        dailyUploadedBytes: BigInt(0),
        dailyResetAt: new Date(),
        isActive: true,
      },
    });

    return {
      success: true,
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
      },
    };
  }

  public async createAccount(dto: CreateDriveAccountDto) {
    const account = await this.prisma.driveAccount.create({
      data: {
        name: dto.name,
        email: dto.email,
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        refreshToken: dto.refreshToken,
        totalStorageBytes: STORAGE_CONSTANTS.GOOGLE_ACCOUNT_MAX_STORAGE_BYTES,
        usedStorageBytes: BigInt(0),
        dailyUploadedBytes: BigInt(0),
        dailyResetAt: new Date(),
        isActive: true,
      },
    });
    await this.syncAccountStats(account.id);
    return account;
  }

  public async listAccounts(): Promise<DriveAccountListItem[]> {
    await this.checkAndResetDailyQuotas();
    const accounts = await this.prisma.driveAccount.findMany({
      orderBy: { createdAt: 'asc' },
    });

    return accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      email: acc.email,
      isActive: acc.isActive,
      isQuotaExceeded: acc.isQuotaExceeded,
      statusMessage: acc.statusMessage,
      usedStorageBytes: acc.usedStorageBytes.toString(),
      totalStorageBytes: acc.totalStorageBytes.toString(),
      dailyUploadedBytes: acc.dailyUploadedBytes.toString(),
      dailyLimitBytes: STORAGE_CONSTANTS.GOOGLE_DAILY_UPLOAD_LIMIT_BYTES.toString(),
      usedStoragePercent: Number(
        (acc.usedStorageBytes * BigInt(100)) / (acc.totalStorageBytes || BigInt(1)),
      ),
      dailyUploadedPercent: Number(
        (acc.dailyUploadedBytes * BigInt(100)) / STORAGE_CONSTANTS.GOOGLE_DAILY_UPLOAD_LIMIT_BYTES,
      ),
      dailyResetAt: acc.dailyResetAt,
      createdAt: acc.createdAt,
    }));
  }

  public async syncAccountStats(accountId: string) {
    const account = await this.prisma.driveAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Drive account not found');

    try {
      const auth = await this.getAuthenticatedClient(account.id);
      const drive = google.drive({ version: 'v3', auth });
      const about = await drive.about.get({ fields: 'user, storageQuota' });

      const usedStorage = BigInt(about.data.storageQuota?.usage || '0');
      const totalStorage = about.data.storageQuota?.limit
        ? BigInt(about.data.storageQuota.limit)
        : STORAGE_CONSTANTS.GOOGLE_ACCOUNT_MAX_STORAGE_BYTES;

      const updated = await this.prisma.driveAccount.update({
        where: { id: accountId },
        data: {
          email: about.data.user?.emailAddress || account.email,
          usedStorageBytes: usedStorage,
          totalStorageBytes: totalStorage,
          statusMessage: 'Healthy',
        },
      });
      return updated;
    } catch (e: any) {
      this.logger.error(`Failed to sync Drive account ${accountId}: ${e.message}`);
      await this.prisma.driveAccount.update({
        where: { id: accountId },
        data: { statusMessage: `Sync error: ${e.message}` },
      });
      throw e;
    }
  }

  public async deleteAccount(id: string) {
    this.authClients.delete(id);
    return this.prisma.driveAccount.delete({ where: { id } });
  }

  public async checkAndResetDailyQuotas() {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await this.prisma.driveAccount.updateMany({
      where: {
        dailyResetAt: { lte: twentyFourHoursAgo },
      },
      data: {
        dailyUploadedBytes: BigInt(0),
        dailyResetAt: now,
        isQuotaExceeded: false,
        statusMessage: 'Daily quota reset',
      },
    });
  }

  public async recordUploadedBytes(accountId: string, bytes: number | bigint) {
    const b = BigInt(bytes);
    const account = await this.prisma.driveAccount.findUnique({ where: { id: accountId } });
    if (!account) return;

    const newDaily = account.dailyUploadedBytes + b;
    const isExceeded = newDaily >= STORAGE_CONSTANTS.GOOGLE_DAILY_UPLOAD_LIMIT_BYTES;

    await this.prisma.driveAccount.update({
      where: { id: accountId },
      data: {
        dailyUploadedBytes: newDaily,
        usedStorageBytes: account.usedStorageBytes + b,
        isQuotaExceeded: isExceeded,
        statusMessage: isExceeded ? 'Daily 750GB limit reached. Will reset in 24h.' : 'Active',
      },
    });
  }

  public async markAccountRateLimited(accountId: string, reason: string) {
    this.logger.warn(`Drive account ${accountId} rate limited: ${reason}`);
    await this.prisma.driveAccount.update({
      where: { id: accountId },
      data: {
        isQuotaExceeded: true,
        statusMessage: `Rate limited (403): ${reason}`,
      },
    });
  }

  public async getBestAvailableAccount(estimatedFileBytes: bigint = BigInt(0)) {
    await this.checkAndResetDailyQuotas();

    const accounts = await this.prisma.driveAccount.findMany({
      where: {
        isActive: true,
        isQuotaExceeded: false,
      },
      orderBy: [{ dailyUploadedBytes: 'asc' }, { usedStorageBytes: 'asc' }],
    });

    for (const acc of accounts) {
      const dailyLeft = STORAGE_CONSTANTS.GOOGLE_DAILY_UPLOAD_LIMIT_BYTES - acc.dailyUploadedBytes;
      const spaceLeft = acc.totalStorageBytes - acc.usedStorageBytes;

      if (dailyLeft > estimatedFileBytes && spaceLeft > estimatedFileBytes) {
        return acc;
      }
    }

    if (accounts.length > 0) {
      return accounts[0];
    }

    throw new BadRequestException(
      'No available Google Drive accounts with remaining storage or daily quota',
    );
  }

  public async getAuthenticatedClient(accountId: string): Promise<OAuth2Client> {
    if (this.authClients.has(accountId)) {
      return this.authClients.get(accountId)!;
    }

    const account = await this.prisma.driveAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`Drive account ${accountId} not found`);

    const oauth2Client = new google.auth.OAuth2(
      account.clientId,
      account.clientSecret,
      'http://localhost:4000/api/storage/oauth2callback',
    );

    oauth2Client.setCredentials({
      refresh_token: account.refreshToken,
      access_token: account.accessToken || undefined,
      expiry_date: account.tokenExpiry ? account.tokenExpiry.getTime() : undefined,
    });

    oauth2Client.on('tokens', async (tokens) => {
      await this.prisma.driveAccount.update({
        where: { id: accountId },
        data: {
          accessToken: tokens.access_token,
          tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        },
      });
    });

    this.authClients.set(accountId, oauth2Client);
    return oauth2Client;
  }
}
