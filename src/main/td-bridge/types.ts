/**
 * TD Bridge Types
 *
 * Type definitions for WebSocket communication between Parlor and TouchDesigner.
 */

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

// ===== Outbound Messages (Parlor → TD) =====

export type TDOutboundMessage =
  | { type: 'mood_update'; mood: string; color?: string; intensity?: number }
  | { type: 'reveal_effect'; effect_type: string; intensity: number; duration: number; landmark?: number }
  | { type: 'aura_update'; color: string; size: number; behavior: string }
  | { type: 'skeleton_augment'; overlays: SkeletonOverlay[] }
  | { type: 'scene_params'; params: SceneParams }
  | { type: 'zone_update'; zone: ZoneName; glsl_code: string }
  | { type: 'orientation_update'; portrait: boolean; width: number; height: number }
  | { type: 'tracking_frame'; timestamp: number; fps: number; frame: FrameInfo; pose: PoseData; face: FaceData }
  | { type: 'mentalist_state'; active: boolean; phase?: string; mood?: string; colorAccent?: string; particleBehavior?: string }
  | { type: 'analysis_update'; valence: number; arousal: number; tension: number; openness: number; engagement: number; primary_emotion: string }
  | { type: 'ping' };

// ===== Analysis Data (for visuals) =====

/**
 * Psychological analysis values sent to TD to drive visuals.
 * Sent after each mentalist turn when AI provides analysis.
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

// ===== Inbound Messages (TD → Parlor) =====

export type TDInboundMessage =
  | { type: 'td_ready'; capabilities: TDCapabilities }
  | { type: 'compile_result'; zone: string; success: boolean; error?: string }
  | { type: 'metrics'; fps: number; particle_count: number; coverage: number }
  | { type: 'pong' };

// ===== Callbacks =====

export interface TDBridgeCallbacks {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onReady?: (capabilities: TDCapabilities) => void;
  onMetrics?: (metrics: { fps: number; particle_count: number; coverage: number }) => void;
  onError?: (error: string) => void;
}
