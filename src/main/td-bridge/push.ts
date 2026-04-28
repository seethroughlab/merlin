/**
 * TD Bridge Push Methods
 *
 * Outbound methods for sending messages to TouchDesigner.
 */

import { send, isConnected } from './connection';
import type { SceneParams, SkeletonOverlay } from './types';

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
