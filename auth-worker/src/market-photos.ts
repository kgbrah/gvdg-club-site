// Listing photos: the tee-sign pipeline's validation (data URL, magic bytes must match the declared type,
// no SVG), a smaller per-photo cap, and metadata stripping. Clients re-encode through a canvas (which drops
// EXIF); the server strips EXIF/XMP/comments again so a phone photo can never publish its GPS position.

import { decodeDataUrl, type DecodedImage } from "./photos.js";

export const MAX_LISTING_PHOTO_BYTES = 1_500_000;
/** Body cap for a create request carrying up to four photos as base64 data URLs. */
export const LISTING_BODY_BYTES = 9_000_000;
/** Body cap for one added photo. */
export const PHOTO_BODY_BYTES = 2_200_000;

export function decodeListingPhoto(value: unknown): DecodedImage | null {
  const image = decodeDataUrl(value);
  if (!image || image.bytes.length > MAX_LISTING_PHOTO_BYTES) return null;
  const stripped = stripImageMetadata(image);
  return stripped && stripped.bytes.length > 0 ? stripped : null;
}

/** Server-controlled R2 key: listing id is an integer, uuid is server-generated. */
export function listingPhotoKey(listingId: number, ext: string, uuid: string): string {
  return `market/${listingId}/${uuid}.${ext}`;
}

export function stripImageMetadata(image: DecodedImage): DecodedImage | null {
  const bytes = image.contentType === "image/jpeg" ? stripJpeg(image.bytes)
    : image.contentType === "image/png" ? stripPng(image.bytes)
      : stripWebp(image.bytes);
  return bytes ? { ...image, bytes } : null;
}

/** Drop APP1 (EXIF / XMP), APP13 (IPTC) and COM segments before the image data. */
export function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    // Start of scan: everything from here (entropy-coded data, EOI) is copied as is.
    if (marker === 0xda) { parts.push(bytes.subarray(i)); return concat(parts); }
    if (marker === 0xd9) { parts.push(bytes.subarray(i)); return concat(parts); }
    if (marker >= 0xd0 && marker <= 0xd7) { parts.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(bytes.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return null;
}

const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

export function stripPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!;
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const end = i + 12 + length;
    if (end > bytes.length) return null;
    if (!PNG_DROP.has(type)) parts.push(bytes.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(parts);
  }
  return null;
}

const WEBP_DROP = new Set(["EXIF", "XMP "]);

export function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  let flagsAt = -1;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
    const size = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | ((bytes[i + 7]! << 24) >>> 0);
    const end = i + 8 + size + (size & 1);
    if (end > bytes.length + 1) return null;
    if (!WEBP_DROP.has(type)) {
      if (type === "VP8X") flagsAt = parts.reduce((sum, part) => sum + part.length, 0) + 8;
      parts.push(bytes.slice(i, Math.min(end, bytes.length)));
    }
    i = end;
  }
  const body = concat(parts);
  // VP8X carries "has EXIF" (bit 3) and "has XMP" (bit 2) flags; clear them since the chunks are gone.
  if (flagsAt >= 0 && flagsAt < body.length) body[flagsAt] = body[flagsAt]! & ~0x0c;
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  const riffSize = 4 + body.length;
  out[4] = riffSize & 0xff; out[5] = (riffSize >> 8) & 0xff; out[6] = (riffSize >> 16) & 0xff; out[7] = (riffSize >>> 24) & 0xff;
  out.set(body, 12);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
