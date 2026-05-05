/**
 * TD State Mirror
 *
 * Tracks the most recent render_mode and flipbook_config that test mode
 * has pushed to TouchDesigner. NOT authoritative — TD's actual state may
 * have drifted (e.g. someone edited TD directly) but this reflects what
 * Merlin last sent, which is good enough for the test panel readout.
 *
 * Pure module — no electron / fs / WS dependencies. Both test-sprite
 * and test-render-mode write into this; the Render Mode tab reads from
 * it via getMirroredState().
 */

import type { MirroredTDState, RenderMode, SpriteFlipbookConfig } from '../../shared/types';

export const DEFAULT_MIRROR: MirroredTDState = {
  renderMode: 'mesh',
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

function cloneDefault(): MirroredTDState {
  return {
    renderMode: DEFAULT_MIRROR.renderMode,
    flipbook: { ...DEFAULT_MIRROR.flipbook },
    lastUpdatedAt: null,
    lastSource: null,
  };
}

/** Returns a deep copy so callers cannot mutate internal state. */
export function getMirroredState(): MirroredTDState {
  return {
    renderMode: state.renderMode,
    flipbook: { ...state.flipbook },
    lastUpdatedAt: state.lastUpdatedAt,
    lastSource: state.lastSource,
  };
}

export function recordRenderModePush(mode: RenderMode): void {
  state.renderMode = mode;
  state.lastUpdatedAt = Date.now();
  state.lastSource = 'render_mode';
}

export function recordFlipbookConfigPush(config: SpriteFlipbookConfig): void {
  state.flipbook = { ...config };
  state.lastUpdatedAt = Date.now();
  state.lastSource = 'flipbook_config';
}

/** Test-only reset between vitest cases. */
export function resetMirror(): void {
  state = cloneDefault();
}
