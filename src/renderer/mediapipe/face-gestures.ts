/**
 * Face-gesture event detector.
 *
 * Consumes ARKit-style blendshape scores from FaceLandmarker and emits
 * discrete trigger events when the participant starts / stops:
 *   - mouth_open   (jaw opens past threshold)
 *   - smile        (both mouth-smile shapes active past threshold)
 *   - brow_raise   (browInnerUp past threshold)
 *   - eye_closed   (both eyeBlink shapes past threshold — wink filtered out)
 *
 * Edge-triggered with hysteresis: each gesture has separate ON/OFF
 * thresholds so a signal hovering near the boundary doesn't fire a
 * stream of start/end events. A short MIN_GAP debounces rapid retriggers.
 *
 * Each event also includes the raw normalized intensity at the moment
 * of firing, so downstream consumers can scale effects.
 *
 * Scope: renderer-only for now. Consumers wire a callback via
 * `setFaceGestureCallback`; the renderer's main loop calls
 * `updateFaceGestures(blendshapes)` each frame.
 */

export type FaceGestureKind =
  | 'mouth_open'
  | 'smile'
  | 'brow_raise'
  | 'eye_closed';

export type FaceGestureEdge = 'start' | 'end';

export interface FaceGestureEvent {
  kind: FaceGestureKind;
  edge: FaceGestureEdge;
  /** Score at the moment of firing (0-1 normalized). */
  score: number;
  /** performance.now() at fire time. */
  timestamp: number;
}

type GestureConfig = {
  /** Score required to fire a 'start' event when currently OFF. */
  onThreshold: number;
  /** Score must fall below this to fire an 'end' event when currently ON. */
  offThreshold: number;
  /** Minimum gap (ms) between fires of the same edge for this gesture. */
  minGapMs: number;
  /** Pure function: blendshapes → 0-1 gesture intensity. */
  score: (b: Map<string, number>) => number;
};

const GESTURES: Record<FaceGestureKind, GestureConfig> = {
  mouth_open: {
    onThreshold: 0.35,
    offThreshold: 0.20,
    minGapMs: 300,
    score: (b) => b.get('jawOpen') ?? 0,
  },
  smile: {
    // Average of left + right so a one-sided smirk doesn't trigger;
    // either side alone caps the smile intensity at ~0.5.
    onThreshold: 0.40,
    offThreshold: 0.25,
    minGapMs: 400,
    score: (b) => {
      const l = b.get('mouthSmileLeft') ?? 0;
      const r = b.get('mouthSmileRight') ?? 0;
      return (l + r) / 2;
    },
  },
  brow_raise: {
    // browInnerUp captures the "surprise / curious" raise. Outer brows
    // also raise during full expressions but inner is the most reliable.
    onThreshold: 0.45,
    offThreshold: 0.25,
    minGapMs: 400,
    score: (b) => b.get('browInnerUp') ?? 0,
  },
  eye_closed: {
    // Both eyes closing — winks (single eye) are explicitly NOT
    // counted because they're often involuntary or accidental.
    onThreshold: 0.55,
    offThreshold: 0.30,
    minGapMs: 250,
    score: (b) => {
      const l = b.get('eyeBlinkLeft') ?? 0;
      const r = b.get('eyeBlinkRight') ?? 0;
      return Math.min(l, r); // require BOTH eyes
    },
  },
};

interface GestureState {
  active: boolean;
  lastFireMs: number;
}

const state: Record<FaceGestureKind, GestureState> = {
  mouth_open: { active: false, lastFireMs: 0 },
  smile: { active: false, lastFireMs: 0 },
  brow_raise: { active: false, lastFireMs: 0 },
  eye_closed: { active: false, lastFireMs: 0 },
};

let callback: ((evt: FaceGestureEvent) => void) | null = null;

/**
 * Register the consumer for face-gesture events. Called by the
 * renderer's startup wiring; replaces any previous callback.
 */
export function setFaceGestureCallback(cb: (evt: FaceGestureEvent) => void): void {
  callback = cb;
}

/**
 * Reset all gesture state. Call when a Merlin session starts/ends so
 * stale ON-states from a previous session don't suppress events.
 */
export function resetFaceGestureState(): void {
  for (const k of Object.keys(state) as FaceGestureKind[]) {
    state[k].active = false;
    state[k].lastFireMs = 0;
  }
}

/**
 * Run one frame's worth of detection. Pass the blendshapes Map from
 * `getFaceBlendshapes()`; null/undefined when no face is detected.
 * Fires edge events through the registered callback.
 */
export function updateFaceGestures(blendshapes: Map<string, number> | null): void {
  if (!blendshapes) {
    // Lost the face — fall back to "no signal" by gradually letting
    // active gestures decay via the next frame that has a face. No
    // synthetic 'end' events from a tracking dropout; that would fire
    // spuriously when the participant briefly looks down.
    return;
  }

  const now = performance.now();
  for (const kind of Object.keys(GESTURES) as FaceGestureKind[]) {
    const cfg = GESTURES[kind];
    const s = state[kind];
    const score = cfg.score(blendshapes);

    if (!s.active && score >= cfg.onThreshold && now - s.lastFireMs >= cfg.minGapMs) {
      s.active = true;
      s.lastFireMs = now;
      callback?.({ kind, edge: 'start', score, timestamp: now });
    } else if (s.active && score <= cfg.offThreshold && now - s.lastFireMs >= cfg.minGapMs) {
      s.active = false;
      s.lastFireMs = now;
      callback?.({ kind, edge: 'end', score, timestamp: now });
    }
  }
}
