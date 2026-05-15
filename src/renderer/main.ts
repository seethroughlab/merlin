/**
 * Merlin - Renderer Process
 *
 * Handles camera capture, MediaPipe processing, and canvas rendering.
 */

import {
  initAllMediaPipe,
  // Segmentation disabled — TD/NVIDIA Broadcast handles person mask.
  // initImageSegmenter,
  detectPose,
  drawPose,
  detectFaces,
  drawFaces,
  // segmentImage,
  // drawSegmentationOverlay,
  // segmentToMask,
  detectFaceLandmarks,
  drawFaceLandmarks,
  getFaceBlendshapes,
  setFaceGestureCallback,
  resetFaceGestureState,
  updateFaceGestures,
} from './mediapipe';
import { captureFaceStrip } from './faceStrip';
import { captureSkeletonStrip } from './skeletonStrip';
import {
  initWhisper,
  startContinuousListening,
  stopContinuousListening,
  setSpeechStartCallback,
} from './whisper';
import {
  initTTS,
  speak,
  stop as stopTTS,
  isSpeaking,
  onSpeakingStateChange,
  isTTSReady,
  initStreamingTTS,
  speakStreaming,
  isStreamingEnabled,
} from './tts';
import {
  initDeviceSelection,
  getSelectedCameraId,
  setSelectedCameraId,
  setSelectedMicrophoneId,
  getSelectedMicrophoneId,
  listDevices,
  resolveDeviceId,
  onDeviceListChange,
} from './devices';
import type {
  TrackingFrame,
  PoseData,
  FaceData,
  MicroExpressionAnalysis,
  BodyLanguageAnalysis,
  MerlinUIUpdate,
  GeminiTurn,
  GeminiTurnSource,
} from '../shared/types';
import { CONVERSATION_TEST_PRESETS } from '../shared/conversation-test-presets';
import { transcriptContains } from '../shared/transcript-match';
import { updateFaceHud, resetFaceHud } from './face-hud';
import { appendGeminiTurn } from './gemini-sidebar';
import {
  displayPhaseLabel,
  updateMerlinUI,
  updateMerlinSpellUI,
  addMerlinMessage,
  clearMerlinUI,
  updateMerlinSpeakingIndicator,
} from './merlin-ui';
import {
  initTestPanel,
  toggleTestShaderPanel,
  isTestModeMuted,
  handleZoneCompileResult,
  runConversationTest,
} from './test-panel';

// DOM Elements
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const fpsDisplay = document.querySelector('#stats .fps') as HTMLSpanElement;
const statusDisplay = document.getElementById('status') as HTMLDivElement;

// Canvas contexts
const ctx = canvas.getContext('2d')!;
const overlayCtx = overlay?.getContext('2d');

// Offscreen canvas for rotated frames (used in portrait mode)
let rotatedCanvas: HTMLCanvasElement | null = null;
let rotatedCtx: CanvasRenderingContext2D | null = null;

// Check URL params for render mode
const urlParams = new URLSearchParams(window.location.search);
const isSpoutMode = urlParams.has('spout');  // Raw video output
const isMaskMode = urlParams.has('mask');    // Segmentation mask output

// Detection toggles (whether to run MediaPipe)
let detectPoseEnabled = true;
let detectFaceEnabled = true;
let detectSegmentEnabled = true;

// Drawing toggles (whether to render overlays)
let drawPoseEnabled = true;
let drawFaceEnabled = true;
let drawMeshEnabled = true;
let drawSegmentEnabled = true;

// Latest analysis results
let lastFaceAnalysis: MicroExpressionAnalysis | null = null;
let lastBodyAnalysis: BodyLanguageAnalysis | null = null;
// Spout sender names
let spoutVideoName = 'Merlin';
let spoutMaskName = 'Merlin Mask';

// Camera orientation (landscape or portrait)
let isPortraitMode = false;

// MediaPipe ready state
let mediapipeReady = false;

// Voice command state
let voiceReady = false;

// TTS state
let ttsReady = false;

// Merlin mode state
let merlinModeActive = false;
let merlinIsListening = false;
let merlinIsProcessing = false;

// Background cast listener state. Armed by main via `merlin-cast-armed`
// the moment prepare_casting dispatches. When the participant says the
// magic word the renderer fires `merlin-trigger-cast` directly to main,
// bypassing the slow merlin-process-speech / Gemini round-trip.
let armedMagicWord: string | null = null;

// In-flight chunk-path TTS promise. The chunk handler is fire-and-forget
// (it starts speaking as soon as Gemini emits its initial text during
// tool dispatch), but the post-turn spokenText TTS path needs to AWAIT
// the chunk before starting its own request — otherwise main fires two
// TTS requests at the LiveTTS WebSocket in quick succession and the
// server interleaves the two audio streams on the wire. Tracking this
// promise so the spokenText path can sequence cleanly.
let inFlightSpeechPromise: Promise<void> | null = null;

// Pending analysis capture (started when user begins speaking)
let pendingAnalysisCapture: Promise<{
  face: MicroExpressionAnalysis | null;
  body: BodyLanguageAnalysis | null;
}> | null = null;

/**
 * Speak text using streaming TTS (Live API) if available, else batch TTS
 * Streaming provides lower latency by playing audio chunks as they arrive.
 */
async function speakWithStreaming(text: string, mood: string = 'mysterious'): Promise<void> {
  if (isStreamingEnabled()) {
    return speakStreaming(text, mood);
  } else {
    return speak(text, mood);
  }
}

// Hide UI in Spout/Mask modes and enable full-window rendering
if (isSpoutMode || isMaskMode) {
  document.body.classList.add('spout-mode');
  document.getElementById('stats')?.remove();
  document.getElementById('status')?.remove();
  document.getElementById('sidebar')?.remove();
  document.getElementById('filmstrip-panel')?.remove();
  overlay?.remove();
}

// FPS calculation
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 0;

/**
 * Build video constraints honoring the user-selected camera.
 */
function buildVideoConstraints(deviceId: string | undefined): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) {
    video.deviceId = { exact: deviceId };
  }
  return { video, audio: false };
}

/**
 * Acquire a camera stream, falling back to the system default if the
 * user-selected device is unavailable.
 */
async function acquireCameraStream(): Promise<MediaStream> {
  const desired = getSelectedCameraId();
  try {
    return await navigator.mediaDevices.getUserMedia(buildVideoConstraints(desired));
  } catch (err) {
    if (desired) {
      console.warn(`[camera] Selected device "${desired}" unavailable, falling back to default:`, err);
      setSelectedCameraId(undefined);
      return await navigator.mediaDevices.getUserMedia(buildVideoConstraints(undefined));
    }
    throw err;
  }
}

/**
 * Initialize camera
 */
async function initCamera(): Promise<void> {
  if (statusDisplay) statusDisplay.textContent = 'Requesting camera access...';

  try {
    const stream = await acquireCameraStream();
    video.srcObject = stream;
    await video.play();

    // Set canvas sizes to match video
    const { videoWidth, videoHeight } = video;
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    if (overlay) {
      overlay.width = videoWidth;
      overlay.height = videoHeight;
    }

    // Create rotated canvas for portrait mode (swapped dimensions)
    rotatedCanvas = document.createElement('canvas');
    rotatedCanvas.width = videoHeight;  // Swapped
    rotatedCanvas.height = videoWidth;  // Swapped
    rotatedCtx = rotatedCanvas.getContext('2d')!;

    if (statusDisplay) statusDisplay.textContent = `Camera: ${videoWidth}x${videoHeight}`;
    console.log(`Camera initialized: ${videoWidth}x${videoHeight}`);

    // Start render loop
    requestAnimationFrame(renderLoop);
  } catch (error) {
    console.error('Camera error:', error);
    if (statusDisplay) statusDisplay.textContent = `Camera error: ${error}`;
  }
}

/**
 * Swap the live camera stream to a different device. Stops the current
 * tracks, acquires a fresh stream, and resizes canvases to the new
 * video dimensions.
 */
async function switchCamera(): Promise<void> {
  const oldStream = video.srcObject as MediaStream | null;
  try {
    const stream = await acquireCameraStream();
    video.srcObject = stream;
    await video.play();
    oldStream?.getTracks().forEach((t) => t.stop());

    const { videoWidth, videoHeight } = video;
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    if (overlay) {
      overlay.width = videoWidth;
      overlay.height = videoHeight;
    }
    if (rotatedCanvas) {
      rotatedCanvas.width = videoHeight;
      rotatedCanvas.height = videoWidth;
    }
    console.log(`Camera switched: ${videoWidth}x${videoHeight}`);
    if (statusDisplay) statusDisplay.textContent = `Camera: ${videoWidth}x${videoHeight}`;
  } catch (err) {
    console.error('[camera] switch failed:', err);
    if (statusDisplay) statusDisplay.textContent = `Camera switch failed: ${err}`;
  }
}

/**
 * Get the current video frame source (handles portrait rotation)
 * Returns the appropriate canvas/video element and dimensions
 */
export function getFrameSource(): { source: HTMLCanvasElement | HTMLVideoElement; width: number; height: number } {
  if (isPortraitMode && rotatedCanvas && rotatedCtx) {
    // Rotate video 90 degrees counter-clockwise onto the rotated canvas
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    rotatedCtx.save();
    rotatedCtx.translate(0, vw);  // Move to bottom-left
    rotatedCtx.rotate(-Math.PI / 2);  // Rotate -90 degrees
    rotatedCtx.drawImage(video, 0, 0);
    rotatedCtx.restore();

    return { source: rotatedCanvas, width: vh, height: vw };
  }

  return { source: video, width: video.videoWidth, height: video.videoHeight };
}

/**
 * Main render loop
 */
function renderLoop(): void {
  const timestamp = performance.now();

  // Get frame source (rotated if in portrait mode)
  const { source: frameSource, width: frameWidth, height: frameHeight } = getFrameSource();

  // Update canvas size if needed (for orientation changes)
  if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    if (overlay) {
      overlay.width = frameWidth;
      overlay.height = frameHeight;
    }
  }

  // Mask mode disabled — TouchDesigner does person segmentation via
  // NVIDIA Broadcast, which is markedly better than MediaPipe selfie
  // segmentation. The renderer no longer produces a "Merlin Mask"
  // Spout output. Leave the branch in place so re-enabling is one
  // uncomment away.
  // if (isMaskMode) {
  //   if (mediapipeReady) {
  //     segmentToMask(frameSource as HTMLVideoElement, ctx, timestamp);
  //   } else {
  //     ctx.fillStyle = 'black';
  //     ctx.fillRect(0, 0, canvas.width, canvas.height);
  //   }
  //   requestAnimationFrame(renderLoop);
  //   return;
  // }

  // Draw video frame to canvas
  ctx.drawImage(frameSource, 0, 0);

  // In Spout mode, just render video - no overlays or processing
  if (isSpoutMode) {
    requestAnimationFrame(renderLoop);
    return;
  }

  // Clear overlay
  if (overlayCtx) {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Tracking data for this frame
  let poseData: PoseData | null = null;
  let faceData: FaceData | null = null;

  // MediaPipe processing (use frameSource for proper orientation)
  if (mediapipeReady && overlayCtx) {
    // Segmentation disabled — TD/NVIDIA Broadcast handles person mask now.
    // if (detectSegmentEnabled) {
    //   segmentImage(frameSource as HTMLVideoElement, timestamp);
    // }
    // if (drawSegmentEnabled && detectSegmentEnabled) {
    //   drawSegmentationOverlay(overlayCtx);
    // }

    // Pose detection
    if (detectPoseEnabled) {
      const poseResult = detectPose(frameSource as HTMLVideoElement, timestamp);
      if (poseResult && poseResult.landmarks.length > 0) {
        if (drawPoseEnabled) {
          drawPose(overlayCtx, poseResult);
        }

        // Convert to our format
        poseData = {
          landmarks: poseResult.landmarks[0].map((lm) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z,
            visibility: lm.visibility,
          })),
          worldLandmarks: poseResult.worldLandmarks[0]?.map((lm) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z,
          })) ?? [],
        };
      }
    }

    // Face detection
    if (detectFaceEnabled) {
      const faceResults = detectFaces(frameSource as HTMLVideoElement, timestamp);
      if (faceResults.length > 0) {
        if (drawFaceEnabled) {
          drawFaces(overlayCtx, faceResults, frameWidth, frameHeight);
        }

        // Convert first face to our format
        const face = faceResults[0];
        const bbox = face.boundingBox;
        if (bbox) {
          faceData = {
            bbox: {
              x: bbox.originX / frameWidth,
              y: bbox.originY / frameHeight,
              width: bbox.width / frameWidth,
              height: bbox.height / frameHeight,
            },
            landmarks: face.keypoints?.map((kp) => ({
              x: kp.x,
              y: kp.y,
            })) ?? [],
          };
        }
      }

      // Face landmarks + blendshapes for expression-driven trigger
      // events (mouth_open, smile, brow_raise, eye_closed). Renderer-only;
      // not sent to TD. The gesture detector handles edge-detection and
      // dispatches FaceGestureEvent through the callback set below.
      const faceLm = detectFaceLandmarks(frameSource as HTMLVideoElement, timestamp);
      updateFaceGestures(getFaceBlendshapes());

      // Mesh wireframe overlay — toggleable via the "Mesh" checkbox.
      if (drawMeshEnabled && faceLm && faceLm.faceLandmarks.length > 0) {
        drawFaceLandmarks(overlayCtx, faceLm);
      }
    }

    // Send tracking data via IPC
    const trackingFrame: TrackingFrame = {
      timestamp,
      fps: currentFps,
      pose: poseData,
      face: faceData,
      hasSegmentation: detectSegmentEnabled,
      frameWidth,
      frameHeight,
      isPortrait: isPortraitMode,
    };

    if (window.electronAPI) {
      window.electronAPI.sendTrackingFrame(trackingFrame);
    }
  } else if (overlayCtx) {
    // Show loading message
    overlayCtx.fillStyle = 'rgba(255, 255, 0, 0.8)';
    overlayCtx.font = '20px sans-serif';
    overlayCtx.fillText('MediaPipe: Loading models...', 20, overlay.height - 20);
  }

  // Calculate FPS
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    if (fpsDisplay) fpsDisplay.textContent = currentFps.toString();
    frameCount = 0;
    lastFpsTime = now;
  }

  // Continue loop
  requestAnimationFrame(renderLoop);
}

let isCapturing = false;
let isCapturingBody = false;

/**
 * Quick face analysis - 3 frames over ~1 second
 */
async function captureQuickFaceAnalysis(): Promise<typeof lastFaceAnalysis> {
  if (isCapturing) {
    console.log('[QuickFace] Capture in progress, returning cached');
    return lastFaceAnalysis;
  }

  isCapturing = true;
  console.log(`[QuickFace ${new Date().toISOString().slice(11, 23)}] Capturing...`);

  try {
    const result = await captureFaceStrip(video, {
      frameCount: 3,
      intervalMs: 333,  // ~1 second total
      frameSize: 128,
    }, getFrameSource);

    if (!result) {
      console.log('[QuickFace] No face detected');
      return lastFaceAnalysis;
    }

    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeFaceStrip(result.imageDataUrl);
      console.log('[QuickFace] Analysis:', analysis.primaryEmotion);
      lastFaceAnalysis = analysis;
      return analysis;
    }
    return lastFaceAnalysis;
  } catch (error) {
    console.error('[QuickFace] Error:', error);
    return lastFaceAnalysis;
  } finally {
    isCapturing = false;
  }
}

/**
 * Quick body analysis - 3 frames over ~1 second
 */
async function captureQuickBodyAnalysis(): Promise<typeof lastBodyAnalysis> {
  if (isCapturingBody) {
    console.log('[QuickBody] Capture in progress, returning cached');
    return lastBodyAnalysis;
  }

  isCapturingBody = true;
  console.log(`[QuickBody ${new Date().toISOString().slice(11, 23)}] Capturing...`);

  try {
    const result = await captureSkeletonStrip({
      frameCount: 3,
      intervalMs: 333,  // ~1 second total
      frameWidth: 192,
      frameHeight: 288,
    }, getFrameSource);

    if (!result) {
      console.log('[QuickBody] No skeleton detected');
      return lastBodyAnalysis;
    }

    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeSkeletonStrip(result.imageDataUrl);
      console.log('[QuickBody] Analysis:', analysis.primaryPosture);
      lastBodyAnalysis = analysis;
      return analysis;
    }
    return lastBodyAnalysis;
  } catch (error) {
    console.error('[QuickBody] Error:', error);
    return lastBodyAnalysis;
  } finally {
    isCapturingBody = false;
  }
}

/**
 * Load saved settings from main process and apply to UI
 */
async function loadSettings(): Promise<void> {
  if (!window.electronAPI) return;

  try {
    const settings = await window.electronAPI.getSettings();
    console.log('Loaded settings:', settings);

    // Apply settings to variables
    detectPoseEnabled = settings.detectPose as boolean ?? true;
    detectFaceEnabled = settings.detectFace as boolean ?? true;
    detectSegmentEnabled = settings.detectSegment as boolean ?? true;
    drawPoseEnabled = settings.drawPose as boolean ?? true;
    drawFaceEnabled = settings.drawFace as boolean ?? true;
    drawMeshEnabled = settings.drawMesh as boolean ?? true;
    drawSegmentEnabled = settings.drawSegment as boolean ?? true;
    isPortraitMode = settings.isPortraitMode as boolean ?? false;

    // Apply to UI elements
    const detectPoseCheckbox = document.getElementById('detect-pose') as HTMLInputElement;
    const detectFaceCheckbox = document.getElementById('detect-face') as HTMLInputElement;
    const detectSegmentCheckbox = document.getElementById('detect-segment') as HTMLInputElement;
    const drawPoseCheckbox = document.getElementById('draw-pose') as HTMLInputElement;
    const drawFaceCheckbox = document.getElementById('draw-face') as HTMLInputElement;
    const drawMeshCheckbox = document.getElementById('draw-mesh') as HTMLInputElement;
    const drawSegmentCheckbox = document.getElementById('draw-segment') as HTMLInputElement;
    const landscapeBtn = document.getElementById('orientation-landscape');
    const portraitBtn = document.getElementById('orientation-portrait');
    const canvasWrapper = document.getElementById('canvas-wrapper');

    if (detectPoseCheckbox) detectPoseCheckbox.checked = detectPoseEnabled;
    if (detectFaceCheckbox) detectFaceCheckbox.checked = detectFaceEnabled;
    if (detectSegmentCheckbox) detectSegmentCheckbox.checked = detectSegmentEnabled;
    if (drawPoseCheckbox) {
      drawPoseCheckbox.checked = drawPoseEnabled;
      drawPoseCheckbox.disabled = !detectPoseEnabled;
    }
    if (drawFaceCheckbox) {
      drawFaceCheckbox.checked = drawFaceEnabled;
      drawFaceCheckbox.disabled = !detectFaceEnabled;
    }
    if (drawMeshCheckbox) {
      drawMeshCheckbox.checked = drawMeshEnabled;
      // Mesh draw is gated on face detection too (FaceLandmarker only
      // runs when detectFaceEnabled is on).
      drawMeshCheckbox.disabled = !detectFaceEnabled;
    }
    if (drawSegmentCheckbox) {
      drawSegmentCheckbox.checked = drawSegmentEnabled;
      drawSegmentCheckbox.disabled = !detectSegmentEnabled;
    }

    // Apply portrait mode
    if (isPortraitMode) {
      landscapeBtn?.classList.remove('active');
      portraitBtn?.classList.add('active');
      canvasWrapper?.classList.add('portrait');
    }

    console.log('Settings applied to UI');
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

/**
 * Save a setting to main process
 */
function saveSetting(key: string, value: unknown): void {
  if (window.electronAPI) {
    window.electronAPI.saveSetting(key, value).catch((err) => {
      console.error(`Failed to save setting ${key}:`, err);
    });
  }
}

/**
 * Setup sidebar control handlers
 */
function setupSidebar(): void {
  // Detection toggles
  const detectPoseCheckbox = document.getElementById('detect-pose') as HTMLInputElement;
  const detectFaceCheckbox = document.getElementById('detect-face') as HTMLInputElement;
  const detectSegmentCheckbox = document.getElementById('detect-segment') as HTMLInputElement;

  // Drawing toggles
  const drawPoseCheckbox = document.getElementById('draw-pose') as HTMLInputElement;
  const drawFaceCheckbox = document.getElementById('draw-face') as HTMLInputElement;
  const drawMeshCheckbox = document.getElementById('draw-mesh') as HTMLInputElement;
  const drawSegmentCheckbox = document.getElementById('draw-segment') as HTMLInputElement;

  // Spout name inputs
  const spoutVideoInput = document.getElementById('spout-video-name') as HTMLInputElement;
  const spoutMaskInput = document.getElementById('spout-mask-name') as HTMLInputElement;

  // Helper to update draw checkbox state based on detect checkbox
  function updateDrawCheckbox(detectCheckbox: HTMLInputElement, drawCheckbox: HTMLInputElement) {
    if (drawCheckbox) {
      drawCheckbox.disabled = !detectCheckbox.checked;
      if (!detectCheckbox.checked) {
        drawCheckbox.checked = false;
      }
    }
  }

  // Wire up detection toggles (also controls draw checkbox enabled state)
  detectPoseCheckbox?.addEventListener('change', () => {
    detectPoseEnabled = detectPoseCheckbox.checked;
    updateDrawCheckbox(detectPoseCheckbox, drawPoseCheckbox);
    if (!detectPoseEnabled) drawPoseEnabled = false;
    saveSetting('detectPose', detectPoseEnabled);
    if (!detectPoseEnabled) saveSetting('drawPose', false);
  });
  detectFaceCheckbox?.addEventListener('change', () => {
    detectFaceEnabled = detectFaceCheckbox.checked;
    updateDrawCheckbox(detectFaceCheckbox, drawFaceCheckbox);
    updateDrawCheckbox(detectFaceCheckbox, drawMeshCheckbox);
    if (!detectFaceEnabled) {
      drawFaceEnabled = false;
      drawMeshEnabled = false;
    }
    saveSetting('detectFace', detectFaceEnabled);
    if (!detectFaceEnabled) {
      saveSetting('drawFace', false);
      saveSetting('drawMesh', false);
    }
  });
  detectSegmentCheckbox?.addEventListener('change', () => {
    detectSegmentEnabled = detectSegmentCheckbox.checked;
    updateDrawCheckbox(detectSegmentCheckbox, drawSegmentCheckbox);
    if (!detectSegmentEnabled) drawSegmentEnabled = false;
    saveSetting('detectSegment', detectSegmentEnabled);
    if (!detectSegmentEnabled) saveSetting('drawSegment', false);
  });

  // Wire up drawing toggles
  drawPoseCheckbox?.addEventListener('change', () => {
    drawPoseEnabled = drawPoseCheckbox.checked;
    saveSetting('drawPose', drawPoseEnabled);
  });
  drawFaceCheckbox?.addEventListener('change', () => {
    drawFaceEnabled = drawFaceCheckbox.checked;
    saveSetting('drawFace', drawFaceEnabled);
  });
  drawMeshCheckbox?.addEventListener('change', () => {
    drawMeshEnabled = drawMeshCheckbox.checked;
    saveSetting('drawMesh', drawMeshEnabled);
  });
  drawSegmentCheckbox?.addEventListener('change', () => {
    drawSegmentEnabled = drawSegmentCheckbox.checked;
    saveSetting('drawSegment', drawSegmentEnabled);
  });

  // Wire up Spout name inputs with debounce
  let spoutVideoDebounce: number | null = null;
  spoutVideoInput?.addEventListener('input', () => {
    if (spoutVideoDebounce) clearTimeout(spoutVideoDebounce);
    spoutVideoDebounce = window.setTimeout(async () => {
      const newName = spoutVideoInput.value.trim();
      if (newName && newName !== spoutVideoName && window.electronAPI) {
        const success = await window.electronAPI.renameSpoutSender(spoutVideoName, newName);
        if (success) {
          spoutVideoName = newName;
          console.log(`Spout video renamed to: ${newName}`);
        }
      }
    }, 500);
  });

  let spoutMaskDebounce: number | null = null;
  spoutMaskInput?.addEventListener('input', () => {
    if (spoutMaskDebounce) clearTimeout(spoutMaskDebounce);
    spoutMaskDebounce = window.setTimeout(async () => {
      const newName = spoutMaskInput.value.trim();
      if (newName && newName !== spoutMaskName && window.electronAPI) {
        const success = await window.electronAPI.renameSpoutSender(spoutMaskName, newName);
        if (success) {
          spoutMaskName = newName;
          console.log(`Spout mask renamed to: ${newName}`);
        }
      }
    }, 500);
  });

  // Orientation toggle buttons
  const landscapeBtn = document.getElementById('orientation-landscape');
  const portraitBtn = document.getElementById('orientation-portrait');
  const canvasWrapper = document.getElementById('canvas-wrapper');

  function setOrientation(portrait: boolean, broadcast: boolean = false) {
    isPortraitMode = portrait;

    if (portrait) {
      landscapeBtn?.classList.remove('active');
      portraitBtn?.classList.add('active');
      canvasWrapper?.classList.add('portrait');
    } else {
      portraitBtn?.classList.remove('active');
      landscapeBtn?.classList.add('active');
      canvasWrapper?.classList.remove('portrait');
    }

    // Broadcast to other windows (Spout, Mask) if triggered by user click
    if (broadcast && window.electronAPI) {
      window.electronAPI.setPortraitMode(portrait);
      saveSetting('isPortraitMode', portrait);
    }

    console.log(`Orientation: ${portrait ? 'portrait' : 'landscape'}`);
  }

  landscapeBtn?.addEventListener('click', () => setOrientation(false, true));
  portraitBtn?.addEventListener('click', () => setOrientation(true, true));

  // Start WebSocket stats polling
  startWsStatsPoll();

  // Device choosers (camera + mic)
  setupDeviceChoosers();

  // TD reset button
  setupTDResetButton();

  console.log('Sidebar controls initialized');
}

/**
 * Wire the "Reset to Baseline" button. Pushes a known-good clean state
 * to TD: default shaders, default sprite, mesh mode, idle program.
 */
function setupTDResetButton(): void {
  const btn = document.getElementById('td-reset-btn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('td-reset-status') as HTMLDivElement | null;
  if (!btn || !statusEl) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Resetting...';
    statusEl.textContent = 'Pushing baseline to TD...';
    statusEl.className = 'td-reset-status';

    try {
      const result = await window.electronAPI.merlinResetTDBaseline();
      const errors = result.steps.filter(s => s.status === 'error');
      const skipped = result.steps.filter(s => s.status === 'skipped');
      const ok = result.steps.filter(s => s.status === 'ok');
      if (result.success) {
        const skipNote = skipped.length > 0
          ? ` (${skipped.length} skipped: ${skipped.map(s => s.label.replace(/^zone:/, '')).join(', ')})`
          : '';
        statusEl.textContent = `✓ ${ok.length}/${result.steps.length} reset${skipNote}`;
        statusEl.className = 'td-reset-status success';
      } else {
        const summary = errors.map(s => `${s.label}: ${s.error ?? 'failed'}`).join('; ');
        statusEl.textContent = `✗ ${errors.length}/${result.steps.length} failed — ${summary}`;
        statusEl.className = errors.length === result.steps.length ? 'td-reset-status error' : 'td-reset-status partial';
      }
    } catch (error) {
      statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
      statusEl.className = 'td-reset-status error';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reset to Baseline';
    }
  });
}

/**
 * Populate the camera and microphone select dropdowns and wire up
 * change/devicechange handlers.
 */
function setupDeviceChoosers(): void {
  const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement | null;
  const micSelect = document.getElementById('mic-select') as HTMLSelectElement | null;
  if (!cameraSelect || !micSelect) return;

  function populate(select: HTMLSelectElement, devices: MediaDeviceInfo[], selectedId: string | undefined, defaultLabel: string) {
    select.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = defaultLabel;
    select.appendChild(defaultOpt);

    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Device ${i + 1}`;
      select.appendChild(opt);
    });

    const resolved = resolveDeviceId(selectedId, devices);
    select.value = resolved ?? '';
    if (resolved !== selectedId) {
      if (select === cameraSelect) setSelectedCameraId(undefined);
      else setSelectedMicrophoneId(undefined);
    }
  }

  async function refresh() {
    try {
      const { cameras, microphones } = await listDevices();
      populate(cameraSelect!, cameras, getSelectedCameraId(), 'System Default');
      populate(micSelect!, microphones, getSelectedMicrophoneId(), 'System Default');
    } catch (err) {
      console.error('[devices] enumerateDevices failed:', err);
    }
  }

  cameraSelect.addEventListener('change', () => {
    const id = cameraSelect.value || undefined;
    setSelectedCameraId(id);
    switchCamera();
  });

  micSelect.addEventListener('change', () => {
    const id = micSelect.value || undefined;
    setSelectedMicrophoneId(id);
    // whisper subscribes to mic-change and restarts its stream automatically
  });

  onDeviceListChange(() => {
    console.log('[devices] devicechange event - refreshing lists');
    refresh();
  });

  refresh();
}

/**
 * Poll and display WebSocket bridge stats
 */
function startWsStatsPoll(): void {
  const wsPort = document.getElementById('ws-port');
  const wsStatus = document.getElementById('ws-status');

  async function updateWsStats() {
    if (!window.electronAPI) return;

    try {
      const stats = await window.electronAPI.getBridgeStats();
      if (wsPort) wsPort.textContent = stats.port.toString();
      if (wsStatus) {
        wsStatus.textContent = stats.connected ? 'Connected' : 'Waiting...';
        wsStatus.style.color = stats.connected ? '#0f0' : '#888';
      }
    } catch {
      // Ignore errors silently
    }
  }

  // Update every second
  setInterval(updateWsStats, 1000);
  updateWsStats(); // Initial update
}

/**
 * Capitalize first letter
 */
/**
 * Add analysis bubbles to the conversation
 * Shows what the AI "sees" - facial expressions and body language
 */
function addAnalysisBubbles(
  face: MicroExpressionAnalysis | null,
  body: BodyLanguageAnalysis | null
): void {
  const conversation = document.getElementById('merlin-conversation');
  if (!conversation) return;

  const bubbleContainer = document.createElement('div');
  bubbleContainer.className = 'analysis-bubbles';

  // Face analysis bubble
  if (face) {
    const faceBubble = document.createElement('div');
    faceBubble.className = 'analysis-bubble face';
    const valenceSign = face.valence >= 0 ? '+' : '';
    faceBubble.innerHTML = `
      <span class="bubble-icon">😶</span>
      <span class="bubble-text">${face.primaryEmotion}</span>
      <span class="bubble-detail">${valenceSign}${face.valence.toFixed(1)}</span>
    `;
    bubbleContainer.appendChild(faceBubble);
  }

  // Body analysis bubble
  if (body) {
    const bodyBubble = document.createElement('div');
    bodyBubble.className = 'analysis-bubble body';
    bodyBubble.innerHTML = `
      <span class="bubble-icon">🧍</span>
      <span class="bubble-text">${body.primaryPosture}</span>
      <span class="bubble-detail">${(body.openness >= 0 ? '+' : '')}${body.openness.toFixed(1)} open</span>
    `;
    bubbleContainer.appendChild(bodyBubble);
  }

  if (bubbleContainer.children.length > 0) {
    conversation.appendChild(bubbleContainer);
    conversation.scrollTop = conversation.scrollHeight;
  }
}

/**
 * Setup keyboard handlers
 */
function setupKeyboardHandlers(): void {
  document.addEventListener('keydown', (event) => {
    // Ignore if typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;

    // Shift+M toggles Merlin mode
    if (event.code === 'KeyM' && !event.repeat && event.shiftKey) {
      event.preventDefault();
      if (voiceReady) {
        toggleMerlinMode();
      }
    }

    // Shift+T opens test shader panel
    if (event.code === 'KeyT' && !event.repeat && event.shiftKey) {
      event.preventDefault();
      toggleTestShaderPanel();
    }
  });

  console.log('Keyboard handlers ready (Shift+M = Merlin, Shift+T = Test Shaders)');
}

// Test panel functions are in ./test-panel — imported above.

async function initMediaPipe(): Promise<void> {
  if (statusDisplay) statusDisplay.textContent = 'Loading MediaPipe models...';
  console.log('Initializing MediaPipe...');

  try {
    const results = await initAllMediaPipe();
    console.log('MediaPipe init results:', results);

    const loaded = [];
    if (results.pose) loaded.push('Pose');
    if (results.face) loaded.push('Face');
    if (results.faceLandmarks) loaded.push('FaceLandmarks');
    if (results.segmentation) loaded.push('Segmentation');

    mediapipeReady = loaded.length > 0;

    // Wire face-gesture events. Renderer-only signals — log to console,
    // forward to main via IPC for the get_face_events tool / FACE
    // ACTIVITY context injection, AND update the sidebar HUD so the
    // user can SEE that detection is working.
    setFaceGestureCallback((evt) => {
      const ts = new Date(performance.timeOrigin + evt.timestamp).toISOString().slice(11, 23);
      console.log(`[FaceGesture ${ts}] ${evt.kind} ${evt.edge} (score=${evt.score.toFixed(2)})`);
      if (window.electronAPI?.sendFaceGesture) {
        window.electronAPI.sendFaceGesture(evt);
      }
      updateFaceHud(evt);
    });
  } catch (error) {
    console.error('MediaPipe init error:', error);
    if (statusDisplay) statusDisplay.textContent = `MediaPipe error: ${error}`;
  }
}


/**
 * Initialize text-to-speech (Gemini TTS)
 */
async function initSpeech(): Promise<void> {
  console.log('Initializing Gemini TTS...');

  onSpeakingStateChange((speaking) => {
    updateMerlinSpeakingIndicator(speaking, merlinModeActive, merlinIsListening);
  });

  const success = await initTTS();
  ttsReady = success;

  if (success) {
    console.log('TTS ready');

    // Initialize streaming TTS listeners for Live API
    initStreamingTTS();
    console.log('Streaming TTS listeners initialized');
  } else {
    console.warn('TTS not available');
  }
}

// ============ MERLIN MODE ============

/**
 * Wake phrase patterns for Merlin activation
 */
const MERLIN_WAKE_PATTERNS = [
  /hello\s*merlin/i,
  /hey\s*merlin/i,
  /hi\s*merlin/i,
];

/**
 * Detect Merlin wake phrase in transcript
 */
function detectMerlinWakePhrase(transcript: string): boolean {
  const normalized = transcript.toLowerCase().trim();
  return MERLIN_WAKE_PATTERNS.some(p => p.test(normalized));
}

// updateMerlinUI, updateMerlinSpellUI, addMerlinMessage → imported from ./merlin-ui
// Gemini sidebar functions → imported from ./gemini-sidebar
/**
 * Start Merlin mode
 */
async function startMerlinMode(): Promise<void> {
  if (merlinModeActive) return;
  if (!window.electronAPI) {
    console.error('Electron API not available');
    return;
  }

  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[Merlin ${ts()}] Starting...`);
  merlinModeActive = true;

  // Activate UI
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('merlin-panel');
  sidebar?.classList.add('merlin-active');
  panel?.classList.add('active');

  clearMerlinUI();

  // Update status
  const voiceStatus = document.getElementById('merlin-voice-status');
  if (voiceStatus) {
    voiceStatus.textContent = 'Starting session...';
    voiceStatus.className = 'merlin-voice-status processing';
  }

  try {
    // Start session with Gemini
    const response = await window.electronAPI.merlinStart();
    console.log(`[Merlin ${ts()}] Session started:`, response.text);

    // Add intro message
    addMerlinMessage('assistant', response.text);

    // Update spell state
    updateMerlinSpellUI(response.spell);

    // Update phase display
    const phaseSpan = document.getElementById('merlin-phase');
    if (phaseSpan) phaseSpan.textContent = displayPhaseLabel(response.phase);

    // Speak the un-streamed intro remainder. If the chunk path already
    // streamed the greeting during tool dispatch, spokenText is the
    // post-tool portion (often empty). When no chunk fired, spokenText
    // equals the full intro. Await any in-flight chunk first so we
    // don't fire a second concurrent TTS request.
    if (ttsReady) {
      if (inFlightSpeechPromise) {
        await inFlightSpeechPromise;
        inFlightSpeechPromise = null;
      }
      if (response.spokenText) {
        await speakWithStreaming(response.spokenText, 'wizard');
      }
    }

    // Start continuous listening (after TTS finishes)
    merlinIsListening = true;
    await startContinuousListening(handleMerlinTranscript);

    // Register speech start callback to begin analysis capture early
    setSpeechStartCallback(() => {
      if (!merlinModeActive || pendingAnalysisCapture) return;

      console.log(`[Merlin ${ts()}] Speech started - beginning analysis capture...`);
      pendingAnalysisCapture = Promise.all([
        captureQuickFaceAnalysis(),
        captureQuickBodyAnalysis(),
      ]).then(([face, body]) => ({ face, body }));
    });

    console.log(`[Merlin ${ts()}] Continuous listening started`);

  } catch (error) {
    console.error('[Merlin] Failed to start:', error);
    stopMerlinMode();
  }
}

/**
 * Stop Merlin mode
 */
async function stopMerlinMode(): Promise<void> {
  if (!merlinModeActive) return;

  console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Stopping...`);

  // Stop continuous listening and clear callbacks
  stopContinuousListening();
  setSpeechStartCallback(null);
  pendingAnalysisCapture = null;
  merlinIsListening = false;
  // Disarm the background cast listener — next session re-arms via
  // merlin-cast-armed when prepare_casting fires.
  armedMagicWord = null;
  // Reset face-gesture edge-detector so stale ON-states from a previous
  // session don't suppress 'start' events on the next session.
  resetFaceGestureState();
  resetFaceHud();

  // End session
  if (window.electronAPI) {
    try {
      const response = await window.electronAPI.merlinEnd();
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Session ended:`, response.text);

      // Add finale message
      addMerlinMessage('assistant', response.text);

      // Speak the finale aloud with wizard voice. endSession returns
      // spokenText explicitly so this matches the merlin-process-speech
      // pattern; empty means nothing to say (cast-already-fired path).
      if (ttsReady && response.spokenText) {
        await speakWithStreaming(response.spokenText, 'wizard');
      }
    } catch (error) {
      console.error('[Merlin] Error ending session:', error);
    }
  }

  // Deactivate UI after a short delay to show finale
  setTimeout(() => {
    merlinModeActive = false;
    const sidebar = document.getElementById('sidebar');
    const panel = document.getElementById('merlin-panel');
    sidebar?.classList.remove('merlin-active');
    panel?.classList.remove('active');
  }, 3000);
}

/**
 * Toggle Merlin mode
 */
async function toggleMerlinMode(): Promise<void> {
  if (merlinModeActive) {
    await stopMerlinMode();
  } else {
    await startMerlinMode();
  }
}

// Lock to prevent concurrent Merlin transcript processing
let isProcessingMerlinTranscript = false;

/**
 * Handle transcript from continuous listening in Merlin mode
 */
async function handleMerlinTranscript(transcript: string): Promise<void> {
  if (!merlinModeActive || !window.electronAPI) return;

  // Background cast listener — runs BEFORE the busy guard and BEFORE
  // any Gemini round-trip. When prepare_casting fires, main arms
  // `armedMagicWord`. If the participant speaks it, we fire a direct
  // IPC to trigger the cast without going through merlinProcessSpeech
  // at all. Re-casts during play are handled the same way (triggerCast
  // is idempotent for phase advance; it resets the inactivity timer).
  const tsBg = () => new Date().toISOString().slice(11, 23);
  if (!isSpeaking()) {
    if (armedMagicWord && transcriptContains(transcript, armedMagicWord)) {
      console.log(`[Merlin ${tsBg()}] Background trigger: magic word "${armedMagicWord}" matched — firing cast`);
      void window.electronAPI.merlinTriggerCast();
      return;
    }
  }

  // Prevent concurrent processing - drop if already processing
  if (isProcessingMerlinTranscript) {
    console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Dropping transcript (busy): "${transcript}"`);
    return;
  }

  isProcessingMerlinTranscript = true;
  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[Merlin ${ts()}] User said: "${transcript}"`);

  // Add user message to UI
  addMerlinMessage('user', transcript);

  // Update UI to show processing
  merlinIsProcessing = true;
  const voiceStatus = document.getElementById('merlin-voice-status');
  if (voiceStatus) {
    voiceStatus.textContent = 'Processing...';
    voiceStatus.className = 'merlin-voice-status processing';
  }

  // Use the pre-started analysis capture if available
  let analysisPromise: Promise<{ face: MicroExpressionAnalysis | null; body: BodyLanguageAnalysis | null }>;

  if (pendingAnalysisCapture) {
    console.log(`[Merlin ${ts()}] Using pre-started analysis capture`);
    analysisPromise = pendingAnalysisCapture;
    pendingAnalysisCapture = null;
  } else {
    console.log(`[Merlin ${ts()}] No pre-started capture, starting now...`);
    analysisPromise = Promise.all([
      captureQuickFaceAnalysis(),
      captureQuickBodyAnalysis(),
    ]).then(([face, body]) => ({ face, body }));
  }

  try {
    // Await analysis
    const { face: freshFace, body: freshBody } = await analysisPromise;
    console.log(`[Merlin ${ts()}] Analysis ready:`, {
      face: freshFace?.primaryEmotion,
      body: freshBody?.primaryPosture,
    });

    // Show analysis bubbles
    addAnalysisBubbles(freshFace, freshBody);

    // Update cached analysis in main process
    window.electronAPI.merlinUpdateAnalysis({
      body: freshBody ?? undefined,
      face: freshFace ?? undefined,
    });

    // Call Gemini
    console.log(`[Merlin ${ts()}] Calling Gemini...`);
    const response = await window.electronAPI.merlinProcessSpeech(transcript);
    console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Response:`, response.text);

    // During play phase, re-casts and ambient speech return empty text
    // (only the first cast triggers a Gemini welcome line). Skip UI +
    // TTS for empty responses so we don't render blank bubbles or silence.
    if (!response.text) {
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Empty response (play phase re-cast) — skipping UI + TTS`);
      return;
    }

    // Add response to conversation
    addMerlinMessage('assistant', response.text);

    // Update spell state
    updateMerlinSpellUI(response.spell);

    // Update phase in UI
    const phaseSpan = document.getElementById('merlin-phase');
    const header = document.getElementById('merlin-header');
    if (phaseSpan) phaseSpan.textContent = displayPhaseLabel(response.phase);
    if (header && response.spell.element) {
      header.className = `merlin-header element-${response.spell.element}`;
    }

    // Speak the un-streamed REMAINDER (post-tool text). When the chunk
    // path streamed the initial response during tool dispatch, the
    // remainder is whatever Gemini emitted AFTER tools ran (sentences 3+
    // of the response, etc.). When no chunk fired, spokenText equals the
    // full response. Empty means everything already spoken — skip.
    if (ttsReady && response.spokenText) {
      stopContinuousListening();

      // Wait for any in-flight chunk-path TTS to finish before kicking
      // off the remainder. Two parallel TTS requests would interleave
      // their audio chunks at the LiveTTS server and play overlapping.
      if (inFlightSpeechPromise) {
        console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Awaiting in-flight chunk TTS before speaking remainder`);
        await inFlightSpeechPromise;
      }
      inFlightSpeechPromise = null;

      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Speaking remainder (${response.spokenText.length} chars)`);
      await speakWithStreaming(response.spokenText, 'wizard');

      // Resume listening after TTS finishes
      if (merlinModeActive) {
        console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Resuming listening after TTS`);
        await startContinuousListening(handleMerlinTranscript);
      }
    } else if (inFlightSpeechPromise) {
      // No remainder, but a chunk IS in flight (the common path under
      // the one-response-per-turn rule). Wait for the chunk to finish,
      // then RESUME listening — the chunk handler called
      // stopContinuousListening when TTS started, so without resuming
      // here the mic stays closed forever and the session "stops after
      // 1 reaction".
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] No remainder — awaiting chunk TTS to finish`);
      await inFlightSpeechPromise;
      inFlightSpeechPromise = null;
      if (merlinModeActive) {
        console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Resuming listening after chunk-only turn`);
        await startContinuousListening(handleMerlinTranscript);
      }
    } else {
      // Neither chunk nor remainder fired this turn — the mic was
      // never closed, so listening is still active. Nothing to do.
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] No speech this turn`);
    }

  } catch (error) {
    console.error('[Merlin] Error processing speech:', error);
    if (statusDisplay) statusDisplay.textContent = `Merlin error: ${error}`;
  } finally {
    isProcessingMerlinTranscript = false;
    merlinIsProcessing = false;

    // Resume listening indicator
    if (voiceStatus && merlinModeActive) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'merlin-voice-status listening';
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(`Merlin renderer starting... (spout: ${isSpoutMode}, mask: ${isMaskMode})`);

  // Load saved device selections before opening any media streams
  await initDeviceSelection();

  // Initialize camera first
  await initCamera();

  // Mask-mode branch disabled — TD/NVIDIA Broadcast handles the mask.
  // The mask-window creation in main/index.ts is also commented out, so
  // ?mask should never be hit in practice. Leaving the dispatch shell.
  // if (isMaskMode) {
  //   console.log('Initializing segmentation for mask output...');
  //   await initImageSegmenter();
  //   mediapipeReady = true;
  //   console.log('Segmentation ready');
  // } else if (!isSpoutMode) {
  if (!isSpoutMode && !isMaskMode) {
    // Preview mode: initialize everything
    await loadSettings();
    setupSidebar();
    setupKeyboardHandlers();
    initTestPanel({ getMerlinActive: () => merlinModeActive, stopMerlinMode });
    await initMediaPipe();

    // Initialize Whisper (needed for Merlin continuous listening) and TTS (async, don't block)
    initWhisper({ model: 'onnx-community/whisper-small.en', silenceTimeout: 1500, maxRecordingTime: 15000 })
      .then(success => { voiceReady = success; });
    initSpeech();
  }
  // Spout mode: no MediaPipe needed (raw video only)
}

// Listen for portrait mode changes from other windows (or main process broadcast)
if (window.electronAPI) {
  window.electronAPI.onPortraitModeChanged((portrait: boolean) => {
    console.log(`Portrait mode changed (via IPC): ${portrait}`);
    isPortraitMode = portrait;

    // Update UI if in preview mode (has sidebar)
    const landscapeBtn = document.getElementById('orientation-landscape');
    const portraitBtn = document.getElementById('orientation-portrait');
    const canvasWrapper = document.getElementById('canvas-wrapper');

    if (portrait) {
      landscapeBtn?.classList.remove('active');
      portraitBtn?.classList.add('active');
      canvasWrapper?.classList.add('portrait');
    } else {
      portraitBtn?.classList.remove('active');
      landscapeBtn?.classList.add('active');
      canvasWrapper?.classList.remove('portrait');
    }
  });

  // Listen for analysis requests from main process (when Gemini tools need fresh data)
  window.electronAPI.onRequestAnalysis(async (data) => {
    console.log(`[Analysis ${new Date().toISOString().slice(11, 23)}] Main process requested fresh ${data.type} analysis`);

    let result: unknown;
    if (data.type === 'face') {
      result = await captureQuickFaceAnalysis();
    } else {
      result = await captureQuickBodyAnalysis();
    }

    console.log(`[Analysis ${new Date().toISOString().slice(11, 23)}] Sending result for ${data.requestId}`);
    window.electronAPI.sendAnalysisResult(data.requestId, result);
  });

  // Listen for Merlin UI updates from main process
  window.electronAPI.onMerlinUpdate((update: MerlinUIUpdate) => {
    console.log('[Merlin] UI update received:', update);
    updateMerlinUI(update);
  });

  // Listen for Gemini conversation events (sidebar turn cards)
  window.electronAPI.onGeminiConversation((turn) => {
    if (!turn || !turn.id || !turn.source) return;
    appendGeminiTurn(turn as Partial<GeminiTurn> & { id: string; source: GeminiTurnSource });
  });

  // Listen for auto-end signal when Merlin session completes
  window.electronAPI.onMerlinAutoEnd(() => {
    console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Session complete - auto-ending...`);
    stopMerlinMode();
  });

  // Parallel TTS: main fires this when Gemini emits text alongside tool
  // calls so we can start speaking BEFORE the (potentially slow) tool
  // dispatch loop finishes. Speech runs concurrently with the in-flight
  // processUserSpeech promise. We pause continuous listening here too,
  // mirroring the post-response TTS path; it resumes when the
  // processUserSpeech finally lands and the response-side TTS finishes
  // (or is skipped because finalText was already streamed).
  window.electronAPI.onMerlinSpeakChunk((text: string) => {
    if (!ttsReady || !text) return;
    if (isTestModeMuted()) {
      // Conversation Tester is running — swallow chunk TTS silently so
      // the handleMerlinTranscript spokenText path can still serialize
      // on a resolved promise without waiting for any audio.
      inFlightSpeechPromise = Promise.resolve();
      return;
    }
    console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Parallel-TTS chunk: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
    stopContinuousListening();
    // Track the promise so the post-turn spokenText TTS path can await
    // it. Without this serialization, the second speakWithStreaming
    // fires another LiveTTS request while the chunk's audio chunks are
    // still arriving from the server — they interleave on the wire and
    // play overlapping (two voices on top of each other).
    const chunkPromise = speakWithStreaming(text, 'wizard');
    inFlightSpeechPromise = chunkPromise;
    void chunkPromise.finally(() => {
      // Clear only if the spokenText path didn't already replace this.
      if (inFlightSpeechPromise === chunkPromise) {
        inFlightSpeechPromise = null;
      }
    });
  });

  // Conversation Tester HTTP trigger — main forwards POSTs to
  // /run-conversation here. Runs the preset and signals completion
  // back so main can resolve the HTTP response with the transcript
  // path.
  window.electronAPI.onConversationTestTrigger(async ({ requestId, presetId, claudeDriven }) => {
    const preset = CONVERSATION_TEST_PRESETS.find(p => p.id === presetId);
    if (!preset) {
      window.electronAPI.sendConversationTestComplete({
        requestId,
        error: `unknown presetId: ${presetId}`,
      });
      return;
    }
    console.log(`[ConversationTest] HTTP trigger received for ${presetId} (requestId=${requestId})`);
    try {
      const result = await runConversationTest({
        id: preset.id,
        character: preset.description,
        script: preset.script,
        muteTts: true,
        pauseMs: 0,
        face: preset.expectedFace,
        body: preset.expectedBody,
        claudeDriven,
        expectedSpell: preset.expectedSpell,
        onTurnComplete: () => { /* trigger path doesn't update panel UI */ },
        onStatus: (msg) => console.log(`[ConversationTest] ${msg}`),
      });
      window.electronAPI.sendConversationTestComplete({
        requestId,
        transcriptPath: result.transcriptPath,
      });
    } catch (err) {
      window.electronAPI.sendConversationTestComplete({
        requestId,
        error: String(err),
      });
    }
  });

  // Cast armed — main fires this when prepare_casting dispatches. From
  // this moment on, the renderer matches every transcript against the
  // declared magic word locally and triggers the cast via direct IPC,
  // independent of the Gemini conversation pipeline.
  window.electronAPI.onMerlinCastArmed((payload) => {
    armedMagicWord = payload.magicWord || null;
    console.log(
      `[Merlin ${new Date().toISOString().slice(11, 23)}] ` +
      `Cast armed: magicWord="${armedMagicWord}"`,
    );
  });

  // Listen for zone compile results to update status indicators
  window.electronAPI.onZoneCompileResult((result) => {
    console.log(`[Zone ${new Date().toISOString().slice(11, 23)}] Compile result: ${result.zone} = ${result.success ? 'OK' : result.error}`);
    handleZoneCompileResult(result);
  });
}

// Start the app
main().catch(console.error);
