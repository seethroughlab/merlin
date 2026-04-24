/**
 * Face Strip Capture
 *
 * Captures a filmstrip of face crops over time for micro-expression analysis.
 */

import { detectFaces, getLastFaceResults } from './mediapipe';

interface FaceStripConfig {
  frameCount: number;      // Number of frames to capture (default: 8)
  intervalMs: number;      // Interval between captures (default: 125ms = 8fps)
  cropPadding: number;     // Padding around face bbox (default: 0.3 = 30%)
  frameSize: number;       // Size of each frame in the strip (default: 128px)
}

interface CaptureResult {
  imageDataUrl: string;    // Base64 data URL of the filmstrip
  framesCaptured: number;  // Actual number of frames captured
  durationMs: number;      // Total capture duration
}

// Frame source getter type (avoids circular import with main.ts)
export type FrameSourceGetter = () => { source: HTMLCanvasElement | HTMLVideoElement; width: number; height: number };

const DEFAULT_CONFIG: FaceStripConfig = {
  frameCount: 8,
  intervalMs: 125,
  cropPadding: 0.3,
  frameSize: 128,
};

/**
 * Capture a filmstrip of face crops from the video
 * @param video - Video element (used as fallback if no frameSourceGetter)
 * @param config - Configuration options
 * @param frameSourceGetter - Optional function to get the current frame source (handles rotation)
 */
export async function captureFaceStrip(
  video: HTMLVideoElement,
  config: Partial<FaceStripConfig> = {},
  frameSourceGetter?: FrameSourceGetter
): Promise<CaptureResult | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { frameCount, intervalMs, cropPadding, frameSize } = cfg;

  // Create canvas for the filmstrip (horizontal strip)
  const stripCanvas = document.createElement('canvas');
  stripCanvas.width = frameSize * frameCount;
  stripCanvas.height = frameSize;
  const stripCtx = stripCanvas.getContext('2d')!;

  // Fill with black background
  stripCtx.fillStyle = '#000';
  stripCtx.fillRect(0, 0, stripCanvas.width, stripCanvas.height);

  // Temp canvas for cropping individual faces
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = frameSize;
  cropCanvas.height = frameSize;
  const cropCtx = cropCanvas.getContext('2d')!;

  const startTime = performance.now();
  let framesCaptured = 0;

  // Capture frames at intervals
  for (let i = 0; i < frameCount; i++) {
    // Get the current frame source (handles portrait rotation if getter provided)
    let frameSource: HTMLCanvasElement | HTMLVideoElement;
    let sourceWidth: number;
    let sourceHeight: number;

    if (frameSourceGetter) {
      const frameInfo = frameSourceGetter();
      frameSource = frameInfo.source;
      sourceWidth = frameInfo.width;
      sourceHeight = frameInfo.height;
    } else {
      frameSource = video;
      sourceWidth = video.videoWidth;
      sourceHeight = video.videoHeight;
    }

    // Run face detection on the (possibly rotated) frame
    const timestamp = performance.now();
    const faces = detectFaces(frameSource as HTMLVideoElement, timestamp);

    if (i === 0) {
      console.log(`Face strip: ${faces.length} faces detected, bbox:`, faces[0]?.boundingBox);
    }

    if (faces.length > 0 && faces[0].boundingBox) {
      const bbox = faces[0].boundingBox;
      const videoWidth = sourceWidth;
      const videoHeight = sourceHeight;

      // Calculate padded crop region
      const padX = bbox.width * cropPadding;
      const padY = bbox.height * cropPadding;

      let cropX = bbox.originX - padX;
      let cropY = bbox.originY - padY;
      let cropWidth = bbox.width + padX * 2;
      let cropHeight = bbox.height + padY * 2;

      // Make it square (use larger dimension)
      const cropSize = Math.max(cropWidth, cropHeight);
      cropX -= (cropSize - cropWidth) / 2;
      cropY -= (cropSize - cropHeight) / 2;
      cropWidth = cropSize;
      cropHeight = cropSize;

      // Clamp to video bounds
      cropX = Math.max(0, cropX);
      cropY = Math.max(0, cropY);
      if (cropX + cropWidth > videoWidth) cropWidth = videoWidth - cropX;
      if (cropY + cropHeight > videoHeight) cropHeight = videoHeight - cropY;

      // Draw cropped face to temp canvas (scaled to frameSize)
      cropCtx.drawImage(
        frameSource,
        cropX, cropY, cropWidth, cropHeight,
        0, 0, frameSize, frameSize
      );

      // Copy to filmstrip
      stripCtx.drawImage(cropCanvas, i * frameSize, 0);
      framesCaptured++;
    }

    // Wait for next frame (except on last iteration)
    if (i < frameCount - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  const durationMs = performance.now() - startTime;

  if (framesCaptured === 0) {
    console.warn('No faces captured in filmstrip');
    return null;
  }

  return {
    imageDataUrl: stripCanvas.toDataURL('image/jpeg', 0.9),
    framesCaptured,
    durationMs,
  };
}

/**
 * Capture a single face frame (for quick snapshots)
 */
export function captureFaceFrame(
  video: HTMLVideoElement,
  frameSize: number = 256,
  cropPadding: number = 0.3
): string | null {
  const faces = getLastFaceResults();

  if (faces.length === 0 || !faces[0].boundingBox) {
    return null;
  }

  const bbox = faces[0].boundingBox;
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;

  // Calculate padded crop region
  const padX = bbox.width * cropPadding;
  const padY = bbox.height * cropPadding;

  let cropX = bbox.originX - padX;
  let cropY = bbox.originY - padY;
  let cropWidth = bbox.width + padX * 2;
  let cropHeight = bbox.height + padY * 2;

  // Make it square
  const cropSize = Math.max(cropWidth, cropHeight);
  cropX -= (cropSize - cropWidth) / 2;
  cropY -= (cropSize - cropHeight) / 2;
  cropWidth = cropSize;
  cropHeight = cropSize;

  // Clamp to video bounds
  cropX = Math.max(0, cropX);
  cropY = Math.max(0, cropY);
  if (cropX + cropWidth > videoWidth) cropWidth = videoWidth - cropX;
  if (cropY + cropHeight > videoHeight) cropHeight = videoHeight - cropY;

  // Create canvas and draw
  const canvas = document.createElement('canvas');
  canvas.width = frameSize;
  canvas.height = frameSize;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(
    video,
    cropX, cropY, cropWidth, cropHeight,
    0, 0, frameSize, frameSize
  );

  return canvas.toDataURL('image/jpeg', 0.9);
}
