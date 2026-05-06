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

// ============ TEST SHADER TYPES ============

/**
 * Configuration for test shader generation
 */
export interface TestShaderConfig {
  intent: string;
  element: string;
  energy: number;
  /**
   * Optional subset of zones to generate. When omitted or empty, defaults to
   * all marker-bearing zones. Used by the Shaders-tab zone checkboxes.
   */
  zones?: string[];
}

/**
 * A named natural-language scenario that pre-fills the Shaders tab form.
 */
export interface ShaderTestPreset {
  id: string;
  label: string;
  intent: string;
  element: string;
  energy: number;
}

/**
 * Individual zone shader result
 */
export interface ZoneShaderResult {
  zone: string;
  glsl_code: string;
  description: string;
  /** Compile status: pending, active (compiled), or error */
  status?: 'pending' | 'active' | 'error';
  /** Error message if compilation failed */
  error?: string;
  /** Validation warnings */
  warnings?: string[];
}

/**
 * Result from test shader generation
 */
export interface TestShaderResult {
  zones: ZoneShaderResult[];
  rawResponse: string;
  success: boolean;
  error?: string;
}

// ============ SPRITE / FLIPBOOK TYPES ============

/**
 * Canonical playback / drive enums. Used by sprite generation, the
 * flipbook config message to TD, and the Render Mode tab.
 */
export type PlaybackMode = 'loop' | 'once' | 'pingpong' | 'random';
export type DriveSource = 'age' | 'life' | 'velocity' | 'id' | 'time';

/** Atlas frame counts the sprite generator supports. */
export type SpriteFrameCount = 4 | 8 | 9 | 12 | 16 | 25;

/** Backward-compat aliases — prefer the unprefixed names above. */
export type SpritePlaybackMode = PlaybackMode;
export type SpriteDriveSource = DriveSource;

/**
 * Direct-spec input for sprite test mode. Mirrors the args of the
 * live `generate_sprite` Gemini tool plus an explicit `frameDuration`.
 */
export interface SpriteTestSpec {
  description: string;
  style?: string;
  animation?: string;
  frameCount?: SpriteFrameCount;
  playbackMode?: SpritePlaybackMode;
  driveSource?: SpriteDriveSource;
  frameDuration?: number;
}

/**
 * Canonical flipbook configuration. Same shape used by the
 * `flipbook_config` WebSocket message and the local TD-state mirror.
 */
export interface FlipbookConfig {
  atlasCols: number;
  atlasRows: number;
  frameCount: number;
  playbackMode: PlaybackMode;
  frameDuration: number;
  driveSource: DriveSource;
}

/** Backward-compat alias — prefer FlipbookConfig. */
export type SpriteFlipbookConfig = FlipbookConfig;
/** Backward-compat alias — prefer FlipbookConfig. */
export type FlipbookConfigMessage = FlipbookConfig;

/**
 * Result of a sprite test generation.
 * `previewPng` is base64-encoded PNG content for inline rendering.
 * `pushed` reports whether each TD push attempt actually went out
 * (false when TD is disconnected — Imagen still ran).
 */
export interface SpriteTestResult {
  success: boolean;
  error?: string;
  assetId?: string;
  assetType?: 'single' | 'flipbook';
  texturePath?: string;
  previewPng?: string;
  flipbookConfig?: SpriteFlipbookConfig;
  /** Args Gemini chose, only set in Gemini-interpretation mode. */
  geminiArgs?: SpriteTestSpec;
  pushed: { texture: boolean; flipbook: boolean };
}

// ============ TEST RENDER MODE TYPES ============

export type RenderMode = 'mesh' | 'billboard';

/**
 * Local mirror of the most recent state we pushed to TD. Used by the
 * Render Mode tab readout. NOT authoritative — TD's actual state may
 * have drifted (e.g. user changed something in TD directly), but for
 * a developer test panel this reflects what the test mode last sent.
 */
export interface MirroredTDState {
  renderMode: RenderMode;
  flipbook: SpriteFlipbookConfig;
  /** ms epoch of last update, or null if never pushed in this process. */
  lastUpdatedAt: number | null;
  /** Which test-mode action produced the most recent update. */
  lastSource: 'render_mode' | 'flipbook_config' | null;
}

/**
 * Result of a render-mode or flipbook-config test push. `success: true`
 * even when `pushed: false` — the operation completed locally; the
 * message just didn't reach TD because we're not connected.
 */
export interface RenderModeTestResult {
  success: boolean;
  pushed: boolean;
  state: MirroredTDState;
  error?: string;
}

// ============ TEST SPELL PROGRAM TYPES ============

export type SpellProgramMode = 'buildup' | 'release';

/**
 * Input for the Spell Program test tab. The user picks a mode and a
 * free-text prompt; intent/element/origin are optional steering hints.
 * Gemini fills in the visual parameters via the set_spell_program tool.
 */
export interface SpellProgramTestInput {
  prompt: string;
  mode: SpellProgramMode;
  intent?: SpellIntent | null;
  element?: SpellElement | null;
  castingOrigin?: CastingOrigin | null;
}

/**
 * Result of a spell-program test push. `pushed` is false when TD is
 * disconnected. `geminiArgs` carries the raw structured args Gemini
 * returned (for UI inspection); `program` is the merged final payload
 * that was actually pushed.
 */
export interface SpellProgramTestResult {
  success: boolean;
  pushed: boolean;
  /** Final ParticleSpellProgram pushed to TD (typed loosely here so shared/ doesn't depend on main/merlin/types). */
  program?: Record<string, unknown>;
  /** Raw structured args Gemini chose. */
  geminiArgs?: Record<string, unknown>;
  error?: string;
}

// ============ GEMINI CONVERSATION EVENTS ============

/**
 * Source of a Gemini conversation turn — used to tag the sidebar card
 * so the user can tell live-session activity apart from each test-mode
 * surface.
 */
export type GeminiTurnSource =
  | 'live'
  | 'test_shader'
  | 'test_sprite'
  | 'test_spell_program';

/**
 * One Gemini tool call as it appears in the sidebar — name + args, plus
 * optional downstream effects (push to TD, validation result, etc.).
 */
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * One per-zone (or per-asset) push outcome surfaced to the sidebar so
 * the user can see ✓ / ✗ inline with the conversation.
 */
export interface GeminiPushResult {
  zone?: string;
  label?: string;
  success: boolean;
  error?: string;
  warnings?: string[];
}

/**
 * Marks the start of a retry round — visually shown as a divider in the
 * sidebar (e.g. "↻ retry 1/2 — force_field").
 */
export interface GeminiRetryMarker {
  attempt: number;
  total: number;
  zone?: string;
  reason?: string;
}

/**
 * One progressive event in a Gemini turn. The publisher emits multiple
 * partial events with the same `id` as the conversation evolves; the
 * renderer merges them into a single card.
 *
 * Lifecycle:
 *   1. Initial event with systemPrompt + userPrompt (turn opens)
 *   2. Response event(s) with responseText / toolCalls
 *   3. Push-result event(s) per zone/asset
 *   4. Optional retry markers + further response events
 *   5. Final event with `final: true` (turn closes)
 */
export interface GeminiTurn {
  /** Stable id for the whole turn — same across all partial emissions. */
  id: string;
  source: GeminiTurnSource;
  createdAt: number;
  /** Full system instruction sent to Gemini. Empty for tool-only sources. */
  systemPrompt?: string;
  userPrompt?: string;
  /** Free-text portion of Gemini's response. Concatenated across retries. */
  responseText?: string;
  toolCalls?: GeminiToolCall[];
  pushResults?: GeminiPushResult[];
  retry?: GeminiRetryMarker;
  /** True on the final emission; lets the renderer mark the card done. */
  final?: boolean;
}

// ============ RESET TD ============

/**
 * Status of one Reset to Baseline step.
 *  - 'ok'      : step pushed cleanly
 *  - 'skipped' : TD reported the target zone/node doesn't exist in this
 *                project (e.g. material_pixel without its glslMAT). Not
 *                a real failure — the project just doesn't use it.
 *  - 'error'   : actual push or compile failure
 */
export type ResetTDStatus = 'ok' | 'skipped' | 'error';

/**
 * One step of a TD baseline reset (e.g. "zone:force_field", "sprite",
 * "render_mode", "flipbook", "idle_program").
 */
export interface ResetTDStep {
  label: string;
  status: ResetTDStatus;
  /** Compile error or push failure detail. */
  error?: string;
  /** Skip reason (e.g. "MAT zone not found"). */
  note?: string;
}

/**
 * Result of a Reset to Baseline action. `success` is true when no step
 * has status 'error' — skips do not count as failure.
 */
export interface ResetTDResult {
  success: boolean;
  steps: ResetTDStep[];
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
