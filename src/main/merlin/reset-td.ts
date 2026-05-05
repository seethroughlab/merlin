/**
 * Reset TD to Baseline
 *
 * Pushes a known-good clean state to TouchDesigner: empty zone code so
 * each shader template runs its default behavior, an explicit pass-
 * through for post_fx (the template's vignette would otherwise still
 * apply), the default sprite, mesh render mode, a 1x1 single-frame
 * flipbook config, and the idle particle program.
 *
 * Used by the sidebar "Reset to Baseline" button.
 */

import {
  pushZoneUpdateWithValidation,
  pushFlipbookConfig,
  pushRenderMode,
  pushResetSprite,
  pushParticleSpellProgram,
} from '../td-bridge';
import { createIdleProgram } from './particle-program';
import { getMarkerBearingZones } from './test-shader';
import {
  recordRenderModePush,
  recordFlipbookConfigPush,
} from './td-state-mirror';
import type { ResetTDResult, ResetTDStep, FlipbookConfig } from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * post_fx template applies a vignette before the {zone_code} marker.
 * To get true "no post-processing" we re-sample the input and overwrite
 * `color`, bypassing any earlier modifications.
 */
const POSTFX_PASSTHROUGH = '// reset baseline: bypass any earlier modifications\n    color = texture(sTD2DInputs[0], uv);';

/**
 * Baseline flipbook config pushed during reset: a 1x1 single-frame
 * "atlas" so the billboard shader's flipbook math becomes a no-op.
 */
const BASELINE_FLIPBOOK: FlipbookConfig = {
  atlasCols: 1,
  atlasRows: 1,
  frameCount: 1,
  playbackMode: 'loop',
  frameDuration: 0.1,
  driveSource: 'age',
};

export async function resetTDBaseline(): Promise<ResetTDResult> {
  console.log(`[ResetTD ${ts()}] Starting baseline reset`);
  const steps: ResetTDStep[] = [];
  const record = (label: string, ok: boolean, error?: string) => {
    steps.push({ label, ok, error });
    console.log(`[ResetTD ${ts()}]   ${label}: ${ok ? 'OK' : `FAIL${error ? ` - ${error}` : ''}`}`);
  };

  // 1. Reset all marker-bearing zones (empty code, except post_fx pass-through).
  for (const zone of getMarkerBearingZones()) {
    const code = zone === 'post_fx' ? POSTFX_PASSTHROUGH : '';
    const r = await pushZoneUpdateWithValidation(zone, code);
    record(`zone:${zone}`, r.success, r.error);
  }

  // 2. Sprite reset (TD reverts to its default radial gradient).
  record('sprite', pushResetSprite());

  // 3. Render mode = mesh.
  const renderOK = pushRenderMode('mesh');
  if (renderOK) recordRenderModePush('mesh');
  record('render_mode', renderOK, renderOK ? undefined : 'TD not connected');

  // 4. Flipbook 1x1 single frame.
  const fbOK = pushFlipbookConfig(BASELINE_FLIPBOOK);
  if (fbOK) recordFlipbookConfigPush(BASELINE_FLIPBOOK);
  record('flipbook', fbOK, fbOK ? undefined : 'TD not connected');

  // 5. Idle particle program (low energy, generic motion).
  const idleOK = pushParticleSpellProgram('idle', createIdleProgram());
  record('idle_program', idleOK, idleOK ? undefined : 'TD not connected');

  const success = steps.every(s => s.ok);
  console.log(`[ResetTD ${ts()}] Done: ${success ? 'all steps OK' : `${steps.filter(s => !s.ok).length} step(s) failed`}`);
  return { success, steps };
}
