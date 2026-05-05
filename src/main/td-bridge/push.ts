/**
 * TD Bridge Push Methods
 *
 * Outbound methods for sending messages to TouchDesigner.
 */

import { send, isConnected } from './connection';
import type { SceneParams, SkeletonOverlay, ZoneName, AnalysisUpdate, FlipbookConfigMessage, RenderMode } from './types';
import type { TrackingFrame, CastingOrigin } from '../../shared/types';
import type { ParticleSpellProgram, CastEnvelope, SpellVisualMode } from '../merlin/types';
import { validateGlslSnippet } from '../merlin/glsl-validator';
import { validateZoneCode, ZoneValidationError, isValidZoneName } from '../merlin/zone-registry';
import { zoneStateManager } from '../merlin/zone-state';

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Send a message with connection guard
 */
function guardedSend(message: object, description: string): boolean {
  if (!isConnected()) {
    console.log(`[TDBridge ${ts()}] Cannot ${description}: not connected`);
    return false;
  }
  return send(message);
}

// ===== Mood & Scene =====

/**
 * Update the current mood/atmosphere
 */
export function pushMoodUpdate(mood: string, color?: string, intensity?: number): boolean {
  return guardedSend({ type: 'mood_update', mood, color, intensity }, 'push mood');
}

/**
 * Update scene parameters (particles, aura, etc.)
 */
export function pushSceneParams(params: SceneParams): boolean {
  return guardedSend({ type: 'scene_params', params }, 'push scene params');
}

// ===== Effects =====

/**
 * Trigger a visual reveal effect
 */
export function pushRevealEffect(
  effect_type: string,
  intensity: number,
  duration: number,
  landmark?: number
): boolean {
  return guardedSend(
    { type: 'reveal_effect', effect_type, intensity, duration, landmark },
    'push reveal effect'
  );
}

/**
 * Update the aura around the participant
 */
export function pushAuraUpdate(color: string, size: number, behavior: string): boolean {
  return guardedSend({ type: 'aura_update', color, size, behavior }, 'push aura update');
}

// ===== Skeleton =====

/**
 * Update skeleton overlay effects
 */
export function pushSkeletonAugment(overlays: SkeletonOverlay[]): boolean {
  return guardedSend({ type: 'skeleton_augment', overlays }, 'push skeleton augment');
}

// ===== GLSL Zones =====

/**
 * Update a GLSL zone with a shader code snippet
 * The snippet gets merged into the zone's shader template at {zone_code}
 */
export function pushZoneUpdate(zone: ZoneName, zone_code: string): boolean {
  return guardedSend({ type: 'zone_update', zone, zone_code }, `push zone ${zone}`);
}

/**
 * Result of zone update with validation
 */
export interface ZoneUpdateResult {
  success: boolean;
  error?: string;
  warnings?: string[];
}

/**
 * Update a GLSL zone with full validation pipeline
 *
 * Steps:
 * 1. Syntax validation (balanced braces, parens, etc.)
 * 2. Zone contract validation (variables, line limits, banned keywords)
 * 3. Mark zone as pending, save previous code
 * 4. Send to TouchDesigner
 * 5. Wait for compile result from TD
 * 6. On failure: rollback to previous code
 */
export async function pushZoneUpdateWithValidation(
  zone: string,
  zoneCode: string,
  options: { timeoutMs?: number } = {}
): Promise<ZoneUpdateResult> {
  const timeoutMs = options.timeoutMs ?? 3000;

  // 1. Validate zone name
  if (!isValidZoneName(zone)) {
    return { success: false, error: `Unknown zone: ${zone}` };
  }

  // 2. Syntax validation
  const syntaxResult = validateGlslSnippet(zoneCode);
  if (!syntaxResult.isValid) {
    return { success: false, error: syntaxResult.error ?? 'Syntax error', warnings: syntaxResult.warnings };
  }

  // 3. Zone contract validation
  try {
    validateZoneCode(zone, zoneCode);
  } catch (e) {
    if (e instanceof ZoneValidationError) {
      return { success: false, error: e.message, warnings: syntaxResult.warnings };
    }
    throw e;
  }

  // 4. Check connection
  if (!isConnected()) {
    return { success: false, error: 'Not connected to TouchDesigner', warnings: syntaxResult.warnings };
  }

  // 5. Mark zone as pending and save previous code
  zoneStateManager.updateZone(zone, zoneCode);

  // 6. Send to TD
  const sent = send({ type: 'zone_update', zone, zone_code: zoneCode });
  if (!sent) {
    return { success: false, error: 'Failed to send to TouchDesigner', warnings: syntaxResult.warnings };
  }

  console.log(`[TDBridge ${ts()}] Zone '${zone}' sent for compilation`);

  // 7. Wait for compile result
  const compiled = await zoneStateManager.waitForCompileResult(zone, timeoutMs);

  if (!compiled) {
    // Get the error from zone state
    const error = zoneStateManager.getZoneError(zone) || 'Compilation failed';

    // Rollback to previous code
    const previousCode = zoneStateManager.rollbackZone(zone);
    if (previousCode !== null) {
      // Re-send the previous working code
      send({ type: 'zone_update', zone, zone_code: previousCode });
      console.log(`[TDBridge ${ts()}] Zone '${zone}' rolled back to previous code`);
    }

    return { success: false, error, warnings: syntaxResult.warnings };
  }

  return { success: true, warnings: syntaxResult.warnings };
}

// ===== Orientation =====

/**
 * Update orientation and frame dimensions
 * Call this when TD connects and when orientation changes
 */
export function pushOrientationUpdate(portrait: boolean, width: number, height: number): boolean {
  return guardedSend(
    { type: 'orientation_update', portrait, width, height },
    'push orientation'
  );
}

// ===== Tracking =====

/**
 * Send a tracking frame with pose and face data
 * Called every frame (30fps) - batches all landmarks into a single message
 */
export function pushTrackingFrame(frame: TrackingFrame): boolean {
  if (!isConnected()) return false;

  const message = {
    type: 'tracking_frame',
    timestamp: frame.timestamp,
    fps: frame.fps,
    frame: {
      width: frame.frameWidth,
      height: frame.frameHeight,
      portrait: frame.isPortrait,
    },
    pose: frame.pose
      ? {
          detected: true,
          landmarks: frame.pose.landmarks.map((lm) => [
            Math.round(lm.x * 10000) / 10000, // 4 decimal precision
            Math.round(lm.y * 10000) / 10000,
            Math.round(lm.z * 10000) / 10000,
            Math.round((lm.visibility ?? 1) * 100) / 100,
          ]),
        }
      : { detected: false },
    face: frame.face
      ? {
          detected: true,
          bbox: [
            frame.face.bbox.x,
            frame.face.bbox.y,
            frame.face.bbox.width,
            frame.face.bbox.height,
          ],
        }
      : { detected: false },
  };

  return send(message);
}

// ===== Merlin State =====

export interface MerlinStateUpdate {
  active: boolean;
  phase?: string;
  spell?: {
    intent?: string | null;
    element?: string | null;
    energy?: number;
    castingOrigin?: string | null;
    palette?: string | null;
    confidence?: number;
  };
}

/**
 * Update the Merlin session state
 * Sends spell-casting state to TD for visual effects
 */
export function pushMerlinState(state: MerlinStateUpdate): boolean {
  return guardedSend({ type: 'merlin_state', ...state }, 'push merlin state');
}

// ===== Analysis =====

/**
 * Push psychological analysis values to TD for visual feedback.
 * These values drive the "mirror/echo" AR effects:
 * - tension: edge energy around silhouette
 * - openness: aura expansion/contraction
 * - valence: color temperature and particle direction
 * - arousal: overall visual energy/speed
 * - engagement: skeleton glow intensity
 * - primary_emotion: color palette selection
 */
export function pushAnalysisUpdate(analysis: AnalysisUpdate): boolean {
  return guardedSend(
    {
      type: 'analysis_update',
      valence: analysis.valence,
      arousal: analysis.arousal,
      tension: analysis.tension,
      openness: analysis.openness,
      engagement: analysis.engagement,
      primary_emotion: analysis.primary_emotion,
    },
    'push analysis update'
  );
}

// ===== Particle Spell Program =====

/**
 * Push a complete particle spell program to TD.
 * Used for both buildup and release mode changes.
 */
export function pushParticleSpellProgram(
  mode: SpellVisualMode,
  program: ParticleSpellProgram
): boolean {
  console.log(
    `[TDBridge ${ts()}] Pushing spell program: mode=${mode} archetype=${program.archetype} energy=${program.energy.toFixed(2)}`
  );
  return guardedSend({ type: 'particle_spell_program', mode, program }, `push particle program (${mode})`);
}

/**
 * Push spell charge state (particles tightening around origin).
 * Called as user approaches casting readiness.
 */
export function pushSpellCharge(
  origin: CastingOrigin,
  intensity: number,
  castingLandmarks: number[]
): boolean {
  console.log(`[TDBridge ${ts()}] Pushing spell charge: origin=${origin} intensity=${intensity.toFixed(2)}`);
  return guardedSend(
    { type: 'spell_charge', origin, intensity, castingLandmarks },
    'push spell charge'
  );
}

/**
 * Push spell cast trigger with envelope timing.
 * Called when magic word + gesture detected.
 */
export function pushSpellCast(
  origin: CastingOrigin,
  intensity: number,
  durationMs: number,
  envelope: CastEnvelope,
  program: ParticleSpellProgram
): boolean {
  console.log(
    `[TDBridge ${ts()}] SPELL CAST! origin=${origin} duration=${durationMs}ms archetype=${program.archetype}`
  );
  return guardedSend(
    { type: 'spell_cast', origin, intensity, durationMs, envelope, program },
    'push spell cast'
  );
}

// ===== Sprite System =====

/**
 * Push a sprite texture to TouchDesigner.
 * TD will load the texture from the specified path and apply it to particles.
 */
export function pushSpriteTexture(assetId: string, texturePath: string): boolean {
  console.log(`[TDBridge ${ts()}] Pushing sprite texture: ${assetId}`);
  return guardedSend(
    { type: 'sprite_texture', assetId, texturePath },
    'push sprite texture'
  );
}

/**
 * Push flipbook configuration to TouchDesigner.
 * This configures the atlas grid, playback mode, and frame timing.
 */
export function pushFlipbookConfig(config: FlipbookConfigMessage): boolean {
  console.log(
    `[TDBridge ${ts()}] Pushing flipbook config: ${config.atlasCols}x${config.atlasRows} ` +
    `(${config.frameCount} frames, ${config.playbackMode}, drive=${config.driveSource})`
  );
  return guardedSend(
    { type: 'flipbook_config', config },
    'push flipbook config'
  );
}

/**
 * Push render mode change to TouchDesigner.
 * Switches between mesh-based and billboard-based particle rendering.
 */
export function pushRenderMode(mode: RenderMode): boolean {
  console.log(`[TDBridge ${ts()}] Pushing render mode: ${mode}`);
  return guardedSend(
    { type: 'render_mode', mode },
    'push render mode'
  );
}
