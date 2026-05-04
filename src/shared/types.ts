/**
 * Shared types between main and renderer processes
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PoseData {
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
}

export interface FaceData {
  bbox: BoundingBox;
  landmarks: Array<{ x: number; y: number }>;
}

export interface TrackingFrame {
  timestamp: number;
  fps: number;
  pose: PoseData | null;
  face: FaceData | null;
  hasSegmentation: boolean;
  /** Frame width (after rotation if in portrait mode) */
  frameWidth: number;
  /** Frame height (after rotation if in portrait mode) */
  frameHeight: number;
  /** Whether the frame is in portrait orientation (camera rotated 90°) */
  isPortrait: boolean;
}

export interface Config {
  camera: {
    deviceId?: string;
    width: number;
    height: number;
    targetFps: number;
  };
  mediapipe: {
    enablePose: boolean;
    enableFace: boolean;
    enableSegmentation: boolean;
  };
  osc: {
    enabled: boolean;
    host: string;
    port: number;
  };
  spout: {
    enabled: boolean;
    senderName: string;
  };
}

/**
 * Micro-expression analysis result from Gemini
 */
export interface MicroExpressionAnalysis {
  /** Overall emotional valence (-1 to 1, negative to positive) */
  valence: number;
  /** Arousal level (0 to 1, calm to excited) */
  arousal: number;
  /** Primary detected emotion */
  primaryEmotion: string;
  /** Secondary emotion if present */
  secondaryEmotion?: string;
  /** Confidence in the analysis (0 to 1) */
  confidence: number;
  /** Detected micro-expressions */
  microExpressions: Array<{
    type: string;
    timestamp: 'early' | 'middle' | 'late';
    intensity: number;
  }>;
  /** Brief narrative description */
  description: string;
  /** Raw response for debugging */
  rawResponse?: string;
}

/**
 * Body language analysis result from Gemini
 */
export interface BodyLanguageAnalysis {
  /** Openness level (-1 defensive/closed to 1 open/engaged) */
  openness: number;
  /** Tension level (0 relaxed to 1 tense) */
  tension: number;
  /** Engagement level (0 disengaged to 1 highly engaged) */
  engagement: number;
  /** Primary posture type */
  primaryPosture: string;
  /** Types of gestures observed */
  gestureTypes: string[];
  /** Movement level (0 still to 1 active) */
  movementLevel: number;
  /** Confidence in the analysis (0 to 1) */
  confidence: number;
  /** Key observations */
  observations: string[];
  /** Brief narrative description */
  description: string;
  /** Raw response for debugging */
  rawResponse?: string;
}

/**
 * WebSocket bridge connection statistics
 */
export interface BridgeStats {
  /** Whether a client is connected */
  connected: boolean;
  /** Server port */
  port: number;
}

/**
 * Voice command result from Gemini
 */
export interface VoiceCommandResult {
  /** Whether a valid command was recognized */
  understood: boolean;
  /** The action to perform */
  action: VoiceCommandAction | null;
  /** Human-readable response to show the user */
  response: string;
  /** Confidence in the interpretation (0 to 1) */
  confidence: number;
}

/**
 * Possible voice command actions
 */
export type VoiceCommandAction =
  | { type: 'toggle_pose'; enabled: boolean }
  | { type: 'toggle_face'; enabled: boolean }
  | { type: 'toggle_segmentation'; enabled: boolean }
  | { type: 'toggle_pose_overlay'; enabled: boolean }
  | { type: 'toggle_face_overlay'; enabled: boolean }
  | { type: 'toggle_segmentation_overlay'; enabled: boolean }
  | { type: 'set_orientation'; portrait: boolean }
  | { type: 'capture_face' }
  | { type: 'capture_body' }
  | { type: 'start_auto_face'; intervalSeconds?: number }
  | { type: 'stop_auto_face' }
  | { type: 'start_auto_body'; intervalSeconds?: number }
  | { type: 'stop_auto_body' }
  | { type: 'set_face_interval'; seconds: number }
  | { type: 'set_body_interval'; seconds: number };

// ============ MERLIN TYPES ============

/**
 * Phases of the Merlin Mirror experience
 */
export type MerlinPhase =
  | 'idle'
  | 'wake'
  | 'intro'
  | 'discovery'
  | 'formation'
  | 'ready_to_cast'
  | 'casting'
  | 'outro';

/**
 * What the user seeks from the spell
 */
export type SpellIntent =
  | 'confidence'
  | 'calm'
  | 'protection'
  | 'clarity'
  | 'creativity'
  | 'transformation'
  | 'release'
  | 'focus'
  | 'joy'
  | 'wonder';

/**
 * Elemental nature of the spell
 */
export type SpellElement =
  | 'fire'
  | 'water'
  | 'air'
  | 'earth'
  | 'light'
  | 'shadow'
  | 'crystal'
  | 'storm'
  | 'flora'
  | 'cosmic';

/**
 * Body part that casts the spell
 */
export type CastingOrigin = 'hands' | 'heart' | 'eyes' | 'whole_body' | 'wand';

/**
 * Emotional tone/character of the spell
 */
export type SpellTone = 'gentle' | 'playful' | 'mysterious' | 'heroic' | 'calm' | 'wild';

/**
 * Core spell state that accumulates during the Merlin session
 */
export interface SpellState {
  intent: SpellIntent | null;
  element: SpellElement | null;
  tone: SpellTone | null;
  /** Energy level 0-1 */
  energy: number;
  /** Complexity level 0-1 */
  complexity: number;
  castingOrigin: CastingOrigin | null;
  /** Visual archetype name e.g. 'rising_embers' */
  visualArchetype: string | null;
  /** Hex color for the spell palette */
  palette: string | null;
  /** The magic word to trigger casting */
  magicWord: string | null;
  /** Confidence in the spell formation 0-1 */
  confidence: number;
}

/**
 * Response from the Merlin session
 */
export interface MerlinResponse {
  text: string;
  phase: MerlinPhase;
  spell: SpellState;
}

/**
 * Conversation message in Merlin session
 */
export interface MerlinConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Data sent to renderer for Merlin UI updates
 */
export interface MerlinUIUpdate {
  phase: MerlinPhase;
  turnCount: number;
  spell: SpellState;
  lastMessage?: MerlinConversationMessage;
  isListening: boolean;
  isProcessing: boolean;
}

/**
 * Merlin session state (for IPC)
 */
export interface MerlinSessionInfo {
  state: {
    phase: MerlinPhase;
    turnCount: number;
    spell: SpellState;
  };
  history: MerlinConversationMessage[];
  isActive: boolean;
}

// ============ TTS TYPES ============

/**
 * Result from Gemini TTS generation
 */
export interface TTSResult {
  /** Base64-encoded PCM audio data */
  audioBase64: string;
  /** Sample rate in Hz (typically 24000) */
  sampleRate: number;
  /** Number of channels (typically 1 for mono) */
  channels: number;
  /** Bit depth (typically 16) */
  bitDepth: number;
}
