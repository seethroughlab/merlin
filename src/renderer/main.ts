/**
 * Merlin - Renderer Process
 *
 * Handles camera capture, MediaPipe processing, and canvas rendering.
 */

import {
  initAllMediaPipe,
  initImageSegmenter,
  detectPose,
  drawPose,
  detectFaces,
  drawFaces,
  segmentImage,
  drawSegmentationOverlay,
  segmentToMask,
  detectFaceLandmarks,
  drawFaceLandmarks,
  getFaceBlendshapes,
  setFaceGestureCallback,
  resetFaceGestureState,
  updateFaceGestures,
  type FaceGestureEvent,
} from './mediapipe';
import { captureFaceStrip } from './faceStrip';
import { captureSkeletonStrip } from './skeletonStrip';
import {
  initWhisper,
  startRecording,
  stopRecording,
  isVoiceRecording,
  isWhisperReady,
  onVoiceStatus,
  onVoiceTranscript,
  startContinuousListening,
  stopContinuousListening,
  setTranscriptCallback,
  setSpeechStartCallback,
  type VoiceStatus,
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
  VoiceCommandAction,
  MerlinUIUpdate,
  MerlinResponse,
  SpellState,
  SpriteTestSpec,
  SpriteTestResult,
  SpriteFrameCount,
  SpritePlaybackMode,
  SpriteDriveSource,
  SpriteFlipbookConfig,
  FlipbookTestResult,
  MirroredTDState,
  ShaderTestPreset,
  LiveSpellTestInput,
  LiveSpellTestResult,
  GeminiTurn,
  GeminiToolCall,
  GeminiPushResult,
  GeminiRetryMarker,
  GeminiTurnSource,
  ConversationTurnSnapshot,
} from '../shared/types';
import { SHADER_TEST_PRESETS } from '../shared/test-shader-presets';
import { LIVE_SPELL_PRESETS } from '../shared/live-spell-presets';
import { CONVERSATION_TEST_PRESETS } from '../shared/conversation-test-presets';
import { transcriptContains } from '../shared/transcript-match';

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
let lastFlipbookMirror: MirroredTDState | null = null;
let lastFaceStripUrl: string | null = null;
let lastBodyStripUrl: string | null = null;

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
let armedEndWord: string | null = null;

// Conversation Tester (Shift+T → Conversation tab) sets this to mute
// all TTS during scripted runs so an end-to-end conversation walks
// through in seconds without anyone having to listen to Merlin speak.
// The chunk handler and post-turn spokenText handler both early-return
// when this is true.
let testModeMuteTts = false;

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

  // In Mask mode, render segmentation mask (white=person, black=background)
  if (isMaskMode) {
    if (mediapipeReady) {
      segmentToMask(frameSource as HTMLVideoElement, ctx, timestamp);
    } else {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(renderLoop);
    return;
  }

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
    // Segmentation (detect and optionally draw - first so it's behind other overlays)
    if (detectSegmentEnabled) {
      segmentImage(frameSource as HTMLVideoElement, timestamp);
    }
    if (drawSegmentEnabled && detectSegmentEnabled) {
      drawSegmentationOverlay(overlayCtx);
    }

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

// Track if capture is in progress
let isCapturing = false;

/**
 * Capture face strip and analyze with Gemini
 */
async function captureAndAnalyze(): Promise<void> {
  if (isCapturing) {
    console.log('Capture already in progress');
    return;
  }

  isCapturing = true;
  if (statusDisplay) statusDisplay.textContent = 'Capturing face strip...';

  try {
    // Capture filmstrip (8 frames over 5 seconds)
    const result = await captureFaceStrip(video, {
      frameCount: 8,
      intervalMs: 625,  // 5000ms / 8 frames
      frameSize: 128,
    }, getFrameSource);

    if (!result) {
      if (statusDisplay) statusDisplay.textContent = 'No face detected for capture';
      return;
    }

    console.log(`Captured ${result.framesCaptured} frames in ${result.durationMs.toFixed(0)}ms`);
    if (statusDisplay) statusDisplay.textContent = 'Analyzing with Gemini...';

    // Send to Gemini for analysis
    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeFaceStrip(result.imageDataUrl);

      // Store result
      lastFaceAnalysis = analysis;
      lastFaceStripUrl = result.imageDataUrl;

      // Display result in status
      console.log('Analysis result:', analysis);
      if (statusDisplay) {
        statusDisplay.textContent = `${analysis.primaryEmotion} (${(analysis.valence > 0 ? '+' : '')}${analysis.valence.toFixed(2)})`;
      }
    } else {
      if (statusDisplay) statusDisplay.textContent = 'Electron API not available';
    }
  } catch (error) {
    console.error('Capture/analysis error:', error);
    if (statusDisplay) statusDisplay.textContent = `Error: ${error}`;
  } finally {
    isCapturing = false;
  }
}

// Track if body language capture is in progress
let isCapturingBody = false;

/**
 * Capture skeleton strip and analyze body language with Gemini
 */
async function captureAndAnalyzeBodyLanguage(): Promise<void> {
  if (isCapturingBody) {
    console.log('Body language capture already in progress');
    return;
  }

  isCapturingBody = true;
  if (statusDisplay) statusDisplay.textContent = 'Capturing skeleton strip (5s)...';

  try {
    // Capture body strip (8 frames over 5 seconds). Real photo crop +
    // skeleton overlay (see skeletonStrip.ts). Frame source getter
    // gives the strip access to the current rendered video frame.
    const result = await captureSkeletonStrip({
      frameCount: 8,
      intervalMs: 625,  // 5000ms / 8 frames
      frameWidth: 192,
      frameHeight: 288,
    }, getFrameSource);

    if (!result) {
      if (statusDisplay) statusDisplay.textContent = 'No pose detected for capture';
      return;
    }

    console.log(`Captured ${result.framesCaptured} skeleton frames in ${result.durationMs.toFixed(0)}ms`);
    if (statusDisplay) statusDisplay.textContent = 'Analyzing body language...';

    // Send to Gemini for analysis
    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeSkeletonStrip(result.imageDataUrl);

      // Store result
      lastBodyAnalysis = analysis;
      lastBodyStripUrl = result.imageDataUrl;

      // Display result in status
      console.log('Body language result:', analysis);
      if (statusDisplay) {
        const posture = analysis.primaryPosture ?? 'unknown';
        statusDisplay.textContent = posture;
      }
    } else {
      if (statusDisplay) statusDisplay.textContent = 'Electron API not available';
    }
  } catch (error) {
    console.error('Body language capture/analysis error:', error);
    if (statusDisplay) statusDisplay.textContent = `Error: ${error}`;
  } finally {
    isCapturingBody = false;
  }
}

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
      lastFaceStripUrl = result.imageDataUrl;
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
      lastBodyStripUrl = result.imageDataUrl;
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
 * Execute a voice command action
 */
function executeVoiceCommand(action: VoiceCommandAction): void {
  const detectPoseCheckbox = document.getElementById('detect-pose') as HTMLInputElement;
  const detectFaceCheckbox = document.getElementById('detect-face') as HTMLInputElement;
  const detectSegmentCheckbox = document.getElementById('detect-segment') as HTMLInputElement;
  const drawPoseCheckbox = document.getElementById('draw-pose') as HTMLInputElement;
  const drawFaceCheckbox = document.getElementById('draw-face') as HTMLInputElement;
  const drawSegmentCheckbox = document.getElementById('draw-segment') as HTMLInputElement;
  switch (action.type) {
    case 'toggle_pose':
      detectPoseEnabled = action.enabled;
      if (detectPoseCheckbox) {
        detectPoseCheckbox.checked = action.enabled;
        detectPoseCheckbox.dispatchEvent(new Event('change'));
      }
      break;

    case 'toggle_face':
      detectFaceEnabled = action.enabled;
      if (detectFaceCheckbox) {
        detectFaceCheckbox.checked = action.enabled;
        detectFaceCheckbox.dispatchEvent(new Event('change'));
      }
      break;

    case 'toggle_segmentation':
      detectSegmentEnabled = action.enabled;
      if (detectSegmentCheckbox) {
        detectSegmentCheckbox.checked = action.enabled;
        detectSegmentCheckbox.dispatchEvent(new Event('change'));
      }
      break;

    case 'toggle_pose_overlay':
      drawPoseEnabled = action.enabled;
      if (drawPoseCheckbox) drawPoseCheckbox.checked = action.enabled;
      break;

    case 'toggle_face_overlay':
      drawFaceEnabled = action.enabled;
      if (drawFaceCheckbox) drawFaceCheckbox.checked = action.enabled;
      break;

    case 'toggle_segmentation_overlay':
      drawSegmentEnabled = action.enabled;
      if (drawSegmentCheckbox) drawSegmentCheckbox.checked = action.enabled;
      break;

    case 'set_orientation':
      if (window.electronAPI) {
        window.electronAPI.setPortraitMode(action.portrait);
      }
      break;

    case 'capture_face':
      captureAndAnalyze();
      break;

    case 'capture_body':
      captureAndAnalyzeBodyLanguage();
      break;

    default:
      console.warn('Unknown voice command action:', action);
  }
}

/**
 * Handle voice transcript - send to Gemini for interpretation
 */
async function handleVoiceTranscript(transcript: string): Promise<void> {
  if (!window.electronAPI) {
    console.error('Electron API not available');
    return;
  }

  if (statusDisplay) statusDisplay.textContent = `Processing: "${transcript}"`;

  try {
    const result = await window.electronAPI.interpretVoiceCommand(transcript);
    console.log('Voice command result:', result);

    if (result.understood && result.action) {
      executeVoiceCommand(result.action);
      if (statusDisplay) statusDisplay.textContent = result.response;
    } else {
      if (statusDisplay) statusDisplay.textContent = result.response || 'Command not understood';
    }
  } catch (error) {
    console.error('Voice command error:', error);
    if (statusDisplay) statusDisplay.textContent = `Voice error: ${error}`;
  }
}

/**
 * Update voice status display
 */
function updateVoiceStatusDisplay(status: VoiceStatus): void {
  const voiceStatus = document.getElementById('voice-status');
  if (voiceStatus) {
    voiceStatus.textContent = status.message;
    voiceStatus.className = `voice-status voice-${status.state}`;
  }
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Map internal MerlinPhase to participant-facing label for the sidebar.
 * Internal names stay unchanged to keep tests + persistence stable; only
 * the display label collapses the multi-turn arc into the
 * Attract / Interaction / Cast / Play / Outro vocabulary the client
 * uses.
 */
function displayPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
    case 'wake':
      return 'Attract';
    case 'intro':
    case 'discovery':
    case 'formation':
    case 'ready_to_cast':
      return 'Interaction';
    case 'casting':
      return 'Cast';
    case 'play':
      return 'Play';
    case 'outro':
      return 'Outro';
    default:
      return capitalize(phase);
  }
}

// ============ FACE HUD ============
// Renders the live face-gesture state in the sidebar so the user can
// verify FaceLandmarker is producing events. Updated from the
// setFaceGestureCallback registered at MediaPipe init.

const FACE_KIND_LABEL: Record<string, { label: string; emoji: string }> = {
  mouth_open: { label: 'mouth open', emoji: '😮' },
  smile:      { label: 'smile',      emoji: '😄' },
  brow_raise: { label: 'brows up',   emoji: '🤨' },
  eye_closed: { label: 'eyes closed', emoji: '😑' },
};

const faceHudActive = new Set<string>();
interface RecentFaceEvent {
  kind: string;
  edge: 'start' | 'end';
  at: number; // performance.now()
}
const faceHudRecent: RecentFaceEvent[] = [];
const FACE_HUD_RECENT_MAX = 8;
let faceHudRefreshInterval: ReturnType<typeof setInterval> | null = null;

function updateFaceHud(evt: { kind: string; edge: 'start' | 'end'; timestamp: number }): void {
  if (evt.edge === 'start') faceHudActive.add(evt.kind);
  else faceHudActive.delete(evt.kind);

  faceHudRecent.unshift({ kind: evt.kind, edge: evt.edge, at: evt.timestamp });
  while (faceHudRecent.length > FACE_HUD_RECENT_MAX) faceHudRecent.pop();

  renderFaceHud();
  // Kick a slow refresh so the "Xs ago" labels stay accurate while
  // nothing new fires.
  if (!faceHudRefreshInterval) {
    faceHudRefreshInterval = setInterval(renderFaceHud, 1000);
  }
}

function renderFaceHud(): void {
  const activeEl = document.getElementById('face-hud-active');
  const recentEl = document.getElementById('face-hud-recent');
  if (!activeEl || !recentEl) return;

  if (faceHudActive.size === 0) {
    activeEl.innerHTML = '<span class="face-hud-empty">neutral</span>';
  } else {
    activeEl.innerHTML = '';
    for (const kind of faceHudActive) {
      const meta = FACE_KIND_LABEL[kind] ?? { label: kind, emoji: '·' };
      const pill = document.createElement('span');
      pill.className = 'face-pill';
      pill.textContent = `${meta.emoji} ${meta.label}`;
      activeEl.appendChild(pill);
    }
  }

  const now = performance.now();
  // Drop entries older than 10s from the recent display (buffer keeps
  // them for slightly longer but the HUD only shows recent).
  while (faceHudRecent.length > 0 && now - faceHudRecent[faceHudRecent.length - 1].at > 10000) {
    faceHudRecent.pop();
  }

  if (faceHudRecent.length === 0) {
    recentEl.innerHTML = '';
    // No recent activity — pause the refresh timer.
    if (faceHudRefreshInterval) {
      clearInterval(faceHudRefreshInterval);
      faceHudRefreshInterval = null;
    }
    return;
  }

  recentEl.innerHTML = '';
  for (const e of faceHudRecent) {
    const meta = FACE_KIND_LABEL[e.kind] ?? { label: e.kind, emoji: '·' };
    const secs = Math.max(0, Math.round((now - e.at) / 1000));
    const line = document.createElement('div');
    line.className = 'face-recent-line';
    line.textContent = `${meta.emoji} ${meta.label} ${e.edge === 'start' ? 'started' : 'ended'} ${secs}s ago`;
    recentEl.appendChild(line);
  }
}

function resetFaceHud(): void {
  faceHudActive.clear();
  faceHudRecent.length = 0;
  if (faceHudRefreshInterval) {
    clearInterval(faceHudRefreshInterval);
    faceHudRefreshInterval = null;
  }
  renderFaceHud();
}

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

// ============ TEST SHADER PANEL ============

// Test shader panel state
let testShaderPanelVisible = false;

/**
 * Toggle the test shader panel
 */
function toggleTestShaderPanel(): void {
  if (testShaderPanelVisible) {
    hideTestShaderPanel();
  } else {
    showTestShaderPanel();
  }
}

/**
 * Show the test shader panel
 */
function showTestShaderPanel(): void {
  let panel = document.getElementById('test-shader-panel');

  if (!panel) {
    panel = createTestShaderPanel();
    document.body.appendChild(panel);
  }

  panel.classList.add('visible');
  testShaderPanelVisible = true;

  // Auto-open the Merlin sidebar so test-mode Gemini activity is visible.
  // Existing CSS handles the rest of the layout once these classes are set.
  const sidebar = document.getElementById('sidebar');
  const merlinPanel = document.getElementById('merlin-panel');
  sidebar?.classList.add('merlin-active');
  merlinPanel?.classList.add('active');
}

/**
 * Hide the test shader panel
 */
function hideTestShaderPanel(): void {
  const panel = document.getElementById('test-shader-panel');
  if (panel) {
    panel.classList.remove('visible');
  }
  testShaderPanelVisible = false;

  // Restore the regular sidebar UNLESS a live Merlin session is active —
  // in that case the sidebar should stay in Merlin mode for the live
  // conversation.
  if (!merlinModeActive) {
    const sidebar = document.getElementById('sidebar');
    const merlinPanel = document.getElementById('merlin-panel');
    sidebar?.classList.remove('merlin-active');
    merlinPanel?.classList.remove('active');
  }
}

/**
 * Create the test panel DOM with tabs (Shaders / Sprites)
 */
function createTestShaderPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'test-shader-panel';
  panel.className = 'test-shader-panel';

  // Shader preset dropdown options
  const presetOptions = [
    `<option value="">Custom (type your own)</option>`,
    ...SHADER_TEST_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`),
  ].join('');

  // Marker-bearing zones for the Shaders tab.
  const shaderZones = [
    'force_field',
    'color_over_life',
    'size_over_life',
    'spawn_behavior',
    'velocity_modifier',
    'post_fx',
    'billboard_pixel',
    'billboard_vertex',
  ];
  const zoneCheckboxes = shaderZones
    .map(z => `<label class="zone-checkbox-label"><input type="checkbox" data-zone="${z}" checked> ${z}</label>`)
    .join('');

  // Casting origin options for the Spell Program tab.
  const castingOrigins = ['hands', 'heart', 'eyes', 'whole_body', 'wand'];
  const castingOriginOptions = castingOrigins
    .map(o => `<option value="${o}">${o}</option>`)
    .join('');

  // Sprite dropdowns
  const frameCountOptions = [4, 8, 9, 12, 16]
    .map(n => `<option value="${n}"${n === 16 ? ' selected' : ''}>${n}</option>`)
    .join('');
  const playbackOptions = ['loop', 'once', 'pingpong', 'random']
    .map(m => `<option value="${m}">${m}</option>`)
    .join('');
  const driveOptions = ['age', 'life', 'velocity', 'id', 'time']
    .map(d => `<option value="${d}">${d}</option>`)
    .join('');

  panel.innerHTML = `
    <div class="test-shader-header">
      <h3>Test Mode</h3>
      <div class="test-shader-tabs">
        <button class="test-shader-tab active" data-tab="shaders">Shaders</button>
        <button class="test-shader-tab" data-tab="sprites">Sprites</button>
        <button class="test-shader-tab" data-tab="flipbook">Flipbook</button>
        <button class="test-shader-tab" data-tab="live-spell">Live Spell</button>
        <button class="test-shader-tab" data-tab="conversation">Conversation</button>
        <button class="test-shader-tab" data-tab="sessions">Sessions</button>
      </div>
      <button class="close-btn">×</button>
    </div>

    <div class="test-shader-tab-content" data-tab="shaders">
      <div class="test-shader-config">
        <div class="config-row preset-row">
          <label>Preset:</label>
          <select id="test-preset">${presetOptions}</select>
        </div>
        <div class="config-row">
          <label>Spell:</label>
          <textarea id="test-prompt" rows="3" placeholder="A fire eruption spell — intense confidence, scorching orange plasma blasting upward from the chest"></textarea>
        </div>
        <div class="config-row zones-row">
          <label>Zones:</label>
          <div class="zone-checkboxes">${zoneCheckboxes}</div>
        </div>
        <button id="generate-shaders-btn" class="generate-btn">Generate Shaders</button>
      </div>
      <div id="test-shader-status" class="test-shader-status"></div>
      <div id="test-shader-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="sprites" style="display: none;">
      <div class="sprite-mode-toggle">
        <label><input type="radio" name="sprite-mode" value="direct" checked> Direct Spec</label>
        <label><input type="radio" name="sprite-mode" value="gemini"> Gemini Interpretation</label>
      </div>

      <div class="test-shader-config sprite-direct-form">
        <div class="config-row">
          <label>Description:</label>
          <input type="text" id="sprite-description" placeholder="glowing blue orb">
        </div>
        <div class="config-row">
          <label>Style:</label>
          <input type="text" id="sprite-style" placeholder="soft glow">
        </div>
        <div class="config-row">
          <label>Animation:</label>
          <input type="text" id="sprite-animation" placeholder="(blank = single sprite)">
        </div>
        <div class="config-row">
          <label>Frames:</label>
          <select id="sprite-frame-count">${frameCountOptions}</select>
        </div>
        <div class="config-row">
          <label>Playback:</label>
          <select id="sprite-playback">${playbackOptions}</select>
        </div>
        <div class="config-row">
          <label>Drive:</label>
          <select id="sprite-drive">${driveOptions}</select>
        </div>
        <div class="config-row">
          <label>Frame dur:</label>
          <input type="number" id="sprite-frame-duration" value="0.1" step="0.01" min="0.001">
        </div>
        <button id="generate-sprite-btn" class="generate-btn">Generate Sprite</button>
      </div>

      <div class="test-shader-config sprite-gemini-form" style="display: none;">
        <div class="config-row">
          <label>Prompt:</label>
          <textarea id="sprite-gemini-prompt" rows="3" placeholder="a slow-pulsing protective shield, 9 frames, plays once"></textarea>
        </div>
        <button id="generate-sprite-gemini-btn" class="generate-btn">Interpret &amp; Generate</button>
      </div>

      <div id="sprite-status" class="test-shader-status"></div>
      <div id="sprite-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="flipbook" style="display: none;">
      <div class="test-shader-config flipbook-reconfig-form">
        <div class="config-row">
          <label>Playback:</label>
          <select id="rm-playback">${playbackOptions}</select>
        </div>
        <div class="config-row">
          <label>Drive:</label>
          <select id="rm-drive">${driveOptions}</select>
        </div>
        <div class="config-row">
          <label>Frame dur:</label>
          <input type="number" id="rm-frame-duration" value="0.1" step="0.01" min="0.001">
        </div>
        <button id="rm-apply-flipbook-btn" class="generate-btn">Apply Flipbook Config</button>
      </div>

      <div id="rm-status" class="test-shader-status"></div>

      <div class="sprite-state-readout" id="rm-readout">
        <div class="readout-title">Last pushed to TD</div>
        <div class="readout-grid" id="rm-readout-grid"></div>
      </div>
    </div>

    <div class="test-shader-tab-content" data-tab="live-spell" style="display: none;">
      <div class="test-shader-config spell-program-form">
        <div class="config-row">
          <label>Preset:</label>
          <select id="ls-preset">
            <option value="">Custom (type your own)</option>
            ${LIVE_SPELL_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="config-row">
          <label>Describe a spell:</label>
          <textarea id="ls-prompt" rows="3" placeholder="a slow-pulsing protective shield that explodes outward at release"></textarea>
        </div>
        <button id="ls-run-btn" class="generate-btn">Run Full Creative Process</button>
      </div>

      <div id="ls-status" class="test-shader-status"></div>
      <div id="ls-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="conversation" style="display: none;">
      <div class="test-shader-config conversation-form">
        <div class="config-row">
          <label>Character:</label>
          <select id="cv-preset">
            ${CONVERSATION_TEST_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="config-row conversation-opts">
          <label class="conversation-opt"><input type="checkbox" id="cv-mute-tts" checked> Mute TTS</label>
          <label class="conversation-opt"><input type="checkbox" id="cv-claude-driven" checked> Claude-driven (in-character)</label>
          <label class="conversation-opt">Pause (s): <input type="number" id="cv-pause" value="1.0" step="0.1" min="0" style="width: 60px"></label>
        </div>
        <div class="conversation-buttons">
          <button id="cv-run-btn" class="generate-btn">Run Script</button>
          <button id="cv-stop-btn" class="generate-btn" disabled>Stop</button>
          <button id="cv-copy-btn" class="generate-btn" disabled>Copy Transcript</button>
        </div>
      </div>
      <div id="cv-preview" class="conversation-preview"></div>
      <div id="cv-status" class="test-shader-status"></div>
      <div id="cv-transcript" class="conversation-transcript"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="sessions" style="display: none;">
      <div class="test-shader-config">
        <div class="config-row">
          <label>Name (optional):</label>
          <input type="text" id="session-name-input" placeholder="e.g. blue fire shield">
        </div>
        <button id="session-save-btn" class="generate-btn">Save Current Session</button>
        <p class="session-note">Note: sprite texture is not saved — particle texture will default to placeholder after loading.</p>
      </div>
      <div id="session-status" class="test-shader-status"></div>
      <div id="session-list" class="test-shader-results"></div>
    </div>
  `;

  // === Shader tab event listeners ===
  const presetSelect = panel.querySelector('#test-preset') as HTMLSelectElement;
  const promptTextarea = panel.querySelector('#test-prompt') as HTMLTextAreaElement;
  presetSelect.addEventListener('change', () => {
    const preset = SHADER_TEST_PRESETS.find(p => p.id === presetSelect.value);
    if (preset) promptTextarea.value = preset.prompt;
  });

  const generateBtn = panel.querySelector('#generate-shaders-btn') as HTMLButtonElement;
  generateBtn.addEventListener('click', runTestShaderGeneration);

  // === Sprites tab event listeners ===
  const directBtn = panel.querySelector('#generate-sprite-btn') as HTMLButtonElement;
  directBtn.addEventListener('click', runSpriteDirect);

  const geminiBtn = panel.querySelector('#generate-sprite-gemini-btn') as HTMLButtonElement;
  geminiBtn.addEventListener('click', runSpriteGemini);

  panel.querySelectorAll('input[name="sprite-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = (radio as HTMLInputElement).value;
      const directForm = panel.querySelector('.sprite-direct-form') as HTMLElement;
      const geminiForm = panel.querySelector('.sprite-gemini-form') as HTMLElement;
      directForm.style.display = mode === 'direct' ? '' : 'none';
      geminiForm.style.display = mode === 'gemini' ? '' : 'none';
    });
  });

  // === Flipbook tab event listeners ===
  const applyFlipbookBtn = panel.querySelector('#rm-apply-flipbook-btn') as HTMLButtonElement;
  applyFlipbookBtn.addEventListener('click', runApplyFlipbookConfig);

  // === Live Spell tab event listeners ===
  const lsRunBtn = panel.querySelector('#ls-run-btn') as HTMLButtonElement;
  lsRunBtn.addEventListener('click', runLiveSpell);

  const lsPresetSelect = panel.querySelector('#ls-preset') as HTMLSelectElement;
  const lsPromptEl = panel.querySelector('#ls-prompt') as HTMLTextAreaElement;
  lsPresetSelect.addEventListener('change', () => {
    const preset = LIVE_SPELL_PRESETS.find(p => p.id === lsPresetSelect.value);
    if (preset) lsPromptEl.value = preset.prompt;
  });

  // === Conversation tab event listeners ===
  const cvPresetSelect = panel.querySelector('#cv-preset') as HTMLSelectElement;
  const cvPreviewEl = panel.querySelector('#cv-preview') as HTMLDivElement;
  const renderPreview = () => {
    const preset = CONVERSATION_TEST_PRESETS.find(p => p.id === cvPresetSelect.value);
    if (!preset) {
      cvPreviewEl.innerHTML = '';
      return;
    }
    const spellLine = preset.expectedSpell
      ? `<div class="cv-preview-meta">expected: ${escapeHtml(preset.expectedSpell.intent)} / ${escapeHtml(preset.expectedSpell.element)}</div>`
      : '';
    const faceLine = preset.expectedFace?.primaryEmotion
      ? `<div class="cv-preview-meta">face: ${escapeHtml(preset.expectedFace.primaryEmotion)}${preset.expectedFace.secondaryEmotion ? ' + ' + escapeHtml(preset.expectedFace.secondaryEmotion) : ''}</div>`
      : '';
    const bodyLine = preset.expectedBody?.primaryPosture
      ? `<div class="cv-preview-meta">body: ${escapeHtml(preset.expectedBody.primaryPosture)}</div>`
      : '';
    cvPreviewEl.innerHTML = `
      <div class="cv-preview-desc">${escapeHtml(preset.description)}</div>
      ${spellLine}
      ${faceLine}
      ${bodyLine}
      <ol class="cv-preview-script">
        ${preset.script.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
      </ol>
    `;
  };
  cvPresetSelect.addEventListener('change', renderPreview);
  // Initial fill — the first option is selected by default.
  renderPreview();

  const cvRunBtn = panel.querySelector('#cv-run-btn') as HTMLButtonElement;
  const cvStopBtn = panel.querySelector('#cv-stop-btn') as HTMLButtonElement;
  const cvCopyBtn = panel.querySelector('#cv-copy-btn') as HTMLButtonElement;
  cvRunBtn.addEventListener('click', () => runConversationFromPanel(panel));
  cvStopBtn.addEventListener('click', () => requestConversationStop());

  // === Sessions tab event listeners ===
  const sessionSaveBtn = panel.querySelector('#session-save-btn') as HTMLButtonElement;
  sessionSaveBtn.addEventListener('click', async () => {
    const nameInput = panel.querySelector('#session-name-input') as HTMLInputElement;
    const statusDiv = panel.querySelector('#session-status') as HTMLDivElement;
    const name = nameInput.value.trim() || undefined;
    statusDiv.textContent = 'Saving…';
    const result = await window.electronAPI.merlinSaveSession(name);
    if (result.success) {
      statusDiv.textContent = `Saved (${result.sessionId})`;
      nameInput.value = '';
      await refreshSessionList(panel);
    } else {
      statusDiv.textContent = `Error: ${result.error}`;
    }
  });

  // === Tab switching ===
  panel.querySelectorAll('.test-shader-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const tabName = (tabBtn as HTMLButtonElement).dataset.tab;
      panel.querySelectorAll('.test-shader-tab').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      panel.querySelectorAll('.test-shader-tab-content').forEach(content => {
        const el = content as HTMLElement;
        el.style.display = el.dataset.tab === tabName ? '' : 'none';
      });
      if (tabName === 'flipbook') {
        refreshFlipbookTabFromMirror();
      }
      if (tabName === 'sessions') {
        refreshSessionList(panel);
      }
    });
  });

  // Close handler — route through hideTestShaderPanel so the sidebar
  // is restored cleanly when no live session is active.
  const closeBtn = panel.querySelector('.close-btn') as HTMLButtonElement;
  closeBtn.addEventListener('click', () => {
    hideTestShaderPanel();
  });

  return panel;
}

/**
 * Run the test shader generation
 */
async function runTestShaderGeneration(): Promise<void> {
  const promptTextarea = document.getElementById('test-prompt') as HTMLTextAreaElement;
  const statusDiv = document.getElementById('test-shader-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('test-shader-results') as HTMLDivElement;
  const generateBtn = document.getElementById('generate-shaders-btn') as HTMLButtonElement;

  const prompt = promptTextarea.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Enter a spell description';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  // Gather selected zones from the checkbox grid
  const zoneCheckboxes = document.querySelectorAll<HTMLInputElement>(
    '.zone-checkboxes input[type="checkbox"]'
  );
  const zones = Array.from(zoneCheckboxes)
    .filter(c => c.checked)
    .map(c => c.dataset.zone || '');

  if (zones.length === 0) {
    statusDiv.textContent = 'Pick at least one zone';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  const config = { prompt, zones };

  // Update UI to loading state
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  statusDiv.textContent = `Generating ${zones.length} zone(s)...`;
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestShader(config);

    if (result.success) {
      statusDiv.textContent = `Generated ${result.zones.length} zone shaders`;
      statusDiv.className = 'test-shader-status success';
    } else {
      statusDiv.textContent = result.error || 'Failed to generate shaders';
      statusDiv.className = 'test-shader-status error';
    }

    // Display results with status indicators
    resultsDiv.innerHTML = result.zones.map(zone => `
      <div class="shader-zone-result" data-zone="${zone.zone}">
        <div class="zone-header">
          <span class="zone-status ${zone.status || 'pending'}"></span>
          <span class="zone-name">${zone.zone}</span>
          <span class="zone-desc">${zone.description}</span>
        </div>
        ${zone.error ? `<div class="zone-error">${escapeHtml(zone.error)}</div>` : ''}
        ${zone.warnings?.length ? `<div class="zone-warnings">${zone.warnings.map(w => escapeHtml(w)).join('<br>')}</div>` : ''}
        <pre class="zone-glsl">${escapeHtml(zone.glsl_code)}</pre>
      </div>
    `).join('');

  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  // Reset button
  generateBtn.disabled = false;
  generateBtn.textContent = 'Generate Shaders';
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Read the Direct-mode form into a SpriteTestSpec.
 */
function readSpriteSpecFromForm(): SpriteTestSpec | null {
  const description = (document.getElementById('sprite-description') as HTMLInputElement).value.trim();
  if (!description) return null;

  const style = (document.getElementById('sprite-style') as HTMLInputElement).value.trim();
  const animation = (document.getElementById('sprite-animation') as HTMLInputElement).value.trim();
  const frameCount = parseInt((document.getElementById('sprite-frame-count') as HTMLSelectElement).value, 10) as SpriteFrameCount;
  const playbackMode = (document.getElementById('sprite-playback') as HTMLSelectElement).value as SpritePlaybackMode;
  const driveSource = (document.getElementById('sprite-drive') as HTMLSelectElement).value as SpriteDriveSource;
  const frameDuration = parseFloat((document.getElementById('sprite-frame-duration') as HTMLInputElement).value);

  const spec: SpriteTestSpec = { description };
  if (style) spec.style = style;
  if (animation) spec.animation = animation;
  // Only include flipbook params when there's an animation; single-sprite path ignores them.
  if (animation) {
    spec.frameCount = frameCount;
    spec.playbackMode = playbackMode;
    spec.driveSource = driveSource;
    if (!isNaN(frameDuration)) spec.frameDuration = frameDuration;
  }
  return spec;
}

/**
 * Run sprite generation in Direct mode.
 */
async function runSpriteDirect(): Promise<void> {
  const btn = document.getElementById('generate-sprite-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('sprite-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('sprite-results') as HTMLDivElement;

  const spec = readSpriteSpecFromForm();
  if (!spec) {
    statusDiv.textContent = 'Description is required';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';
  statusDiv.textContent = `Generating ${spec.animation ? 'flipbook' : 'sprite'}: "${spec.description}"...`;
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestSpriteDirect(spec);
    renderSpriteResult(result, statusDiv, resultsDiv);
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Generate Sprite';
}

/**
 * Run sprite generation in Gemini-interpretation mode.
 */
async function runSpriteGemini(): Promise<void> {
  const btn = document.getElementById('generate-sprite-gemini-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('sprite-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('sprite-results') as HTMLDivElement;
  const promptEl = document.getElementById('sprite-gemini-prompt') as HTMLTextAreaElement;

  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Prompt is required';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Interpreting...';
  statusDiv.textContent = 'Asking Gemini to choose sprite parameters...';
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestSpriteGemini(prompt);
    renderSpriteResult(result, statusDiv, resultsDiv);
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Interpret & Generate';
}

/**
 * Render a sprite result into the status + results panels.
 */
function renderSpriteResult(
  result: SpriteTestResult,
  statusDiv: HTMLDivElement,
  resultsDiv: HTMLDivElement
): void {
  if (!result.success) {
    statusDiv.textContent = result.error || 'Generation failed';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  // Status: success, but warn if TD push failed.
  if (result.pushed.texture === false) {
    statusDiv.textContent = 'Generated, but TD not connected — texture not pushed';
    statusDiv.className = 'test-shader-status error';
  } else {
    statusDiv.textContent = `Generated ${result.assetType} sprite (${result.assetId})`;
    statusDiv.className = 'test-shader-status success';
  }

  const parts: string[] = [];

  if (result.geminiArgs) {
    parts.push(`
      <div class="gemini-args">
        <div class="gemini-args-title">Gemini chose:</div>
        <pre>${escapeHtml(JSON.stringify(result.geminiArgs, null, 2))}</pre>
      </div>
    `);
  }

  if (result.previewPng) {
    parts.push(`
      <div class="sprite-preview">
        <img src="data:image/png;base64,${result.previewPng}" alt="generated sprite" />
      </div>
    `);
  }

  const meta: Array<[string, string]> = [
    ['assetId', result.assetId ?? '-'],
    ['assetType', result.assetType ?? '-'],
    ['texturePath', result.texturePath ?? '-'],
    ['texturePushed', String(result.pushed.texture)],
  ];
  if (result.assetType === 'flipbook' && result.flipbookConfig) {
    meta.push(['atlas', `${result.flipbookConfig.atlasCols}x${result.flipbookConfig.atlasRows}`]);
    meta.push(['frameCount', String(result.flipbookConfig.frameCount)]);
    meta.push(['playbackMode', result.flipbookConfig.playbackMode]);
    meta.push(['frameDuration', String(result.flipbookConfig.frameDuration)]);
    meta.push(['driveSource', result.flipbookConfig.driveSource]);
    meta.push(['flipbookPushed', String(result.pushed.flipbook)]);
  }

  parts.push(`
    <div class="sprite-meta">
      ${meta.map(([k, v]) => `<div><span class="meta-key">${k}:</span> <span class="meta-value">${escapeHtml(v)}</span></div>`).join('')}
    </div>
  `);

  resultsDiv.innerHTML = parts.join('');
}

// ============ FLIPBOOK TAB ============

/**
 * Pull the latest mirrored TD state from the main process and paint it
 * into the readout + the read-only atlas/frame-count fields. Called on
 * tab open and after every push.
 */
async function refreshSessionList(panel: HTMLElement): Promise<void> {
  const listDiv = panel.querySelector('#session-list') as HTMLDivElement;
  if (!listDiv) return;
  try {
    const sessions = await window.electronAPI.merlinListSessions();
    if (sessions.length === 0) {
      listDiv.innerHTML = '<p class="session-empty">No saved sessions.</p>';
      return;
    }
    listDiv.innerHTML = sessions.map(s => {
      const label = s.name || new Date(s.timestamp).toLocaleString();
      const meta = [s.spellIntent, s.spellElement, `${s.zoneCount} zone${s.zoneCount !== 1 ? 's' : ''}`]
        .filter(Boolean).join(' · ');
      return `
        <div class="session-row" data-id="${escapeHtml(s.sessionId)}">
          <div class="session-row-label">
            <strong>${escapeHtml(label)}</strong>
            <span class="session-meta">${escapeHtml(meta)}</span>
          </div>
          <div class="session-row-actions">
            <button class="session-load-btn" data-id="${escapeHtml(s.sessionId)}">Load</button>
            <button class="session-delete-btn" data-id="${escapeHtml(s.sessionId)}">Delete</button>
          </div>
        </div>`;
    }).join('');

    listDiv.querySelectorAll('.session-load-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLButtonElement).dataset.id!;
        const statusDiv = panel.querySelector('#session-status') as HTMLDivElement;
        statusDiv.textContent = 'Loading…';
        const result = await window.electronAPI.merlinLoadSession(id);
        if (result.success) {
          const zonesSummary = Object.entries(result.zoneResults ?? {})
            .map(([z, ok]) => `${z}:${ok ? '✓' : '✗'}`).join(' ');
          statusDiv.textContent = `Loaded. Zones: ${zonesSummary || 'none'}`;
        } else {
          statusDiv.textContent = `Error: ${result.error}`;
        }
      });
    });

    listDiv.querySelectorAll('.session-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLButtonElement).dataset.id!;
        await window.electronAPI.merlinDeleteSession(id);
        await refreshSessionList(panel);
      });
    });
  } catch (error) {
    listDiv.innerHTML = `<p class="session-empty">Error loading sessions.</p>`;
    console.error('[Sessions] Failed to list sessions:', error);
  }
}

async function refreshFlipbookTabFromMirror(): Promise<void> {
  try {
    const state = await window.electronAPI.merlinTestGetMirroredState();
    paintMirroredState(state);
  } catch (error) {
    console.error('[Flipbook] Failed to fetch mirrored state:', error);
  }
}

function paintMirroredState(state: MirroredTDState): void {
  lastFlipbookMirror = state;

  const setVal = (id: string, value: string | number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(value);
  };

  // Pre-fill the editable fields with current values so Apply doesn't
  // surprise the user by reverting to defaults.
  setVal('rm-frame-duration', state.flipbook.frameDuration);
  const playbackEl = document.getElementById('rm-playback') as HTMLSelectElement | null;
  if (playbackEl) playbackEl.value = state.flipbook.playbackMode;
  const driveEl = document.getElementById('rm-drive') as HTMLSelectElement | null;
  if (driveEl) driveEl.value = state.flipbook.driveSource;

  // Readout grid
  const grid = document.getElementById('rm-readout-grid');
  if (!grid) return;
  const ago = state.lastUpdatedAt ? `${Math.round((Date.now() - state.lastUpdatedAt) / 1000)}s ago` : 'never';
  const rows: Array<[string, string]> = [
    ['atlas', `${state.flipbook.atlasCols} × ${state.flipbook.atlasRows}`],
    ['frame_count', String(state.flipbook.frameCount)],
    ['playback_mode', state.flipbook.playbackMode],
    ['frame_duration', String(state.flipbook.frameDuration)],
    ['drive_source', state.flipbook.driveSource],
    ['last_source', state.lastSource ? `${state.lastSource} (${ago})` : 'never pushed'],
  ];
  grid.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="readout-key">${k}:</div><div class="readout-value">${escapeHtml(v)}</div>`
    )
    .join('');
}

function setFlipbookStatus(text: string, kind: 'loading' | 'success' | 'error'): void {
  const statusDiv = document.getElementById('rm-status') as HTMLDivElement | null;
  if (!statusDiv) return;
  statusDiv.textContent = text;
  statusDiv.className = `test-shader-status ${kind}`;
}

async function runApplyFlipbookConfig(): Promise<void> {
  const atlasCols = lastFlipbookMirror?.flipbook.atlasCols ?? 1;
  const atlasRows = lastFlipbookMirror?.flipbook.atlasRows ?? 1;
  const frameCount = lastFlipbookMirror?.flipbook.frameCount ?? 1;
  const playbackMode = (document.getElementById('rm-playback') as HTMLSelectElement).value as SpritePlaybackMode;
  const driveSource = (document.getElementById('rm-drive') as HTMLSelectElement).value as SpriteDriveSource;
  const frameDuration = parseFloat((document.getElementById('rm-frame-duration') as HTMLInputElement).value);

  const config: SpriteFlipbookConfig = {
    atlasCols,
    atlasRows,
    frameCount,
    playbackMode,
    frameDuration,
    driveSource,
  };

  const btn = document.getElementById('rm-apply-flipbook-btn') as HTMLButtonElement;
  btn.disabled = true;
  setFlipbookStatus('Pushing flipbook_config...', 'loading');

  try {
    const result: FlipbookTestResult = await window.electronAPI.merlinTestFlipbookConfig(config);
    paintMirroredState(result.state);
    if (result.pushed) {
      setFlipbookStatus('flipbook_config applied', 'success');
    } else {
      setFlipbookStatus('TD not connected — flipbook_config not pushed', 'error');
    }
  } catch (error) {
    setFlipbookStatus(`Error: ${error}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ LIVE SPELL TAB ============

async function runLiveSpell(): Promise<void> {
  const btn = document.getElementById('ls-run-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('ls-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('ls-results') as HTMLDivElement;
  const promptEl = document.getElementById('ls-prompt') as HTMLTextAreaElement;

  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Describe a spell first';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  const input: LiveSpellTestInput = { prompt };

  btn.disabled = true;
  btn.textContent = 'Running…';
  statusDiv.textContent = 'Gemini is creating the spell — watch the sidebar for tool calls';
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result: LiveSpellTestResult = await window.electronAPI.merlinTestLiveSpell(input);
    if (result.success) {
      statusDiv.textContent = `Done — ${result.toolCallCount} tool call(s) executed`;
      statusDiv.className = 'test-shader-status success';
      const parts: string[] = [];
      if (result.finalText) {
        parts.push(`<div class="gemini-args"><div class="gemini-args-title">Gemini said:</div><pre>${escapeHtml(result.finalText)}</pre></div>`);
      }
      if (result.finalSpell) {
        parts.push(`<div class="gemini-args"><div class="gemini-args-title">Final spell state:</div><pre>${escapeHtml(JSON.stringify(result.finalSpell, null, 2))}</pre></div>`);
      }
      resultsDiv.innerHTML = parts.join('');
    } else {
      statusDiv.textContent = result.error || 'Run failed';
      statusDiv.className = 'test-shader-status error';
    }
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Run Full Creative Process';
}

// ============ CONVERSATION TESTER ============
//
// Multi-turn scripted participant playback. The runner walks a list of
// utterances through the real Merlin pipeline (merlinStart →
// merlinProcessSpeech per line → merlinEnd) and bypasses Whisper. TTS
// is muted via `testModeMuteTts` so the whole conversation runs in
// seconds. Tool calls per turn are captured by listening to
// `gemini-conversation` events emitted by the live session.

let conversationRunActive = false;
let conversationRunStopRequested = false;

interface ConversationRunOpts {
  /** Slug for the saved transcript filename (e.g. preset id or "custom"). */
  id: string;
  character: string;
  script: string[];
  muteTts: boolean;
  pauseMs: number;
  /** Synthetic face analysis pushed before each turn. Replaces MediaPipe. */
  face?: Partial<MicroExpressionAnalysis>;
  /** Synthetic body analysis pushed before each turn. Replaces MediaPipe. */
  body?: Partial<BodyLanguageAnalysis>;
  /**
   * When true, the runner uses the first script line as an opener and
   * then asks Claude (via main IPC) to generate each subsequent
   * participant utterance in-character. Falls back to the canned
   * script silently if the IPC reports no Anthropic key is configured.
   */
  claudeDriven?: boolean;
  /** Used to ask Claude to lean toward this spell shape. */
  expectedSpell?: { intent: string; element: string };
  onTurnComplete: (turn: ConversationTurnSnapshot) => void;
  onStatus: (msg: string) => void;
}

interface ConversationRunResult {
  snapshots: ConversationTurnSnapshot[];
  transcriptPath?: string;
}

async function runConversationTest(opts: ConversationRunOpts): Promise<ConversationRunResult> {
  if (conversationRunActive) throw new Error('A conversation test is already running');
  if (merlinModeActive) {
    opts.onStatus('Stopping live Merlin session before test…');
    await stopMerlinMode();
    // stopMerlinMode triggers a 3s UI fade — wait a beat so the next
    // start gets a clean slate.
    await new Promise(r => setTimeout(r, 200));
  }

  conversationRunActive = true;
  conversationRunStopRequested = false;
  testModeMuteTts = opts.muteTts;

  // Collect gemini-conversation events emitted between merlinProcessSpeech
  // start and resolution. We tag the start of each turn with a sentinel
  // and pull events that arrived after it.
  const liveEvents: Partial<GeminiTurn>[] = [];
  const removeListener = window.electronAPI.onGeminiConversation((turn) => {
    if (turn.source === 'live') liveEvents.push(turn);
  });

  const snapshots: ConversationTurnSnapshot[] = [];

  // Conversation history for the Claude-as-participant path. We log
  // every Merlin response and every participant line here so Claude
  // can produce a coherent in-character reply each turn.
  const history: Array<{ speaker: 'merlin' | 'participant'; text: string }> = [];

  // Indexes of script lines that drive a real conversational turn (i.e.
  // not [CAST]/[END] markers). Used to figure out which line is the
  // first conversational turn (use canned opener) and which is the
  // last (tell Claude to wind down).
  const conversationalIdxs = opts.script
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter(({ line }) => line && line !== '[CAST]' && line !== '[END]')
    .map(({ idx }) => idx);
  const firstConversationalIdx = conversationalIdxs[0];
  const lastConversationalIdx = conversationalIdxs[conversationalIdxs.length - 1];

  // Phase + spell flow through the per-call response objects — no need
  // to subscribe to onMerlinUpdate. merlinStart, merlinProcessSpeech,
  // merlinTriggerCast and merlinTriggerEnd all return the current
  // phase, and merlinStart/merlinProcessSpeech additionally return the
  // current SpellState.
  let currentPhase: string;
  let currentSpell: SpellState;
  let claudeAvailable = opts.claudeDriven === true;

  // Make the merlin-conversation sidebar visible so the chat-history
  // bubbles we add per turn are actually seen. Live mode does this via
  // startMerlinMode; the runner sidesteps that and calls merlinStart
  // directly, so we have to flip the classes ourselves.
  const sidebarEl = document.getElementById('sidebar');
  const merlinPanelEl = document.getElementById('merlin-panel');
  sidebarEl?.classList.add('merlin-active');
  merlinPanelEl?.classList.add('active');
  clearMerlinUI();

  try {
    opts.onStatus('Starting Merlin session…');
    const intro = await window.electronAPI.merlinStart();
    currentPhase = intro.phase;
    currentSpell = intro.spell;
    if (intro.text) {
      addMerlinMessage('assistant', intro.text);
      history.push({ speaker: 'merlin', text: intro.text });
    }
    // Drain intro-time gemini events so they don't get attributed to turn 1.
    await new Promise(r => setTimeout(r, 50));
    liveEvents.length = 0;

    for (let i = 0; i < opts.script.length; i++) {
      if (conversationRunStopRequested) {
        opts.onStatus('Stopped by user');
        break;
      }
      let line = opts.script[i].trim();
      if (!line) continue;

      const phaseBefore = currentPhase;
      const t0 = performance.now();

      // Marker handling: [CAST] / [END] bypass Gemini and fire IPC directly.
      if (line === '[CAST]') {
        opts.onStatus(`Turn ${i + 1}: triggering cast`);
        const result = await window.electronAPI.merlinTriggerCast();
        if (result.phase) currentPhase = result.phase;
        await new Promise(r => setTimeout(r, 150)); // let downstream effects propagate
        const snap: ConversationTurnSnapshot = {
          index: i + 1,
          participantLine: '[CAST]',
          geminiText: result.ok ? '(cast triggered)' : `(cast skipped: ${result.reason || 'unknown'})`,
          phaseBefore,
          phaseAfter: currentPhase,
          toolCalls: [],
          spell: currentSpell,
          faceActivity: null,
          durationMs: Math.round(performance.now() - t0),
          marker: 'cast',
        };
        snapshots.push(snap);
        opts.onTurnComplete(snap);
        if (opts.pauseMs > 0) await new Promise(r => setTimeout(r, opts.pauseMs));
        continue;
      }
      if (line === '[END]') {
        opts.onStatus(`Turn ${i + 1}: triggering end`);
        const result = await window.electronAPI.merlinTriggerEnd();
        if (result.phase) currentPhase = result.phase;
        await new Promise(r => setTimeout(r, 150));
        const snap: ConversationTurnSnapshot = {
          index: i + 1,
          participantLine: '[END]',
          geminiText: result.ok ? '(play closed)' : `(end skipped: ${result.reason || 'unknown'})`,
          phaseBefore,
          phaseAfter: currentPhase,
          toolCalls: [],
          spell: currentSpell,
          faceActivity: null,
          durationMs: Math.round(performance.now() - t0),
          marker: 'end',
        };
        snapshots.push(snap);
        opts.onTurnComplete(snap);
        if (opts.pauseMs > 0) await new Promise(r => setTimeout(r, opts.pauseMs));
        continue;
      }

      // Claude-as-participant: replace canned mid-conversation lines
      // with an in-character utterance generated from history. Keep
      // the first conversational line as the opener so each preset has
      // a consistent starting beat. If the IPC reports no API key (or
      // the call fails) we fall through to the canned script.
      const isFirstTurn = i === firstConversationalIdx;
      const isClosingTurn = i === lastConversationalIdx;
      if (claudeAvailable && !isFirstTurn) {
        opts.onStatus(`Turn ${i + 1}: asking Claude for participant line…`);
        const result = await window.electronAPI.generateParticipantLine({
          characterDescription: opts.character,
          faceDescription: opts.face?.description,
          bodyDescription: opts.body?.description,
          expectedSpell: opts.expectedSpell,
          history,
          closing: isClosingTurn,
        });
        if (!result.available) {
          console.warn('[ConversationTest] ANTHROPIC_API_KEY not set; falling back to canned script.');
          claudeAvailable = false;
        } else if (result.ok && result.line) {
          line = result.line;
        } else {
          console.warn('[ConversationTest] Claude returned no line; falling back to canned script:', result.error);
        }
      }

      opts.onStatus(`Turn ${i + 1}/${opts.script.length}: ${line.slice(0, 60)}${line.length > 60 ? '…' : ''}`);
      // Mirror the live mic path: surface the participant's line in the
      // sidebar's merlin-conversation chat history so it's visible
      // alongside Merlin's replies (the live LIVE Gemini card hides
      // userPrompt by design — this is the canonical "what did the
      // participant say" bubble).
      addMerlinMessage('user', line);
      history.push({ speaker: 'participant', text: line });
      // Push the character's synthetic face + body analysis so Gemini's
      // per-turn context contains the same shape it would have from
      // MediaPipe + analyzeMicroExpressions in the live mic path.
      if (opts.face || opts.body) {
        window.electronAPI.merlinUpdateAnalysis({
          face: opts.face,
          body: opts.body,
        });
      }
      const turnStartIdx = liveEvents.length;
      const response = await window.electronAPI.merlinProcessSpeech(line);
      // Brief grace period so any trailing post-tool events flush.
      await new Promise(r => setTimeout(r, 50));
      if (response.text) {
        addMerlinMessage('assistant', response.text);
        history.push({ speaker: 'merlin', text: response.text });
      }

      const turnEvents = liveEvents.slice(turnStartIdx);
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let faceActivity: string | null = null;
      for (const ev of turnEvents) {
        if (ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            toolCalls.push({ name: tc.name, args: tc.args });
          }
        }
        if (ev.faceActivity) faceActivity = ev.faceActivity;
      }

      currentPhase = response.phase;
      currentSpell = response.spell;
      const snap: ConversationTurnSnapshot = {
        index: i + 1,
        participantLine: line,
        geminiText: response.text,
        phaseBefore,
        phaseAfter: response.phase,
        toolCalls,
        spell: response.spell,
        faceActivity,
        durationMs: Math.round(performance.now() - t0),
      };
      snapshots.push(snap);
      opts.onTurnComplete(snap);

      if (opts.pauseMs > 0 && i < opts.script.length - 1) {
        await new Promise(r => setTimeout(r, opts.pauseMs));
      }
    }

    opts.onStatus('Ending Merlin session…');
    try {
      await window.electronAPI.merlinEnd();
    } catch (err) {
      console.warn('[ConversationTest] merlinEnd error:', err);
    }
  } finally {
    removeListener();
    testModeMuteTts = false;
    conversationRunActive = false;
    conversationRunStopRequested = false;
  }

  const transcriptJson = JSON.stringify({
    id: opts.id,
    character: opts.character,
    runAt: new Date().toISOString(),
    muteTts: opts.muteTts,
    pauseMs: opts.pauseMs,
    claudeDriven: opts.claudeDriven === true,
    snapshots,
  }, null, 2);
  console.log('[ConversationTest] Full transcript:', transcriptJson);
  let transcriptPath: string | undefined;
  try {
    const saveResult = await window.electronAPI.saveConversationTranscript({
      id: opts.id,
      json: transcriptJson,
    });
    if (saveResult.ok) {
      transcriptPath = saveResult.path;
      opts.onStatus(`Saved transcript: ${saveResult.path}`);
      console.log(`[ConversationTest] Transcript saved to ${saveResult.path}`);
    } else {
      console.warn('[ConversationTest] Failed to save transcript:', saveResult.error);
    }
  } catch (err) {
    console.warn('[ConversationTest] Save IPC failed:', err);
  }
  return { snapshots, transcriptPath };
}

function requestConversationStop(): void {
  conversationRunStopRequested = true;
}

/**
 * Glue between the Conversation tab UI and `runConversationTest`.
 * Reads the form, drives the runner, renders per-turn rows into the
 * transcript pane, and enables the Copy button once the run finishes.
 */
async function runConversationFromPanel(panel: HTMLElement): Promise<void> {
  const runBtn = panel.querySelector('#cv-run-btn') as HTMLButtonElement;
  const stopBtn = panel.querySelector('#cv-stop-btn') as HTMLButtonElement;
  const copyBtn = panel.querySelector('#cv-copy-btn') as HTMLButtonElement;
  const statusDiv = panel.querySelector('#cv-status') as HTMLDivElement;
  const transcriptDiv = panel.querySelector('#cv-transcript') as HTMLDivElement;
  const presetSelect = panel.querySelector('#cv-preset') as HTMLSelectElement;
  const muteEl = panel.querySelector('#cv-mute-tts') as HTMLInputElement;
  const pauseEl = panel.querySelector('#cv-pause') as HTMLInputElement;

  const preset = CONVERSATION_TEST_PRESETS.find(p => p.id === presetSelect.value);
  if (!preset) {
    statusDiv.textContent = 'No character selected';
    statusDiv.className = 'test-shader-status error';
    return;
  }
  const script = preset.script;
  const pauseMs = Math.max(0, parseFloat(pauseEl.value || '1') * 1000);
  const muteTts = muteEl.checked;
  const claudeEl = panel.querySelector('#cv-claude-driven') as HTMLInputElement;
  const claudeDriven = claudeEl.checked;

  runBtn.disabled = true;
  stopBtn.disabled = false;
  copyBtn.disabled = true;
  transcriptDiv.innerHTML = '';
  statusDiv.className = 'test-shader-status loading';

  const renderTurn = (turn: ConversationTurnSnapshot) => {
    const row = document.createElement('div');
    row.className = 'conversation-turn';
    const toolsHtml = turn.toolCalls.length
      ? `<div class="cv-tools">${turn.toolCalls.map(tc => `<span class="cv-tool-chip">${escapeHtml(tc.name)}</span>`).join('')}</div>`
      : '';
    const faceHtml = turn.faceActivity
      ? `<div class="cv-face">face: ${escapeHtml(turn.faceActivity)}</div>`
      : '';
    const spellHtml = (turn.spell && (turn.spell.intent || turn.spell.element))
      ? `<div class="cv-spell">spell: ${escapeHtml(turn.spell.intent || '–')} / ${escapeHtml(turn.spell.element || '–')}${turn.spell.castingOrigin ? ' / ' + escapeHtml(turn.spell.castingOrigin) : ''}</div>`
      : '';
    row.innerHTML = `
      <div class="cv-line cv-you">YOU: ${escapeHtml(turn.participantLine)}</div>
      <div class="cv-line cv-merlin">MERLIN: ${escapeHtml(turn.geminiText)}</div>
      <div class="cv-meta">phase: ${escapeHtml(turn.phaseBefore)} → ${escapeHtml(turn.phaseAfter)} · ${turn.durationMs}ms</div>
      ${spellHtml}
      ${toolsHtml}
      ${faceHtml}
    `;
    transcriptDiv.appendChild(row);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
  };

  let snapshots: ConversationTurnSnapshot[] = [];
  try {
    const result = await runConversationTest({
      id: preset.id,
      character: preset.description,
      script,
      muteTts,
      pauseMs,
      face: preset.expectedFace,
      body: preset.expectedBody,
      claudeDriven,
      expectedSpell: preset.expectedSpell,
      onTurnComplete: renderTurn,
      onStatus: (msg) => {
        statusDiv.textContent = msg;
      },
    });
    snapshots = result.snapshots;
    statusDiv.textContent = `Done — ${snapshots.length} turn(s)`;
    statusDiv.className = 'test-shader-status success';
  } catch (err) {
    statusDiv.textContent = `Error: ${err}`;
    statusDiv.className = 'test-shader-status error';
  } finally {
    runBtn.disabled = false;
    stopBtn.disabled = true;
    copyBtn.disabled = snapshots.length === 0;
    copyBtn.onclick = () => {
      const json = JSON.stringify(snapshots, null, 2);
      void navigator.clipboard.writeText(json);
      statusDiv.textContent = 'Transcript copied to clipboard';
    };
  }
}

/**
 * Initialize MediaPipe models
 */
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

    if (loaded.length === 4) {
      if (statusDisplay) statusDisplay.textContent = `MediaPipe: All models loaded`;
    } else if (loaded.length > 0) {
      if (statusDisplay) statusDisplay.textContent = `MediaPipe: ${loaded.join(', ')} loaded`;
    } else {
      if (statusDisplay) statusDisplay.textContent = 'MediaPipe: Failed to load models';
    }

    mediapipeReady = loaded.length > 0;

    // Wire face-gesture events. Renderer-only signals — log to console,
    // forward to main via IPC for the get_face_events tool / FACE
    // ACTIVITY context injection, AND update the sidebar HUD so the
    // user can SEE that detection is working.
    setFaceGestureCallback((evt: FaceGestureEvent) => {
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
 * Initialize voice commands (Whisper)
 */
async function initVoice(): Promise<void> {
  console.log('Initializing Whisper for voice commands...');

  // Setup callbacks
  onVoiceStatus(updateVoiceStatusDisplay);
  onVoiceTranscript(handleVoiceTranscript);

  // Initialize Whisper (small model for better accuracy)
  const success = await initWhisper({
    model: 'onnx-community/whisper-small.en',
    silenceTimeout: 1500,
    maxRecordingTime: 15000,
  });

  voiceReady = success;
  if (success) {
    console.log('Voice commands ready');
  } else {
    console.warn('Voice commands not available');
  }
}

/**
 * Initialize text-to-speech (Gemini TTS)
 */
async function initSpeech(): Promise<void> {
  console.log('Initializing Gemini TTS...');

  // Setup callback for speaking state changes
  onSpeakingStateChange((speaking) => {
    updateMerlinSpeakingIndicator(speaking);
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

/**
 * Update Merlin UI with current state
 */
function updateMerlinUI(update: MerlinUIUpdate): void {
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('merlin-panel');
  const header = document.getElementById('merlin-header');
  const phaseSpan = document.getElementById('merlin-phase');
  const turnSpan = document.getElementById('merlin-turn');
  const voiceStatus = document.getElementById('merlin-voice-status');

  if (!sidebar || !panel) return;

  // Update phase and turn
  if (phaseSpan) phaseSpan.textContent = displayPhaseLabel(update.phase);
  if (turnSpan) turnSpan.textContent = update.turnCount.toString();

  // Update spell state display
  updateMerlinSpellUI(update.spell);

  // Update element accent on header
  if (header && update.spell.element) {
    header.className = `merlin-header element-${update.spell.element}`;
  }

  // Update voice status
  if (voiceStatus) {
    if (update.isProcessing) {
      voiceStatus.textContent = 'Processing...';
      voiceStatus.className = 'merlin-voice-status processing';
    } else if (update.isListening) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'merlin-voice-status listening';
    } else if (update.phase === 'idle') {
      voiceStatus.textContent = 'Shift+M to begin';
      voiceStatus.className = 'merlin-voice-status';
    } else {
      voiceStatus.textContent = 'Ready';
      voiceStatus.className = 'merlin-voice-status';
    }
  }

  // Add last message to conversation
  if (update.lastMessage) {
    addMerlinMessage(update.lastMessage.role, update.lastMessage.content);
  }
}

/**
 * Update spell state UI elements
 */
function updateMerlinSpellUI(spell: SpellState): void {
  const intentEl = document.getElementById('spell-intent');
  const elementEl = document.getElementById('spell-element');
  const originEl = document.getElementById('spell-origin');
  const magicWordEl = document.getElementById('spell-magic-word');
  const confidenceFill = document.getElementById('spell-confidence-fill');

  if (intentEl) {
    intentEl.textContent = spell.intent ? capitalize(spell.intent) : '-';
    intentEl.classList.toggle('empty', !spell.intent);
  }
  if (elementEl) {
    elementEl.textContent = spell.element ? capitalize(spell.element) : '-';
    elementEl.classList.toggle('empty', !spell.element);
  }
  if (originEl) {
    const origin = spell.castingOrigin?.replace(/_/g, ' ');
    originEl.textContent = origin ? capitalize(origin) : '-';
    originEl.classList.toggle('empty', !spell.castingOrigin);
  }
  if (magicWordEl) {
    magicWordEl.textContent = spell.magicWord ?? '-';
    magicWordEl.classList.toggle('empty', !spell.magicWord);
  }
  if (confidenceFill) {
    confidenceFill.style.width = `${Math.round(spell.confidence * 100)}%`;
  }
}

/**
 * Add a message to the Merlin conversation
 */
function addMerlinMessage(role: 'user' | 'assistant', content: string): void {
  const conversation = document.getElementById('merlin-conversation');
  if (!conversation) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `merlin-message ${role}`;

  // Build with textContent so Gemini/user-supplied content can't inject HTML.
  const roleDiv = document.createElement('div');
  roleDiv.className = 'merlin-message-role';
  roleDiv.textContent = role === 'user' ? 'You' : 'Merlin';
  msgDiv.appendChild(roleDiv);

  const contentDiv = document.createElement('div');
  contentDiv.textContent = content;
  msgDiv.appendChild(contentDiv);

  conversation.appendChild(msgDiv);
  conversation.scrollTop = conversation.scrollHeight;
}

// ============ GEMINI CONVERSATION SIDEBAR ============

const SOURCE_LABELS: Record<GeminiTurnSource, string> = {
  live: 'Live',
  test_shader: 'Shaders',
  test_sprite: 'Sprites',
  test_live_spell: 'Live Spell',
};

function ensureTurnCard(turn: Partial<GeminiTurn> & { id: string; source: GeminiTurnSource }): HTMLElement | null {
  const conversation = document.getElementById('merlin-conversation');
  if (!conversation) return null;

  let card = conversation.querySelector<HTMLElement>(`.gemini-turn[data-turn-id="${turn.id}"]`);
  if (card) return card;

  card = document.createElement('div');
  card.className = 'gemini-turn';
  card.dataset.turnId = turn.id;
  card.dataset.source = turn.source;

  const header = document.createElement('div');
  header.className = 'gemini-turn-header';
  const sourceSpan = document.createElement('span');
  sourceSpan.className = 'gemini-turn-source';
  // textContent escapes the fallback if a future code path emits an unknown source.
  sourceSpan.textContent = SOURCE_LABELS[turn.source] ?? turn.source;
  header.appendChild(sourceSpan);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'gemini-turn-body';
  card.appendChild(body);

  conversation.appendChild(card);
  return card;
}

function appendGeminiTurn(turn: Partial<GeminiTurn> & { id: string; source: GeminiTurnSource }): void {
  const card = ensureTurnCard(turn);
  if (!card) return;
  const body = card.querySelector<HTMLElement>('.gemini-turn-body')!;

  // System prompt — collapsed details block, only added on first sight.
  if (turn.systemPrompt && !card.querySelector('.gemini-system-prompt')) {
    const det = document.createElement('details');
    det.className = 'gemini-system-prompt';
    const summary = document.createElement('summary');
    summary.textContent = `system prompt (${turn.systemPrompt.length.toLocaleString()} chars)`;
    const pre = document.createElement('pre');
    pre.textContent = turn.systemPrompt;
    det.appendChild(summary);
    det.appendChild(pre);
    body.appendChild(det);
  }

  // User prompt block intentionally not rendered here — the chat-history
  // bubble above the LIVE card already shows the participant's words.
  // GeminiTurn.userPrompt is still emitted in case other surfaces need it.

  // FACE ACTIVITY (live) — surfaces the per-turn snippet that main
  // injected into Gemini's context (e.g. "Currently smiling. Brows
  // raised 3s ago."). Only added on first sight so retry-followup
  // events don't duplicate it.
  if (turn.faceActivity && !card.querySelector('.gemini-face-activity')) {
    const faceDiv = document.createElement('div');
    faceDiv.className = 'gemini-face-activity';
    faceDiv.textContent = `face: ${turn.faceActivity}`;
    body.appendChild(faceDiv);
  }

  // Response text and tool calls — each emission produces a new section
  // so retry-followup responses appear below their pushResults. The
  // `kind` field labels each emission so the user can see at a glance:
  //   - 'initial'              → first response (text streamed to TTS)
  //   - 'post-tool-spoken'     → post-tool text that WAS spoken (filler-cover case)
  //   - 'post-tool-dropped'    → post-tool text dropped from speech (one-response-per-turn rule)
  if (turn.responseText || (turn.toolCalls && turn.toolCalls.length > 0)) {
    const kind = turn.kind ?? 'initial';
    const respDiv = document.createElement('div');
    respDiv.className = `gemini-response gemini-response-${kind}`;

    // Role label with kind annotation so it's obvious what the emission
    // is doing in the turn flow.
    let kindLabel = '';
    if (kind === 'initial') kindLabel = ' · initial → TTS';
    else if (kind === 'post-tool-spoken') kindLabel = ' · post-tool → TTS';
    else if (kind === 'post-tool-dropped') kindLabel = ' · post-tool · not spoken';
    respDiv.innerHTML = `<div class="gemini-role">Gemini${kindLabel}</div>`;

    if (turn.responseText) {
      const textDiv = document.createElement('div');
      textDiv.className = 'gemini-text';
      textDiv.textContent = turn.responseText;
      respDiv.appendChild(textDiv);
    }

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      const callsDiv = document.createElement('div');
      callsDiv.className = 'gemini-tool-calls';
      for (const tc of turn.toolCalls) {
        callsDiv.appendChild(renderToolCall(tc));
      }
      respDiv.appendChild(callsDiv);
    }
    body.appendChild(respDiv);
  }

  // Push results — append each as a row.
  if (turn.pushResults && turn.pushResults.length > 0) {
    const resultsDiv = document.createElement('div');
    resultsDiv.className = 'gemini-push-results';
    for (const pr of turn.pushResults) {
      resultsDiv.appendChild(renderPushResult(pr));
    }
    body.appendChild(resultsDiv);
  }

  // Multi-frame temporal capture — what Gemini saw across the energy
  // envelope (idle / peak / afterglow). Stacked vertically with labels.
  if (turn.screenshots && turn.screenshots.length > 0) {
    const stripDiv = document.createElement('div');
    stripDiv.className = 'gemini-screenshot gemini-screenshot-strip';
    const role = document.createElement('div');
    role.className = 'gemini-role';
    role.textContent = `Visual feedback (${turn.screenshots.length} frames)`;
    stripDiv.appendChild(role);
    if (turn.screenshots[0]?.caption) {
      const cap = document.createElement('div');
      cap.className = 'gemini-screenshot-caption';
      cap.textContent = turn.screenshots[0].caption;
      stripDiv.appendChild(cap);
    }
    for (const shot of turn.screenshots) {
      const frameDiv = document.createElement('div');
      frameDiv.className = 'gemini-screenshot-frame';
      if (shot.label) {
        const lbl = document.createElement('div');
        lbl.className = 'gemini-screenshot-label';
        lbl.textContent = shot.label;
        frameDiv.appendChild(lbl);
      }
      const img = document.createElement('img');
      img.className = 'gemini-screenshot-img';
      img.src = `data:image/png;base64,${shot.base64}`;
      img.width = shot.width;
      img.height = shot.height;
      frameDiv.appendChild(img);
      stripDiv.appendChild(frameDiv);
    }
    body.appendChild(stripDiv);
  }

  // Single screenshot — legacy / non-temporal paths.
  if (turn.screenshot) {
    const shotDiv = document.createElement('div');
    shotDiv.className = 'gemini-screenshot';
    const role = document.createElement('div');
    role.className = 'gemini-role';
    role.textContent = 'Screenshot';
    shotDiv.appendChild(role);
    if (turn.screenshot.caption) {
      const cap = document.createElement('div');
      cap.className = 'gemini-screenshot-caption';
      cap.textContent = turn.screenshot.caption;
      shotDiv.appendChild(cap);
    }
    const img = document.createElement('img');
    img.className = 'gemini-screenshot-img';
    img.src = `data:image/png;base64,${turn.screenshot.base64}`;
    img.width = turn.screenshot.width;
    img.height = turn.screenshot.height;
    shotDiv.appendChild(img);
    body.appendChild(shotDiv);
  }

  // Retry marker — visual divider before the next response.
  if (turn.retry) {
    body.appendChild(renderRetryMarker(turn.retry));
  }

  // Final marker — purely cosmetic; could be used to "lock" the card.
  if (turn.final) {
    card.classList.add('final');
  }

  const conversation = document.getElementById('merlin-conversation');
  if (conversation) conversation.scrollTop = conversation.scrollHeight;
}

function renderToolCall(tc: GeminiToolCall): HTMLElement {
  const row = document.createElement('div');
  row.className = 'gemini-tool-call';
  const argsSummary = summarizeToolArgs(tc.args);
  row.innerHTML = `<span class="gemini-tool-glyph">⊳</span> <span class="gemini-tool-name">${escapeHtml(tc.name)}</span>`;
  if (argsSummary) {
    const argsSpan = document.createElement('span');
    argsSpan.className = 'gemini-tool-call-args';
    argsSpan.textContent = ` ${argsSummary}`;
    row.appendChild(argsSpan);
  }
  return row;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  // Compact one-line summary for the row header. Long fields (glsl_code,
  // descriptions, full programs) are elided here and shown on click via
  // a "details" expansion if we add it later.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const short = v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
      parts.push(`${k}=${short}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else if (v && typeof v === 'object') {
      parts.push(`${k}={…}`);
    }
    if (parts.join(', ').length > 100) break;
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

function renderPushResult(pr: GeminiPushResult): HTMLElement {
  const row = document.createElement('div');
  row.className = `gemini-push-result ${pr.success ? 'success' : 'error'}`;
  const label = pr.zone ?? pr.label ?? 'unknown';
  const glyph = pr.success ? '✓' : '✗';
  row.textContent = `TD: ${glyph} ${label}${pr.error ? ` — ${pr.error}` : ''}`;
  return row;
}

function renderRetryMarker(r: GeminiRetryMarker): HTMLElement {
  const div = document.createElement('div');
  div.className = 'gemini-retry-marker';
  const zone = r.zone ? ` — ${r.zone}` : '';
  div.textContent = `↻ retry ${r.attempt}/${r.total}${zone}`;
  return div;
}

/**
 * Clear Merlin conversation
 */
function clearMerlinUI(): void {
  const conversation = document.getElementById('merlin-conversation');
  if (conversation) conversation.innerHTML = '';

  // Reset spell state display
  const emptySpell: SpellState = {
    intent: null,
    element: null,
    tone: null,
    energy: 0.3,
    complexity: 0.2,
    castingOrigin: null,
    visualArchetype: null,
    palette: null,
    magicWord: null,
    confidence: 0,
  };
  updateMerlinSpellUI(emptySpell);
}

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
  armedEndWord = null;
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
  // `armedMagicWord` (and `armedEndWord` for play phase). If the
  // participant speaks either, we fire a direct IPC to trigger the
  // cast (or end the play phase) without going through
  // merlinProcessSpeech at all. The Gemini side keeps running for
  // pre-cast conversation; once armed, the cast trigger is decoupled
  // from it entirely.
  const tsBg = () => new Date().toISOString().slice(11, 23);
  if (!isSpeaking()) {
    if (armedMagicWord && transcriptContains(transcript, armedMagicWord)) {
      console.log(`[Merlin ${tsBg()}] Background trigger: magic word "${armedMagicWord}" matched — firing cast`);
      // Don't clear armedMagicWord — triggerCast is idempotent (it only
      // advances phase once via markCastCompleted) and the participant
      // is allowed to re-cast visually during play. Same for endWord.
      void window.electronAPI.merlinTriggerCast();
      return;
    }
    if (armedEndWord && transcriptContains(transcript, armedEndWord)) {
      console.log(`[Merlin ${tsBg()}] Background trigger: end word "${armedEndWord}" matched — closing play`);
      void window.electronAPI.merlinTriggerEnd();
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

    // After the cast has fired, processUserSpeech short-circuits and
    // returns empty text — Merlin's interaction is over but the
    // participant can still re-cast visually. Skip the chat-history /
    // UI update / TTS for empty responses so we don't render blank
    // bubbles or play silence.
    if (!response.text) {
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Empty response (post-cast) — skipping UI + TTS`);
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
 * Update Merlin UI to show speaking state
 */
function updateMerlinSpeakingIndicator(speaking: boolean): void {
  const voiceStatus = document.getElementById('merlin-voice-status');
  if (voiceStatus && merlinModeActive) {
    if (speaking) {
      voiceStatus.textContent = 'Speaking...';
      voiceStatus.className = 'merlin-voice-status speaking';
    } else if (merlinIsListening) {
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

  if (isMaskMode) {
    // Mask mode: only initialize segmentation
    console.log('Initializing segmentation for mask output...');
    await initImageSegmenter();
    mediapipeReady = true;
    console.log('Segmentation ready');
  } else if (!isSpoutMode) {
    // Preview mode: initialize everything
    await loadSettings();
    setupSidebar();
    setupKeyboardHandlers();
    await initMediaPipe();

    // Initialize voice commands and TTS (async, don't block)
    initVoice();
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
    if (testModeMuteTts) {
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
    armedEndWord = payload.endWord || null;
    console.log(
      `[Merlin ${new Date().toISOString().slice(11, 23)}] ` +
      `Cast armed: magicWord="${armedMagicWord}" endWord="${armedEndWord}"`,
    );
  });

  // Listen for zone compile results to update status indicators
  window.electronAPI.onZoneCompileResult((result) => {
    console.log(`[Zone ${new Date().toISOString().slice(11, 23)}] Compile result: ${result.zone} = ${result.success ? 'OK' : result.error}`);

    // Update the status indicator in the test shader panel if visible
    const zoneResult = document.querySelector(`.shader-zone-result[data-zone="${result.zone}"]`);
    if (zoneResult) {
      const statusIndicator = zoneResult.querySelector('.zone-status');
      if (statusIndicator) {
        statusIndicator.className = `zone-status ${result.success ? 'active' : 'error'}`;
      }

      // Add or remove error message
      const existingError = zoneResult.querySelector('.zone-error');
      if (result.success) {
        existingError?.remove();
      } else if (result.error && !existingError) {
        const header = zoneResult.querySelector('.zone-header');
        if (header) {
          const errorDiv = document.createElement('div');
          errorDiv.className = 'zone-error';
          errorDiv.textContent = result.error;
          header.insertAdjacentElement('afterend', errorDiv);
        }
      }
    }
  });
}

// Start the app
main().catch(console.error);
