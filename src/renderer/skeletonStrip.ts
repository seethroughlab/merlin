/**
 * Skeleton Strip Capture
 *
 * Captures a filmstrip of skeleton poses over time for body language analysis.
 */

import { PoseLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import { getLastPoseResults } from './mediapipe';

interface SkeletonStripConfig {
  frameCount: number;      // Number of frames to capture (default: 8)
  intervalMs: number;      // Interval between captures (default: 625ms = 5s total)
  frameWidth: number;      // Width of each frame (default: 128px)
  frameHeight: number;     // Height of each frame (default: 192px for body proportions)
}

interface SkeletonStripResult {
  imageDataUrl: string;    // Base64 data URL of the filmstrip
  framesCaptured: number;  // Actual number of frames captured
  durationMs: number;      // Total capture duration
}

const DEFAULT_CONFIG: SkeletonStripConfig = {
  frameCount: 8,
  intervalMs: 625,         // 5 seconds / 8 frames
  frameWidth: 128,
  frameHeight: 192,        // Taller than wide for body proportions
};

/**
 * Capture a filmstrip of skeleton poses
 */
export async function captureSkeletonStrip(
  config: Partial<SkeletonStripConfig> = {}
): Promise<SkeletonStripResult | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { frameCount, intervalMs, frameWidth, frameHeight } = cfg;

  // Create canvas for the filmstrip (horizontal strip)
  const stripCanvas = document.createElement('canvas');
  stripCanvas.width = frameWidth * frameCount;
  stripCanvas.height = frameHeight;
  const stripCtx = stripCanvas.getContext('2d')!;

  // Fill with black background
  stripCtx.fillStyle = '#000';
  stripCtx.fillRect(0, 0, stripCanvas.width, stripCanvas.height);

  // Temp canvas for rendering individual skeleton frames
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = frameWidth;
  frameCanvas.height = frameHeight;
  const frameCtx = frameCanvas.getContext('2d')!;

  const startTime = performance.now();
  let framesCaptured = 0;

  // Capture frames at intervals
  for (let i = 0; i < frameCount; i++) {
    // Get pose from the last detection (from render loop)
    const poseResult = getLastPoseResults();

    if (i === 0) {
      console.log(`Skeleton strip: pose detected:`, poseResult?.landmarks?.length ?? 0, 'people');
    }

    if (poseResult && poseResult.landmarks.length > 0) {
      // Clear frame canvas to black
      frameCtx.fillStyle = '#000';
      frameCtx.fillRect(0, 0, frameWidth, frameHeight);

      // Render skeleton to frame canvas
      renderSkeleton(frameCtx, poseResult.landmarks[0], frameWidth, frameHeight);

      // Copy to filmstrip
      stripCtx.drawImage(frameCanvas, i * frameWidth, 0);
      framesCaptured++;
    }

    // Wait for next frame (except on last iteration)
    if (i < frameCount - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  const durationMs = performance.now() - startTime;

  if (framesCaptured === 0) {
    console.warn('No poses captured in skeleton strip');
    return null;
  }

  return {
    imageDataUrl: stripCanvas.toDataURL('image/jpeg', 0.9),
    framesCaptured,
    durationMs,
  };
}

/**
 * Render a skeleton to a canvas
 *
 * Note: DrawingUtils expects normalized 0-1 coordinates and automatically
 * scales them to the canvas dimensions.
 */
function renderSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Array<{ x: number; y: number; z: number; visibility?: number }>,
  _width: number,
  _height: number
): void {
  // Use MediaPipe's DrawingUtils for consistent rendering
  // DrawingUtils automatically scales normalized (0-1) coordinates to canvas size
  const drawingUtils = new DrawingUtils(ctx);

  // Draw connections (skeleton lines) in cyan
  drawingUtils.drawConnectors(
    landmarks as any,
    PoseLandmarker.POSE_CONNECTIONS,
    {
      color: '#00FFFF',
      lineWidth: 2,
    }
  );

  // Draw landmarks (joints) in white
  drawingUtils.drawLandmarks(landmarks as any, {
    color: '#FFFFFF',
    radius: 3,
  });
}

/**
 * Capture a single skeleton frame (for quick snapshots)
 */
export function captureSkeletonFrame(
  frameWidth: number = 256,
  frameHeight: number = 384
): string | null {
  const poseResult = getLastPoseResults();

  if (!poseResult || poseResult.landmarks.length === 0) {
    return null;
  }

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = frameWidth;
  canvas.height = frameHeight;
  const ctx = canvas.getContext('2d')!;

  // Black background
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, frameWidth, frameHeight);

  // Render skeleton
  renderSkeleton(ctx, poseResult.landmarks[0], frameWidth, frameHeight);

  return canvas.toDataURL('image/jpeg', 0.9);
}
