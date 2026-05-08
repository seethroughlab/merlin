/**
 * Reset TD to Baseline
 *
 * Pushes a known-good clean state to TouchDesigner: empty zone code so
 * each shader template runs its default behavior, the default sprite,
 * a 1x1 single-frame flipbook config, default cast tween envelope, and
 * default particle simulation params.
 *
 * Mesh-mode rendering and its render_mode reset step have been pruned;
 * see docs/mesh-mode-pipeline.md if we ever bring it back. Archetype /
 * spell-program pushes have also been pruned — visuals come entirely
 * from Gemini's set_zone_shader calls during a session, and "baseline"
 * means "no zone code, just template defaults."
 *
 * post_fx note: the template includes default bloom + vignette before
 * {zone_code}, so "no zone code" at baseline now means subtle bloom +
 * vignette are visible. This matches the design intent of improvement-04
 * — particles should glow as light sources by default.
 *
 * Used by the sidebar "Reset to Baseline" button.
 */

import {
  pushZoneUpdateWithValidation,
  pushFlipbookConfig,
  pushResetSprite,
  pushCastParams,
  pushParticleParams,
} from '../td-bridge';
import type { CastParams, ParticleParams } from '../td-bridge';
import { getMarkerBearingZones } from './test-shader';
import { recordFlipbookConfigPush } from './td-state-mirror';
import type { ResetTDResult, ResetTDStep, ResetTDStatus, FlipbookConfig } from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);


/**
 * Baseline flipbook config pushed during reset: a 1x1 single-frame
 * "atlas" so the billboard shader's flipbook math becomes a no-op.
 *
 * Exported because the single-sprite push paths (turn-runner.ts and
 * test-sprite.ts) reuse this to clear any prior multi-frame flipbook
 * state when a non-flipbook sprite arrives — otherwise TD keeps
 * slicing the new texture by the previous spell's atlas grid.
 */
export const BASELINE_FLIPBOOK: FlipbookConfig = {
  atlasCols: 1,
  atlasRows: 1,
  frameCount: 1,
  playbackMode: 'loop',
  frameDuration: 0.1,
  driveSource: 'age',
};

/**
 * Baseline cast tween envelope pushed during reset. Fast rise/fall for
 * snappy iteration in the test panel; live sessions can override per
 * spell via the `set_cast_params` tool.
 */
export const BASELINE_CAST_PARAMS: CastParams = {
  riseMs: 600,
  fallMs: 800,
  peakEnergy: 1.0,
};

/**
 * Baseline particle simulation parameters pushed during reset so density,
 * blend mode, and spawn spread don't leak between spells. Per-spell
 * overrides come from the `set_particle_params` tool.
 *
 * blendMode='additive' is the default because most spell archetypes
 * (fire/light/plasma/energy) read as emissive. For non-emissive spells
 * (crystal/earth/shadow), the tool can switch to 'alpha'.
 */
export const BASELINE_PARTICLE_PARAMS: ParticleParams = {
  maxCount: 500,
  lifespan: 4.0,
  emitRate: 120,
  spawnRadius: 0.2,
  blendMode: 'additive',
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
  // template's default behavior in place. For post_fx that means the
  // default bloom + vignette in top_postfx.glsl run normally — i.e.
  // "baseline" includes a subtle particle glow.
  const NOOP = '// reset to defaults';
  for (const zone of getMarkerBearingZones()) {
    const r = await pushZoneUpdateWithValidation(zone, NOOP);
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

  // 3. Flipbook 1x1 single frame.
  const fbOK = pushFlipbookConfig(BASELINE_FLIPBOOK);
  if (fbOK) recordFlipbookConfigPush(BASELINE_FLIPBOOK);
  record('flipbook', fbOK ? 'ok' : 'error', { error: fbOK ? undefined : 'TD not connected' });

  // 4. Cast tween baseline so each Live Spell run starts from the same
  // fast rise/fall envelope regardless of what the previous run set.
  const castOK = pushCastParams(BASELINE_CAST_PARAMS);
  record('cast_params', castOK ? 'ok' : 'error', { error: castOK ? undefined : 'TD not connected' });

  // 5. Particle simulation baseline so density / lifespan / blend mode
  // don't leak between spells. Sets blend back to additive (the most
  // common spell archetype) — Gemini can switch to 'alpha' per-spell.
  const ppOK = pushParticleParams(BASELINE_PARTICLE_PARAMS);
  record('particle_params', ppOK ? 'ok' : 'error', { error: ppOK ? undefined : 'TD not connected' });

  const errors = steps.filter(s => s.status === 'error').length;
  const skipped = steps.filter(s => s.status === 'skipped').length;
  const success = errors === 0;
  console.log(`[ResetTD ${ts()}] Done: ${success ? `all OK${skipped ? ` (${skipped} skipped)` : ''}` : `${errors} step(s) failed`}`);
  return { success, steps };
}
