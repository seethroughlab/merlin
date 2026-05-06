/**
 * Test Flipbook
 *
 * Standalone entry points for the Shift+T test panel's Flipbook tab.
 * Lets a developer re-configure flipbook playback (frameDuration /
 * playbackMode / driveSource) on an already-loaded billboard texture
 * without regenerating it.
 *
 * Each push records into td-state-mirror so the Flipbook tab readout
 * reflects what we last sent to TD.
 *
 * (Mesh-mode rendering, and the render-mode toggle that selected it,
 * have been pruned. See docs/mesh-mode-pipeline.md for the future-work
 * notes if we ever bring it back.)
 */

import { pushFlipbookConfig } from '../td-bridge';
import {
  getMirroredState,
  recordFlipbookConfigPush,
} from './td-state-mirror';
import type {
  MirroredTDState,
  FlipbookTestResult,
  SpriteFlipbookConfig,
} from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

export function applyFlipbookConfig(config: SpriteFlipbookConfig): FlipbookTestResult {
  console.log(
    `[TestFlipbook ${ts()}] applyFlipbookConfig(${config.atlasCols}x${config.atlasRows} ` +
    `frames=${config.frameCount} mode=${config.playbackMode} dur=${config.frameDuration} drive=${config.driveSource})`
  );
  const pushed = pushFlipbookConfig(config);
  if (pushed) recordFlipbookConfigPush(config);
  return { success: true, pushed, state: getMirroredState() };
}

export function getCurrentMirroredState(): MirroredTDState {
  return getMirroredState();
}
