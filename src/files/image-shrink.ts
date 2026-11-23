// Purpose: make one stored photo smaller without changing how it looks.
// Responsibilities: scales the longest side down to a limit (never up), keeps the picture upright (the phone's rotation is applied when
//   the image is read, and the result carries none), and re-encodes it in the SAME format: JPEG at the given quality, PNG losslessly.
//   Returns null - "leave the file as it is" - when the file is not a JPEG/PNG, cannot be read, or the result would not be clearly smaller.
// Important: the "clearly smaller" rule (at least 10% by default) also stops a photo that is already light from being re-compressed
//   again and again. Uses @napi-rs/canvas, which the selfie stamp already uses, so there is no extra dependency.
import { createCanvas, loadImage } from '@napi-rs/canvas';

export interface ShrinkOptions {
  /** The longest side, in pixels, the result may have. */
  maxEdge: number;
  /** JPEG quality, 1-100. */
  quality: number;
  /** Smallest worthwhile saving, as a fraction of the original size. Default 0.1 (10%). */
  minSaving?: number;
}

export const SHRINKABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

export async function shrinkImage(
  data: Buffer,
  extension: string,
  options: ShrinkOptions,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const ext = extension.toLowerCase();
  if (!SHRINKABLE_EXTENSIONS.has(ext)) return null;
  let image;
  try {
    image = await loadImage(data);
  } catch {
    return null;
  }
  const longest = Math.max(image.width, image.height);
  if (!longest) return null;
  const scale = Math.min(1, options.maxEdge / longest);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ext !== '.png') {
    // JPEG has no transparency: anything see-through gets a white background, not black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  const out = ext === '.png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', options.quality);
  const minSaving = options.minSaving ?? 0.1;
  if (out.length > data.length * (1 - minSaving)) return null;
  return { data: out, width, height };
}
