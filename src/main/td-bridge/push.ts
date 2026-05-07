/**
 * TD Bridge Push Methods
 *
 * Outbound methods for sending messages to TouchDesigner.
 */

import { send, isConnected } from './connection';
import type { ZoneName, FlipbookConfigMessage } from './types';
import type { TrackingFrame, CastingOrigin } from '../../shared/types';
import type { CastEnvelope } from '../merlin/types';
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

// ===== Spell Cast =====

/**
 * Push spell cast trigger with envelope timing. TD switches to release
 * mode and animates the cast envelope; visuals come from whatever GLSL
 * Gemini wrote into the zones via set_zone_shader.
 */
export function pushSpellCast(
  origin: CastingOrigin,
  intensity: number,
  durationMs: number,
  envelope: CastEnvelope
): boolean {
  console.log(
    `[TDBridge ${ts()}] SPELL CAST! origin=${origin} duration=${durationMs}ms`
  );
  return guardedSend(
    { type: 'spell_cast', origin, intensity, durationMs, envelope },
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
 * Tell TouchDesigner to revert to its default sprite (the radial-gradient
 * dot). Handled by handle_reset_sprite in ws_callbacks.py.
 */
export function pushResetSprite(): boolean {
  console.log(`[TDBridge ${ts()}] Pushing reset_sprite`);
  return guardedSend({ type: 'reset_sprite' }, 'push reset sprite');
}
