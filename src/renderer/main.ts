/**
 * Parlor - Renderer Process
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
  MentalistUIUpdate,
  MentalistConversationMessage,
  MentalistInsight,
  MentalistPhase,
  MentalistMood,
} from '../shared/types';

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
let spoutVideoName = 'Parlor';
let spoutMaskName = 'Parlor Mask';

// Camera orientation (landscape or portrait)
let isPortraitMode = false;

// MediaPipe ready state
let mediapipeReady = false;

// Voice command state
let voiceReady = false;

// TTS state
let ttsReady = false;

// Mentalist mode state
let mentalistModeActive = false;
let mentalistIsListening = false;
let mentalistIsProcessing = false;

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

// Hide UI in Spout/Mask modes
if (isSpoutMode || isMaskMode) {
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

  // OSC format link handler
  const oscFormatLink = document.getElementById('osc-format-link');
  oscFormatLink?.addEventListener('click', (e) => {
    e.preventDefault();
    showOscFormatModal();
  });

  // Start OSC stats polling
  startOscStatsPoll();

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
 * Poll and display OSC stats
 */
function startOscStatsPoll(): void {
  const oscPort = document.getElementById('osc-port');
  const oscRate = document.getElementById('osc-rate');

  async function updateOscStats() {
    if (!window.electronAPI) return;

    try {
      const stats = await window.electronAPI.getOscStats();
      if (oscPort) oscPort.textContent = stats.port.toString();
      if (oscRate) oscRate.textContent = `${stats.messagesPerSecond} msg/s`;
    } catch {
      // Ignore errors silently
    }
  }

  // Update every second
  setInterval(updateOscStats, 1000);
  updateOscStats(); // Initial update
}

/**
 * Show OSC format modal
 */
function showOscFormatModal(): void {
  // Check if modal already exists
  let modal = document.getElementById('osc-format-modal');
  if (modal) {
    modal.style.display = 'flex';
    return;
  }

  // Create modal
  modal = document.createElement('div');
  modal.id = 'osc-format-modal';
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
    <div style="background: #1a1a1a; padding: 24px; border-radius: 8px; max-width: 600px; max-height: 80vh; overflow-y: auto; border: 1px solid #333;">
      <h2 style="margin: 0 0 16px; color: #fff; font-size: 18px;">OSC Output Format</h2>
      <p style="color: #888; font-size: 13px; margin-bottom: 16px;">
        Parlor sends tracking data via OSC (Open Sound Control) to localhost on the configured port.
      </p>
      <h3 style="color: #0f0; font-size: 14px; margin: 16px 0 8px;">Addresses:</h3>
      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/fps</td>
          <td style="padding: 6px 8px; color: #888;">[float] Current FPS</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/pose/detected</td>
          <td style="padding: 6px 8px; color: #888;">[int] 1 if pose detected, 0 otherwise</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/pose/landmark/{i}</td>
          <td style="padding: 6px 8px; color: #888;">[x, y, z, visibility] Landmark 0-32</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/pose/landmarks</td>
          <td style="padding: 6px 8px; color: #888;">[blob] All 33 landmarks (Float32)</td>
        </tr>
        <tr style="border-bottom: 1px solid #333;">
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/face/detected</td>
          <td style="padding: 6px 8px; color: #888;">[int] 1 if face detected, 0 otherwise</td>
        </tr>
        <tr>
          <td style="padding: 6px 8px; color: #6af; font-family: monospace;">/parlor/face/bbox</td>
          <td style="padding: 6px 8px; color: #888;">[x, y, w, h] Bounding box (0-1)</td>
        </tr>
      </table>
      <p style="color: #666; font-size: 11px; margin-top: 16px;">
        Coordinates are normalized 0-1. Pose landmarks follow the MediaPipe BlazePose topology.
      </p>
      <button id="osc-modal-close" style="margin-top: 16px; background: #333; border: none; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Close</button>
    </div>
  `;

  document.body.appendChild(modal);

  // Close on click outside or close button
  modal.addEventListener('click', (e) => {
    if (e.target === modal || (e.target as HTMLElement).id === 'osc-modal-close') {
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

    case 'start_auto_face':
      if (action.intervalSeconds && faceIntervalInput) {
        faceIntervalInput.value = action.intervalSeconds.toString();
        faceAnalysisInterval = action.intervalSeconds * 1000;
      }
      autoAnalyzeFace = true;
      if (autoFaceCheckbox) autoFaceCheckbox.checked = true;
      startFaceAnalysisTimer();
      break;

    case 'stop_auto_face':
      autoAnalyzeFace = false;
      if (autoFaceCheckbox) autoFaceCheckbox.checked = false;
      stopFaceAnalysisTimer();
      break;

    case 'start_auto_body':
      if (action.intervalSeconds && bodyIntervalInput) {
        bodyIntervalInput.value = action.intervalSeconds.toString();
        bodyAnalysisInterval = action.intervalSeconds * 1000;
      }
      autoAnalyzeBody = true;
      if (autoBodyCheckbox) autoBodyCheckbox.checked = true;
      startBodyAnalysisTimer();
      break;

    case 'stop_auto_body':
      autoAnalyzeBody = false;
      if (autoBodyCheckbox) autoBodyCheckbox.checked = false;
      stopBodyAnalysisTimer();
      break;

    case 'set_face_interval':
      faceAnalysisInterval = action.seconds * 1000;
      if (faceIntervalInput) faceIntervalInput.value = action.seconds.toString();
      if (autoAnalyzeFace) startFaceAnalysisTimer();
      break;

    case 'set_body_interval':
      bodyAnalysisInterval = action.seconds * 1000;
      if (bodyIntervalInput) bodyIntervalInput.value = action.seconds.toString();
      if (autoAnalyzeBody) startBodyAnalysisTimer();
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

// ============ MENTALIST MODE ============

/**
 * Update the mentalist UI with current state
 */
function updateMentalistUI(update: MentalistUIUpdate): void {
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('mentalist-panel');
  const header = document.getElementById('mentalist-header');
  const phaseSpan = document.getElementById('mentalist-phase');
  const moodSpan = document.getElementById('mentalist-mood');
  const voiceStatus = document.getElementById('mentalist-voice-status');

  if (!sidebar || !panel) return;

  // Update phase and mood
  if (phaseSpan) phaseSpan.textContent = capitalize(update.phase);
  if (moodSpan) moodSpan.textContent = capitalize(update.mood);

  // Update mood class on header
  if (header) {
    header.className = `mentalist-header mood-${update.mood}`;
  }

  // Update voice status
  if (voiceStatus) {
    if (update.isProcessing) {
      voiceStatus.textContent = 'Processing...';
      voiceStatus.className = 'mentalist-voice-status processing';
    } else if (update.isListening) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'mentalist-voice-status listening';
    } else if (update.phase === 'idle') {
      voiceStatus.textContent = 'Press M to begin';
      voiceStatus.className = 'mentalist-voice-status';
    } else {
      voiceStatus.textContent = 'Ready';
      voiceStatus.className = 'mentalist-voice-status';
    }
  }

  // Add last message to conversation
  if (update.lastMessage) {
    addMentalistMessage(update.lastMessage);
  }

  // Update insights
  updateMentalistInsights(update.revealedInsights);
}

/**
 * Add a message to the mentalist conversation
 */
function addMentalistMessage(message: MentalistConversationMessage): void {
  const conversation = document.getElementById('mentalist-conversation');
  if (!conversation) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `mentalist-message ${message.role}`;

  const roleLabel = message.role === 'user' ? 'You' : 'Mentalist';
  msgDiv.innerHTML = `
    <div class="mentalist-message-role">${roleLabel}</div>
    <div>${message.content}</div>
  `;

  conversation.appendChild(msgDiv);
  conversation.scrollTop = conversation.scrollHeight;
}

/**
 * Add analysis bubbles to the mentalist conversation
 * Shows what the mentalist "sees" - facial expressions and body language
 */
function addAnalysisBubbles(
  face: MicroExpressionAnalysis | null,
  body: BodyLanguageAnalysis | null
): void {
  const conversation = document.getElementById('mentalist-conversation');
  if (!conversation) return;

  const bubbleContainer = document.createElement('div');
  bubbleContainer.className = 'mentalist-analysis-bubbles';

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
 * Update mentalist insights display
 */
function updateMentalistInsights(insights: MentalistInsight[]): void {
  const container = document.getElementById('mentalist-insights');
  if (!container) return;

  container.innerHTML = '';

  for (const insight of insights) {
    const insightDiv = document.createElement('div');
    insightDiv.className = 'mentalist-insight';
    insightDiv.innerHTML = `
      <div class="mentalist-insight-type">${insight.type}</div>
      <div class="mentalist-insight-content">${insight.content}</div>
    `;
    container.appendChild(insightDiv);
  }
}

/**
 * Clear mentalist conversation and insights
 */
function clearMentalistUI(): void {
  const conversation = document.getElementById('mentalist-conversation');
  const insights = document.getElementById('mentalist-insights');
  if (conversation) conversation.innerHTML = '';
  if (insights) insights.innerHTML = '';
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Start mentalist mode
 */
async function startMentalistMode(): Promise<void> {
  if (mentalistModeActive) return;
  if (!window.electronAPI) {
    console.error('Electron API not available');
    return;
  }

  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[Mentalist ${ts()}] Starting...`);
  mentalistModeActive = true;

  // Activate UI
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('mentalist-panel');
  sidebar?.classList.add('mentalist-active');
  panel?.classList.add('active');

  clearMentalistUI();

  // Update status
  const voiceStatus = document.getElementById('mentalist-voice-status');
  if (voiceStatus) {
    voiceStatus.textContent = 'Starting session...';
    voiceStatus.className = 'mentalist-voice-status processing';
  }

  try {
    // Start session with Gemini
    const response = await window.electronAPI.mentalistStart();
    console.log(`[Mentalist ${ts()}] Session started:`, response.text);

    // Add intro message
    addMentalistMessage({
      role: 'assistant',
      content: response.text,
      timestamp: Date.now(),
    });

    // Update UI state (don't pass lastMessage - we already added it above)
    updateMentalistUI({
      phase: response.phase,
      mood: response.mood,
      turnCount: 0,
      revealedInsights: [],
      isListening: false,
      isProcessing: false,
      lastMessage: undefined,  // Explicitly undefined to avoid duplicate
    });

    // Speak the intro aloud with appropriate mood (streaming for lower latency)
    if (ttsReady && response.text) {
      await speakWithStreaming(response.text, response.mood);
    }

    // Start continuous listening (after TTS finishes)
    mentalistIsListening = true;
    await startContinuousListening(handleMentalistTranscript);

    // Register speech start callback to begin analysis capture early
    setSpeechStartCallback(() => {
      if (!mentalistModeActive || pendingAnalysisCapture) return;

      console.log(`[Mentalist ${ts()}] Speech started - beginning analysis capture...`);
      pendingAnalysisCapture = Promise.all([
        captureQuickFaceAnalysis(),
        captureQuickBodyAnalysis(),
      ]).then(([face, body]) => ({ face, body }));
    });

    console.log(`[Mentalist ${ts()}] Continuous listening started`);

  } catch (error) {
    console.error('[Mentalist] Failed to start:', error);
    stopMentalistMode();
  }
}

/**
 * Stop mentalist mode
 */
async function stopMentalistMode(): Promise<void> {
  if (!mentalistModeActive) return;

  console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Stopping...`);

  // Stop continuous listening and clear callbacks
  stopContinuousListening();
  setSpeechStartCallback(null);
  pendingAnalysisCapture = null;
  mentalistIsListening = false;

  // End session
  if (window.electronAPI) {
    try {
      const response = await window.electronAPI.mentalistEnd();
      console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Session ended:`, response.text);

      // Add finale message
      addMentalistMessage({
        role: 'assistant',
        content: response.text,
        timestamp: Date.now(),
      });

      // Speak the finale aloud with warm mood (streaming for lower latency)
      if (ttsReady && response.text) {
        await speakWithStreaming(response.text, 'warm');
      }
    } catch (error) {
      console.error('[Mentalist] Error ending session:', error);
    }
  }

  // Deactivate UI after a short delay to show finale
  setTimeout(() => {
    mentalistModeActive = false;
    const sidebar = document.getElementById('sidebar');
    const panel = document.getElementById('mentalist-panel');
    sidebar?.classList.remove('mentalist-active');
    panel?.classList.remove('active');
  }, 3000);
}

/**
 * Toggle mentalist mode
 */
async function toggleMentalistMode(): Promise<void> {
  if (mentalistModeActive) {
    await stopMentalistMode();
  } else {
    await startMentalistMode();
  }
}

// Lock to prevent concurrent transcript processing
let isProcessingTranscript = false;

/**
 * Handle transcript from continuous listening in mentalist mode
 */
async function handleMentalistTranscript(transcript: string): Promise<void> {
  if (!mentalistModeActive || !window.electronAPI) return;

  // Prevent concurrent processing - drop if already processing
  if (isProcessingTranscript) {
    console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Dropping transcript (busy): "${transcript}"`);
    return;
  }

  isProcessingTranscript = true;
  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[Mentalist ${ts()}] User said: "${transcript}"`);

  // Add user message to UI
  addMentalistMessage({
    role: 'user',
    content: transcript,
    timestamp: Date.now(),
  });

  // Update UI to show processing
  mentalistIsProcessing = true;
  const voiceStatus = document.getElementById('mentalist-voice-status');
  if (voiceStatus) {
    voiceStatus.textContent = 'Processing...';
    voiceStatus.className = 'mentalist-voice-status processing';
  }

  // Use the pre-started analysis capture (from speech start) if available
  // Otherwise start a new capture as fallback
  let analysisPromise: Promise<{ face: MicroExpressionAnalysis | null; body: BodyLanguageAnalysis | null }>;

  if (pendingAnalysisCapture) {
    console.log(`[Mentalist ${ts()}] Using pre-started analysis capture (from speech start)`);
    analysisPromise = pendingAnalysisCapture;
    pendingAnalysisCapture = null; // Clear for next utterance
  } else {
    console.log(`[Mentalist ${ts()}] No pre-started capture, starting now...`);
    analysisPromise = Promise.all([
      captureQuickFaceAnalysis(),
      captureQuickBodyAnalysis(),
    ]).then(([face, body]) => ({ face, body }));
  }

  try {
    // Await analysis (should be ready or nearly ready since it started when user began speaking)
    const { face: freshFace, body: freshBody } = await analysisPromise;
    console.log(`[Mentalist ${ts()}] Analysis ready:`, {
      face: freshFace?.primaryEmotion,
      body: freshBody?.primaryPosture,
    });

    // Show analysis bubbles in conversation
    addAnalysisBubbles(freshFace, freshBody);

    // Update cached analysis in main process
    window.electronAPI.mentalistUpdateAnalysis({
      body: freshBody ?? undefined,
      face: freshFace ?? undefined,
    });

    // Now call Gemini with fresh analysis ready
    console.log(`[Mentalist ${ts()}] Calling Gemini...`);
    const response = await window.electronAPI.mentalistProcessSpeech(transcript);
    console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Response:`, response.text);

    // Add response to conversation
    addMentalistMessage({
      role: 'assistant',
      content: response.text,
      timestamp: Date.now(),
    });

    // Update phase/mood in UI
    const phaseSpan = document.getElementById('mentalist-phase');
    const moodSpan = document.getElementById('mentalist-mood');
    const header = document.getElementById('mentalist-header');

    if (phaseSpan) phaseSpan.textContent = capitalize(response.phase);
    if (moodSpan) moodSpan.textContent = capitalize(response.mood);
    if (header) header.className = `mentalist-header mood-${response.mood}`;

    // Update insights if any revealed
    if (response.revealedInsight) {
      const container = document.getElementById('mentalist-insights');
      if (container) {
        const insightDiv = document.createElement('div');
        insightDiv.className = 'mentalist-insight';
        insightDiv.innerHTML = `
          <div class="mentalist-insight-type">${response.revealedInsight.type}</div>
          <div class="mentalist-insight-content">${response.revealedInsight.content}</div>
        `;
        container.appendChild(insightDiv);
      }
    }

    // Speak the response aloud with appropriate mood (streaming for lower latency)
    // Pause listening during TTS to prevent feedback
    if (ttsReady && response.text) {
      stopContinuousListening();
      console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Paused listening for TTS`);

      await speakWithStreaming(response.text, response.mood);

      // Resume listening after TTS finishes
      if (mentalistModeActive) {
        console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Resuming listening after TTS`);
        await startContinuousListening(handleMentalistTranscript);
      }
    }

  } catch (error) {
    console.error('[Mentalist] Error processing speech:', error);
    if (statusDisplay) statusDisplay.textContent = `Mentalist error: ${error}`;
  } finally {
    isProcessingTranscript = false;  // Release lock
    mentalistIsProcessing = false;

    // Resume listening indicator (after TTS finishes)
    if (voiceStatus && mentalistModeActive) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'mentalist-voice-status listening';
    }
  }
}

/**
 * Setup keyboard handlers
 */
function setupKeyboardHandlers(): void {
  document.addEventListener('keydown', (event) => {
    // Ignore if typing in an input
    if (event.target instanceof HTMLInputElement) return;

    // V key triggers voice command (push-to-talk) - only when not in mentalist mode
    if (event.code === 'KeyV' && !event.repeat && !mentalistModeActive) {
      event.preventDefault();
      if (voiceReady && !isVoiceRecording()) {
        startRecording();
      }
    }

    // M key toggles mentalist mode
    if (event.code === 'KeyM' && !event.repeat) {
      event.preventDefault();
      if (voiceReady) {
        toggleMentalistMode();
      }
    }
  });

  // V key release stops recording (only when not in mentalist mode)
  document.addEventListener('keyup', (event) => {
    if (event.target instanceof HTMLInputElement) return;

    if (event.code === 'KeyV' && !mentalistModeActive) {
      if (isVoiceRecording()) {
        stopRecording();
      }
    }
  });

  console.log('Keyboard handlers ready (V = voice, M = mentalist)');
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
    updateMentalistSpeakingIndicator(speaking);
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

/**
 * Update UI to show speaking state
 */
function updateMentalistSpeakingIndicator(speaking: boolean): void {
  const voiceStatus = document.getElementById('mentalist-voice-status');
  if (voiceStatus && mentalistModeActive) {
    if (speaking) {
      voiceStatus.textContent = 'Speaking...';
      voiceStatus.className = 'mentalist-voice-status speaking';
    } else if (mentalistIsListening) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'mentalist-voice-status listening';
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(`Parlor renderer starting... (spout: ${isSpoutMode}, mask: ${isMaskMode})`);

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

  // Listen for mentalist UI updates from main process
  window.electronAPI.onMentalistUpdate((update: MentalistUIUpdate) => {
    console.log('[Mentalist] UI update received:', update);
    updateMentalistUI(update);
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

  // Listen for auto-end signal when session completes (turn limit reached)
  window.electronAPI.onMentalistAutoEnd(() => {
    console.log(`[Mentalist ${new Date().toISOString().slice(11, 23)}] Session complete - auto-ending...`);
    stopMentalistMode();
  });
}

// Start the app
main().catch(console.error);
