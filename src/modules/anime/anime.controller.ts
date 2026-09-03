import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { AnimeService } from './anime.service';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { UpdateAnimeMetadataDto } from './dto/anime.dto';
import { type Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { UploadedFileDto } from './interfaces/anime.interface';
import { getCoversDirectory, isSafeFilename, isPathInsideDirectory } from '../../common/helpers';

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

@ApiTags('Anime Catalog & Metadata')
@Controller('api/anime')
export class AnimeController {
  constructor(private readonly animeService: AnimeService) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated anime catalog (24/48 per page) with search and filters' })
  public async findAll(@Query() query: PaginationQueryDto) {
    return this.animeService.findAll(query);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Get all unique tags and genres for auto-completion' })
  public async getTags() {
    return this.animeService.getAllTagsAndGenres();
  }

  @Get('proxy-image')
  @ApiOperation({
    summary: 'Proxy external cover image to bypass hotlinking protection and ISP/RKN blocks',
  })
  public async proxyImage(@Query('url') imageUrl: string, @Res() res: Response) {
    return this.animeService.proxyImage(imageUrl, res);
  }

  @Get('covers/:filename')
  @ApiOperation({ summary: 'Get extracted video frame screenshot cover image' })
  public getCoverImage(@Param('filename') filename: string, @Res() res: Response) {
    if (!isSafeFilename(filename)) {
      throw new BadRequestException('Invalid cover filename');
    }

    const coversDir = getCoversDirectory();
    const filePath = path.join(coversDir, filename);

    if (!isPathInsideDirectory(filePath, coversDir) || !fs.existsSync(filePath)) {
      throw new NotFoundException('Cover image not found');
    }

    return res.sendFile(filePath);
  }

  @Post(':id/extract-screenshots')
  @ApiOperation({
    summary:
      'Automatically generate 4-6 video frame screenshots from anime stream with FFmpeg 1080p upscale',
  })
  public async generateScreenshots(@Param('id') id: string) {
    const screenshots = await this.animeService.generateScreenshots(id);
    return { success: true, screenshots };
  }

  @Post(':id/upload-cover')
  @ApiOperation({
    summary:
      'Upload custom cover image from local computer (Drag & Drop) with automatic FFmpeg Lanczos upscale',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
          return cb(
            new BadRequestException(
              `Unsupported file format: ${file.mimetype}. Allowed: JPG, PNG, WebP, AVIF.`,
            ),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  public async uploadCover(@Param('id') id: string, @UploadedFile() file: UploadedFileDto) {
    const url = await this.animeService.uploadCover(id, file);
    return { success: true, url };
  }

  @Post('clear-all')
  @ApiOperation({ summary: 'Complete wipe of all anime catalog titles and files from database' })
  public async clearAll() {
    return this.animeService.clearAllCatalog();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single anime details including episodes, files and Drive links' })
  public async findOne(@Param('id') id: string) {
    return this.animeService.findOne(id);
  }

  @Patch(':id/metadata')
  @ApiOperation({ summary: 'Update anime metadata (titles, description, tags, covers)' })
  public async updateMetadata(@Param('id') id: string, @Body() dto: UpdateAnimeMetadataDto) {
    return this.animeService.updateMetadata(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete anime title and all related records' })
  public async delete(@Param('id') id: string) {
    return this.animeService.delete(id);
  }
}
