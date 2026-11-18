// Server-side redaction of the writing on a disc photo. Photon (Rust -> WASM, @cf-wasm/photon) decodes the
// private original, every detected box is padded generously and replaced by a coarse mosaic (blocks at least
// as large as the writing, so nothing can be read back), and the result is re-encoded as a fresh JPEG with no
// metadata. Photon is imported lazily so the WASM module is compiled only when a photo is processed, never on
// an ordinary request.

import type { Box } from "./lf-vision.js";

/** Longest side of a public photo. Larger originals are scaled down first (bounds CPU and size). */
export const PUBLIC_MAX_SIDE = 1280;
export const PUBLIC_QUALITY = 82;

type Photon = typeof import("@cf-wasm/photon");
let photonModule: Promise<Photon> | null = null;

function photon(): Promise<Photon> {
  if (!photonModule) photonModule = import("@cf-wasm/photon").catch((error) => { photonModule = null; throw error; });
  return photonModule;
}

export interface PixelBox { x: number; y: number; w: number; h: number }

/**
 * Pad a normalised box (25% of its size on every side, at least 2.5% of the image) and convert it to pixels,
 * clamped to the image. Pure.
 */
export function padBox(box: Box, width: number, height: number): PixelBox {
  const bw = (box.x1 - box.x0) * width;
  const bh = (box.y1 - box.y0) * height;
  const padX = Math.max(bw * 0.25, width * 0.025, 6);
  const padY = Math.max(bh * 0.25, height * 0.025, 6);
  const x0 = Math.max(0, Math.floor(box.x0 * width - padX));
  const y0 = Math.max(0, Math.floor(box.y0 * height - padY));
  const x1 = Math.min(width, Math.ceil(box.x1 * width + padX));
  const y1 = Math.min(height, Math.ceil(box.y1 * height + padY));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Mosaic block size: at least 16 px and half the box's short side, so a block is bigger than a letter. */
export function blockSize(area: PixelBox): number {
  return Math.max(16, Math.ceil(Math.min(area.w, area.h) / 2));
}

/** Replace each area of an RGBA buffer with flat blocks of the area's average colour per block. Pure. */
export function mosaic(pixels: Uint8Array, width: number, areas: readonly PixelBox[]): void {
  for (const area of areas) {
    if (area.w <= 0 || area.h <= 0) continue;
    const size = blockSize(area);
    for (let by = area.y; by < area.y + area.h; by += size) {
      for (let bx = area.x; bx < area.x + area.w; bx += size) {
        const x1 = Math.min(bx + size, area.x + area.w);
        const y1 = Math.min(by + size, area.y + area.h);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = by; y < y1; y++) {
          for (let x = bx; x < x1; x++) {
            const i = (y * width + x) * 4;
            r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!; n++;
          }
        }
        if (!n) continue;
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        for (let y = by; y < y1; y++) {
          for (let x = bx; x < x1; x++) {
            const i = (y * width + x) * 4;
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
          }
        }
      }
    }
  }
}

export interface Redacted {
  bytes: Uint8Array;
  contentType: "image/jpeg";
  width: number;
  height: number;
  areas: PixelBox[];
}

/** Decode, scale down, blur every box out, re-encode. Throws on undecodable input (the caller keeps it private). */
export async function redactImage(original: Uint8Array, boxes: readonly Box[]): Promise<Redacted> {
  const { PhotonImage, resize, SamplingFilter } = await photon();
  let image = PhotonImage.new_from_byteslice(original);
  try {
    const longest = Math.max(image.get_width(), image.get_height());
    if (longest > PUBLIC_MAX_SIDE) {
      const scale = PUBLIC_MAX_SIDE / longest;
      const scaled = resize(image, Math.max(1, Math.round(image.get_width() * scale)), Math.max(1, Math.round(image.get_height() * scale)), SamplingFilter.Triangle);
      image.free();
      image = scaled;
    }
    const width = image.get_width();
    const height = image.get_height();
    const pixels = image.get_raw_pixels();
    const areas = boxes.map((box) => padBox(box, width, height)).filter((area) => area.w > 0 && area.h > 0);
    mosaic(pixels, width, areas);
    const out = new PhotonImage(pixels, width, height);
    try {
      return { bytes: out.get_bytes_jpeg(PUBLIC_QUALITY), contentType: "image/jpeg", width, height, areas };
    } finally {
      out.free();
    }
  } finally {
    image.free();
  }
}
