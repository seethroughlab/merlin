import { config } from 'dotenv';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
// OSC removed - all communication now via WebSocket (td-bridge)
import { createSpoutSender, wireWindowToSender, closeSpout, resizeSpoutSender } from './spout';
import { initGemini, analyzeMicroExpressions, analyzeBodyLanguage, interpretVoiceCommand, isGeminiAvailable } from './gemini';
import { initTTS as initGeminiTTS, generateMentalistSpeech as generateSpeech, isTTSAvailable } from './tts';
import { initLiveTTS, streamSpeech, isLiveTTSConnected, closeLiveTTS } from './tts-live';
import { MerlinSession, createMerlinSession as createMerlinSessionInstance } from './merlin';
import { testShaderGeneration } from './merlin/test-shader';
import { generateSpriteDirect, generateSpriteWithGemini } from './merlin/test-sprite';
import { applyFlipbookConfig, getCurrentMirroredState } from './merlin/test-flipbook';
import { testLiveSpell } from './merlin/test-live-spell';
import { setMainWindow as setGeminiEventsMainWindow } from './merlin/gemini-events';
import { resetTDBaseline } from './merlin/reset-td';
import { saveSessionState, loadSessionState, applySessionState, listSavedSessions, deleteSession } from './merlin/state-persistence';
import {
  initTDBridge,
  closeTDBridge,
  isConnected as isTDConnected,
  isTDReady,
  pushOrientationUpdate,
  pushTrackingFrame,
  pushMerlinState,
  pushZoneUpdateWithValidation,
  state as tdState,
} from './td-bridge';
import { store, getAllSettings, setSetting } from './settings';
import type { TrackingFrame, BodyLanguageAnalysis, MicroExpressionAnalysis, MerlinUIUpdate, SpellState, TestShaderConfig, SpriteTestSpec, SpriteFlipbookConfig, LiveSpellTestInput } from '../shared/types';

// Load .env file - try multiple locations for dev vs production
const envPaths = [
  join(process.cwd(), '.env'),                           // Current working directory
  join(dirname(process.execPath), '.env'),               // Next to executable
  join(app.getAppPath(), '.env'),                        // App directory
  join(app.getAppPath(), '..', '.env'),                  // Parent of app directory
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    console.log(`Loaded .env from: ${envPath}`);
    break;
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.log('GEMINI_API_KEY not found. Place .env file next to Merlin.exe with: GEMINI_API_KEY=your_key');
}

let mainWindow: BrowserWindow | null = null;
let spoutWindow: BrowserWindow | null = null;
let maskWindow: BrowserWindow | null = null;

// OSC removed - all communication now via WebSocket (td-bridge)

// Spout configuration
const spoutConfig = {
  enabled: true,
  senderName: 'Merlin',
  width: 1280,
  height: 720,
  frameRate: 30,
};

// Merlin session (singleton)
let merlinSession: MerlinSession | null = null;

// Cached analysis for mentalist/merlin mode
let lastBodyAnalysis: Partial<BodyLanguageAnalysis> | null = null;
let lastFaceAnalysis: Partial<MicroExpressionAnalysis> | null = null;

// Pending analysis requests (for tool callbacks)
const pendingAnalysisRequests = new Map<string, (result: unknown) => void>();

/**
 * Request fresh analysis from the renderer
 * Used when Gemini's tools request updated body/face analysis
 */
async function requestFreshAnalysis(
  type: 'face' | 'body'
): Promise<BodyLanguageAnalysis | MicroExpressionAnalysis | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log(`[Analysis ${ts()}] No main window, returning cached`);
    return type === 'body' ? lastBodyAnalysis as BodyLanguageAnalysis : lastFaceAnalysis as MicroExpressionAnalysis;
  }

  return new Promise((resolve) => {
    const requestId = `${type}_${Date.now()}`;

    // Set timeout to fall back to cached
    const timeout = setTimeout(() => {
      console.log(`[Analysis ${ts()}] Request timed out, returning cached`);
      pendingAnalysisRequests.delete(requestId);
      resolve(type === 'body' ? lastBodyAnalysis as BodyLanguageAnalysis : lastFaceAnalysis as MicroExpressionAnalysis);
    }, 5000);

    pendingAnalysisRequests.set(requestId, (result) => {
      clearTimeout(timeout);
      resolve(result as BodyLanguageAnalysis | MicroExpressionAnalysis | null);
    });

    console.log(`[Analysis ${ts()}] Requesting fresh ${type} analysis...`);
    mainWindow!.webContents.send('request-analysis', { type, requestId });
  });
}

/**
 * Send Merlin UI update to all windows
 */
function broadcastMerlinUpdate(update: MerlinUIUpdate): void {
  const windows = [mainWindow, spoutWindow, maskWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('merlin-update', update);
    }
  }
}

/**
 * Create a MerlinSession with callbacks
 */
function createMerlinSession(): MerlinSession {
  return createMerlinSessionInstance({
    onSpellUpdate: (spell: SpellState) => {
      console.log(`[Merlin] Spell updated: intent=${spell.intent}, element=${spell.element}, confidence=${spell.confidence}`);
      // WebSocket
      if (isTDConnected()) {
        pushMerlinState({
          active: true,
          spell,
        });
      }
    },
    onPhaseChange: (phase) => {
      console.log(`[Merlin] Phase changed: ${phase}`);
      // Broadcast phase change
      if (merlinSession) {
        broadcastMerlinUpdate({
          phase,
          turnCount: merlinSession.getState().turnCount,
          spell: merlinSession.getSpell(),
          isListening: false,
          isProcessing: false,
        });
      }
    },
    onRequestAnalysis: async (type, _focus) => {
      // Request fresh analysis from renderer (or fall back to cached)
      return requestFreshAnalysis(type);
    },
    onCaptureFrame: async () => {
      // Capture current camera frame as base64 for personalized intro
      if (!mainWindow || mainWindow.isDestroyed()) {
        return null;
      }
      try {
        const frameData = await mainWindow.webContents.executeJavaScript(`
          (function() {
            const video = document.getElementById('video');
            if (!video || video.videoWidth === 0) return null;
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
          })()
        `);
        return frameData;
      } catch (e) {
        console.error('[Merlin] Frame capture failed:', e);
        return null;
      }
    },
    onSessionComplete: () => {
      // Session reached outro - notify renderer to end
      console.log(`[Merlin ${ts()}] Session complete (auto-end triggered)`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merlin-auto-end');
      }
    },
  });
}

/**
 * Create the main visible preview window
 */
function createMainWindow(): void {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Merlin - Preview',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Restore maximized state
  if (bounds.isMaximized) {
    mainWindow.maximize();
  }

  // Wire the Gemini conversation event publisher to this window so
  // test-mode and live-session callers can stream activity to the sidebar.
  setGeminiEventsMainWindow(mainWindow);

  // In development, load from Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Save window bounds before closing
  mainWindow.on('close', () => {
    if (mainWindow) {
      const isMaximized = mainWindow.isMaximized();
      if (!isMaximized) {
        const currentBounds = mainWindow.getBounds();
        store.set('windowBounds', {
          x: currentBounds.x,
          y: currentBounds.y,
          width: currentBounds.width,
          height: currentBounds.height,
          isMaximized: false,
        });
      } else {
        store.set('windowBounds.isMaximized', true);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close spout windows when main window closes
    if (spoutWindow) {
      spoutWindow.close();
    }
    if (maskWindow) {
      maskWindow.close();
    }
  });
}

/**
 * Create the hidden offscreen window for Spout video output
 */
async function createSpoutWindow(): Promise<void> {
  const spoutAvailable = await createSpoutSender({
    name: 'Merlin',
    width: spoutConfig.width,
    height: spoutConfig.height,
  });
  if (!spoutAvailable) {
    console.log('Spout not available, skipping Spout window');
    return;
  }

  spoutWindow = new BrowserWindow({
    width: spoutConfig.width,
    height: spoutConfig.height,
    show: false,
    title: 'Merlin - Spout Video',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: { useSharedTexture: true },
    },
  });

  wireWindowToSender(spoutWindow, 'Merlin', spoutConfig.frameRate);

  if (process.env.VITE_DEV_SERVER_URL) {
    spoutWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?spout=1`);
  } else {
    spoutWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { spout: '1' },
    });
  }

  spoutWindow.on('closed', () => {
    spoutWindow = null;
  });

  console.log('Spout video window created');
}

/**
 * Create the hidden offscreen window for Spout mask output
 */
async function createMaskWindow(): Promise<void> {
  const maskAvailable = await createSpoutSender({
    name: 'Merlin Mask',
    width: spoutConfig.width,
    height: spoutConfig.height,
  });
  if (!maskAvailable) {
    console.log('Spout mask sender not available, skipping mask window');
    return;
  }

  maskWindow = new BrowserWindow({
    width: spoutConfig.width,
    height: spoutConfig.height,
    show: false,
    title: 'Merlin - Spout Mask',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: { useSharedTexture: true },
    },
  });

  wireWindowToSender(maskWindow, 'Merlin Mask', spoutConfig.frameRate);

  // Build URL with mask param
  const maskUrl = process.env.VITE_DEV_SERVER_URL
    ? new URL('/', process.env.VITE_DEV_SERVER_URL)
    : null;

  if (maskUrl) {
    maskUrl.searchParams.set('mask', '1');
    maskWindow.loadURL(maskUrl.toString());
  } else {
    maskWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { mask: '1' },
    });
  }

  maskWindow.on('closed', () => {
    maskWindow = null;
  });

  console.log('Spout mask window created');
}

// IPC handlers for tracking data - only accept from main window (not Spout window)
ipcMain.on('tracking-frame', (event, data: TrackingFrame) => {
  // Only process tracking data from the main preview window
  if (mainWindow && event.sender.id === mainWindow.webContents.id) {
    // Send via WebSocket (unified protocol)
    if (isTDConnected()) {
      pushTrackingFrame(data);
    }
  }
});

// IPC handler for face strip analysis (micro-expressions)
ipcMain.handle('analyze-face-strip', async (_event, imageDataUrl: string) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log('Analyzing face strip...');
  const startTime = Date.now();

  try {
    const analysis = await analyzeMicroExpressions(imageDataUrl);
    console.log(`Face analysis complete in ${Date.now() - startTime}ms`);
    console.log('Result:', JSON.stringify(analysis, null, 2));
    return analysis;
  } catch (error) {
    console.error('Face strip analysis failed:', error);
    throw error;
  }
});

// IPC handler for skeleton strip analysis (body language)
ipcMain.handle('analyze-skeleton-strip', async (_event, imageDataUrl: string) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log('Analyzing skeleton strip for body language...');
  const startTime = Date.now();

  try {
    const analysis = await analyzeBodyLanguage(imageDataUrl);
    console.log(`Body language analysis complete in ${Date.now() - startTime}ms`);
    console.log('Result:', JSON.stringify(analysis, null, 2));
    return analysis;
  } catch (error) {
    console.error('Skeleton strip analysis failed:', error);
    throw error;
  }
});

// IPC handler for voice command interpretation
ipcMain.handle('interpret-voice-command', async (_event, transcript: string) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`Interpreting voice command: "${transcript}"`);
  const startTime = Date.now();

  try {
    const result = await interpretVoiceCommand(transcript);
    console.log(`Voice command interpreted in ${Date.now() - startTime}ms`);
    console.log('Result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Voice command interpretation failed:', error);
    throw error;
  }
});

// IPC handler for renaming Spout senders
ipcMain.handle('rename-spout-sender', async (_event, oldName: string, newName: string) => {
  console.log(`Renaming Spout sender: ${oldName} -> ${newName}`);
  try {
    const { renameSpoutSender } = await import('./spout');
    return renameSpoutSender(oldName, newName);
  } catch (error) {
    console.error('Failed to rename Spout sender:', error);
    return false;
  }
});

// IPC handler for connection stats (TD Bridge)
ipcMain.handle('get-bridge-stats', () => {
  return {
    connected: isTDConnected(),
    port: 8001,
  };
});

// IPC handlers for settings persistence
ipcMain.handle('get-settings', () => {
  return getAllSettings();
});

ipcMain.handle('save-setting', (_event, key: string, value: unknown) => {
  setSetting(key as keyof ReturnType<typeof getAllSettings>, value as never);
  return true;
});

// IPC handler for portrait mode - broadcast to all windows and resize Spout
ipcMain.on('set-portrait-mode', async (_event, portrait: boolean) => {
  console.log(`Portrait mode: ${portrait}`);

  // Calculate new dimensions
  const width = portrait ? 720 : 1280;
  const height = portrait ? 1280 : 720;

  // Resize Spout senders
  await resizeSpoutSender('Merlin', width, height);
  await resizeSpoutSender('Merlin Mask', width, height);

  // Resize Spout windows
  if (spoutWindow && !spoutWindow.isDestroyed()) {
    spoutWindow.setSize(width, height);
    // Re-wire the window to the new sender
    wireWindowToSender(spoutWindow, 'Merlin', 30);
  }
  if (maskWindow && !maskWindow.isDestroyed()) {
    maskWindow.setSize(width, height);
    wireWindowToSender(maskWindow, 'Merlin Mask', 30);
  }

  // Broadcast to all windows
  const windows = [mainWindow, spoutWindow, maskWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('portrait-mode-changed', portrait);
    }
  }

  // Send orientation update to TouchDesigner
  if (isTDConnected()) {
    pushOrientationUpdate(portrait, width, height);
    console.log(`Sent orientation to TD: ${portrait ? 'portrait' : 'landscape'} ${width}x${height}`);
  }
});

// Helper for timestamped logs
const ts = () => new Date().toISOString().slice(11, 23);

// Receive analysis result from renderer (response to request-analysis)
ipcMain.on('analysis-result', (_event, data: { requestId: string; result: unknown }) => {
  const resolver = pendingAnalysisRequests.get(data.requestId);
  if (resolver) {
    console.log(`[Analysis ${ts()}] Received result for ${data.requestId}`);
    pendingAnalysisRequests.delete(data.requestId);
    resolver(data.result);
  }
});

// ============ MERLIN IPC HANDLERS ============

// Start a Merlin session
ipcMain.handle('merlin-start', async () => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`[Merlin ${ts()}] Starting session...`);
  merlinSession = createMerlinSession();

  try {
    const response = await merlinSession.startSession();

    // WebSocket
    if (isTDConnected()) {
      pushMerlinState({
        active: true,
        phase: response.phase,
        spell: response.spell,
      });
    }

    // Broadcast UI update
    broadcastMerlinUpdate({
      phase: response.phase,
      turnCount: 0,
      spell: response.spell,
      isListening: false,
      isProcessing: false,
    });

    return response;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Failed to start session:`, error);
    merlinSession = null;
    throw error;
  }
});

// Process user speech in Merlin session
ipcMain.handle('merlin-process-speech', async (_event, transcript: string) => {
  if (!merlinSession || !merlinSession.isActive()) {
    throw new Error('Merlin session not active');
  }

  console.log(`[Merlin ${ts()}] Processing: "${transcript}"`);

  try {
    const response = await merlinSession.processUserSpeech(
      transcript,
      lastBodyAnalysis,
      lastFaceAnalysis
    );

    const state = merlinSession.getState();

    // WebSocket
    if (isTDConnected()) {
      pushMerlinState({
        active: true,
        phase: response.phase,
        spell: response.spell,
      });
    }

    // Broadcast UI update
    broadcastMerlinUpdate({
      phase: response.phase,
      turnCount: state.turnCount,
      spell: response.spell,
      isListening: false,
      isProcessing: false,
    });

    return response;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Failed to process speech:`, error);
    throw error;
  }
});

// End Merlin session
ipcMain.handle('merlin-end', async () => {
  if (!merlinSession) {
    return { text: 'Session was not active.', phase: 'idle', spell: null };
  }

  console.log(`[Merlin ${ts()}] Ending session...`);

  try {
    const response = await merlinSession.endSession();

    // WebSocket
    if (isTDConnected()) {
      pushMerlinState({
        active: false,
        phase: 'idle',
      });
    }

    // Broadcast final UI update
    broadcastMerlinUpdate({
      phase: 'idle',
      turnCount: 0,
      spell: response.spell,
      isListening: false,
      isProcessing: false,
    });

    merlinSession = null;
    return response;
  } catch (error) {
    console.error('[Merlin] Failed to end session:', error);
    merlinSession = null;
    throw error;
  }
});

// Get Merlin session state
ipcMain.handle('merlin-get-state', () => {
  if (!merlinSession) {
    return null;
  }
  return {
    state: merlinSession.getState(),
    spell: merlinSession.getSpell(),
    history: merlinSession.getConversationHistory(),
    isActive: merlinSession.isActive(),
  };
});

// Update cached analysis for Merlin (same handler as mentalist)
ipcMain.on('merlin-update-analysis', (_event, data: {
  body?: Partial<BodyLanguageAnalysis>;
  face?: Partial<MicroExpressionAnalysis>;
}) => {
  if (data.body) {
    lastBodyAnalysis = data.body;
  }
  if (data.face) {
    lastFaceAnalysis = data.face;
  }
});

// Test shader generation (Shift+T debug mode)
ipcMain.handle('merlin-test-shader', async (_event, config: TestShaderConfig) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`[Merlin ${ts()}] Test shader: intent=${config.intent} element=${config.element} energy=${config.energy}`);
  const startTime = Date.now();

  try {
    const result = await testShaderGeneration(config);
    console.log(`[Merlin ${ts()}] Test shader complete in ${Date.now() - startTime}ms, ${result.zones.length} zones`);
    return result;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Test shader failed:`, error);
    throw error;
  }
});

// Test sprite generation - direct spec (Shift+T Sprites tab)
ipcMain.handle('merlin-test-sprite-direct', async (_event, spec: SpriteTestSpec) => {
  console.log(`[Merlin ${ts()}] Test sprite (direct): "${spec.description}"`);
  const startTime = Date.now();

  try {
    const result = await generateSpriteDirect(spec);
    console.log(`[Merlin ${ts()}] Test sprite (direct) complete in ${Date.now() - startTime}ms, success=${result.success}`);
    return result;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Test sprite (direct) failed:`, error);
    throw error;
  }
});

// Test sprite generation - Gemini interpretation (Shift+T Sprites tab)
ipcMain.handle('merlin-test-sprite-gemini', async (_event, prompt: string) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`[Merlin ${ts()}] Test sprite (gemini): "${prompt}"`);
  const startTime = Date.now();

  try {
    const result = await generateSpriteWithGemini(prompt);
    console.log(`[Merlin ${ts()}] Test sprite (gemini) complete in ${Date.now() - startTime}ms, success=${result.success}`);
    return result;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Test sprite (gemini) failed:`, error);
    throw error;
  }
});

// Test flipbook re-config without regenerating texture (Shift+T Flipbook tab)
ipcMain.handle('merlin-test-flipbook-config', async (_event, config: SpriteFlipbookConfig) => {
  console.log(`[Merlin ${ts()}] Test flipbook config: ${JSON.stringify(config)}`);
  return applyFlipbookConfig(config);
});

// Get the current mirrored TD state (last-pushed snapshot)
ipcMain.handle('merlin-test-get-mirrored-state', async () => {
  return getCurrentMirroredState();
});

// Reset TD shaders / sprite / render mode / flipbook / spell program to baseline
ipcMain.handle('merlin-reset-td-baseline', async () => {
  console.log(`[Merlin ${ts()}] Reset TD baseline`);
  const startTime = Date.now();
  try {
    const result = await resetTDBaseline();
    const failed = result.steps.filter(s => s.status === 'error').length;
    const skipped = result.steps.filter(s => s.status === 'skipped').length;
    console.log(`[Merlin ${ts()}] Reset complete in ${Date.now() - startTime}ms (${failed} failed, ${skipped} skipped)`);
    return result;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Reset failed:`, error);
    throw error;
  }
});

// ============ SESSION PERSISTENCE IPC HANDLERS ============

ipcMain.handle('merlin-list-sessions', async () => {
  return listSavedSessions();
});

ipcMain.handle('merlin-save-session', async (_event, name?: string) => {
  const state = merlinSession?.getState();
  if (!state) return { success: false, error: 'No active session' };
  const id = `session_${Date.now()}`;
  const ok = saveSessionState(id, state.spell, name ? { name } : undefined);
  return { success: ok, sessionId: id };
});

ipcMain.handle('merlin-load-session', async (_event, sessionId: string) => {
  const state = loadSessionState(sessionId);
  if (!state) return { success: false, error: 'Session not found' };
  applySessionState(state);
  const zoneResults: Record<string, boolean> = {};
  for (const [zone, code] of Object.entries(state.zones)) {
    if (code) {
      const result = await pushZoneUpdateWithValidation(zone, code);
      zoneResults[zone] = result.success;
    }
  }
  return { success: true, spell: state.spell, zoneResults };
});

ipcMain.handle('merlin-delete-session', async (_event, sessionId: string) => {
  return { success: deleteSession(sessionId) };
});

// Test live spell - end-to-end Gemini creative process (Shift+T Live Spell tab)
ipcMain.handle('merlin-test-live-spell', async (_event, input: LiveSpellTestInput) => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`[Merlin ${ts()}] Test live spell: prompt="${input.prompt}"`);
  const startTime = Date.now();

  try {
    const result = await testLiveSpell(input);
    console.log(`[Merlin ${ts()}] Test live spell complete in ${Date.now() - startTime}ms, success=${result.success} toolCalls=${result.toolCallCount}`);
    return result;
  } catch (error) {
    console.error(`[Merlin ${ts()}] Test live spell failed:`, error);
    throw error;
  }
});

// ============ TTS IPC HANDLERS ============

// Generate speech using Gemini TTS (batch mode)
ipcMain.handle('generate-speech', async (_event, text: string, mood?: string) => {
  if (!isTTSAvailable()) {
    throw new Error('Gemini TTS not available - check GEMINI_API_KEY');
  }

  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[TTS ${timestamp}] Generating speech for mood "${mood || 'mysterious'}"...`);
  const startTime = Date.now();

  try {
    const result = await generateSpeech(
      text,
      (mood as 'mysterious' | 'warm' | 'intense' | 'playful') || 'mysterious'
    );
    const endTimestamp = new Date().toISOString().slice(11, 23);
    console.log(`[TTS ${endTimestamp}] IPC complete in ${Date.now() - startTime}ms`);
    return result;
  } catch (error) {
    console.error('[TTS] Generation failed:', error);
    throw error;
  }
});

// Stream speech using Gemini Live API (streaming mode)
ipcMain.on('stream-speech', (_event, text: string, mood?: string) => {
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[LiveTTS ${timestamp}] Stream request for mood "${mood || 'mysterious'}"...`);

  if (!isLiveTTSConnected()) {
    console.log(`[LiveTTS ${timestamp}] Not connected, request will be queued`);
  }

  streamSpeech(text, mood || 'mysterious');
});

// ============ TD BRIDGE IPC HANDLERS ============

// Get TD connection status
ipcMain.handle('td-get-status', () => ({
  connected: isTDConnected(),
  ready: isTDReady(),
  capabilities: tdState.capabilities,
}));

app.whenReady().then(async () => {
  console.log('=== Merlin Starting ===');

  // Initialize Gemini (for LLM analysis)
  const geminiReady = initGemini();
  if (geminiReady) {
    console.log('Gemini initialized');
  } else {
    console.log('Gemini not available (set GEMINI_API_KEY to enable)');
  }

  // Initialize Gemini TTS
  const ttsReady = initGeminiTTS();
  if (ttsReady) {
    console.log('Gemini TTS initialized');
  } else {
    console.log('Gemini TTS not available');
  }

  // OSC removed - all communication now via WebSocket (td-bridge)

  // Initialize TD Bridge (WebSocket server for TouchDesigner)
  initTDBridge({
    onConnect: () => {
      console.log('TouchDesigner connected');
      mainWindow?.webContents.send('td-status', { connected: true, ready: false });
    },
    onDisconnect: () => {
      console.log('TouchDesigner disconnected');
      mainWindow?.webContents.send('td-status', { connected: false, ready: false });
    },
    onReady: (capabilities) => {
      console.log('TouchDesigner ready:', capabilities);
      mainWindow?.webContents.send('td-status', { connected: true, ready: true, capabilities });

      // Send current orientation to TD on connect
      const isPortrait = store.get('isPortraitMode') as boolean ?? false;
      const width = isPortrait ? 720 : 1280;
      const height = isPortrait ? 1280 : 720;
      pushOrientationUpdate(isPortrait, width, height);
      console.log(`Sent initial orientation to TD: ${isPortrait ? 'portrait' : 'landscape'} ${width}x${height}`);
    },
    onCompileResult: (result) => {
      // Forward zone compile results to renderer for UI updates
      mainWindow?.webContents.send('zone-compile-result', result);
    },
    onError: (error) => {
      console.error('TD Bridge error:', error);
    },
  });
  console.log('TD Bridge initialized');

  // Create visible preview window
  createMainWindow();
  console.log('Preview window created');

  // Initialize Live TTS (streaming WebSocket) - needs mainWindow
  if (mainWindow) {
    const liveTTSReady = initLiveTTS(mainWindow);
    if (liveTTSReady) {
      console.log('Live TTS (streaming) initialized');
    }
  }

  // Create hidden Spout output windows (video + mask)
  await createSpoutWindow();
  await createMaskWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      await createSpoutWindow();
      await createMaskWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  closeSpout();
  closeLiveTTS();
  closeTDBridge();
});
