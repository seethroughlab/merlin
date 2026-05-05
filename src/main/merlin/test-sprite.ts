/**
 * Test Sprite Generation
 *
 * Standalone entry points for the Shift+T test panel's Sprites tab.
 * Two modes:
 *   - generateSpriteDirect(spec): use a literal spec to drive Imagen
 *     and the TD push pipeline.
 *   - generateSpriteWithGemini(prompt): ask Gemini-2.5-flash to interpret
 *     a free-text prompt into the same `generate_sprite` tool args the
 *     live session uses, then delegate to generateSpriteDirect.
 *
 * Both paths run Imagen end-to-end (cost is intentional — we want to
 * exercise the full pipeline) and push to TD via the real WebSocket
 * bridge. The result includes `pushed.{texture,flipbook}` so the UI
 * can surface "TD not connected" without crashing.
 */

import { readFileSync } from 'fs';
import {
  GoogleGenerativeAI,
  FunctionCallingMode,
} from '@google/generative-ai';
import { GENERATE_SPRITE_TOOL } from './prompts';
import { getSpriteGenerator } from './sprite-generator';
import { getFlipbookConfig } from './asset-manager';
import { pushSpriteTexture, pushFlipbookConfig } from '../td-bridge';
import { recordFlipbookConfigPush } from './td-state-mirror';
import type {
  SpriteTestSpec,
  SpriteTestResult,
  SpriteFlipbookConfig,
  SpriteFrameCount,
  SpritePlaybackMode,
  SpriteDriveSource,
} from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

const VALID_FRAME_COUNTS: readonly SpriteFrameCount[] = [4, 8, 9, 12, 16, 25];
const VALID_PLAYBACK_MODES: readonly SpritePlaybackMode[] = ['loop', 'once', 'pingpong', 'random'];
const VALID_DRIVE_SOURCES: readonly SpriteDriveSource[] = ['age', 'life', 'velocity', 'id', 'time'];

let genAI: GoogleGenerativeAI | null = null;

function ensureGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

function readPngAsBase64(path: string): string | undefined {
  try {
    return readFileSync(path).toString('base64');
  } catch (e) {
    console.warn(`[TestSprite ${ts()}] Could not read PNG at ${path}: ${e}`);
    return undefined;
  }
}

/**
 * Direct-spec sprite generation: run Imagen with the given spec and
 * push to TD. `spec.animation` (truthy) or `spec.frameCount > 1`
 * triggers the flipbook path.
 */
export async function generateSpriteDirect(spec: SpriteTestSpec): Promise<SpriteTestResult> {
  const isFlipbook = Boolean(spec.animation) || (spec.frameCount !== undefined && spec.frameCount > 1);
  console.log(
    `[TestSprite ${ts()}] Direct: description="${spec.description}" ` +
    `mode=${isFlipbook ? 'flipbook' : 'single'}` +
    (isFlipbook ? ` frameCount=${spec.frameCount ?? 16}` : '')
  );

  const generator = getSpriteGenerator();

  if (isFlipbook) {
    const frameCount = (spec.frameCount ?? 16) as SpriteFrameCount;
    const result = await generator.generateFlipbookSync(spec.description, {
      frameCount,
      style: spec.style,
      animation: spec.animation,
      playbackMode: spec.playbackMode ?? 'loop',
      driveSource: spec.driveSource ?? 'age',
      frameDuration: spec.frameDuration,
    });

    if (!result.success || !result.asset) {
      return {
        success: false,
        error: result.error ?? 'Flipbook generation failed',
        pushed: { texture: false, flipbook: false },
      };
    }

    const asset = result.asset;
    const flipbook: SpriteFlipbookConfig = result.flipbookConfig ?? getFlipbookConfig(asset, {
      playbackMode: spec.playbackMode,
      frameDuration: spec.frameDuration,
      driveSource: spec.driveSource,
    });

    const texturePushed = pushSpriteTexture(asset.assetId, asset.texturePath);
    const flipbookPushed = pushFlipbookConfig(flipbook);
    if (flipbookPushed) recordFlipbookConfigPush(flipbook);

    return {
      success: true,
      assetId: asset.assetId,
      assetType: 'flipbook',
      texturePath: asset.texturePath,
      previewPng: readPngAsBase64(asset.texturePath),
      flipbookConfig: flipbook,
      pushed: { texture: texturePushed, flipbook: flipbookPushed },
    };
  }

  // Single sprite path
  const result = await generator.generateSpriteSync(spec.description, { style: spec.style });

  if (!result.success || !result.asset) {
    return {
      success: false,
      error: result.error ?? 'Sprite generation failed',
      pushed: { texture: false, flipbook: false },
    };
  }

  const asset = result.asset;
  const texturePushed = pushSpriteTexture(asset.assetId, asset.texturePath);

  return {
    success: true,
    assetId: asset.assetId,
    assetType: 'single',
    texturePath: asset.texturePath,
    previewPng: readPngAsBase64(asset.texturePath),
    pushed: { texture: texturePushed, flipbook: false },
  };
}

/**
 * Coerce raw Gemini tool-call args (loosely typed strings/numbers) into
 * a SpriteTestSpec, dropping anything that doesn't match the allowed
 * unions. Throws if `description` is missing.
 */
export function coerceGeminiArgs(args: Record<string, unknown>): SpriteTestSpec {
  const description = typeof args.description === 'string' ? args.description : '';
  if (!description) throw new Error('Gemini did not provide a description');

  const spec: SpriteTestSpec = { description };

  if (typeof args.style === 'string' && args.style) spec.style = args.style;
  if (typeof args.animation === 'string' && args.animation) spec.animation = args.animation;

  if (typeof args.frameCount === 'number' && (VALID_FRAME_COUNTS as readonly number[]).includes(args.frameCount)) {
    spec.frameCount = args.frameCount as SpriteFrameCount;
  }
  if (typeof args.playbackMode === 'string' && (VALID_PLAYBACK_MODES as readonly string[]).includes(args.playbackMode)) {
    spec.playbackMode = args.playbackMode as SpritePlaybackMode;
  }
  if (typeof args.driveSource === 'string' && (VALID_DRIVE_SOURCES as readonly string[]).includes(args.driveSource)) {
    spec.driveSource = args.driveSource as SpriteDriveSource;
  }

  return spec;
}

/**
 * Gemini-interpretation mode: free-text prompt → Gemini-2.5-flash with
 * the `generate_sprite` tool forced ON → coerce args → delegate to
 * generateSpriteDirect. The result includes `geminiArgs` so the UI
 * can show what Gemini picked.
 */
export async function generateSpriteWithGemini(prompt: string): Promise<SpriteTestResult> {
  console.log(`[TestSprite ${ts()}] Gemini interpretation: "${prompt}"`);

  const ai = ensureGenAI();
  const model = ai.getGenerativeModel({
    model: 'gemini-2.5-flash',
    tools: [{ functionDeclarations: [GENERATE_SPRITE_TOOL] }],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingMode.ANY,
        allowedFunctionNames: ['generate_sprite'],
      },
    },
  });

  const response = await model.generateContent(
    `Choose sprite parameters for this request. Call generate_sprite once with appropriate args.\n\nRequest: ${prompt}`
  );
  const candidate = response.response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let args: Record<string, unknown> | null = null;
  for (const part of parts) {
    if ('functionCall' in part && part.functionCall?.name === 'generate_sprite') {
      args = (part.functionCall.args ?? {}) as Record<string, unknown>;
      break;
    }
  }

  if (!args) {
    return {
      success: false,
      error: 'Gemini did not call generate_sprite',
      pushed: { texture: false, flipbook: false },
    };
  }

  let spec: SpriteTestSpec;
  try {
    spec = coerceGeminiArgs(args);
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      pushed: { texture: false, flipbook: false },
    };
  }

  console.log(`[TestSprite ${ts()}] Gemini chose: ${JSON.stringify(spec)}`);

  const result = await generateSpriteDirect(spec);
  return { ...result, geminiArgs: spec };
}
