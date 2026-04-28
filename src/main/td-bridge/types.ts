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
  | { type: 'ping' };

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
