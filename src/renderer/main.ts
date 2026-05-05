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
  RenderMode,
  SpriteFlipbookConfig,
  RenderModeTestResult,
  MirroredTDState,
  ShaderTestPreset,
  SpellProgramTestInput,
  SpellProgramTestResult,
  SpellProgramMode,
} from '../shared/types';
import { SHADER_TEST_PRESETS } from '../shared/test-shader-presets';

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
let drawSegmentEnabled = true;

// Latest analysis results (used by mentalist mode)
let lastFaceAnalysis: MicroExpressionAnalysis | null = null;
let lastBodyAnalysis: BodyLanguageAnalysis | null = null;
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
    // Capture skeleton strip (8 frames over 5 seconds)
    const result = await captureSkeletonStrip({
      frameCount: 8,
      intervalMs: 625,  // 5000ms / 8 frames
      frameWidth: 128,
      frameHeight: 192,
    });

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
 * Used for real-time mentalist mode analysis
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
 * Used for real-time mentalist mode analysis
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
      frameWidth: 128,
      frameHeight: 192,
    });

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
    drawSegmentEnabled = settings.drawSegment as boolean ?? true;
    isPortraitMode = settings.isPortraitMode as boolean ?? false;

    // Apply to UI elements
    const detectPoseCheckbox = document.getElementById('detect-pose') as HTMLInputElement;
    const detectFaceCheckbox = document.getElementById('detect-face') as HTMLInputElement;
    const detectSegmentCheckbox = document.getElementById('detect-segment') as HTMLInputElement;
    const drawPoseCheckbox = document.getElementById('draw-pose') as HTMLInputElement;
    const drawFaceCheckbox = document.getElementById('draw-face') as HTMLInputElement;
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
    if (!detectFaceEnabled) drawFaceEnabled = false;
    saveSetting('detectFace', detectFaceEnabled);
    if (!detectFaceEnabled) saveSetting('drawFace', false);
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

  // WebSocket format link handler
  const wsFormatLink = document.getElementById('ws-format-link');
  wsFormatLink?.addEventListener('click', (e) => {
    e.preventDefault();
    showWsFormatModal();
  });

  // Start WebSocket stats polling
  startWsStatsPoll();

  // Device choosers (camera + mic)
  setupDeviceChoosers();

  console.log('Sidebar controls initialized');
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
 * Show WebSocket message format modal
 */
function showWsFormatModal(): void {
  // Check if modal already exists
  let modal = document.getElementById('ws-format-modal');
  if (modal) {
    modal.style.display = 'flex';
    return;
  }

  // Create modal
  modal = document.createElement('div');
  modal.id = 'ws-format-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  modal.innerHTML = `
    <div style="background: #1a1a1a; padding: 24px; border-radius: 8px; max-width: 700px; max-height: 80vh; overflow-y: auto; border: 1px solid #333;">
      <h2 style="margin: 0 0 16px; color: #fff; font-size: 18px;">WebSocket Message Format</h2>
      <p style="color: #888; font-size: 13px; margin-bottom: 16px;">
        Merlin runs a WebSocket server on localhost. Clients connect to receive tracking data and scene control messages as JSON.
      </p>
      <h3 style="color: #0f0; font-size: 14px; margin: 16px 0 8px;">High-Frequency (30fps):</h3>
      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">tracking_frame</td>
          <td style="padding: 6px 8px; color: #888;">fps, frame {width, height, portrait}, pose {detected, landmarks[]}, face {detected, bbox}</td>
        </tr>
      </table>
      <h3 style="color: #0f0; font-size: 14px; margin: 16px 0 8px;">Event-Driven:</h3>
      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">orientation_update</td>
          <td style="padding: 6px 8px; color: #888;">portrait, width, height</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">mood_update</td>
          <td style="padding: 6px 8px; color: #888;">mood, color, intensity</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">scene_params</td>
          <td style="padding: 6px 8px; color: #888;">params {particle_*, aura_*, ...}</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">mentalist_state</td>
          <td style="padding: 6px 8px; color: #888;">active, phase, mood, colorAccent</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">reveal_effect</td>
          <td style="padding: 6px 8px; color: #888;">effect_type, intensity, duration</td>
        </tr>
        <tr>
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">zone_update</td>
          <td style="padding: 6px 8px; color: #888;">zone, glsl_code</td>
        </tr>
      </table>
      <p style="color: #666; font-size: 11px; margin-top: 16px;">
        Coordinates are normalized 0-1. Pose landmarks follow the MediaPipe BlazePose topology (33 landmarks).
      </p>
      <button id="ws-modal-close" style="margin-top: 16px; background: #333; border: none; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Close</button>
    </div>
  `;

  document.body.appendChild(modal);

  // Close on click outside or close button
  modal.addEventListener('click', (e) => {
    if (e.target === modal || (e.target as HTMLElement).id === 'ws-modal-close') {
      modal!.style.display = 'none';
    }
  });
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
  const autoFaceCheckbox = document.getElementById('auto-face') as HTMLInputElement;
  const autoBodyCheckbox = document.getElementById('auto-body') as HTMLInputElement;
  const faceIntervalInput = document.getElementById('face-interval') as HTMLInputElement;
  const bodyIntervalInput = document.getElementById('body-interval') as HTMLInputElement;

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

    // Legacy auto-analysis commands (UI removed, kept for voice command compatibility)
    case 'start_auto_face':
    case 'stop_auto_face':
    case 'start_auto_body':
    case 'stop_auto_body':
    case 'set_face_interval':
    case 'set_body_interval':
      console.log('Auto-analysis commands not available (UI removed)');
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
}

/**
 * Create the test panel DOM with tabs (Shaders / Sprites)
 */
function createTestShaderPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'test-shader-panel';
  panel.className = 'test-shader-panel';

  // Intent options
  const intents = ['confidence', 'calm', 'protection', 'clarity', 'creativity', 'transformation', 'release', 'focus', 'joy', 'wonder'];
  const intentOptions = intents.map(i => `<option value="${i}">${i}</option>`).join('');

  // Element options
  const elements = ['fire', 'water', 'air', 'earth', 'light', 'shadow', 'crystal', 'storm', 'flora', 'cosmic'];
  const elementOptions = elements.map(e => `<option value="${e}">${e}</option>`).join('');

  // Shader preset dropdown options
  const presetOptions = [
    `<option value="">Custom (no preset)</option>`,
    ...SHADER_TEST_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`),
  ].join('');

  // Marker-bearing zones for the Shaders tab. After Phase 4 added the
  // billboard_vertex marker, all 9 zones are eligible.
  const shaderZones = [
    'force_field',
    'color_over_life',
    'size_over_life',
    'spawn_behavior',
    'velocity_modifier',
    'post_fx',
    'material_pixel',
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
  const frameCountOptions = [4, 8, 9, 12, 16, 25]
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
        <button class="test-shader-tab" data-tab="render-mode">Render Mode</button>
        <button class="test-shader-tab" data-tab="spell-program">Spell Program</button>
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
          <label>Intent:</label>
          <select id="test-intent">${intentOptions}</select>
        </div>
        <div class="config-row">
          <label>Element:</label>
          <select id="test-element">${elementOptions}</select>
        </div>
        <div class="config-row">
          <label>Energy:</label>
          <input type="range" id="test-energy" min="0" max="1" step="0.1" value="0.7">
          <span id="test-energy-value">0.7</span>
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

    <div class="test-shader-tab-content" data-tab="render-mode" style="display: none;">
      <div class="render-mode-toggle">
        <button class="render-mode-btn" data-mode="mesh">Mesh</button>
        <button class="render-mode-btn" data-mode="billboard">Billboard</button>
      </div>

      <div class="test-shader-config flipbook-reconfig-form">
        <div class="config-row">
          <label>Atlas:</label>
          <input type="text" id="rm-atlas-cols" readonly value="1"> ×
          <input type="text" id="rm-atlas-rows" readonly value="1">
        </div>
        <div class="config-row">
          <label>Frames:</label>
          <input type="text" id="rm-frame-count" readonly value="1">
        </div>
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

    <div class="test-shader-tab-content" data-tab="spell-program" style="display: none;">
      <div class="spell-program-mode-toggle">
        <label><input type="radio" name="spell-program-mode" value="buildup" checked> Buildup</label>
        <label><input type="radio" name="spell-program-mode" value="release"> Release</label>
      </div>

      <div class="test-shader-config spell-program-form">
        <div class="config-row">
          <label>Prompt:</label>
          <textarea id="sp-prompt" rows="3" placeholder="a slow-pulsing protective shield that explodes outward at release"></textarea>
        </div>
        <div class="config-row">
          <label>Intent:</label>
          <select id="sp-intent"><option value="">(let Gemini decide)</option>${intentOptions}</select>
        </div>
        <div class="config-row">
          <label>Element:</label>
          <select id="sp-element"><option value="">(let Gemini decide)</option>${elementOptions}</select>
        </div>
        <div class="config-row">
          <label>Origin:</label>
          <select id="sp-origin"><option value="">(default)</option>${castingOriginOptions}</select>
        </div>
        <button id="sp-generate-btn" class="generate-btn">Interpret &amp; Push</button>
      </div>

      <div id="sp-status" class="test-shader-status"></div>
      <div id="sp-results" class="test-shader-results"></div>
    </div>
  `;

  // === Shader tab event listeners ===
  const energySlider = panel.querySelector('#test-energy') as HTMLInputElement;
  const energyValue = panel.querySelector('#test-energy-value') as HTMLSpanElement;
  energySlider.addEventListener('input', () => {
    energyValue.textContent = energySlider.value;
  });

  const presetSelect = panel.querySelector('#test-preset') as HTMLSelectElement;
  presetSelect.addEventListener('change', () => {
    const preset = SHADER_TEST_PRESETS.find(p => p.id === presetSelect.value);
    if (!preset) return;
    (panel.querySelector('#test-intent') as HTMLSelectElement).value = preset.intent;
    (panel.querySelector('#test-element') as HTMLSelectElement).value = preset.element;
    energySlider.value = String(preset.energy);
    energyValue.textContent = String(preset.energy);
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

  // === Render Mode tab event listeners ===
  panel.querySelectorAll('.render-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLButtonElement).dataset.mode as RenderMode;
      runRenderModeToggle(mode);
    });
  });

  const applyFlipbookBtn = panel.querySelector('#rm-apply-flipbook-btn') as HTMLButtonElement;
  applyFlipbookBtn.addEventListener('click', runApplyFlipbookConfig);

  // === Spell Program tab event listeners ===
  const spGenerateBtn = panel.querySelector('#sp-generate-btn') as HTMLButtonElement;
  spGenerateBtn.addEventListener('click', runSpellProgramGenerate);

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
      if (tabName === 'render-mode') {
        refreshRenderModeTabFromMirror();
      }
    });
  });

  // Close handler
  const closeBtn = panel.querySelector('.close-btn') as HTMLButtonElement;
  closeBtn.addEventListener('click', () => {
    panel.classList.remove('visible');
    testShaderPanelVisible = false;
  });

  return panel;
}

/**
 * Run the test shader generation
 */
async function runTestShaderGeneration(): Promise<void> {
  const intentSelect = document.getElementById('test-intent') as HTMLSelectElement;
  const elementSelect = document.getElementById('test-element') as HTMLSelectElement;
  const energySlider = document.getElementById('test-energy') as HTMLInputElement;
  const statusDiv = document.getElementById('test-shader-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('test-shader-results') as HTMLDivElement;
  const generateBtn = document.getElementById('generate-shaders-btn') as HTMLButtonElement;

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

  const config = {
    intent: intentSelect.value,
    element: elementSelect.value,
    energy: parseFloat(energySlider.value),
    zones,
  };

  // Update UI to loading state
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  statusDiv.textContent = `Generating ${zones.length} zone(s): ${config.element}/${config.intent} at ${config.energy} energy...`;
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

// ============ RENDER MODE TAB ============

/**
 * Pull the latest mirrored TD state from the main process and paint it
 * into the readout + the read-only atlas/frame-count fields. Called on
 * tab open and after every push.
 */
async function refreshRenderModeTabFromMirror(): Promise<void> {
  try {
    const state = await window.electronAPI.merlinTestGetMirroredState();
    paintMirroredState(state);
  } catch (error) {
    console.error('[RenderMode] Failed to fetch mirrored state:', error);
  }
}

function paintMirroredState(state: MirroredTDState): void {
  // Highlight the active render-mode button
  document.querySelectorAll('.render-mode-btn').forEach(btn => {
    const isActive = (btn as HTMLButtonElement).dataset.mode === state.renderMode;
    btn.classList.toggle('active', isActive);
  });

  // Read-only atlas display
  const setVal = (id: string, value: string | number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(value);
  };
  setVal('rm-atlas-cols', state.flipbook.atlasCols);
  setVal('rm-atlas-rows', state.flipbook.atlasRows);
  setVal('rm-frame-count', state.flipbook.frameCount);

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
    ['render_mode', state.renderMode],
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

function setRenderModeStatus(text: string, kind: 'loading' | 'success' | 'error'): void {
  const statusDiv = document.getElementById('rm-status') as HTMLDivElement | null;
  if (!statusDiv) return;
  statusDiv.textContent = text;
  statusDiv.className = `test-shader-status ${kind}`;
}

async function runRenderModeToggle(mode: RenderMode): Promise<void> {
  setRenderModeStatus(`Pushing render_mode=${mode}...`, 'loading');
  try {
    const result = await window.electronAPI.merlinTestRenderMode(mode);
    paintMirroredState(result.state);
    if (result.pushed) {
      setRenderModeStatus(`render_mode set to ${mode}`, 'success');
    } else {
      setRenderModeStatus('TD not connected — render_mode not pushed', 'error');
    }
  } catch (error) {
    setRenderModeStatus(`Error: ${error}`, 'error');
  }
}

async function runApplyFlipbookConfig(): Promise<void> {
  const atlasCols = parseInt((document.getElementById('rm-atlas-cols') as HTMLInputElement).value, 10);
  const atlasRows = parseInt((document.getElementById('rm-atlas-rows') as HTMLInputElement).value, 10);
  const frameCount = parseInt((document.getElementById('rm-frame-count') as HTMLInputElement).value, 10);
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
  setRenderModeStatus('Pushing flipbook_config...', 'loading');

  try {
    const result: RenderModeTestResult = await window.electronAPI.merlinTestFlipbookConfig(config);
    paintMirroredState(result.state);
    if (result.pushed) {
      setRenderModeStatus('flipbook_config applied', 'success');
    } else {
      setRenderModeStatus('TD not connected — flipbook_config not pushed', 'error');
    }
  } catch (error) {
    setRenderModeStatus(`Error: ${error}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ SPELL PROGRAM TAB ============

async function runSpellProgramGenerate(): Promise<void> {
  const btn = document.getElementById('sp-generate-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('sp-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('sp-results') as HTMLDivElement;
  const promptEl = document.getElementById('sp-prompt') as HTMLTextAreaElement;
  const intentEl = document.getElementById('sp-intent') as HTMLSelectElement;
  const elementEl = document.getElementById('sp-element') as HTMLSelectElement;
  const originEl = document.getElementById('sp-origin') as HTMLSelectElement;

  const modeRadio = document.querySelector<HTMLInputElement>(
    'input[name="spell-program-mode"]:checked'
  );
  const mode = (modeRadio?.value ?? 'buildup') as SpellProgramMode;

  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Prompt is required';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  const input: SpellProgramTestInput = {
    mode,
    prompt,
    intent: intentEl.value ? (intentEl.value as SpellProgramTestInput['intent']) : null,
    element: elementEl.value ? (elementEl.value as SpellProgramTestInput['element']) : null,
    castingOrigin: originEl.value ? (originEl.value as SpellProgramTestInput['castingOrigin']) : null,
  };

  btn.disabled = true;
  btn.textContent = 'Interpreting...';
  statusDiv.textContent = `Asking Gemini to interpret a ${mode} program...`;
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result: SpellProgramTestResult = await window.electronAPI.merlinTestSpellProgram(input);
    renderSpellProgramResult(result, statusDiv, resultsDiv);
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Interpret & Push';
}

function renderSpellProgramResult(
  result: SpellProgramTestResult,
  statusDiv: HTMLDivElement,
  resultsDiv: HTMLDivElement
): void {
  if (!result.success) {
    statusDiv.textContent = result.error || 'Generation failed';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  if (result.pushed) {
    statusDiv.textContent = 'Spell program pushed to TD';
    statusDiv.className = 'test-shader-status success';
  } else {
    statusDiv.textContent = 'Generated, but TD not connected — program not pushed';
    statusDiv.className = 'test-shader-status error';
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

  if (result.program) {
    parts.push(`
      <div class="gemini-args">
        <div class="gemini-args-title">Final program (pushed):</div>
        <pre>${escapeHtml(JSON.stringify(result.program, null, 2))}</pre>
      </div>
    `);
  }

  resultsDiv.innerHTML = parts.join('');
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
    if (results.segmentation) loaded.push('Segmentation');

    if (loaded.length === 3) {
      if (statusDisplay) statusDisplay.textContent = `MediaPipe: All models loaded`;
    } else if (loaded.length > 0) {
      if (statusDisplay) statusDisplay.textContent = `MediaPipe: ${loaded.join(', ')} loaded`;
    } else {
      if (statusDisplay) statusDisplay.textContent = 'MediaPipe: Failed to load models';
    }

    mediapipeReady = loaded.length > 0;
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
  if (phaseSpan) phaseSpan.textContent = capitalize(update.phase);
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

  const roleLabel = role === 'user' ? 'You' : 'Merlin';
  msgDiv.innerHTML = `
    <div class="merlin-message-role">${roleLabel}</div>
    <div>${content}</div>
  `;

  conversation.appendChild(msgDiv);
  conversation.scrollTop = conversation.scrollHeight;
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
    if (phaseSpan) phaseSpan.textContent = capitalize(response.phase);

    // Speak the intro aloud (streaming for lower latency)
    if (ttsReady && response.text) {
      await speakWithStreaming(response.text, 'wizard');
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

  // End session
  if (window.electronAPI) {
    try {
      const response = await window.electronAPI.merlinEnd();
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Session ended:`, response.text);

      // Add finale message
      addMerlinMessage('assistant', response.text);

      // Speak the finale aloud with wizard voice
      if (ttsReady && response.text) {
        await speakWithStreaming(response.text, 'wizard');
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

    // Add response to conversation
    addMerlinMessage('assistant', response.text);

    // Update spell state
    updateMerlinSpellUI(response.spell);

    // Update phase in UI
    const phaseSpan = document.getElementById('merlin-phase');
    const header = document.getElementById('merlin-header');
    if (phaseSpan) phaseSpan.textContent = capitalize(response.phase);
    if (header && response.spell.element) {
      header.className = `merlin-header element-${response.spell.element}`;
    }

    // Speak the response aloud (pause listening during TTS)
    if (ttsReady && response.text) {
      stopContinuousListening();
      console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Paused listening for TTS`);

      await speakWithStreaming(response.text, 'wizard');

      // Resume listening after TTS finishes
      if (merlinModeActive) {
        console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Resuming listening after TTS`);
        await startContinuousListening(handleMerlinTranscript);
      }
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

    let result: unknown = null;
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

  // Listen for auto-end signal when Merlin session completes
  window.electronAPI.onMerlinAutoEnd(() => {
    console.log(`[Merlin ${new Date().toISOString().slice(11, 23)}] Session complete - auto-ending...`);
    stopMerlinMode();
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
