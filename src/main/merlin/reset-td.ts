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
import type { ResetTDResult, ResetTDStep, ResetTDStatus, FlipbookConfig } from '../../shared/types';

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

/**
 * "TD doesn't have nodes for this zone" surfaces as an error string
 * containing one of these phrases. We treat those as skips, not
 * failures — the project just doesn't wire that zone up.
 */
const NOT_FOUND_PATTERNS = ['not found', 'unknown'];

function classifyPushError(error: string | undefined): { status: ResetTDStatus; note?: string; error?: string } {
  if (!error) return { status: 'ok' };
  const lower = error.toLowerCase();
  if (NOT_FOUND_PATTERNS.some(p => lower.includes(p))) {
    return { status: 'skipped', note: error };
  }
  return { status: 'error', error };
}

export async function resetTDBaseline(): Promise<ResetTDResult> {
  console.log(`[ResetTD ${ts()}] Starting baseline reset`);
  const steps: ResetTDStep[] = [];
  const record = (label: string, status: ResetTDStatus, opts: { error?: string; note?: string } = {}) => {
    steps.push({ label, status, ...opts });
    const tag = status === 'ok' ? 'OK' : status === 'skipped' ? `SKIPPED${opts.note ? ` - ${opts.note}` : ''}` : `FAIL${opts.error ? ` - ${opts.error}` : ''}`;
    console.log(`[ResetTD ${ts()}]   ${label}: ${tag}`);
  };

  // 1. Reset all marker-bearing zones. The validator rejects literally
  // empty strings, so use a comment as the no-op snippet — the template
  // injects it at {zone_code} where it has no effect, leaving the
  // template's default behavior in place. post_fx is the exception:
  // its template applies a vignette before {zone_code}, so we pass an
  // explicit pass-through that overwrites color.
  const NOOP = '// reset to defaults';
  for (const zone of getMarkerBearingZones()) {
    const code = zone === 'post_fx' ? POSTFX_PASSTHROUGH : NOOP;
    const r = await pushZoneUpdateWithValidation(zone, code);
    if (r.success) {
      record(`zone:${zone}`, 'ok');
    } else {
      const { status, note, error } = classifyPushError(r.error);
      record(`zone:${zone}`, status, { note, error });
    }
  }

  // 2. Sprite reset (TD reverts to its default radial gradient).
  const spriteOK = pushResetSprite();
  record('sprite', spriteOK ? 'ok' : 'error', { error: spriteOK ? undefined : 'TD not connected' });

  // 3. Render mode = mesh.
  const renderOK = pushRenderMode('mesh');
  if (renderOK) recordRenderModePush('mesh');
  record('render_mode', renderOK ? 'ok' : 'error', { error: renderOK ? undefined : 'TD not connected' });

  // 4. Flipbook 1x1 single frame.
  const fbOK = pushFlipbookConfig(BASELINE_FLIPBOOK);
  if (fbOK) recordFlipbookConfigPush(BASELINE_FLIPBOOK);
  record('flipbook', fbOK ? 'ok' : 'error', { error: fbOK ? undefined : 'TD not connected' });

  // 5. Idle particle program (low energy, generic motion).
  const idleOK = pushParticleSpellProgram('idle', createIdleProgram());
  record('idle_program', idleOK ? 'ok' : 'error', { error: idleOK ? undefined : 'TD not connected' });

  const errors = steps.filter(s => s.status === 'error').length;
  const skipped = steps.filter(s => s.status === 'skipped').length;
  const success = errors === 0;
  console.log(`[ResetTD ${ts()}] Done: ${success ? `all OK${skipped ? ` (${skipped} skipped)` : ''}` : `${errors} step(s) failed`}`);
  return { success, steps };
}
