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
 * OSC connection statistics
 */
export interface OscStats {
  /** Whether OSC is enabled */
  enabled: boolean;
  /** Target host */
  host: string;
  /** Target port */
  port: number;
  /** Messages sent per second */
  messagesPerSecond: number;
}
