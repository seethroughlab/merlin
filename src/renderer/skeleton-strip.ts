/**
 * Skeleton Strip Capture
 *
 * Captures a filmstrip of body photos with skeleton overlay over time for
 * body-language analysis. Previously this rendered ONLY the skeleton on
 * a black background — a stick figure with no clothing context, no
 * hand-shape detail beyond 33 landmarks, no gestalt. Gemini Vision
 * couldn't read what a normal observer would see. Now each frame
 * contains the actual cropped body photo with the skeleton drawn semi-
 * transparently on top so Gemini has BOTH the image and the validated
 * pose landmarks.
 *
 * Caller MUST pass `frameSourceGetter` to enable photo compositing.
 * Without it, falls back to black-background skeleton-only (legacy
 * behavior).
 */

import { PoseLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import { getLastPoseResults } from './mediapipe';
import type { FrameSourceGetter } from './face-strip';

interface SkeletonStripConfig {
  frameCount: number;      // Number of frames to capture (default: 8)
  intervalMs: number;      // Interval between captures (default: 625ms = 5s total)
  frameWidth: number;      // Width of each frame (default: 192px — was 128, bumped for photo detail)
  frameHeight: number;     // Height of each frame (default: 288px — was 192, bumped for photo detail)
}

interface SkeletonStripResult {
  imageDataUrl: string;    // Base64 data URL of the filmstrip
  framesCaptured: number;  // Actual number of frames captured
  durationMs: number;      // Total capture duration
}

const DEFAULT_CONFIG: SkeletonStripConfig = {
  frameCount: 8,
  intervalMs: 625,         // 5 seconds / 8 frames
  frameWidth: 192,         // 1.5x previous size so the cropped body photo is readable to Gemini Vision
  frameHeight: 288,        // Taller than wide for body proportions
};

/**
 * Capture a filmstrip of body photos with skeleton overlay.
 */
export async function captureSkeletonStrip(
  config: Partial<SkeletonStripConfig> = {},
  frameSourceGetter?: FrameSourceGetter,
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
      // Clear frame canvas to black (visible as letterbox bars if the
      // cropped photo doesn't fill the frame cell).
      frameCtx.fillStyle = '#000';
      frameCtx.fillRect(0, 0, frameWidth, frameHeight);

      // Composite: real cropped body photo behind, skeleton overlay on
      // top. Falls back to skeleton-only on black if no frame source
      // is available.
      const landmarks = poseResult.landmarks[0];
      if (frameSourceGetter) {
        const { source: frameSource, width: sourceWidth, height: sourceHeight } = frameSourceGetter();
        // Compute body bbox from visible landmarks (filter out
        // low-visibility points so a partly-out-of-frame leg doesn't
        // distort the crop).
        const visible = landmarks.filter(l => (l.visibility ?? 1) > 0.3);
        if (visible.length > 0) {
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          for (const lm of visible) {
            if (lm.x < minX) minX = lm.x;
            if (lm.x > maxX) maxX = lm.x;
            if (lm.y < minY) minY = lm.y;
            if (lm.y > maxY) maxY = lm.y;
          }
          // 15% padding on each side so head + hands aren't clipped.
          const padX = (maxX - minX) * 0.15;
          const padY = (maxY - minY) * 0.15;
          const cropMinX = Math.max(0, minX - padX);
          const cropMinY = Math.max(0, minY - padY);
          const cropMaxX = Math.min(1, maxX + padX);
          const cropMaxY = Math.min(1, maxY + padY);
          const sx = cropMinX * sourceWidth;
          const sy = cropMinY * sourceHeight;
          const sw = (cropMaxX - cropMinX) * sourceWidth;
          const sh = (cropMaxY - cropMinY) * sourceHeight;
          // Fit the crop into the frame cell preserving aspect ratio
          // (letterboxed); avoids stretching the body's proportions.
          const cellAspect = frameWidth / frameHeight;
          const cropAspect = sw / sh;
          let dx = 0, dy = 0, dw = frameWidth, dh = frameHeight;
          if (cropAspect > cellAspect) {
            // crop wider than cell → letterbox top/bottom
            dh = frameWidth / cropAspect;
            dy = (frameHeight - dh) / 2;
          } else {
            // crop taller than cell → letterbox left/right
            dw = frameHeight * cropAspect;
            dx = (frameWidth - dw) / 2;
          }
          frameCtx.drawImage(frameSource, sx, sy, sw, sh, dx, dy, dw, dh);
        }
      }

      // Draw skeleton on top, semi-transparent so the photo stays
      // readable. The skeleton is essential because it gives Gemini
      // validated landmark positions even when the photo is ambiguous
      // (occluded limbs, low contrast clothing on background).
      const prevAlpha = frameCtx.globalAlpha;
      frameCtx.globalAlpha = 0.55;
      renderSkeleton(frameCtx, landmarks, frameWidth, frameHeight);
      frameCtx.globalAlpha = prevAlpha;

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
