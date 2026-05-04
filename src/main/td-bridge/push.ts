/**
 * TD Bridge Push Methods
 *
 * Outbound methods for sending messages to TouchDesigner.
 */

import { send, isConnected } from './connection';
import type { SceneParams, SkeletonOverlay, ZoneName, AnalysisUpdate } from './types';
import type { TrackingFrame } from '../../shared/types';

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
 * Update a GLSL zone with new shader code
 */
export function pushZoneUpdate(zone: ZoneName, glsl_code: string): boolean {
  return guardedSend({ type: 'zone_update', zone, glsl_code }, `push zone ${zone}`);
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
