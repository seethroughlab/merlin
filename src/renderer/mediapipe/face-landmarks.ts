/**
 * MediaPipe Face Landmarker — 468-point mesh + ARKit-style blendshapes.
 *
 * Runs alongside the existing FaceDetector (which only gives a bounding
 * box + 6 keypoints). The Landmarker gives us per-frame normalized
 * scores for jawOpen, mouthSmileLeft/Right, browInnerUp, eyeBlinkLeft/
 * Right, etc. — exactly what we need to turn facial expression into
 * trigger events for spell effects.
 *
 * Scope: renderer-only. Results stay in this process; no TD push, no
 * uniform wiring. Consumers (face-gesture event detector) read the
 * blendshapes via `getFaceBlendshapes()`.
 */

import {
  FaceLandmarker,
  FilesetResolver,
  FaceLandmarkerResult,
  DrawingUtils,
} from '@mediapipe/tasks-vision';

let faceLandmarker: FaceLandmarker | null = null;
let lastVideoTime = -1;
let results: FaceLandmarkerResult | null = null;

/**
 * Initialize the face landmarker. Loads the ~3 MB model from Google's
 * CDN (browser caches after first run). Outputs both 468 landmarks and
 * 52 ARKit blendshape scores per frame. Safe to call alongside
 * initPoseLandmarker / initFaceDetector — different model instances,
 * different GPU contexts.
 */
export async function initFaceLandmarker(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });

  console.log('FaceLandmarker initialized (blendshapes enabled)');
}

/**
 * Detect facial landmarks + blendshapes for the current frame. Mirrors
 * the pose detector's frame-dedup logic: if the source's currentTime
 * hasn't advanced, return cached results without re-running inference.
 */
export function detectFaceLandmarks(
  source: HTMLVideoElement | HTMLCanvasElement,
  timestamp: number,
): FaceLandmarkerResult | null {
  if (!faceLandmarker) return null;

  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;
  if (frameTime === lastVideoTime) return results;
  lastVideoTime = frameTime;

  results = faceLandmarker.detectForVideo(source as HTMLVideoElement, timestamp);
  return results;
}

/**
 * Convenience: pull just the blendshape category→score map from the
 * last detection, or null if no face was found. Keys are ARKit-style
 * blendshape names (jawOpen, mouthSmileLeft, browInnerUp, etc.).
 */
export function getFaceBlendshapes(): Map<string, number> | null {
  if (!results || !results.faceBlendshapes || results.faceBlendshapes.length === 0) {
    return null;
  }
  const categories = results.faceBlendshapes[0].categories;
  const map = new Map<string, number>();
  for (const c of categories) {
    if (c.categoryName) map.set(c.categoryName, c.score);
  }
  return map;
}

/**
 * Draw the 468-point face mesh wireframe on a canvas overlay. Uses
 * MediaPipe's built-in connection sets so the topology is correct (no
 * hand-coded index lists). Layered fine-to-coarse so the tesselation
 * sits behind the feature-specific outlines.
 *
 * Color scheme:
 *   gray tesselation, cyan eyes + brows, magenta lips, white face oval.
 * Tuned to be visible against typical webcam imagery without dominating it.
 */
export function drawFaceLandmarks(
  ctx: CanvasRenderingContext2D,
  result: FaceLandmarkerResult,
): void {
  const drawingUtils = new DrawingUtils(ctx);
  for (const landmarks of result.faceLandmarks) {
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#404040', lineWidth: 0.5 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: '#00FFFF', lineWidth: 1 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: '#00FFFF', lineWidth: 1 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#00FFFF', lineWidth: 1 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, { color: '#00FFFF', lineWidth: 1 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: '#FF00FF', lineWidth: 1.5 });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: '#FFFFFF', lineWidth: 1 });
  }
}

/**
 * Close the face landmarker and release GPU resources.
 */
export function closeFaceLandmarker(): void {
  if (faceLandmarker) {
    faceLandmarker.close();
    faceLandmarker = null;
  }
}
