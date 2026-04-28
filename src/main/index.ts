import { config } from 'dotenv';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { initOsc, sendTrackingFrame, closeOsc, getOscStats, sendMentalistUpdate } from './osc';
import { createSpoutSender, wireWindowToSender, closeSpout, resizeSpoutSender } from './spout';
import { initGemini, analyzeMicroExpressions, analyzeBodyLanguage, interpretVoiceCommand, isGeminiAvailable } from './gemini';
import { initTTS as initGeminiTTS, generateMentalistSpeech, isTTSAvailable } from './tts';
import { initLiveTTS, streamSpeech, isLiveTTSConnected, closeLiveTTS } from './tts-live';
import { MentalistSession } from './mentalist';
import {
  initTDBridge,
  closeTDBridge,
  isConnected as isTDConnected,
  isTDReady,
  pushMoodUpdate,
  pushSceneParams,
  pushRevealEffect,
  state as tdState,
} from './td-bridge';
import { store, getAllSettings, setSetting } from './settings';
import type { TrackingFrame, BodyLanguageAnalysis, MicroExpressionAnalysis } from '../shared/types';
import type { MentalistUIUpdate, RevealTriggerParams, SetMoodParams } from './mentalist';

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
  console.log('GEMINI_API_KEY not found. Place .env file next to Parlor.exe with: GEMINI_API_KEY=your_key');
}

let mainWindow: BrowserWindow | null = null;
let spoutWindow: BrowserWindow | null = null;
let maskWindow: BrowserWindow | null = null;

// OSC configuration (will be loaded from config.yaml later)
const oscConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 9000,
};

// Spout configuration
const spoutConfig = {
  enabled: true,
  senderName: 'Parlor',
  width: 1280,
  height: 720,
  frameRate: 30,
};

// Mentalist session (singleton)
let mentalistSession: MentalistSession | null = null;

// Cached analysis for mentalist mode
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
 * Send mentalist UI update to all windows
 */
function broadcastMentalistUpdate(update: MentalistUIUpdate): void {
  const windows = [mainWindow, spoutWindow, maskWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('mentalist-update', update);
    }
  }
}

/**
 * Create a MentalistSession with callbacks
 */
function createMentalistSession(): MentalistSession {
  return new MentalistSession({
    onReveal: (params: RevealTriggerParams) => {
      console.log(`[Mentalist] Reveal triggered: ${params.type} - "${params.text}"`);
      sendMentalistUpdate({
        reveal: {
          trigger: true,
          type: params.type,
          text: params.text,
          intensity: params.intensity,
        },
      });
    },
    onMoodChange: (params: SetMoodParams) => {
      console.log(`[Mentalist] Mood changed: ${params.mood}`);
      sendMentalistUpdate({
        mood: params.mood,
        colorAccent: params.colorAccent,
        particleBehavior: params.particleBehavior,
      });
    },
    onRequestAnalysis: async (type, _focus) => {
      // Request fresh analysis from renderer (or fall back to cached)
      return requestFreshAnalysis(type);
    },
    onSessionComplete: () => {
      // Session reached finale - notify renderer to end
      console.log(`[Mentalist ${ts()}] Session complete (auto-end triggered)`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mentalist-auto-end');
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
    title: 'Parlor - Preview',
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
    name: 'Parlor',
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
    title: 'Parlor - Spout Video',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: { useSharedTexture: true },
    },
  });

  wireWindowToSender(spoutWindow, 'Parlor', spoutConfig.frameRate);

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
    name: 'Parlor Mask',
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
    title: 'Parlor - Spout Mask',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: { useSharedTexture: true },
    },
  });

  wireWindowToSender(maskWindow, 'Parlor Mask', spoutConfig.frameRate);

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
    sendTrackingFrame(data);
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

// IPC handler for OSC statistics
ipcMain.handle('get-osc-stats', () => {
  return getOscStats();
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
  await resizeSpoutSender('Parlor', width, height);
  await resizeSpoutSender('Parlor Mask', width, height);

  // Resize Spout windows
  if (spoutWindow && !spoutWindow.isDestroyed()) {
    spoutWindow.setSize(width, height);
    // Re-wire the window to the new sender
    wireWindowToSender(spoutWindow, 'Parlor', 30);
  }
  if (maskWindow && !maskWindow.isDestroyed()) {
    maskWindow.setSize(width, height);
    wireWindowToSender(maskWindow, 'Parlor Mask', 30);
  }

  // Broadcast to all windows
  const windows = [mainWindow, spoutWindow, maskWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('portrait-mode-changed', portrait);
    }
  }
});

// ============ MENTALIST IPC HANDLERS ============

// Helper for timestamped logs
const ts = () => new Date().toISOString().slice(11, 23);

// Start a mentalist session
ipcMain.handle('mentalist-start', async () => {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini not available - check GEMINI_API_KEY');
  }

  console.log(`[Mentalist ${ts()}] Starting session...`);
  mentalistSession = createMentalistSession();

  try {
    const response = await mentalistSession.startSession();

    // Send OSC update
    sendMentalistUpdate({
      active: true,
      phase: response.phase,
      mood: response.mood,
    });

    // Broadcast UI update (no lastMessage - renderer adds it directly)
    broadcastMentalistUpdate({
      phase: response.phase,
      mood: response.mood,
      turnCount: 0,
      revealedInsights: [],
      isListening: false,
      isProcessing: false,
    });

    return response;
  } catch (error) {
    console.error(`[Mentalist ${ts()}] Failed to start session:`, error);
    mentalistSession = null;
    throw error;
  }
});

// Process user speech in mentalist session
ipcMain.handle('mentalist-process-speech', async (_event, transcript: string) => {
  if (!mentalistSession || !mentalistSession.isActive()) {
    throw new Error('Mentalist session not active');
  }

  console.log(`[Mentalist ${ts()}] Processing: "${transcript}"`);

  try {
    const response = await mentalistSession.processUserSpeech(
      transcript,
      lastBodyAnalysis,
      lastFaceAnalysis
    );

    const state = mentalistSession.getState();

    // Send OSC update
    sendMentalistUpdate({
      phase: response.phase,
      mood: response.mood,
    });

    // Broadcast UI update (no lastMessage - renderer adds it directly)
    broadcastMentalistUpdate({
      phase: response.phase,
      mood: response.mood,
      turnCount: state.turnCount,
      revealedInsights: mentalistSession.getRevealedInsights(),
      isListening: false,
      isProcessing: false,
    });

    return response;
  } catch (error) {
    console.error(`[Mentalist ${ts()}] Failed to process speech:`, error);
    throw error;
  }
});

// End mentalist session
ipcMain.handle('mentalist-end', async () => {
  if (!mentalistSession) {
    return { text: 'Session was not active.', phase: 'idle', mood: 'warm', newInsights: [] };
  }

  console.log(`[Mentalist ${ts()}] Ending session...`);

  try {
    const response = await mentalistSession.endSession();

    // Send OSC update
    sendMentalistUpdate({
      active: false,
      phase: 'idle',
      mood: 'warm',
    });

    // Broadcast final UI update (no lastMessage - renderer adds it directly)
    broadcastMentalistUpdate({
      phase: 'idle',
      mood: 'warm',
      turnCount: 0,
      revealedInsights: [],
      isListening: false,
      isProcessing: false,
    });

    mentalistSession = null;
    return response;
  } catch (error) {
    console.error('[Mentalist] Failed to end session:', error);
    mentalistSession = null;
    throw error;
  }
});

// Get mentalist session state
ipcMain.handle('mentalist-get-state', () => {
  if (!mentalistSession) {
    return null;
  }
  return {
    state: mentalistSession.getState(),
    history: mentalistSession.getConversationHistory(),
    revealedInsights: mentalistSession.getRevealedInsights(),
    isActive: mentalistSession.isActive(),
  };
});

// Update cached analysis for mentalist (called from renderer periodically)
ipcMain.on('mentalist-update-analysis', (_event, data: {
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

// Receive analysis result from renderer (response to request-analysis)
ipcMain.on('analysis-result', (_event, data: { requestId: string; result: unknown }) => {
  const resolver = pendingAnalysisRequests.get(data.requestId);
  if (resolver) {
    console.log(`[Analysis ${ts()}] Received result for ${data.requestId}`);
    pendingAnalysisRequests.delete(data.requestId);
    resolver(data.result);
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
    const result = await generateMentalistSpeech(
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

// Push mood update to TD
ipcMain.on('td-push-mood', (_event, { mood, color, intensity }: { mood: string; color?: string; intensity?: number }) => {
  pushMoodUpdate(mood, color, intensity);
});

// Push scene parameters to TD
ipcMain.on('td-push-scene', (_event, params: Parameters<typeof pushSceneParams>[0]) => {
  pushSceneParams(params);
});

// Push reveal effect to TD
ipcMain.on('td-push-reveal', (_event, { effect_type, intensity, duration, landmark }: {
  effect_type: string;
  intensity: number;
  duration: number;
  landmark?: number;
}) => {
  pushRevealEffect(effect_type, intensity, duration, landmark);
});

app.whenReady().then(async () => {
  console.log('=== Parlor Starting ===');

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

  // Initialize OSC
  initOsc(oscConfig);
  console.log('OSC initialized');

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
  closeOsc();
  closeSpout();
  closeLiveTTS();
  closeTDBridge();
});
