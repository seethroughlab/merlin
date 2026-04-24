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
import type { TrackingFrame, PoseData, FaceData, MicroExpressionAnalysis, BodyLanguageAnalysis } from '../shared/types';

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

// Analysis settings
let autoAnalyzeFace = false;
let faceAnalysisInterval = 10000;  // ms
let autoAnalyzeBody = false;
let bodyAnalysisInterval = 15000;  // ms

// Analysis timers
let faceAnalysisTimer: number | null = null;
let bodyAnalysisTimer: number | null = null;

// Countdown tracking
let lastFaceAnalysisTime = 0;
let lastBodyAnalysisTime = 0;
let countdownUpdateTimer: number | null = null;

// Latest results for display
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
 * Initialize camera
 */
async function initCamera(): Promise<void> {
  if (statusDisplay) statusDisplay.textContent = 'Requesting camera access...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

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
 * Update filmstrip status display
 */
function setFilmstripStatus(type: 'face' | 'body', status: string | null): void {
  const filmstrip = document.getElementById(`${type}-filmstrip`);
  if (!filmstrip) return;

  const imageDiv = filmstrip.querySelector('.filmstrip-image');
  const statusSpan = filmstrip.querySelector('.filmstrip-status') as HTMLElement;

  if (status) {
    imageDiv?.classList.add('loading');
    if (statusSpan) statusSpan.textContent = status;
  } else {
    imageDiv?.classList.remove('loading');
    if (statusSpan) statusSpan.textContent = '';
  }
}

/**
 * Capture face strip and analyze with Gemini
 */
async function captureAndAnalyze(): Promise<void> {
  if (isCapturing) {
    console.log('Capture already in progress');
    return;
  }

  isCapturing = true;
  setFilmstripStatus('face', 'Capturing...');
  if (statusDisplay) statusDisplay.textContent = 'Capturing face strip...';

  try {
    // Capture filmstrip (8 frames over 5 seconds)
    const result = await captureFaceStrip(video, {
      frameCount: 8,
      intervalMs: 625,  // 5000ms / 8 frames
      frameSize: 128,
    }, getFrameSource);

    if (!result) {
      setFilmstripStatus('face', null);
      if (statusDisplay) statusDisplay.textContent = 'No face detected for capture';
      return;
    }

    console.log(`Captured ${result.framesCaptured} frames in ${result.durationMs.toFixed(0)}ms`);
    setFilmstripStatus('face', 'Analyzing...');
    if (statusDisplay) statusDisplay.textContent = 'Analyzing with Gemini...';

    // Send to Gemini for analysis
    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeFaceStrip(result.imageDataUrl);

      // Store result and filmstrip, update display
      lastFaceAnalysis = analysis;
      lastFaceStripUrl = result.imageDataUrl;
      setFilmstripStatus('face', null);
      updateFilmstripPanel();

      // Display result in status
      console.log('Analysis result:', analysis);
      if (statusDisplay) {
        statusDisplay.textContent = `${analysis.primaryEmotion} (${(analysis.valence > 0 ? '+' : '')}${analysis.valence.toFixed(2)})`;
      }
    } else {
      setFilmstripStatus('face', null);
      if (statusDisplay) statusDisplay.textContent = 'Electron API not available';
    }
  } catch (error) {
    console.error('Capture/analysis error:', error);
    setFilmstripStatus('face', null);
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
  setFilmstripStatus('body', 'Capturing...');
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
      setFilmstripStatus('body', null);
      if (statusDisplay) statusDisplay.textContent = 'No pose detected for capture';
      return;
    }

    console.log(`Captured ${result.framesCaptured} skeleton frames in ${result.durationMs.toFixed(0)}ms`);
    setFilmstripStatus('body', 'Analyzing...');
    if (statusDisplay) statusDisplay.textContent = 'Analyzing body language...';

    // Send to Gemini for analysis
    if (window.electronAPI) {
      const analysis = await window.electronAPI.analyzeSkeletonStrip(result.imageDataUrl);

      // Store result and filmstrip, update display
      lastBodyAnalysis = analysis;
      lastBodyStripUrl = result.imageDataUrl;
      setFilmstripStatus('body', null);
      updateFilmstripPanel();

      // Display result in status
      console.log('Body language result:', analysis);
      if (statusDisplay) {
        const posture = analysis.primaryPosture ?? 'unknown';
        statusDisplay.textContent = posture;
      }
    } else {
      setFilmstripStatus('body', null);
      if (statusDisplay) statusDisplay.textContent = 'Electron API not available';
    }
  } catch (error) {
    console.error('Body language capture/analysis error:', error);
    setFilmstripStatus('body', null);
    if (statusDisplay) statusDisplay.textContent = `Error: ${error}`;
  } finally {
    isCapturingBody = false;
  }
}

/**
 * Update the filmstrip panel with latest analysis results and images
 */
function updateFilmstripPanel(): void {
  const faceFilmstrip = document.getElementById('face-filmstrip');
  const bodyFilmstrip = document.getElementById('body-filmstrip');

  if (faceFilmstrip) {
    const imageDiv = faceFilmstrip.querySelector('.filmstrip-image');
    const emotionDiv = faceFilmstrip.querySelector('.filmstrip-emotion');
    const valuesDiv = faceFilmstrip.querySelector('.filmstrip-values');
    const descDiv = faceFilmstrip.querySelector('.filmstrip-description');

    if (lastFaceStripUrl && imageDiv) {
      imageDiv.innerHTML = `<img src="${lastFaceStripUrl}" alt="Face filmstrip" />`;
    }

    if (lastFaceAnalysis) {
      const { primaryEmotion, valence, arousal, confidence, description } = lastFaceAnalysis;
      if (emotionDiv) emotionDiv.textContent = primaryEmotion;
      if (valuesDiv) valuesDiv.textContent = `Valence: ${valence > 0 ? '+' : ''}${valence.toFixed(2)} | Arousal: ${arousal.toFixed(2)} | Conf: ${(confidence * 100).toFixed(0)}%`;
      if (descDiv) descDiv.textContent = description;
    }
  }

  if (bodyFilmstrip) {
    const imageDiv = bodyFilmstrip.querySelector('.filmstrip-image');
    const emotionDiv = bodyFilmstrip.querySelector('.filmstrip-emotion');
    const valuesDiv = bodyFilmstrip.querySelector('.filmstrip-values');
    const descDiv = bodyFilmstrip.querySelector('.filmstrip-description');

    if (lastBodyStripUrl && imageDiv) {
      imageDiv.innerHTML = `<img src="${lastBodyStripUrl}" alt="Body filmstrip" />`;
    }

    if (lastBodyAnalysis) {
      const { primaryPosture, openness, tension, engagement, confidence, description } = lastBodyAnalysis;
      if (emotionDiv) emotionDiv.textContent = primaryPosture;
      if (valuesDiv) valuesDiv.textContent = `Open: ${openness.toFixed(1)} | Tense: ${tension.toFixed(1)} | Engaged: ${engagement.toFixed(1)} | Conf: ${(confidence * 100).toFixed(0)}%`;
      if (descDiv) descDiv.textContent = description;
    }
  }
}

/**
 * Start face analysis timer
 */
function startFaceAnalysisTimer(): void {
  stopFaceAnalysisTimer();
  lastFaceAnalysisTime = Date.now();
  faceAnalysisTimer = window.setInterval(() => {
    if (!isCapturing) {
      lastFaceAnalysisTime = Date.now();
      captureAndAnalyze();
    }
  }, faceAnalysisInterval);
  startCountdownUpdate();
  console.log(`Face analysis timer started: every ${faceAnalysisInterval / 1000}s`);
}

/**
 * Stop face analysis timer
 */
function stopFaceAnalysisTimer(): void {
  if (faceAnalysisTimer) {
    clearInterval(faceAnalysisTimer);
    faceAnalysisTimer = null;
    lastFaceAnalysisTime = 0;
    updateCountdownDisplay();
    stopCountdownUpdateIfNotNeeded();
    console.log('Face analysis timer stopped');
  }
}

/**
 * Start body analysis timer
 */
function startBodyAnalysisTimer(): void {
  stopBodyAnalysisTimer();
  lastBodyAnalysisTime = Date.now();
  bodyAnalysisTimer = window.setInterval(() => {
    if (!isCapturingBody) {
      lastBodyAnalysisTime = Date.now();
      captureAndAnalyzeBodyLanguage();
    }
  }, bodyAnalysisInterval);
  startCountdownUpdate();
  console.log(`Body analysis timer started: every ${bodyAnalysisInterval / 1000}s`);
}

/**
 * Stop body analysis timer
 */
function stopBodyAnalysisTimer(): void {
  if (bodyAnalysisTimer) {
    clearInterval(bodyAnalysisTimer);
    bodyAnalysisTimer = null;
    lastBodyAnalysisTime = 0;
    updateCountdownDisplay();
    stopCountdownUpdateIfNotNeeded();
    console.log('Body analysis timer stopped');
  }
}

/**
 * Start countdown update timer
 */
function startCountdownUpdate(): void {
  if (countdownUpdateTimer) return;  // Already running
  countdownUpdateTimer = window.setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay();  // Immediate update
}

/**
 * Stop countdown update timer if not needed
 */
function stopCountdownUpdateIfNotNeeded(): void {
  if (!autoAnalyzeFace && !autoAnalyzeBody && countdownUpdateTimer) {
    clearInterval(countdownUpdateTimer);
    countdownUpdateTimer = null;
  }
}

/**
 * Update countdown display
 */
function updateCountdownDisplay(): void {
  const faceCountdown = document.getElementById('face-countdown');
  const bodyCountdown = document.getElementById('body-countdown');

  if (faceCountdown) {
    if (autoAnalyzeFace && lastFaceAnalysisTime > 0) {
      const elapsed = Date.now() - lastFaceAnalysisTime;
      const remaining = Math.max(0, Math.ceil((faceAnalysisInterval - elapsed) / 1000));
      faceCountdown.textContent = `${remaining}s`;
    } else {
      faceCountdown.textContent = '';
    }
  }

  if (bodyCountdown) {
    if (autoAnalyzeBody && lastBodyAnalysisTime > 0) {
      const elapsed = Date.now() - lastBodyAnalysisTime;
      const remaining = Math.max(0, Math.ceil((bodyAnalysisInterval - elapsed) / 1000));
      bodyCountdown.textContent = `${remaining}s`;
    } else {
      bodyCountdown.textContent = '';
    }
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

  // Analysis controls
  const autoFaceCheckbox = document.getElementById('auto-face') as HTMLInputElement;
  const faceIntervalInput = document.getElementById('face-interval') as HTMLInputElement;
  const autoBodyCheckbox = document.getElementById('auto-body') as HTMLInputElement;
  const bodyIntervalInput = document.getElementById('body-interval') as HTMLInputElement;

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
  });
  detectFaceCheckbox?.addEventListener('change', () => {
    detectFaceEnabled = detectFaceCheckbox.checked;
    updateDrawCheckbox(detectFaceCheckbox, drawFaceCheckbox);
    if (!detectFaceEnabled) drawFaceEnabled = false;
  });
  detectSegmentCheckbox?.addEventListener('change', () => {
    detectSegmentEnabled = detectSegmentCheckbox.checked;
    updateDrawCheckbox(detectSegmentCheckbox, drawSegmentCheckbox);
    if (!detectSegmentEnabled) drawSegmentEnabled = false;
  });

  // Wire up drawing toggles
  drawPoseCheckbox?.addEventListener('change', () => {
    drawPoseEnabled = drawPoseCheckbox.checked;
  });
  drawFaceCheckbox?.addEventListener('change', () => {
    drawFaceEnabled = drawFaceCheckbox.checked;
  });
  drawSegmentCheckbox?.addEventListener('change', () => {
    drawSegmentEnabled = drawSegmentCheckbox.checked;
  });

  // Wire up analysis controls
  autoFaceCheckbox?.addEventListener('change', () => {
    autoAnalyzeFace = autoFaceCheckbox.checked;
    if (autoAnalyzeFace) {
      startFaceAnalysisTimer();
    } else {
      stopFaceAnalysisTimer();
    }
  });

  faceIntervalInput?.addEventListener('change', () => {
    faceAnalysisInterval = parseInt(faceIntervalInput.value, 10) * 1000;
    if (autoAnalyzeFace) {
      startFaceAnalysisTimer();
    }
  });

  autoBodyCheckbox?.addEventListener('change', () => {
    autoAnalyzeBody = autoBodyCheckbox.checked;
    if (autoAnalyzeBody) {
      startBodyAnalysisTimer();
    } else {
      stopBodyAnalysisTimer();
    }
  });

  bodyIntervalInput?.addEventListener('change', () => {
    bodyAnalysisInterval = parseInt(bodyIntervalInput.value, 10) * 1000;
    if (autoAnalyzeBody) {
      startBodyAnalysisTimer();
    }
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

  console.log('Sidebar controls initialized');
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
 * Setup keyboard handlers
 */
function setupKeyboardHandlers(): void {
  document.addEventListener('keydown', (event) => {
    // Ignore if typing in an input
    if (event.target instanceof HTMLInputElement) return;

    // Space bar triggers face strip capture (micro-expressions)
    if (event.code === 'Space' && !event.repeat) {
      event.preventDefault();
      captureAndAnalyze();
    }

    // B key triggers skeleton strip capture (body language)
    if (event.code === 'KeyB' && !event.repeat) {
      event.preventDefault();
      captureAndAnalyzeBodyLanguage();
    }
  });

  console.log('Keyboard handlers ready (Space = face, B = body language)');
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
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(`Parlor renderer starting... (spout: ${isSpoutMode}, mask: ${isMaskMode})`);

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
    setupSidebar();
    setupKeyboardHandlers();
    await initMediaPipe();
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
}

// Start the app
main().catch(console.error);
