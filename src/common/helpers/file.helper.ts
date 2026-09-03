import * as fs from 'fs';
import * as path from 'path';
import { STORAGE_CONSTANTS } from '../constants';

/**
 * Ensures a directory exists, creating recursively if needed
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Returns the absolute path to the covers uploads directory
 */
export function getCoversDirectory(): string {
  const dir = path.join(process.cwd(), STORAGE_CONSTANTS.COVERS_DIR_REL);
  ensureDirectoryExists(dir);
  return dir;
}

/**
 * Safely removes a file without throwing exceptions
 */
export function safeUnlink(filePath?: string | null): boolean {
  if (!filePath) return false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Sanitizes a filename for filesystem and Google Drive compatibility
 */
export function sanitizeFilename(name: string): string {
  if (!name) return 'file';
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}
