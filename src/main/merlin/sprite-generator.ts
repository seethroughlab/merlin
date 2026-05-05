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

const ts = () => new Date().toISOString().slice(11, 23);

// ============ CONFIGURATION ============

const SPRITE_SIZE = 256;
const SPRITE_MIN_SIZE = 64;
const SPRITE_MAX_SIZE = 1024;

const FLIPBOOK_FRAME_SIZE = 128;

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
  frameCount: 4 | 8 | 9 | 12 | 16 | 25;
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
  const styleText = style || 'soft and glowing';

  return `Generate a ${size}x${size} pixel particle sprite on a PURE BLACK background.

Visual description:
- A single ${description} shape centered in the image
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
  const totalWidth = cols * FLIPBOOK_FRAME_SIZE;
  const totalHeight = rows * FLIPBOOK_FRAME_SIZE;

  return `Generate a ${cols}x${rows} sprite sheet animation atlas.

Requirements:
- Single PNG image, exactly ${totalWidth}x${totalHeight} pixels total
- ${frameCount} animation frames arranged in a grid (left-to-right, top-to-bottom)
- Each frame: ${FLIPBOOK_FRAME_SIZE}x${FLIPBOOK_FRAME_SIZE} pixels
- PURE BLACK background (RGB 0,0,0) - NOT transparent, NOT checkered
- Each frame shows: ${description}
- Style: ${style}
- Each frame has bright content in center, fading to black at edges

Animation progression:
- Frame 1 (top-left): Animation START state
- Frame ${frameCount} (bottom-right): Animation END/loop point
- Frames should progress smoothly and continuously between states

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
 * Apply luminance-based alpha to raw RGBA pixel data
 * Black pixels become transparent, bright pixels become opaque
 */
function applyLuminanceAlpha(pixels: Uint8Array, width: number, height: number): void {
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    // ITU-R BT.601 luminance formula
    const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    pixels[idx + 3] = luminance;
  }
}

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
 * Validate sprite image data
 * For now, this is a simplified validation that assumes the image is already
 * in the correct format. Full validation would require image decoding.
 */
export function validateSpriteImage(
  imageData: Buffer,
  _expectedSize: number = SPRITE_SIZE
): ValidationResult {
  // For MVP, we accept the image data as-is since we don't have
  // image decoding libraries. The Gemini API returns valid PNGs.
  // In production, we would use sharp or jimp for validation.

  if (imageData.length < 100) {
    return {
      isValid: false,
      message: 'Image data too small',
    };
  }

  // Check PNG signature
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!imageData.subarray(0, 8).equals(pngSignature)) {
    return {
      isValid: false,
      message: 'Not a valid PNG file',
    };
  }

  // For MVP, accept the PNG as-is
  // TODO: Add sharp for proper validation and luminance-alpha conversion
  return {
    isValid: true,
    message: 'Valid PNG (basic validation)',
    processedData: imageData,
  };
}

/**
 * Validate flipbook atlas
 */
export function validateFlipbookAtlas(
  imageData: Buffer,
  _expectedCols: number,
  _expectedRows: number
): ValidationResult {
  // Basic PNG validation
  if (imageData.length < 100) {
    return {
      isValid: false,
      message: 'Image data too small',
    };
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!imageData.subarray(0, 8).equals(pngSignature)) {
    return {
      isValid: false,
      message: 'Not a valid PNG file',
    };
  }

  // TODO: Add sharp for proper atlas validation
  return {
    isValid: true,
    message: 'Valid PNG atlas (basic validation)',
    processedData: imageData,
  };
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
      throw new SpriteGenerationError(`Unsupported frame count: ${frameCount}. Use 4, 8, 9, 12, 16, or 25.`);
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

      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

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

      return {
        success: true,
        asset,
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

      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

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

      return {
        success: true,
        asset,
        flipbookConfig,
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
