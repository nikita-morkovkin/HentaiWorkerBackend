import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('HentaiWorker API')
    .setDescription(
      'Automated 18+ Anime Scraper, Google Drive Multi-Account Storage Pool, and Telegram MTProto Streaming Publisher API',
    )
    .setVersion('1.0.0')
    .addTag(
      'Anime Catalog & Metadata',
      'Endpoints for browsing, searching, and updating anime records',
    )
    .addTag('Scraper Automation', 'Manage Cheerio scraping queues and residential proxy crawler')
    .addTag(
      'Google Drive Storage Pool',
      'Manage multi-account Drive pool, 750GB daily limits and streaming upload',
    )
    .addTag(
      'Telegram Publishing & Bot',
      'GramJS MTProto video upload and Bot API scheduled publishing',
    )
    .addTag(
      'Settings & Credentials',
      'Encrypted credentials management and MTProto authentication wizard',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'HentaiWorker API Docs',
    customCss: '.swagger-ui .topbar { background-color: #1a73e8; }',
  });

  const port = process.env.PORT || 4000;
  await app.listen(port);

  logger.log(`🚀 HentaiWorker Backend is running on: http://localhost:${port}`);
  logger.log(`📚 Swagger Documentation is available at: http://localhost:${port}/api/docs`);
}

bootstrap();
