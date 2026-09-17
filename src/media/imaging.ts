import sharp, { type Metadata } from "sharp";

// Mirrors CodedByKay.ArtShow.CLI/Imaging/ThumbnailGenerator.cs's constants and behavior exactly
// (same quality settings, same "never upscale" thumbnail rule) so an image added through this
// server looks the same as one added through the CLI:
//  - full-res original: re-encoded as WebP, quality 90, no resize.
//  - thumbnail: resized to 600px wide (never upscaled — sharp's withoutEnlargement mirrors the
//    CLI's `if (original.Width <= ThumbnailWidth) return Encode(...)` early-out), WebP quality 75.
// sharp's `.rotate()` with no arguments auto-orients from the EXIF Orientation tag and strips it —
// the same effect as the CLI's hand-rolled ApplyExifOrientation, needed because photographed (not
// scanned-flat) source images often carry a non-default orientation tag.
const THUMBNAIL_WIDTH = 600;
const THUMBNAIL_WEBP_QUALITY = 75;
const ORIGINAL_WEBP_QUALITY = 90;

export interface EncodedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

async function encode(source: Buffer, quality: number, resizeWidth?: number): Promise<EncodedImage> {
  let pipeline = sharp(source).rotate();
  if (resizeWidth !== undefined) {
    pipeline = pipeline.resize({ width: resizeWidth, withoutEnlargement: true });
  }
  const { data, info } = await pipeline.webp({ quality }).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function encodeOriginalAsWebp(source: Buffer): Promise<EncodedImage> {
  return encode(source, ORIGINAL_WEBP_QUALITY);
}

export async function createThumbnail(source: Buffer): Promise<EncodedImage> {
  return encode(source, THUMBNAIL_WEBP_QUALITY, THUMBNAIL_WIDTH);
}

/** Throws with a clear message if `source` isn't decodable as an image — surfaced to the agent
 * before any R2 upload is attempted, so a bad file path or corrupt file fails fast and cheap. */
export async function readImageMetadata(source: Buffer): Promise<Metadata> {
  try {
    return await sharp(source).metadata();
  } catch (err) {
    throw new Error(`Could not decode image: ${(err as Error).message}`);
  }
}
