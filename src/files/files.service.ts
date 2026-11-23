// Purpose: Turns a raw Multer upload into a stored relativeKey plus a signed, time-limited download URL.
// Responsibilities: Owns only describeUpload() — actual disk/storage placement is relativeKeyFor's job,
// and URL signing is file-token's; this is the thin glue between the two for the upload response shape.
import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { shrinkImage } from './image-shrink';
import { DEFAULT_SETTINGS } from './shrink-uploads';
import { relativeKeyFor } from './file-storage.config';
import { signFileToken } from './file-token';
import {
  ALLOWED_MIME_TYPES,
  contentMatchesDeclaredType,
  contentMatchesExtension,
  matchesJpegOrPng,
} from './file-signature';

@Injectable()
export class FilesService {
  async describeUpload(
    file: Express.Multer.File | undefined,
    category: string,
    organizationId: string,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    // multer has already written the file. Check its real bytes against the type the client declared; on a
    // mismatch (HTML/script labelled image/png, an empty or truncated file) delete it and refuse. Disk driver
    // only — the S3 engine never has a local path — where the extension allow-list still applies.
    if (file.path) {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(file.path, 'r');
      let read = 0;
      try {
        read = fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      const bytes = head.subarray(0, read);
      if (
        !contentMatchesDeclaredType(bytes, file.mimetype) ||
        !contentMatchesExtension(bytes, file.originalname)
      ) {
        fs.rmSync(file.path, { force: true });
        throw new BadRequestException(
          'The file is empty or its contents do not match its type.',
        );
      }
      // JPEG/PNG-only categories (branding): the bytes, MIME type and extension must all agree on the format.
      if (
        ALLOWED_MIME_TYPES[category] &&
        !matchesJpegOrPng(bytes, file.originalname, file.mimetype)
      ) {
        fs.rmSync(file.path, { force: true });
        throw new BadRequestException(
          'The image must be a real JPEG or PNG whose file extension and type match.',
        );
      }
    }
    // New profile photos and selfies are stored already shrunk (same limits as scripts/shrink-uploads.ts), so the folder never
    // grows heavy. Disk driver only; any failure leaves the file exactly as uploaded.
    const shrinkSettings = category === 'profile-photos' || category === 'selfies' ? DEFAULT_SETTINGS[category] : null;
    if (file.path && shrinkSettings) {
      try {
        const result = await shrinkImage(fs.readFileSync(file.path), path.extname(file.path), shrinkSettings);
        if (result) fs.writeFileSync(file.path, result.data);
      } catch {
        /* keep the original */
      }
    }
    const relativeKey = relativeKeyFor(organizationId, category, file);
    return {
      relativeKey,
      url: `/files/${signFileToken(organizationId, relativeKey)}`,
    };
  }
}
