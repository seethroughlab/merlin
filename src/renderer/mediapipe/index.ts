/**
 * MediaPipe integration barrel file
 */

export {
  initPoseLandmarker,
  detectPose,
  drawPose,
  getLastResults as getLastPoseResults,
  closePoseLandmarker,
} from './pose';

export {
  initFaceDetector,
  detectFaces,
  drawFaces,
  getLastFaceResults,
  closeFaceDetector,
} from './face';

export {
  initImageSegmenter,
  segmentImage,
  drawSegmentationOverlay,
  getCachedMask,
  segmentAndDraw,
  segmentToMask,
  isSegmenterReady,
  closeImageSegmenter,
} from './segmentation';

/**
 * Initialize all MediaPipe models
 */
export async function initAllMediaPipe(): Promise<{
  pose: boolean;
  face: boolean;
  segmentation: boolean;
}> {
  const results = {
    pose: false,
    face: false,
    segmentation: false,
  };

  // Initialize in parallel for faster startup
  const [poseResult, faceResult, segmentResult] = await Promise.allSettled([
    import('./pose').then(m => m.initPoseLandmarker()),
    import('./face').then(m => m.initFaceDetector()),
    import('./segmentation').then(m => m.initImageSegmenter()),
  ]);

  results.pose = poseResult.status === 'fulfilled';
  results.face = faceResult.status === 'fulfilled';
  results.segmentation = segmentResult.status === 'fulfilled';

  if (poseResult.status === 'rejected') {
    console.error('Pose init failed:', poseResult.reason);
  }
  if (faceResult.status === 'rejected') {
    console.error('Face init failed:', faceResult.reason);
  }
  if (segmentResult.status === 'rejected') {
    console.error('Segmentation init failed:', segmentResult.reason);
  }

  return results;
}

/**
 * Close all MediaPipe models
 */
export async function closeAllMediaPipe(): Promise<void> {
  const [pose, face, segment] = await Promise.all([
    import('./pose'),
    import('./face'),
    import('./segmentation'),
  ]);
  pose.closePoseLandmarker();
  face.closeFaceDetector();
  segment.closeImageSegmenter();
}
