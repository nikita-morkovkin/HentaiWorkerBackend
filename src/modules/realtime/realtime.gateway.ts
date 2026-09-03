import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: 'ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  public server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly prisma: PrismaService) {}

  public async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    try {
      const recentLogs = await this.prisma.taskLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      client.emit(
        'scraper:init_logs',
        recentLogs.map((l) => ({
          taskType: l.taskType,
          status: l.status,
          message: l.message,
          metadata: l.metadata,
          timestamp: l.createdAt.toISOString(),
        })),
      );
    } catch (err: any) {
      this.logger.warn(`Could not send init logs to client ${client.id}: ${err.message}`);
    }
  }

  public handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  public emitUploadProgress(data: {
    jobId: string;
    animeId: string;
    episodeId: string;
    fileName: string;
    uploadedBytes: number;
    totalBytes: number;
    percent: number;
    statusText?: string;
  }) {
    if (this.server) {
      this.server.emit('upload:progress', data);
    }
  }

  public emitTelegramProgress(data: { fileName: string; percent: number; channelId: string }) {
    if (this.server) {
      this.server.emit('telegram:progress', data);
    }
  }

  public async emitLog(
    taskType: string,
    status: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR',
    message: string,
    metadata?: any,
  ) {
    this.logger.log(`[${taskType}][${status}] ${message}`);

    try {
      await this.prisma.taskLog.create({
        data: {
          taskType,
          status,
          message,
          metadata: metadata || null,
        },
      });
    } catch {}

    if (this.server) {
      this.server.emit('scraper:log', {
        taskType,
        status,
        message,
        metadata,
        timestamp: new Date().toISOString(),
      });
    }
  }

  @SubscribeMessage('ping')
  public handlePing(client: Socket) {
    client.emit('pong', { time: Date.now() });
  }
}
