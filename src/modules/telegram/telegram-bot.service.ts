import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { SYSTEM_SETTING_KEYS, TELEGRAM_TEMPLATES } from '../../common/constants';
import axios from 'axios';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(private readonly settingsService: SettingsService) {}

  public async sendMessage(chatId: string, text: string, parseMode: string = 'HTML'): Promise<any> {
    const token = await this.getBotToken();
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
      const response = await axios.post(url, {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      });
      return response.data;
    } catch (err: any) {
      this.logger.error(`Failed to send Telegram Bot message to ${chatId}: ${err.message}`);
      throw err;
    }
  }

  public async sendAdminAlert(message: string, isError: boolean = false): Promise<void> {
    const adminChatId = await this.settingsService.getDecrypted(
      SYSTEM_SETTING_KEYS.TELEGRAM_ADMIN_CHAT_ID,
    );
    if (!adminChatId) {
      this.logger.debug('Admin chat ID not set; skipping admin alert');
      return;
    }

    const icon = isError
      ? TELEGRAM_TEMPLATES.ALERT_HEADER_ERROR
      : TELEGRAM_TEMPLATES.ALERT_HEADER_SUCCESS;
    const fullText = `${icon}\n\n${message}\n\n<i>Time: ${new Date().toISOString()}</i>`;

    try {
      await this.sendMessage(adminChatId, fullText);
    } catch (e: any) {
      this.logger.warn(`Could not deliver admin alert: ${e.message}`);
    }
  }

  private async getBotToken(): Promise<string> {
    const token = await this.settingsService.getDecrypted(SYSTEM_SETTING_KEYS.TELEGRAM_BOT_TOKEN);
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured in Settings');
    }
    return token;
  }
}
