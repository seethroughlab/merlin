/**
 * TD Bridge Types
 *
 * Type definitions for WebSocket communication between Merlin and TouchDesigner.
 */

import type { CastEnvelope } from '../merlin/types';
import type { CastingOrigin, PlaybackMode, DriveSource, FlipbookConfig } from '../../shared/types';

// Re-export so existing td-bridge consumers don't have to change their import path.
export type { PlaybackMode, DriveSource, FlipbookConfig };
/** @deprecated use FlipbookConfig from shared/types */
export type FlipbookConfigMessage = FlipbookConfig;

// ===== Connection State =====

export interface TDBridgeState {
  connected: boolean;
  tdReady: boolean;
  capabilities: TDCapabilities | null;
  lastMessageTime: number;
}

export interface TDCapabilities {
  hasParticles: boolean;
  hasAura: boolean;
  hasSkeletonOverlay: boolean;
  availableZones: string[];
}

// ===== Outbound Messages (Merlin → TD) =====

/**
 * Tween parameters for the TD-side energy CHOP. Configured per-spell
 * via the `set_cast_params` tool — Gemini matches the envelope to the
 * spell's character (slow drift vs explosive snap).
 */
export interface CastParams {
  /** Idle → peak lag in milliseconds. */
  riseMs?: number;
  /** Peak → idle lag in milliseconds. */
  fallMs?: number;
  /** Maximum energy at release (0–1). */
  peakEnergy?: number;
}

export type TDOutboundMessage =
  | { type: 'zone_update'; zone: ZoneName; glsl_code: string }
  | { type: 'orientation_update'; portrait: boolean; width: number; height: number }
  | { type: 'tracking_frame'; timestamp: number; fps: number; frame: FrameInfo; pose: PoseData; face: FaceData }
  | { type: 'merlin_state'; active: boolean; phase?: string; spell?: MerlinSpellState }
  | { type: 'spell_cast'; origin: CastingOrigin; intensity: number; durationMs: number; envelope: CastEnvelope }
  | ({ type: 'set_cast_params' } & CastParams)
  | { type: 'ping' }
  | { type: 'request_screenshot' }
  // Sprite system messages
  | { type: 'sprite_texture'; assetId: string; texturePath: string }
  | { type: 'flipbook_config'; config: FlipbookConfigMessage }
  | { type: 'reset_sprite' };

/**
 * Spell state for Merlin mode (subset for TD communication)
 */
export interface MerlinSpellState {
  intent?: string | null;
  element?: string | null;
  energy?: number;
  castingOrigin?: string | null;
  palette?: string | null;
  confidence?: number;
}

// ===== Tracking Data Types =====

export interface FrameInfo {
  width: number;
  height: number;
  portrait: boolean;
}

export interface PoseData {
  detected: boolean;
  landmarks?: number[][]; // Array of [x, y, z, visibility] tuples
}

export interface FaceData {
  detected: boolean;
  bbox?: number[]; // [x, y, width, height]
}

/**
 * Available GLSL zone names for particle effects
 * Expanded to match vibe-agent's POP system
 */
export type ZoneName =
  | 'force_field'        // Particle forces (tension, openness, valence)
  | 'spawn_behavior'     // Emission patterns (openness, arousal, engagement)
  | 'color_over_life'    // Color gradients (emotion, valence)
  | 'size_over_life'     // Size animation (arousal, tension)
  | 'velocity_modifier'; // Velocity adjustments (arousal, tension)

// (Sprite system types — PlaybackMode, DriveSource, FlipbookConfig —
// are re-exported from shared/types at the top.)

// ===== Inbound Messages (TD → Merlin) =====

export type TDInboundMessage =
  | { type: 'td_ready'; capabilities: TDCapabilities }
  | { type: 'compile_result'; zone: string; success: boolean; error?: string }
  | { type: 'metrics'; fps: number; particle_count: number; coverage: number }
  | { type: 'visibility'; visible_particles: number; culled_particles: number; avg_brightness: number; render_vs_webcam_diff?: number }
  | { type: 'screenshot_result'; base64: string; width: number; height: number }
  | { type: 'sprite_loaded'; assetId: string; success: boolean; error?: string }
  | { type: 'sprite_reset'; success: boolean }
  | { type: 'pong' };

// ===== Callbacks =====

export interface TDBridgeCallbacks {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onReady?: (capabilities: TDCapabilities) => void;
  onMetrics?: (metrics: { fps: number; particle_count: number; coverage: number }) => void;
  onCompileResult?: (result: { zone: string; success: boolean; error?: string }) => void;
  onSpriteLoaded?: (result: { assetId: string; success: boolean; error?: string }) => void;
  onError?: (error: string) => void;
}
