/**
 * Main-process bootstrap for the Merlin Mirror Electron app.
 *
 * Responsibilities (in roughly the order they run):
 *   1. Load environment + check API keys.
 *   2. Initialize Gemini TTS, Live TTS, and the TD WebSocket bridge.
 *   3. Create the visible preview window (+ a hidden Spout window for
 *      texture output; the mask window is currently dormant).
 *   4. Build the MainContext that IPC modules use, then call
 *      registerAllIPC() once to wire up every `ipcMain.handle/on`.
 *
 * Handler bodies live under `src/main/ipc/` (split topically into
 * `system`, `merlin`, `merlin-test`, `tts`). The state they read or
 * write — `mainWindow`, `merlinSession`, last analysis caches, the
 * pending-analysis request map — is owned here and exposed to them via
 * the `MainContext`. Single source of truth, no module-level
 * singletons smuggling state across files.
 */

import { config } from 'dotenv';
import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { createSpoutSender, wireWindowToSender, closeSpout } from './spout';
import { isGeminiAvailable } from './merlin/gemini-analysis';
import { initTTS as initGeminiTTS } from './tts';
import { initLiveTTS, closeLiveTTS } from './tts-live';
import { MerlinSession, createMerlinSession as createMerlinSessionInstance } from './merlin';
import { setMainWindow as setGeminiEventsMainWindow } from './merlin/gemini-events';
import { startConversationTestTrigger } from './conversation-test-trigger';
import {
  initTDBridge,
  closeTDBridge,
  pushOrientationUpdate,
  pushMerlinState,
  isConnected as isTDConnected,
} from './td-bridge';
import { store } from './settings';
import type {
  BodyLanguageAnalysis,
  MicroExpressionAnalysis,
  MerlinUIUpdate,
  SpellState,
} from '../shared/types';
import { registerAllIPC, type MainContext, type MainContextRefs } from './ipc';

// ============ ENV ============

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

// ============ STATE ============

let mainWindow: BrowserWindow | null = null;
let spoutWindow: BrowserWindow | null = null;
let maskWindow: BrowserWindow | null = null;

// Spout configuration (referenced by createSpoutWindow + the mask
// window creator). Static after startup.
const spoutConfig = {
  enabled: true,
  senderName: 'Merlin',
  width: 1280,
  height: 720,
  frameRate: 30,
};

// Mutable refs shared with IPC handlers via the MainContext. Single
// source of truth — both the bootstrap and the IPC modules read/write
// through this bag instead of cloning let-bindings into closures.
const refs: MainContextRefs = {
  session: null,
  lastBodyAnalysis: null,
  lastFaceAnalysis: null,
  pendingAnalysisRequests: new Map(),
};

// ============ HELPERS ============

/** Short timestamp helper (HH:MM:SS.mmm) used in log lines. */
const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Request fresh body or face analysis from the renderer. The renderer
 * runs the actual MediaPipe → filmstrip → Gemini round-trip; the main
 * process just brokers the request and returns the cached result if
 * the renderer is slow or unavailable.
 */
async function requestFreshAnalysis(
  type: 'face' | 'body',
): Promise<BodyLanguageAnalysis | MicroExpressionAnalysis | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log(`[Analysis ${ts()}] No main window, returning cached`);
    return type === 'body'
      ? (refs.lastBodyAnalysis as BodyLanguageAnalysis | null)
      : (refs.lastFaceAnalysis as MicroExpressionAnalysis | null);
  }

  return new Promise((resolve) => {
    const requestId = `${type}_${Date.now()}`;

    // Set timeout to fall back to cached
    const timeout = setTimeout(() => {
      console.log(`[Analysis ${ts()}] Request timed out, returning cached`);
      refs.pendingAnalysisRequests.delete(requestId);
      resolve(
        type === 'body'
          ? (refs.lastBodyAnalysis as BodyLanguageAnalysis | null)
          : (refs.lastFaceAnalysis as MicroExpressionAnalysis | null),
      );
    }, 5000);

    refs.pendingAnalysisRequests.set(requestId, (result) => {
      clearTimeout(timeout);
      resolve(result as BodyLanguageAnalysis | MicroExpressionAnalysis | null);
    });

    console.log(`[Analysis ${ts()}] Requesting fresh ${type} analysis...`);
    mainWindow!.webContents.send('request-analysis', { type, requestId });
  });
}

/** Send a Merlin UI update to every live BrowserWindow. */
function broadcastMerlinUpdate(update: MerlinUIUpdate): void {
  const windows = [mainWindow, spoutWindow, maskWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('merlin-update', update);
    }
  }
}

/**
 * Build a MerlinSession with all the bootstrap-side callbacks wired
 * up (spell/phase broadcasts, frame capture for the intro turn,
 * speak-chunk forwarding, cast-armed signal, session-complete auto-end).
 */
function createMerlinSession(): MerlinSession {
  return createMerlinSessionInstance({
    onSpellUpdate: (spell: SpellState) => {
      console.log(`[Merlin] Spell updated: intent=${spell.intent}, element=${spell.element}, confidence=${spell.confidence}`);
      if (isTDConnected()) {
        pushMerlinState({
          active: true,
          spell,
        });
      }
    },
    onPhaseChange: (phase) => {
      console.log(`[Merlin] Phase changed: ${phase}`);
      if (refs.session) {
        broadcastMerlinUpdate({
          phase,
          turnCount: refs.session.getState().turnCount,
          spell: refs.session.getSpell(),
          isListening: false,
          isProcessing: false,
        });
      }
    },
    onRequestAnalysis: async (type, _focus) => {
      return requestFreshAnalysis(type);
    },
    onCaptureFrame: async () => {
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
      console.log(`[Merlin ${ts()}] Session complete (auto-end triggered)`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merlin-auto-end');
      }
    },
    onSpeakChunk: (text: string) => {
      // Parallel TTS: forward the chunk to the renderer so LiveTTS starts
      // playing while the tool-dispatch loop (often a 25s Imagen call)
      // continues running in main. The turn-runner has already excluded
      // this text from the final response, so the renderer won't
      // double-speak it when processUserSpeech eventually resolves.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merlin-speak-chunk', text);
      }
    },
    onCastArmed: (payload) => {
      // The moment prepare_casting fires, ship the magic word to the
      // renderer so its background cast listener can match the
      // participant's speech directly — no Gemini round-trip needed
      // when they say the word.
      console.log(`[Merlin ${ts()}] Cast armed: magicWord="${payload.magicWord}"`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merlin-cast-armed', payload);
      }
    },
  });
}

// ============ MAIN CONTEXT ============

const ctx: MainContext = {
  getMainWindow: () => mainWindow,
  getSpoutWindow: () => spoutWindow,
  getMaskWindow: () => maskWindow,
  refs,
  ts,
  broadcastMerlinUpdate,
  createMerlinSession,
};

// ============ WINDOWS ============

/**
 * Create the main visible preview window.
 */
function createMainWindow(): void {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Merlin - Preview',
    // Wizard icon for taskbar / alt-tab / window chrome during dev. In
    // packaged builds electron-builder substitutes build/icon.ico into
    // the executable; this path is for the dev runtime. __dirname here
    // resolves to dist/main, so two levels up is the project root.
    icon: join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Tracking loop is rAF-driven; without this Chromium clamps it to
      // ~1 Hz whenever the window loses focus and tracking_frame stops.
      backgroundThrottling: false,
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

  // HTTP trigger for the Conversation Tester (Shift+T → Conversation).
  // Lets Claude (or any external caller) kick off a preset run via
  // `curl -X POST http://localhost:8765/run-conversation -d '{"presetId":"sarah-phd"}'`
  // and get back the saved transcript path. Started once mainWindow exists.
  startConversationTestTrigger(() => mainWindow);
}

/**
 * Create the hidden offscreen window for Spout video output.
 */
async function createSpoutWindow(): Promise<void> {
  const videoAvailable = await createSpoutSender({
    name: 'Merlin',
    width: spoutConfig.width,
    height: spoutConfig.height,
  });
  if (!videoAvailable) {
    console.log('Spout video sender not available, skipping spout window');
    return;
  }

  spoutWindow = new BrowserWindow({
    width: spoutConfig.width,
    height: spoutConfig.height,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: { useSharedTexture: true },
    },
  });

  // Load with ?spout=1 so the renderer mounts in spout-output mode
  // (the canvas fills the window, no sidebar / chrome).
  if (process.env.VITE_DEV_SERVER_URL) {
    spoutWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?spout=1`);
  } else {
    spoutWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { spout: '1' } });
  }

  wireWindowToSender(spoutWindow, 'Merlin', spoutConfig.frameRate);

  spoutWindow.on('closed', () => {
    spoutWindow = null;
  });

  console.log('Spout video window created');
}

/**
 * Create the hidden offscreen window for Spout mask output.
 * Intentionally dormant — re-enable by uncommenting the createMaskWindow
 * calls below (search this file for "uncommenting the createMaskWindow").
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: { useSharedTexture: true },
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    maskWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?mask=1`);
  } else {
    maskWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { mask: '1' } });
  }

  wireWindowToSender(maskWindow, 'Merlin Mask', spoutConfig.frameRate);

  maskWindow.on('closed', () => {
    maskWindow = null;
  });

  console.log('Spout mask window created');
}

// ============ IPC REGISTRATION ============

// All ipcMain.handle/on registrations live in src/main/ipc/* and are
// wired up here once. Handler bodies access shared state through the
// MainContext built above.
registerAllIPC(ctx);

// ============ APP LIFECYCLE ============

app.whenReady().then(async () => {
  console.log('=== Merlin Starting ===');

  if (!isGeminiAvailable()) {
    console.log('Gemini not available (set GEMINI_API_KEY to enable)');
  }

  // Initialize Gemini TTS
  const ttsReady = initGeminiTTS();
  if (ttsReady) {
    console.log('Gemini TTS initialized');
  } else {
    console.log('Gemini TTS not available');
  }

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

  // Create hidden Spout output window (video).
  // Mask window disabled — TD does person segmentation via NVIDIA
  // Broadcast, so we no longer publish a "Merlin Mask" Spout sender.
  // The MediaPipe-based segmenter in the renderer is also commented
  // out. Re-enable by uncommenting the createMaskWindow calls below
  // and the segmentation paths in src/renderer/mediapipe/index.ts +
  // src/renderer/main.ts.
  await createSpoutWindow();
  // await createMaskWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      await createSpoutWindow();
      // await createMaskWindow();
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
