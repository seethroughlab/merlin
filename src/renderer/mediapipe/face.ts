/**
 * MediaPipe Face Detector
 *
 * Detects faces with bounding boxes and basic landmarks.
 */

import {
  FaceDetector,
  FilesetResolver,
  Detection,
} from '@mediapipe/tasks-vision';

let faceDetector: FaceDetector | null = null;
let lastVideoTime = -1;
let results: Detection[] = [];

/**
 * Initialize the face detector
 */
export async function initFaceDetector(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  // Use full-range model for better detection at distance
  // Short-range model only works well within 2 meters
  faceDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/latest/blaze_face_full_range.tflite',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.3,  // Lower threshold for better recall at distance
  });

  console.log('FaceDetector initialized (full-range model)');
}

/**
 * Process a video frame and return face detections
 * Accepts HTMLVideoElement or HTMLCanvasElement (for rotated frames)
 */
export function detectFaces(
  source: HTMLVideoElement | HTMLCanvasElement,
  timestamp: number
): Detection[] {
  if (!faceDetector) return [];

  // Only process new frames (use currentTime for video, timestamp for canvas)
  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;
  if (frameTime === lastVideoTime) return results;
  lastVideoTime = frameTime;

  const detections = faceDetector.detectForVideo(source as HTMLVideoElement, timestamp);
  results = detections.detections;
  return results;
}

/**
 * Draw face detections on a canvas
 */
export function drawFaces(
  ctx: CanvasRenderingContext2D,
  detections: Detection[],
  videoWidth: number,
  videoHeight: number
): void {
  ctx.strokeStyle = '#00FFFF';
  ctx.lineWidth = 2;
  ctx.fillStyle = '#00FFFF';
  ctx.font = '14px sans-serif';

  for (const detection of detections) {
    const bbox = detection.boundingBox;
    if (!bbox) continue;

    // Draw bounding box
    ctx.strokeRect(bbox.originX, bbox.originY, bbox.width, bbox.height);

    // Draw confidence score
    const score = detection.categories?.[0]?.score ?? 0;
    ctx.fillText(
      `Face: ${(score * 100).toFixed(0)}%`,
      bbox.originX,
      bbox.originY - 5
    );

    // Draw keypoints (eyes, nose, mouth, ears)
    if (detection.keypoints) {
      ctx.fillStyle = '#FFFF00';
      for (const keypoint of detection.keypoints) {
        const x = keypoint.x * videoWidth;
        const y = keypoint.y * videoHeight;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.fillStyle = '#00FFFF';
    }
  }
}

/**
 * Get the last detection results
 */
export function getLastFaceResults(): Detection[] {
  return results;
}

/**
 * Close the face detector
 */
export function closeFaceDetector(): void {
  if (faceDetector) {
    faceDetector.close();
    faceDetector = null;
  }
}
