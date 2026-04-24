/**
 * MediaPipe Pose Landmarker
 *
 * Detects 33 pose landmarks with GPU acceleration via WebGL.
 */

import {
  PoseLandmarker,
  FilesetResolver,
  PoseLandmarkerResult,
  DrawingUtils,
} from '@mediapipe/tasks-vision';

let poseLandmarker: PoseLandmarker | null = null;
let lastVideoTime = -1;
let results: PoseLandmarkerResult | null = null;

/**
 * Initialize the pose landmarker
 */
export async function initPoseLandmarker(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  console.log('PoseLandmarker initialized');
}

/**
 * Process a video frame and return pose landmarks
 * Accepts HTMLVideoElement or HTMLCanvasElement (for rotated frames)
 */
export function detectPose(
  source: HTMLVideoElement | HTMLCanvasElement,
  timestamp: number
): PoseLandmarkerResult | null {
  if (!poseLandmarker) return null;

  // Only process new frames (use currentTime for video, timestamp for canvas)
  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;
  if (frameTime === lastVideoTime) return results;
  lastVideoTime = frameTime;

  results = poseLandmarker.detectForVideo(source as HTMLVideoElement, timestamp);
  return results;
}

/**
 * Draw pose landmarks on a canvas
 */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  result: PoseLandmarkerResult
): void {
  const drawingUtils = new DrawingUtils(ctx);

  for (const landmarks of result.landmarks) {
    // Draw connections (skeleton lines)
    drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
      color: '#00FF00',
      lineWidth: 2,
    });

    // Draw landmarks (points)
    drawingUtils.drawLandmarks(landmarks, {
      color: '#FF0000',
      radius: 3,
    });
  }
}

/**
 * Get the last detection results
 */
export function getLastResults(): PoseLandmarkerResult | null {
  return results;
}

/**
 * Close the pose landmarker
 */
export function closePoseLandmarker(): void {
  if (poseLandmarker) {
    poseLandmarker.close();
    poseLandmarker = null;
  }
}
