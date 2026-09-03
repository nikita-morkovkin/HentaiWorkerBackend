export interface UploadedFileDto {
  fieldname?: string;
  originalname: string;
  encoding?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
}

export interface TagsAndGenresResult {
  tags: string[];
  genres: string[];
}

export interface CatalogClearResult {
  success: boolean;
  deletedCount: number;
  message: string;
}
