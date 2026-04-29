/**
 * TD Bridge Push Methods
 *
 * Outbound methods for sending messages to TouchDesigner.
 */

import { send, isConnected } from './connection';
import type { SceneParams, SkeletonOverlay, ZoneName } from './types';
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

// ===== Mentalist State =====

export interface MentalistStateUpdate {
  active: boolean;
  phase?: string;
  mood?: string;
  colorAccent?: string;
  particleBehavior?: string;
}

/**
 * Update the mentalist session state
 * Replaces OSC-based mentalist updates
 */
export function pushMentalistState(state: MentalistStateUpdate): boolean {
  return guardedSend({ type: 'mentalist_state', ...state }, 'push mentalist state');
}
