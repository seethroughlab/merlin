/**
 * TD State Mirror
 *
 * Tracks the most recent flipbook_config that test mode has pushed to
 * TouchDesigner. NOT authoritative — TD's actual state may have drifted
 * (e.g. someone edited TD directly) but this reflects what Merlin last
 * sent, which is good enough for the test panel readout.
 *
 * Pure module — no electron / fs / WS dependencies. Written by
 * test-sprite (after a flipbook generation) and test-flipbook (after
 * a re-config); read by the Flipbook tab via getMirroredState().
 *
 * Mesh-mode rendering and its render_mode toggle have been pruned;
 * see docs/mesh-mode-pipeline.md if we ever bring them back.
 */

import type { MirroredTDState, SpriteFlipbookConfig } from '../../shared/types';

export const DEFAULT_MIRROR: MirroredTDState = {
  flipbook: {
    atlasCols: 1,
    atlasRows: 1,
    frameCount: 1,
    playbackMode: 'loop',
    frameDuration: 0.1,
    driveSource: 'age',
  },
  lastUpdatedAt: null,
  lastSource: null,
};

let state: MirroredTDState = cloneDefault();

/**
 * Local-only record of the most-recently-pushed sprite. Read by
 * request_visual_feedback so Gemini can be shown the active sprite
 * alongside the screenshot ("compare these two — does the texture
 * match?"). Not part of MirroredTDState because the Flipbook tab
 * doesn't need it — it's a turn-runner concern.
 */
interface SpritePushRecord {
  assetId: string;
  texturePath: string;
  description?: string;
  /** 'flipbook' (atlas) or 'single'. */
  assetType: 'flipbook' | 'single';
  pushedAt: number;
}

let lastSpritePush: SpritePushRecord | null = null;

function cloneDefault(): MirroredTDState {
  return {
    flipbook: { ...DEFAULT_MIRROR.flipbook },
    lastUpdatedAt: null,
    lastSource: null,
  };
}

/** Returns a deep copy so callers cannot mutate internal state. */
export function getMirroredState(): MirroredTDState {
  return {
    flipbook: { ...state.flipbook },
    lastUpdatedAt: state.lastUpdatedAt,
    lastSource: state.lastSource,
  };
}

export function recordFlipbookConfigPush(config: SpriteFlipbookConfig): void {
  state.flipbook = { ...config };
  state.lastUpdatedAt = Date.now();
  state.lastSource = 'flipbook_config';
}

/** Record that a sprite was just pushed to TD (texture path on disk + metadata). */
export function recordSpriteTexturePush(record: {
  assetId: string;
  texturePath: string;
  description?: string;
  assetType: 'flipbook' | 'single';
}): void {
  lastSpritePush = { ...record, pushedAt: Date.now() };
}

/** Latest sprite push, or null if no sprite has been pushed this session. */
export function getLastSpritePush(): SpritePushRecord | null {
  return lastSpritePush ? { ...lastSpritePush } : null;
}

/** Test-only reset between vitest cases. */
export function resetMirror(): void {
  state = cloneDefault();
  lastSpritePush = null;
}
