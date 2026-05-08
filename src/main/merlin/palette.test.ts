import { describe, it, expect, vi } from 'vitest';

// nativeImage is mocked because palette.ts imports it at module load.
// extractPalette / middleFrameRect are pure and don't touch electron.
vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: vi.fn(),
  },
}));

import { extractPalette, middleFrameRect, type Palette } from './palette';

/**
 * Build a flat BGRA buffer of `width × height` pixels filled with one color.
 * The nativeImage.toBitmap format is BGRA, so the constructor mirrors that.
 */
function bgraSolid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number = 255,
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = b;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = r;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

/**
 * Two-color split: left half color1, right half color2.
 */
function bgraSplit(
  width: number,
  height: number,
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  const mid = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = x < mid ? c1 : c2;
      buf[i + 0] = c.b;
      buf[i + 1] = c.g;
      buf[i + 2] = c.r;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

const closeTo = (actual: number, expected: number, tol = 0.05) =>
  Math.abs(actual - expected) < tol;

describe('extractPalette', () => {
  it('returns the input color twice for a solid red sprite', () => {
    const pixels = bgraSolid(64, 64, 240, 40, 30);
    const [primary, accent] = extractPalette(pixels, 64, 64);

    // Solid color: median split produces two groups with the same color.
    expect(closeTo(primary.r, 240 / 255)).toBe(true);
    expect(closeTo(primary.g, 40 / 255)).toBe(true);
    expect(closeTo(primary.b, 30 / 255)).toBe(true);
    expect(closeTo(accent.r, 240 / 255)).toBe(true);
  });

  it('separates two clearly distinct colors', () => {
    const red = { r: 240, g: 40, b: 30 };
    const blue = { r: 30, g: 60, b: 220 };
    const pixels = bgraSplit(64, 64, red, blue);
    const [primary, accent] = extractPalette(pixels, 64, 64);

    // The two centroids should be near red and near blue (in either order;
    // primary is the brighter one). We only check the centroids exist on
    // opposite sides of the spectrum.
    const primaryIsRed = primary.r > primary.b;
    const accentIsBlue = accent.b > accent.r;
    expect(primaryIsRed && accentIsBlue).toBe(true);
    expect(closeTo(primary.r, 240 / 255, 0.1)).toBe(true);
    expect(closeTo(accent.b, 220 / 255, 0.1)).toBe(true);
  });

  it('returns white fallback for an all-black sprite', () => {
    const pixels = bgraSolid(64, 64, 0, 0, 0);
    const [primary, accent] = extractPalette(pixels, 64, 64);
    expect(primary).toEqual({ r: 1, g: 1, b: 1 });
    expect(accent).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('returns white fallback when bright pixel count is below MIN_BRIGHT_PIXELS', () => {
    // 8x8 image (64 pixels total) with only a 4x4 bright region (16 pixels).
    // 16 < MIN_BRIGHT_PIXELS=50 → fallback.
    const pixels = bgraSolid(8, 8, 0, 0, 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 8 + x) * 4;
        pixels[i + 0] = 50;
        pixels[i + 1] = 200;
        pixels[i + 2] = 50;
      }
    }
    const [primary, accent] = extractPalette(pixels, 8, 8);
    expect(primary).toEqual({ r: 1, g: 1, b: 1 });
    expect(accent).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('respects the region clamp', () => {
    // Build a 64x32 image: left half red, right half blue.
    const red = { r: 240, g: 40, b: 30 };
    const blue = { r: 30, g: 60, b: 220 };
    const pixels = bgraSplit(64, 32, red, blue);

    // Restrict to the left half only → should return mostly-red.
    const [primary] = extractPalette(pixels, 64, 32, { x: 0, y: 0, w: 32, h: 32 });
    expect(closeTo(primary.r, 240 / 255, 0.1)).toBe(true);
    expect(primary.r > primary.b).toBe(true);

    // Restrict to the right half → should return mostly-blue.
    const [primary2] = extractPalette(pixels, 64, 32, { x: 32, y: 0, w: 32, h: 32 });
    expect(closeTo(primary2.b, 220 / 255, 0.1)).toBe(true);
    expect(primary2.b > primary2.r).toBe(true);
  });

  it('primary centroid is at least as bright as the accent', () => {
    // Bright red vs dim red — primary should be the bright one.
    const brightR = { r: 240, g: 60, b: 60 };
    const dimR = { r: 80, g: 30, b: 30 };
    const pixels = bgraSplit(64, 64, brightR, dimR);
    const [primary, accent] = extractPalette(pixels, 64, 64);
    const lumP = 0.299 * primary.r + 0.587 * primary.g + 0.114 * primary.b;
    const lumA = 0.299 * accent.r + 0.587 * accent.g + 0.114 * accent.b;
    expect(lumP).toBeGreaterThanOrEqual(lumA);
  });
});

describe('middleFrameRect', () => {
  it('returns the center cell of a 4x4 atlas (frame 8 of 16)', () => {
    const rect = middleFrameRect(1024, 1024, 4, 4, 16);
    // floor(16/2) = 8 → col=0, row=2; cellW = cellH = 256
    expect(rect).toEqual({ x: 0, y: 512, w: 256, h: 256 });
  });

  it('returns the center cell of a 3x3 atlas (frame 4 of 9)', () => {
    const rect = middleFrameRect(768, 768, 3, 3, 9);
    // floor(9/2) = 4 → col=1, row=1; cellW = cellH = 256
    expect(rect).toEqual({ x: 256, y: 256, w: 256, h: 256 });
  });

  it('handles single-frame (1x1) atlases', () => {
    const rect = middleFrameRect(512, 512, 1, 1, 1);
    expect(rect).toEqual({ x: 0, y: 0, w: 512, h: 512 });
  });
});
