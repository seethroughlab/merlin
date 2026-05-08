/**
 * Sprite palette extraction
 *
 * Decodes a PNG/JPEG/WebP file via Electron's nativeImage and extracts
 * two dominant colors (primary + accent) using luminance-weighted hue
 * clustering. The colors feed into uSpriteColor1 / uSpriteColor2 vec3
 * uniforms in TD and into the generate_sprite function response so
 * Gemini's zone shaders match the sprite's actual palette.
 *
 * Algorithm rationale: k-means with k=2 would be more robust on
 * complex multi-hued sprites, but adds complexity and an iterative
 * convergence loop. Luminance-weighted hue-split centroid is O(n) in
 * pixel count, has no failure modes that need handling, and produces
 * stable results for the spell archetypes we care about (fire, water,
 * crystal, etc — sprites with one or two distinct color regions).
 */

import { nativeImage } from 'electron';

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
}

export type Palette = [PaletteColor, PaletteColor];

const LUMINANCE_THRESHOLD = 0.15;
const MIN_BRIGHT_PIXELS = 50;
const FALLBACK_WHITE: PaletteColor = { r: 1, g: 1, b: 1 };

/**
 * RGB → hue in [0, 1). For neutral colors (max ≈ min) returns 0;
 * the luminance threshold filter prevents most neutral pixels from
 * making it this far, so the bias toward red is acceptable.
 */
function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-6) return 0;
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h = h / 6;
  if (h < 0) h += 1;
  return h;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Extract two dominant colors from a BGRA pixel buffer.
 *
 * @param pixels  BGRA-ordered byte buffer (Electron nativeImage.toBitmap() format)
 * @param width   image width in pixels
 * @param height  image height in pixels
 * @param region  optional rect to restrict extraction (used for flipbook frame extraction)
 * @returns       [primary, accent] where primary is the brighter of the two centroids
 */
export function extractPalette(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  region?: { x: number; y: number; w: number; h: number },
): Palette {
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const w = region?.w ?? width;
  const h = region?.h ?? height;

  const bright: { hue: number; lum: number; r: number; g: number; b: number }[] = [];

  for (let py = y0; py < y0 + h && py < height; py++) {
    for (let px = x0; px < x0 + w && px < width; px++) {
      const i = (py * width + px) * 4;
      // BGRA order from nativeImage.toBitmap()
      const b = pixels[i] / 255;
      const g = pixels[i + 1] / 255;
      const r = pixels[i + 2] / 255;
      const lum = luminance(r, g, b);
      if (lum < LUMINANCE_THRESHOLD) continue;
      bright.push({ hue: rgbToHue(r, g, b), lum, r, g, b });
    }
  }

  if (bright.length < MIN_BRIGHT_PIXELS) {
    return [FALLBACK_WHITE, FALLBACK_WHITE];
  }

  // Median-split by hue → two groups
  bright.sort((a, b) => a.hue - b.hue);
  const mid = Math.floor(bright.length / 2);
  const groupA = bright.slice(0, mid);
  const groupB = bright.slice(mid);

  // Luminance-weighted centroid of each group
  const centroid = (group: typeof bright): { color: PaletteColor; weight: number } => {
    let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
    for (const p of group) {
      sumR += p.r * p.lum;
      sumG += p.g * p.lum;
      sumB += p.b * p.lum;
      sumW += p.lum;
    }
    if (sumW < 1e-6) return { color: FALLBACK_WHITE, weight: 0 };
    return {
      color: { r: sumR / sumW, g: sumG / sumW, b: sumB / sumW },
      weight: sumW,
    };
  };

  const cA = centroid(groupA);
  const cB = centroid(groupB);

  // Primary = brighter centroid; accent = the other
  const primary = luminance(cA.color.r, cA.color.g, cA.color.b)
    >= luminance(cB.color.r, cB.color.g, cB.color.b)
    ? cA.color
    : cB.color;
  const accent = primary === cA.color ? cB.color : cA.color;

  return [primary, accent];
}

/**
 * Decode an image file into a BGRA pixel buffer via Electron's
 * nativeImage. Supports PNG/JPEG/WebP — everything Imagen can return.
 *
 * Returns null on decode failure (corrupt file, unknown format) so the
 * caller can fall back to a neutral palette without erroring out the
 * sprite generation flow.
 */
export function decodeImage(
  path: string,
): { pixels: Buffer; width: number; height: number } | null {
  try {
    const img = nativeImage.createFromPath(path);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const pixels = img.toBitmap();
    if (pixels.length === 0) return null;
    return { pixels, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/**
 * Convenience: decode + extract in one call. Returns a fallback white
 * palette on any failure so the sprite generation flow always returns
 * a valid palette.
 */
export function extractPaletteFromFile(
  path: string,
  region?: { x: number; y: number; w: number; h: number },
): Palette {
  const decoded = decodeImage(path);
  if (!decoded) return [FALLBACK_WHITE, FALLBACK_WHITE];
  return extractPalette(decoded.pixels, decoded.width, decoded.height, region);
}

/**
 * For a flipbook atlas, compute the rect of the middle frame so palette
 * extraction operates on a single representative cell (rather than the
 * whole atlas, which averages across frames). Frame index is
 * floor(frameCount / 2).
 */
export function middleFrameRect(
  width: number,
  height: number,
  cols: number,
  rows: number,
  frameCount: number,
): { x: number; y: number; w: number; h: number } {
  const idx = Math.floor(frameCount / 2);
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  return { x: col * cellW, y: row * cellH, w: cellW, h: cellH };
}
