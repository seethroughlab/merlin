/**
 * MediaPipe Image Segmenter (Selfie Segmentation)
 *
 * Segments the person from the background.
 */

import {
  ImageSegmenter,
  FilesetResolver,
  ImageSegmenterResult,
} from '@mediapipe/tasks-vision';

let imageSegmenter: ImageSegmenter | null = null;
let lastVideoTime = -1;
let maskCanvas: HTMLCanvasElement | null = null;
let maskCtx: CanvasRenderingContext2D | null = null;

// Cached segmentation result for separate detect/draw
let cachedMaskData: Uint8Array | null = null;
let cachedMaskWidth = 0;
let cachedMaskHeight = 0;

/**
 * Initialize the image segmenter
 */
export async function initImageSegmenter(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });

  // Create offscreen canvas for mask processing
  maskCanvas = document.createElement('canvas');
  maskCanvas.width = 1280;
  maskCanvas.height = 720;
  maskCtx = maskCanvas.getContext('2d');

  // Initialize with black
  if (maskCtx) {
    maskCtx.fillStyle = 'black';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  }

  console.log('ImageSegmenter initialized');
}

/**
 * Run segmentation only (caches result for later drawing)
 * Accepts HTMLVideoElement or HTMLCanvasElement (for rotated frames)
 * Returns true if a new mask was generated
 */
export function segmentImage(
  source: HTMLVideoElement | HTMLCanvasElement,
  timestamp: number
): boolean {
  if (!imageSegmenter) return false;

  // Skip if same video frame (use currentTime for video, timestamp for canvas)
  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;
  if (frameTime === lastVideoTime) return cachedMaskData !== null;
  lastVideoTime = frameTime;

  // Run segmentation with callback
  imageSegmenter.segmentForVideo(source as HTMLVideoElement, timestamp, (result: ImageSegmenterResult) => {
    if (!result.categoryMask) return;

    const mask = result.categoryMask;
    cachedMaskWidth = mask.width;
    cachedMaskHeight = mask.height;

    // Cache the mask data (copy it since the original gets closed)
    const maskData = mask.getAsUint8Array();
    cachedMaskData = new Uint8Array(maskData);

    mask.close();
  });

  return true;
}

/**
 * Draw cached segmentation mask as purple overlay
 */
export function drawSegmentationOverlay(
  ctx: CanvasRenderingContext2D
): boolean {
  if (!cachedMaskData || !maskCanvas || !maskCtx) return false;

  // Ensure mask canvas matches size
  if (maskCanvas.width !== cachedMaskWidth || maskCanvas.height !== cachedMaskHeight) {
    maskCanvas.width = cachedMaskWidth;
    maskCanvas.height = cachedMaskHeight;
  }

  // Create image data for visualization
  const imageData = maskCtx.createImageData(cachedMaskWidth, cachedMaskHeight);
  const data = imageData.data;

  // Convert mask to RGBA (purple tint for person, transparent for background)
  for (let i = 0; i < cachedMaskData.length; i++) {
    const pixelIndex = i * 4;
    if (cachedMaskData[i] > 0) {
      // Person - semi-transparent purple
      data[pixelIndex] = 128;     // R
      data[pixelIndex + 1] = 0;   // G
      data[pixelIndex + 2] = 255; // B
      data[pixelIndex + 3] = 100; // A
    } else {
      // Background - transparent
      data[pixelIndex] = 0;
      data[pixelIndex + 1] = 0;
      data[pixelIndex + 2] = 0;
      data[pixelIndex + 3] = 0;
    }
  }

  // Draw mask to offscreen canvas then to output
  maskCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0);

  return true;
}

/**
 * Get cached mask data (for external use)
 */
export function getCachedMask(): { data: Uint8Array; width: number; height: number } | null {
  if (!cachedMaskData) return null;
  return {
    data: cachedMaskData,
    width: cachedMaskWidth,
    height: cachedMaskHeight,
  };
}

/**
 * Process a video frame and draw segmentation mask (combined for backwards compat)
 * Accepts HTMLVideoElement or HTMLCanvasElement (for rotated frames)
 */
export function segmentAndDraw(
  source: HTMLVideoElement | HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestamp: number
): boolean {
  if (!imageSegmenter || !maskCanvas || !maskCtx) return false;

  // Get source dimensions
  const sourceWidth = 'videoWidth' in source ? source.videoWidth : source.width;
  const sourceHeight = 'videoHeight' in source ? source.videoHeight : source.height;

  // Check for new frame (use currentTime for video, timestamp for canvas)
  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;

  // If same frame, just redraw cached mask (prevents flicker)
  if (frameTime === lastVideoTime) {
    ctx.drawImage(maskCanvas, 0, 0);
    return true;
  }
  lastVideoTime = frameTime;

  // Ensure mask canvas matches source size
  if (maskCanvas.width !== sourceWidth || maskCanvas.height !== sourceHeight) {
    maskCanvas.width = sourceWidth;
    maskCanvas.height = sourceHeight;
  }

  // Run segmentation with callback
  imageSegmenter.segmentForVideo(source as HTMLVideoElement, timestamp, (result: ImageSegmenterResult) => {
    if (!result.categoryMask || !maskCtx || !maskCanvas) return;

    const mask = result.categoryMask;
    const width = mask.width;
    const height = mask.height;

    // Get mask data
    const maskData = mask.getAsUint8Array();

    // Create image data for visualization
    const imageData = maskCtx.createImageData(width, height);
    const data = imageData.data;

    // Convert mask to RGBA (purple tint for person, transparent for background)
    for (let i = 0; i < maskData.length; i++) {
      const pixelIndex = i * 4;
      if (maskData[i] > 0) {
        // Person - semi-transparent purple
        data[pixelIndex] = 128;     // R
        data[pixelIndex + 1] = 0;   // G
        data[pixelIndex + 2] = 255; // B
        data[pixelIndex + 3] = 100; // A
      } else {
        // Background - transparent
        data[pixelIndex] = 0;
        data[pixelIndex + 1] = 0;
        data[pixelIndex + 2] = 0;
        data[pixelIndex + 3] = 0;
      }
    }

    // Draw mask to offscreen canvas
    maskCtx.putImageData(imageData, 0, 0);

    // Draw to overlay canvas
    ctx.drawImage(maskCanvas, 0, 0);

    // Close the mask to free resources
    mask.close();
  });

  return true;
}

/**
 * Process a video frame and draw grayscale mask (white=person, black=background)
 * Used for Spout mask output
 * Accepts HTMLVideoElement or HTMLCanvasElement (for rotated frames)
 */
export function segmentToMask(
  source: HTMLVideoElement | HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestamp: number
): boolean {
  if (!imageSegmenter || !maskCanvas || !maskCtx) return false;

  // Get source dimensions
  const width = 'videoWidth' in source ? source.videoWidth : source.width;
  const height = 'videoHeight' in source ? source.videoHeight : source.height;

  // Check for new frame (use currentTime for video, timestamp for canvas)
  const frameTime = 'currentTime' in source && typeof source.currentTime === 'number'
    ? source.currentTime
    : timestamp;

  // If same frame, just redraw cached mask (prevents flicker)
  if (frameTime === lastVideoTime) {
    ctx.drawImage(maskCanvas, 0, 0);
    return true;
  }
  lastVideoTime = frameTime;

  // Ensure mask canvas matches source size
  if (maskCanvas.width !== width || maskCanvas.height !== height) {
    maskCanvas.width = width;
    maskCanvas.height = height;
  }

  // Run segmentation with callback
  imageSegmenter.segmentForVideo(source as HTMLVideoElement, timestamp, (result: ImageSegmenterResult) => {
    if (!result.categoryMask || !maskCtx || !maskCanvas) return;

    const mask = result.categoryMask;
    const maskData = mask.getAsUint8Array();

    // Create grayscale image data (white = person, black = background)
    const imageData = maskCtx.createImageData(mask.width, mask.height);
    const data = imageData.data;

    for (let i = 0; i < maskData.length; i++) {
      const pixelIndex = i * 4;
      const value = maskData[i] > 0 ? 255 : 0;
      data[pixelIndex] = value;     // R
      data[pixelIndex + 1] = value; // G
      data[pixelIndex + 2] = value; // B
      data[pixelIndex + 3] = 255;   // A (fully opaque)
    }

    // Draw mask to offscreen canvas
    maskCtx.putImageData(imageData, 0, 0);

    // Draw to output canvas
    ctx.drawImage(maskCanvas, 0, 0);

    mask.close();
  });

  return true;
}

/**
 * Check if segmenter is initialized
 */
export function isSegmenterReady(): boolean {
  return imageSegmenter !== null;
}

/**
 * Close the image segmenter
 */
export function closeImageSegmenter(): void {
  if (imageSegmenter) {
    imageSegmenter.close();
    imageSegmenter = null;
  }
  maskCanvas = null;
  maskCtx = null;
}
