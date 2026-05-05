/**
 * TD Bridge Types
 *
 * Type definitions for WebSocket communication between Merlin and TouchDesigner.
 */

import type { ParticleSpellProgram, CastEnvelope, SpellVisualMode } from '../merlin/types';
import type { CastingOrigin, PlaybackMode, DriveSource, RenderMode, FlipbookConfig } from '../../shared/types';

// Re-export so existing td-bridge consumers don't have to change their import path.
export type { PlaybackMode, DriveSource, RenderMode, FlipbookConfig };
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

export type TDOutboundMessage =
  | { type: 'mood_update'; mood: string; color?: string; intensity?: number }
  | { type: 'reveal_effect'; effect_type: string; intensity: number; duration: number; landmark?: number }
  | { type: 'aura_update'; color: string; size: number; behavior: string }
  | { type: 'skeleton_augment'; overlays: SkeletonOverlay[] }
  | { type: 'scene_params'; params: SceneParams }
  | { type: 'zone_update'; zone: ZoneName; glsl_code: string }
  | { type: 'orientation_update'; portrait: boolean; width: number; height: number }
  | { type: 'tracking_frame'; timestamp: number; fps: number; frame: FrameInfo; pose: PoseData; face: FaceData }
  | { type: 'merlin_state'; active: boolean; phase?: string; spell?: MerlinSpellState }
  | { type: 'analysis_update'; valence: number; arousal: number; tension: number; openness: number; engagement: number; primary_emotion: string }
  | { type: 'particle_spell_program'; mode: SpellVisualMode; program: ParticleSpellProgram }
  | { type: 'spell_charge'; origin: CastingOrigin; intensity: number; castingLandmarks: number[] }
  | { type: 'spell_cast'; origin: CastingOrigin; intensity: number; durationMs: number; envelope: CastEnvelope; program: ParticleSpellProgram }
  | { type: 'ping' }
  | { type: 'request_screenshot' }
  | { type: 'request_metrics' }
  // Sprite system messages
  | { type: 'sprite_texture'; assetId: string; texturePath: string }
  | { type: 'flipbook_config'; config: FlipbookConfigMessage }
  | { type: 'render_mode'; mode: RenderMode }
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

// ===== Analysis Data (for visuals) =====

/**
 * Psychological analysis values sent to TD to drive visuals.
 * Sent after each turn when AI provides analysis.
 */
export interface AnalysisUpdate {
  /** Emotional valence: -1 (negative) to 1 (positive) */
  valence: number;
  /** Arousal level: 0 (calm) to 1 (excited) */
  arousal: number;
  /** Tension level: 0 (relaxed) to 1 (tense) */
  tension: number;
  /** Openness: -1 (closed/defensive) to 1 (open/receptive) */
  openness: number;
  /** Engagement: 0 (disengaged) to 1 (highly engaged) */
  engagement: number;
  /** Primary detected emotion */
  primary_emotion: 'joy' | 'fear' | 'anger' | 'sadness' | 'surprise' | 'neutral';
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

export interface SkeletonOverlay {
  landmark_start: number;
  landmark_end: number;
  effect: 'glow' | 'trail' | 'geometric' | 'energy_line';
  color: string;
  intensity: number;
}

export interface SceneParams {
  particle_intensity?: 'subtle' | 'moderate' | 'intense' | 'overwhelming';
  particle_behavior?: 'calm' | 'orbiting' | 'attracted' | 'repelled' | 'burst' | 'trailing';
  particle_color?: string;
  aura_color?: string;
  aura_size?: number;
  background_mood?: 'mysterious' | 'warm' | 'cold' | 'electric' | 'transcendent';
}

// (Sprite system types — RenderMode, PlaybackMode, DriveSource,
// FlipbookConfig — are re-exported from shared/types at the top.)

// ===== Inbound Messages (TD → Merlin) =====

export type TDInboundMessage =
  | { type: 'td_ready'; capabilities: TDCapabilities }
  | { type: 'compile_result'; zone: string; success: boolean; error?: string }
  | { type: 'metrics'; fps: number; particle_count: number; coverage: number }
  | { type: 'visibility'; visible_particles: number; culled_particles: number; avg_brightness: number }
  | { type: 'screenshot_result'; base64: string; width: number; height: number }
  | { type: 'sprite_loaded'; assetId: string; success: boolean; error?: string }
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
