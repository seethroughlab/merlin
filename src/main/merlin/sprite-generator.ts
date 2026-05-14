/**
 * Sprite Generator for Merlin Mirror
 *
 * Handles Gemini image generation for particle sprites.
 * Includes prompt engineering, validation, and async generation flow.
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import {
  saveSprite,
  getDefaultSpritePath,
  getFlipbookConfig,
  FLIPBOOK_LAYOUTS,
  type SpriteAsset,
  type FlipbookConfig,
  type PlaybackMode,
  type DriveSource,
} from './asset-manager';
import { withRetry } from '../retry';

const ts = () => new Date().toISOString().slice(11, 23);

// ============ CONFIGURATION ============

const SPRITE_SIZE = 512;
const SPRITE_MIN_SIZE = 64;
const SPRITE_MAX_SIZE = 1024;

const FLIPBOOK_FRAME_SIZE = 256;

// Hard cap on free-form caller-supplied strings (description, style,
// intent, element) before they hit the Imagen prompt. A malformed or
// runaway caller pushing 10k chars would otherwise build a giant
// prompt that's slow to encode and gives Imagen nothing useful to work
// with. 500 chars comfortably fits any real description.
const PROMPT_INPUT_MAX_CHARS = 500;
function clamp(input: string | undefined, label: string): string {
  if (!input) return '';
  if (input.length <= PROMPT_INPUT_MAX_CHARS) return input;
  console.warn(`[SpriteGen] ${label} truncated from ${input.length} → ${PROMPT_INPUT_MAX_CHARS} chars`);
  return input.slice(0, PROMPT_INPUT_MAX_CHARS);
}

// Validation thresholds
const CENTER_BRIGHTNESS_MIN = 0.15;
const EDGE_TRANSPARENCY_MAX = 0.3;
const FLIPBOOK_CELL_MIN_CONTENT = 0.05;

// ============ TYPES ============

export interface SpriteOptions {
  size?: number;
  style?: string;
  color?: string;
}

export interface FlipbookOptions extends SpriteOptions {
  frameCount: 4 | 8 | 9 | 12 | 16;
  animation?: string;
  playbackMode?: PlaybackMode;
  frameDuration?: number;
  driveSource?: DriveSource;
}

export interface ValidationResult {
  isValid: boolean;
  message: string;
  processedData?: Buffer;
}

export interface GenerationResult {
  success: boolean;
  asset?: SpriteAsset;
  flipbookConfig?: FlipbookConfig;
  /**
   * Two dominant colors extracted from the saved sprite (luminance-
   * weighted hue split). Pushed to TD as uSpriteColor1/2 uniforms and
   * surfaced in the generate_sprite tool response so zone shaders can
   * match the sprite palette. White fallback if extraction fails or
   * the sprite is mostly black.
   */
  palette?: import('./palette').Palette;
  error?: string;
}

export class SpriteGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpriteGenerationError';
  }
}

// ============ PROMPT BUILDERS ============

/**
 * Build optimized prompt for single sprite generation
 */
export function buildSpritePrompt(
  description: string,
  style?: string,
  size: number = SPRITE_SIZE
): string {
  const safeDescription = clamp(description, 'description');
  const styleText = clamp(style, 'style') || 'soft and glowing';

  return `Generate a ${size}x${size} pixel particle sprite on a PURE BLACK background.

Visual description:
- A single ${safeDescription} shape centered in the image
- Style: ${styleText}
- Bright/glowing in the center
- Smoothly fades to pure black (RGB 0,0,0) at the edges
- Radially symmetric, soft falloff

Technical requirements:
- PNG format
- Background MUST be pure black (RGB 0,0,0), NOT a checkerboard pattern
- Single centered object only, no text or borders

The sprite will be used with additive blending, so black = transparent.`;
}

/**
 * Build prompt for flipbook atlas generation
 */
export function buildFlipbookPrompt(
  description: string,
  style: string = 'soft glowing',
  frameCount: number = 16,
  cols: number = 4,
  rows: number = 4
): string {
  const safeDescription = clamp(description, 'description');
  const safeStyle = clamp(style, 'style') || 'soft glowing';
  const totalWidth = cols * FLIPBOOK_FRAME_SIZE;
  const totalHeight = rows * FLIPBOOK_FRAME_SIZE;

  return `Generate a ${cols}x${rows} sprite sheet animation atlas.

Requirements:
- Single PNG image, exactly ${totalWidth}x${totalHeight} pixels total
- ${frameCount} animation frames arranged in a grid (left-to-right, top-to-bottom)
- Each frame: ${FLIPBOOK_FRAME_SIZE}x${FLIPBOOK_FRAME_SIZE} pixels
- PURE BLACK background (RGB 0,0,0) - NOT transparent, NOT checkered
- Each frame shows: ${safeDescription}
- Style: ${safeStyle}
- Each frame has bright content in center, fading to black at edges

Animation progression:
- Frame 1 (top-left): Animation START state
- Frame ${frameCount} (bottom-right): Animation END/loop point
- Each consecutive frame should differ from the previous by a small, incremental amount — like a slow morph or gentle pulse. Avoid large jumps between frames. The animation should look fluid when played at 8-15 frames per second.
- For loopable animations, the last frame must connect smoothly back to the first frame (no visible jump on loop wrap)

Technical:
- PNG format
- The black background will become transparent via additive blending
- Single sprite per cell, centered
- No borders, text, labels, or watermarks`;
}

/**
 * Build sprite prompt from spell intent and element
 */
export function buildSpritePromptFromSpell(
  intent: string,
  element: string,
  style?: string
): string {
  const elementStyles: Record<string, string> = {
    fire: 'warm orange glow with flickering edges',
    water: 'soft blue rippling orb with flowing edges',
    earth: 'earthy brown crystalline structure with solid presence',
    air: 'ethereal white wisps with transparent flowing tendrils',
    light: 'brilliant golden radiance with soft rays',
    shadow: 'deep purple darkness with subtle glowing edges',
    energy: 'electric blue-white crackling orb with plasma tendrils',
  };

  const intentStyles: Record<string, string> = {
    calm: 'gentle pulsing sphere, serene and peaceful',
    energize: 'dynamic spiraling form, vibrant and active',
    protect: 'solid geometric shield shape, strong and stable',
    transform: 'shifting morphing form, transitional and fluid',
    manifest: 'crystallizing structure, forming and solidifying',
    connect: 'interconnected threads, weaving and linking',
  };

  const elementStyle = elementStyles[element] || 'mystical glowing orb';
  const intentStyle = intentStyles[intent] || 'magical particle';

  const description = `${elementStyle}, ${intentStyle}`;
  return buildSpritePrompt(description, style);
}

// ============ VALIDATION ============

/**
 * Calculate average brightness of a region
 */
function getRegionBrightness(
  pixels: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  regionWidth: number,
  regionHeight: number
): number {
  let sum = 0;
  let count = 0;

  for (let y = startY; y < startY + regionHeight; y++) {
    for (let x = startX; x < startX + regionWidth; x++) {
      const idx = (y * width + x) * 4;
      // Average RGB
      const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
      sum += brightness;
      count++;
    }
  }

  return count > 0 ? sum / (count * 255) : 0;
}

/**
 * Calculate average alpha of edge regions
 */
function getEdgeAlpha(
  pixels: Uint8Array,
  width: number,
  height: number,
  edgeWidth: number
): number {
  let sum = 0;
  let count = 0;

  // Top edge
  for (let y = 0; y < edgeWidth; y++) {
    for (let x = 0; x < width; x++) {
      sum += pixels[(y * width + x) * 4 + 3];
      count++;
    }
  }

  // Bottom edge
  for (let y = height - edgeWidth; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sum += pixels[(y * width + x) * 4 + 3];
      count++;
    }
  }

  // Left edge (excluding corners already counted)
  for (let y = edgeWidth; y < height - edgeWidth; y++) {
    for (let x = 0; x < edgeWidth; x++) {
      sum += pixels[(y * width + x) * 4 + 3];
      count++;
    }
  }

  // Right edge (excluding corners already counted)
  for (let y = edgeWidth; y < height - edgeWidth; y++) {
    for (let x = width - edgeWidth; x < width; x++) {
      sum += pixels[(y * width + x) * 4 + 3];
      count++;
    }
  }

  return count > 0 ? sum / (count * 255) : 0;
}

/**
 * Detect image format from magic bytes. Gemini-3.x image generation
 * returns JPEG by default, not PNG; older Gemini-2.x flash-image-exp
 * returned PNG. We accept all three formats TD's moviefilein supports.
 */
export type DetectedImageFormat = 'png' | 'jpeg' | 'webp' | 'unknown';

export function detectImageFormat(imageData: Buffer): DetectedImageFormat {
  if (imageData.length < 12) return 'unknown';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    imageData[0] === 0x89 && imageData[1] === 0x50 &&
    imageData[2] === 0x4e && imageData[3] === 0x47
  ) return 'png';
  // JPEG: FF D8 FF
  if (
    imageData[0] === 0xff && imageData[1] === 0xd8 && imageData[2] === 0xff
  ) return 'jpeg';
  // WebP: "RIFF" .... "WEBP"
  if (
    imageData[0] === 0x52 && imageData[1] === 0x49 &&
    imageData[2] === 0x46 && imageData[3] === 0x46 &&
    imageData[8] === 0x57 && imageData[9] === 0x45 &&
    imageData[10] === 0x42 && imageData[11] === 0x50
  ) return 'webp';
  return 'unknown';
}

/**
 * Validate sprite image data — accepts any format TD's moviefilein
 * supports (PNG / JPEG / WebP). Includes a pixel-level check for a
 * light background (Imagen sometimes ignores the "PURE BLACK
 * background" instruction in the prompt and returns sprites on white).
 */
export function validateSpriteImage(
  imageData: Buffer,
  _expectedSize: number = SPRITE_SIZE
): ValidationResult {
  if (imageData.length < 100) {
    return { isValid: false, message: 'Image data too small' };
  }
  const format = detectImageFormat(imageData);
  if (format === 'unknown') {
    return {
      isValid: false,
      message: `Unrecognized image format (first 12 bytes: ${imageData.subarray(0, 12).toString('hex')})`,
    };
  }
  const bg = detectBorderBrightness(imageData);
  if (bg && bg.isLight) {
    return {
      isValid: false,
      message: `Sprite has a light background (avg border brightness ${bg.avgBrightness.toFixed(2)} of 1.0). Particles need a black/dark background so additive blending composites cleanly. Regenerate with stronger emphasis on "pure black background, RGB 0,0,0".`,
    };
  }
  return {
    isValid: true,
    message: `Valid ${format.toUpperCase()} (border bg=${bg ? bg.avgBrightness.toFixed(2) : 'n/a'})`,
    processedData: imageData,
  };
}

/**
 * Validate flipbook atlas — same format check + background-brightness
 * check as the single-sprite validator.
 */
export function validateFlipbookAtlas(
  imageData: Buffer,
  _expectedCols: number,
  _expectedRows: number
): ValidationResult {
  if (imageData.length < 100) {
    return { isValid: false, message: 'Image data too small' };
  }
  const format = detectImageFormat(imageData);
  if (format === 'unknown') {
    return {
      isValid: false,
      message: `Unrecognized image format (first 12 bytes: ${imageData.subarray(0, 12).toString('hex')})`,
    };
  }
  const bg = detectBorderBrightness(imageData);
  if (bg && bg.isLight) {
    return {
      isValid: false,
      message: `Flipbook atlas has a light background (avg border brightness ${bg.avgBrightness.toFixed(2)} of 1.0). Particles need a black/dark background so additive blending composites cleanly. Regenerate with stronger emphasis on "pure black background, RGB 0,0,0".`,
    };
  }
  return {
    isValid: true,
    message: `Valid ${format.toUpperCase()} atlas (border bg=${bg ? bg.avgBrightness.toFixed(2) : 'n/a'})`,
    processedData: imageData,
  };
}

/**
 * Sample the four borders of a decoded image and return the average
 * brightness of those edge pixels (0 = black, 1 = white). Returns null
 * if Electron's nativeImage couldn't decode the buffer (rare — would
 * have been caught by detectImageFormat already).
 *
 * Used to reject sprites whose background isn't dark enough for
 * additive blending in TD. Imagen sometimes ignores the prompt's
 * "PURE BLACK background" instruction and returns sprites on white —
 * those look broken when composited as particles, so we'd rather
 * reject + retry than ship a white-bordered atlas.
 *
 * Threshold of 0.4 is permissive: a properly-prompted sprite usually
 * has avg border brightness < 0.1, full-white is 1.0, so 0.4 catches
 * genuinely-light backgrounds without false-positives on sprites that
 * happen to extend close to the edges.
 */
function detectBorderBrightness(imageData: Buffer): {
  avgBrightness: number;
  isLight: boolean;
} | null {
  try {
    // Lazy-load electron to keep this module testable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeImage } = require('electron') as typeof import('electron');
    const img = nativeImage.createFromBuffer(imageData);
    const { width, height } = img.getSize();
    if (width === 0 || height === 0) return null;
    const pixels = img.toBitmap(); // BGRA
    let sum = 0;
    let count = 0;
    // Sample every ~32nd pixel along each border so this is O(1) cost
    // regardless of image size.
    const step = Math.max(1, Math.floor(Math.min(width, height) / 32));
    const sample = (x: number, y: number): void => {
      const i = (y * width + x) * 4;
      const b = pixels[i];
      const g = pixels[i + 1];
      const r = pixels[i + 2];
      // Rec. 601 luma — close enough for brightness check.
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      count++;
    };
    for (let x = 0; x < width; x += step) {
      sample(x, 0);
      sample(x, height - 1);
    }
    for (let y = 0; y < height; y += step) {
      sample(0, y);
      sample(width - 1, y);
    }
    if (count === 0) return null;
    const avgBrightness = sum / count / 255;
    return { avgBrightness, isLight: avgBrightness > 0.4 };
  } catch {
    return null;
  }
}

// ============ SPRITE GENERATOR CLASS ============

let genAI: GoogleGenAI | null = null;

/**
 * Initialize or get the Gemini client
 */
function ensureGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

/**
 * SpriteGenerator - handles sprite generation via Gemini
 */
export class SpriteGenerator {
  private pendingGenerations = new Map<string, Promise<GenerationResult>>();

  /**
   * Generate a single sprite from a description
   * Returns the default sprite immediately and generates in background
   */
  async generateSprite(
    description: string,
    options: SpriteOptions = {}
  ): Promise<SpriteAsset> {
    const style = options.style;
    const prompt = buildSpritePrompt(description, style, options.size);

    console.log(`[SpriteGen ${ts()}] Starting sprite generation: "${description}"`);

    // Start background generation
    const generationId = `sprite_${Date.now()}`;
    const generationPromise = this._generateSpriteInternal(prompt, description, options);
    this.pendingGenerations.set(generationId, generationPromise);

    // Return default sprite immediately
    const defaultPath = getDefaultSpritePath();
    const defaultAsset: SpriteAsset = {
      assetId: 'default',
      assetType: 'single',
      texturePath: defaultPath,
      frameCount: 1,
      atlasCols: 1,
      atlasRows: 1,
      width: SPRITE_SIZE,
      height: SPRITE_SIZE,
      createdAt: Date.now(),
    };

    // Clean up when done
    generationPromise.finally(() => {
      this.pendingGenerations.delete(generationId);
    });

    return defaultAsset;
  }

  /**
   * Generate a sprite and wait for the result
   */
  async generateSpriteSync(
    description: string,
    options: SpriteOptions = {}
  ): Promise<GenerationResult> {
    const style = options.style;
    const prompt = buildSpritePrompt(description, style, options.size);

    console.log(`[SpriteGen ${ts()}] Generating sprite (sync): "${description}"`);

    return this._generateSpriteInternal(prompt, description, options);
  }

  /**
   * Generate a flipbook atlas
   */
  async generateFlipbook(
    description: string,
    options: FlipbookOptions
  ): Promise<SpriteAsset> {
    const { frameCount, animation, style, playbackMode, frameDuration, driveSource } = options;

    // Get layout for frame count
    const layout = FLIPBOOK_LAYOUTS[frameCount];
    if (!layout) {
      throw new SpriteGenerationError(`Unsupported frame count: ${frameCount}. Use 4, 8, 9, 12, or 16.`);
    }
    const [cols, rows] = layout;

    const animDescription = animation ? `${description} with ${animation} animation` : description;
    const prompt = buildFlipbookPrompt(animDescription, style || 'soft glowing', frameCount, cols, rows);

    console.log(`[SpriteGen ${ts()}] Starting flipbook generation: "${description}" (${frameCount} frames, ${cols}x${rows})`);

    // Start background generation
    const generationId = `flipbook_${Date.now()}`;
    const generationPromise = this._generateFlipbookInternal(
      prompt,
      description,
      frameCount,
      cols,
      rows,
      options
    );
    this.pendingGenerations.set(generationId, generationPromise);

    // Return default sprite immediately
    const defaultPath = getDefaultSpritePath();
    const defaultAsset: SpriteAsset = {
      assetId: 'default',
      assetType: 'single',
      texturePath: defaultPath,
      frameCount: 1,
      atlasCols: 1,
      atlasRows: 1,
      width: SPRITE_SIZE,
      height: SPRITE_SIZE,
      createdAt: Date.now(),
    };

    // Clean up when done
    generationPromise.finally(() => {
      this.pendingGenerations.delete(generationId);
    });

    return defaultAsset;
  }

  /**
   * Generate a flipbook and wait for the result
   */
  async generateFlipbookSync(
    description: string,
    options: FlipbookOptions
  ): Promise<GenerationResult> {
    const { frameCount, animation, style } = options;

    const layout = FLIPBOOK_LAYOUTS[frameCount];
    if (!layout) {
      throw new SpriteGenerationError(`Unsupported frame count: ${frameCount}`);
    }
    const [cols, rows] = layout;

    const animDescription = animation ? `${description} with ${animation} animation` : description;
    const prompt = buildFlipbookPrompt(animDescription, style || 'soft glowing', frameCount, cols, rows);

    console.log(`[SpriteGen ${ts()}] Generating flipbook (sync): "${description}"`);

    return this._generateFlipbookInternal(prompt, description, frameCount, cols, rows, options);
  }

  /**
   * Internal sprite generation
   */
  private async _generateSpriteInternal(
    prompt: string,
    description: string,
    options: SpriteOptions
  ): Promise<GenerationResult> {
    try {
      const ai = ensureGenAI();

      // Call Gemini image generation
      console.log(`[SpriteGen ${ts()}] Calling Gemini image generation...`);

      const response = await withRetry(
        () => ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
          },
        }),
        { label: 'imagen:sprite' },
      );

      // Extract image from response
      let imageData: Buffer | null = null;
      const candidate = response.candidates?.[0];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('inlineData' in part && part.inlineData) {
            const base64Data = part.inlineData.data;
            if (base64Data) {
              imageData = Buffer.from(base64Data, 'base64');
              break;
            }
          }
        }
      }

      if (!imageData) {
        throw new SpriteGenerationError('No image data in Gemini response');
      }

      console.log(`[SpriteGen ${ts()}] Received image: ${imageData.length} bytes`);

      // Validate
      const validation = validateSpriteImage(imageData);
      if (!validation.isValid) {
        throw new SpriteGenerationError(`Validation failed: ${validation.message}`);
      }

      // Save asset
      const asset = saveSprite(validation.processedData || imageData, {
        assetType: 'single',
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        metadata: {
          prompt: description,
          style: options.style,
        },
      });

      console.log(`[SpriteGen ${ts()}] Saved sprite: ${asset.assetId}`);

      // Extract palette from the saved file. Decoded via Electron's
      // nativeImage so PNG/JPEG/WebP all work without a new dep.
      const { extractPaletteFromFile } = await import('./palette');
      const palette = extractPaletteFromFile(asset.texturePath);

      return {
        success: true,
        asset,
        palette,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SpriteGen ${ts()}] Generation failed: ${message}`);

      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Internal flipbook generation
   */
  private async _generateFlipbookInternal(
    prompt: string,
    description: string,
    frameCount: number,
    cols: number,
    rows: number,
    options: FlipbookOptions
  ): Promise<GenerationResult> {
    try {
      const ai = ensureGenAI();

      console.log(`[SpriteGen ${ts()}] Calling Gemini for flipbook atlas...`);

      const response = await withRetry(
        () => ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
          },
        }),
        { label: 'imagen:flipbook' },
      );

      // Extract image from response
      let imageData: Buffer | null = null;
      const candidate = response.candidates?.[0];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('inlineData' in part && part.inlineData) {
            const base64Data = part.inlineData.data;
            if (base64Data) {
              imageData = Buffer.from(base64Data, 'base64');
              break;
            }
          }
        }
      }

      if (!imageData) {
        throw new SpriteGenerationError('No image data in Gemini response');
      }

      console.log(`[SpriteGen ${ts()}] Received flipbook atlas: ${imageData.length} bytes`);

      // Validate
      const validation = validateFlipbookAtlas(imageData, cols, rows);
      if (!validation.isValid) {
        throw new SpriteGenerationError(`Atlas validation failed: ${validation.message}`);
      }

      // Save asset
      const asset = saveSprite(validation.processedData || imageData, {
        assetType: 'flipbook',
        frameCount,
        atlasCols: cols,
        atlasRows: rows,
        width: cols * FLIPBOOK_FRAME_SIZE,
        height: rows * FLIPBOOK_FRAME_SIZE,
        metadata: {
          prompt: description,
          style: options.style,
          animation: options.animation,
        },
      });

      // Build flipbook config
      const flipbookConfig = getFlipbookConfig(asset, {
        playbackMode: options.playbackMode,
        frameDuration: options.frameDuration,
        driveSource: options.driveSource,
      });

      console.log(`[SpriteGen ${ts()}] Saved flipbook: ${asset.assetId} (${frameCount} frames)`);

      // Extract palette from the middle frame so the colors represent the
      // animation's "peak" state rather than a frame-0 startup state that
      // may not be visually representative (e.g. fire that fades in).
      const { extractPaletteFromFile, middleFrameRect } = await import('./palette');
      const region = middleFrameRect(asset.width, asset.height, cols, rows, frameCount);
      const palette = extractPaletteFromFile(asset.texturePath, region);

      return {
        success: true,
        asset,
        flipbookConfig,
        palette,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SpriteGen ${ts()}] Flipbook generation failed: ${message}`);

      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Get number of pending generations
   */
  getPendingCount(): number {
    return this.pendingGenerations.size;
  }

  /**
   * Wait for all pending generations to complete
   */
  async waitForPending(): Promise<GenerationResult[]> {
    const results = await Promise.all(this.pendingGenerations.values());
    return results;
  }
}

// Export singleton instance
let spriteGeneratorInstance: SpriteGenerator | null = null;

export function getSpriteGenerator(): SpriteGenerator {
  if (!spriteGeneratorInstance) {
    spriteGeneratorInstance = new SpriteGenerator();
  }
  return spriteGeneratorInstance;
}
