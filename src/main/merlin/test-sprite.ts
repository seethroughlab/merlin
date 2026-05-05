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
import { GENERATE_SPRITE_TOOL } from './prompts';
import { getSpriteGenerator } from './sprite-generator';
import { getFlipbookConfig } from './asset-manager';
import { pushSpriteTexture, pushFlipbookConfig } from '../td-bridge';
import { recordFlipbookConfigPush } from './td-state-mirror';
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import { startSingleToolChat } from './gemini-chat-helper';
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
 *
 * `_turnId` lets the Gemini-interpretation wrapper share its turn id so
 * the sidebar shows interpretation + push as one card. When omitted a
 * fresh turn id is allocated for direct-mode invocations.
 */
export async function generateSpriteDirect(
  spec: SpriteTestSpec,
  _turnId?: string,
): Promise<SpriteTestResult> {
  const isFlipbook = Boolean(spec.animation) || (spec.frameCount !== undefined && spec.frameCount > 1);
  console.log(
    `[TestSprite ${ts()}] Direct: description="${spec.description}" ` +
    `mode=${isFlipbook ? 'flipbook' : 'single'}` +
    (isFlipbook ? ` frameCount=${spec.frameCount ?? 16}` : '')
  );

  // If this is a standalone Direct call (no parent turn id), open a
  // sidebar turn to surface the activity. Imagen has no chat / system
  // prompt, so the turn is a synthetic "generate_sprite" tool call
  // tagged with the spec.
  const emitOwnTurn = !_turnId;
  const turnId = _turnId ?? nextTurnId();
  if (emitOwnTurn) {
    emitGeminiTurn({
      id: turnId,
      source: 'test_sprite',
      userPrompt: `[Direct] ${spec.description}`,
      toolCalls: [{ name: 'generate_sprite', args: spec as unknown as Record<string, unknown> }],
    });
  }

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
      emitGeminiTurn({
        id: turnId,
        source: 'test_sprite',
        pushResults: [{ label: 'imagen', success: false, error: result.error ?? 'Flipbook generation failed' }],
        final: emitOwnTurn,
      });
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

    emitGeminiTurn({
      id: turnId,
      source: 'test_sprite',
      pushResults: [
        { label: `sprite_texture (${asset.assetId})`, success: texturePushed, error: texturePushed ? undefined : 'TD not connected' },
        { label: 'flipbook_config', success: flipbookPushed, error: flipbookPushed ? undefined : 'TD not connected' },
      ],
      final: emitOwnTurn,
    });

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
    emitGeminiTurn({
      id: turnId,
      source: 'test_sprite',
      pushResults: [{ label: 'imagen', success: false, error: result.error ?? 'Sprite generation failed' }],
      final: emitOwnTurn,
    });
    return {
      success: false,
      error: result.error ?? 'Sprite generation failed',
      pushed: { texture: false, flipbook: false },
    };
  }

  const asset = result.asset;
  const texturePushed = pushSpriteTexture(asset.assetId, asset.texturePath);

  emitGeminiTurn({
    id: turnId,
    source: 'test_sprite',
    pushResults: [
      { label: `sprite_texture (${asset.assetId})`, success: texturePushed, error: texturePushed ? undefined : 'TD not connected' },
    ],
    final: emitOwnTurn,
  });

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
export function coerceSpriteArgs(args: Record<string, unknown>): SpriteTestSpec {
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
 * can show what Gemini picked. Emits sidebar events progressively.
 */
export async function generateSpriteWithGemini(prompt: string): Promise<SpriteTestResult> {
  console.log(`[TestSprite ${ts()}] Gemini interpretation: "${prompt}"`);

  const turnId = nextTurnId();
  const userPrompt =
    `Choose sprite parameters for this request. Call generate_sprite once with appropriate args.\n\nRequest: ${prompt}`;

  emitGeminiTurn({ id: turnId, source: 'test_sprite', userPrompt });

  let args: Record<string, unknown> | null = null;

  try {
    const handle = startSingleToolChat(GENERATE_SPRITE_TOOL);
    const response = await handle.send(userPrompt);
    const spriteCall = response.toolCalls.find(tc => tc.name === 'generate_sprite');
    if (spriteCall) args = spriteCall.args;

    emitGeminiTurn({
      id: turnId,
      source: 'test_sprite',
      responseText: response.text,
      toolCalls: response.toolCalls,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitGeminiTurn({ id: turnId, source: 'test_sprite', responseText: `Error: ${msg}`, final: true });
    return { success: false, error: msg, pushed: { texture: false, flipbook: false } };
  }

  if (!args) {
    emitGeminiTurn({ id: turnId, source: 'test_sprite', final: true });
    return {
      success: false,
      error: 'Gemini did not call generate_sprite',
      pushed: { texture: false, flipbook: false },
    };
  }

  let spec: SpriteTestSpec;
  try {
    spec = coerceSpriteArgs(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitGeminiTurn({ id: turnId, source: 'test_sprite', responseText: `Coercion error: ${msg}`, final: true });
    return {
      success: false,
      error: msg,
      pushed: { texture: false, flipbook: false },
    };
  }

  console.log(`[TestSprite ${ts()}] Gemini chose: ${JSON.stringify(spec)}`);

  // Delegate to Direct, sharing this turn id so push results land on
  // the same sidebar card as the Gemini interpretation.
  const result = await generateSpriteDirect(spec, turnId);
  emitGeminiTurn({ id: turnId, source: 'test_sprite', final: true });
  return { ...result, geminiArgs: spec };
}
