// Pixel size from an image file's HEADER only (JPEG SOF segment, PNG IHDR, WebP VP8/VP8L/VP8X). The Worker never
// decodes an image: this reads a handful of bytes, so it costs microseconds whatever the photo's size.

import { decodeListingPhoto } from "./market-photos.js";
import type { DecodedImage } from "./photos.js";

export interface PixelSize { width: number; height: number }

function u16be(b: Uint8Array, i: number): number { return (b[i]! << 8) | b[i + 1]!; }
function u24le(b: Uint8Array, i: number): number { return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16); }
function u32be(b: Uint8Array, i: number): number { return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!; }

function jpegSize(b: Uint8Array): PixelSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i + 2);
    // SOF0-SOF15 (not DHT C4, JPG C8 or DAC CC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return width && height ? { width, height } : null;
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function pngSize(b: Uint8Array): PixelSize | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width && height ? { width, height } : null;
}

function webpSize(b: Uint8Array): PixelSize | null {
  if (b.length < 30 || String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) !== "WEBP") return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: ((b[26]! | (b[27]! << 8)) & 0x3fff), height: ((b[28]! | (b[29]! << 8)) & 0x3fff) };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | ((b[24]! << 24) >>> 0);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

export function imageSize(bytes: Uint8Array): PixelSize | null {
  const size = jpegSize(bytes) ?? pngSize(bytes) ?? webpSize(bytes);
  return size && size.width > 0 && size.height > 0 && size.width <= 20_000 && size.height <= 20_000 ? size : null;
}

/** Same shape within 2% (or one pixel of rounding), e.g. a 1280x960 copy of a 4032x3024 original. */
export function sameAspect(a: PixelSize, b: PixelSize): boolean {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  const rounding = 1 / Math.min(b.width, b.height);
  return Math.abs(ra - rb) / ra <= Math.max(0.02, rounding * 2);
}

export interface LfPhoto extends DecodedImage { size: PixelSize }

/** A photo upload: the marketplace / tee-sign checks (data URL, magic bytes, 1.5 MB cap, EXIF/XMP stripped at the
 *  byte level) plus its pixel size read from the header. No decode: a few milliseconds even for a full photo. */
export function decodeLfPhoto(value: unknown): LfPhoto | null {
  const image = decodeListingPhoto(value);
  const size = image ? imageSize(image.bytes) : null;
  return image && size ? { ...image, size } : null;
}

export function photosFrom(value: unknown, min: number, max: number): LfPhoto[] | null {
  if (value == null && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const images = value.map((item) => decodeLfPhoto(item));
  return images.every(Boolean) ? images.map((image) => image!) : null;
}
