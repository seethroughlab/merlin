/**
 * Test Render Mode
 *
 * Standalone entry points for the Shift+T test panel's Render Mode tab.
 * Lets a developer flip the renderer between mesh/billboard and
 * re-configure flipbook playback (frameDuration / playbackMode /
 * driveSource) without regenerating the texture.
 *
 * Each push records into td-state-mirror so the Render Mode tab readout
 * (and any future cross-tab consumer) reflects what we last sent to TD.
 */

import { pushRenderMode, pushFlipbookConfig } from '../td-bridge';
import {
  getMirroredState,
  recordRenderModePush,
  recordFlipbookConfigPush,
} from './td-state-mirror';
import type {
  MirroredTDState,
  RenderMode,
  RenderModeTestResult,
  SpriteFlipbookConfig,
} from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

export function setRenderMode(mode: RenderMode): RenderModeTestResult {
  console.log(`[TestRenderMode ${ts()}] setRenderMode(${mode})`);
  const pushed = pushRenderMode(mode);
  if (pushed) recordRenderModePush(mode);
  return { success: true, pushed, state: getMirroredState() };
}

export function applyFlipbookConfig(config: SpriteFlipbookConfig): RenderModeTestResult {
  console.log(
    `[TestRenderMode ${ts()}] applyFlipbookConfig(${config.atlasCols}x${config.atlasRows} ` +
    `frames=${config.frameCount} mode=${config.playbackMode} dur=${config.frameDuration} drive=${config.driveSource})`
  );
  const pushed = pushFlipbookConfig(config);
  if (pushed) recordFlipbookConfigPush(config);
  return { success: true, pushed, state: getMirroredState() };
}

export function getCurrentMirroredState(): MirroredTDState {
  return getMirroredState();
}
