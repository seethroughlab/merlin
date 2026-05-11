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
  initFaceLandmarker,
  detectFaceLandmarks,
  getFaceBlendshapes,
  drawFaceLandmarks,
  closeFaceLandmarker,
} from './face-landmarks';

export {
  setFaceGestureCallback,
  resetFaceGestureState,
  updateFaceGestures,
} from './face-gestures';
export type { FaceGestureKind, FaceGestureEdge, FaceGestureEvent } from './face-gestures';

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
  faceLandmarks: boolean;
  segmentation: boolean;
}> {
  const results = {
    pose: false,
    face: false,
    faceLandmarks: false,
    segmentation: false,
  };

  // Initialize in parallel for faster startup
  const [poseResult, faceResult, faceLmResult, segmentResult] = await Promise.allSettled([
    import('./pose').then(m => m.initPoseLandmarker()),
    import('./face').then(m => m.initFaceDetector()),
    import('./face-landmarks').then(m => m.initFaceLandmarker()),
    import('./segmentation').then(m => m.initImageSegmenter()),
  ]);

  results.pose = poseResult.status === 'fulfilled';
  results.face = faceResult.status === 'fulfilled';
  results.faceLandmarks = faceLmResult.status === 'fulfilled';
  results.segmentation = segmentResult.status === 'fulfilled';

  if (poseResult.status === 'rejected') {
    console.error('Pose init failed:', poseResult.reason);
  }
  if (faceResult.status === 'rejected') {
    console.error('Face init failed:', faceResult.reason);
  }
  if (faceLmResult.status === 'rejected') {
    console.error('FaceLandmarker init failed:', faceLmResult.reason);
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
  const [pose, face, faceLm, segment] = await Promise.all([
    import('./pose'),
    import('./face'),
    import('./face-landmarks'),
    import('./segmentation'),
  ]);
  pose.closePoseLandmarker();
  face.closeFaceDetector();
  faceLm.closeFaceLandmarker();
  segment.closeImageSegmenter();
}
