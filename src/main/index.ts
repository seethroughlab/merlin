import { config } from 'dotenv';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { initOsc, sendTrackingFrame, closeOsc, getOscStats } from './osc';
import { createSpoutSender, wireWindowToSender, closeSpout, resizeSpoutSender } from './spout';
import { initGemini, analyzeMicroExpressions, analyzeBodyLanguage, isGeminiAvailable } from './gemini';
import type { TrackingFrame } from '../shared/types';

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

/**
 * Create the main visible preview window
 */
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Parlor - Preview',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // In development, load from Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

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

app.whenReady().then(async () => {
  console.log('=== Parlor Starting ===');

  // Initialize Gemini (for LLM analysis)
  const geminiReady = initGemini();
  if (geminiReady) {
    console.log('Gemini initialized');
  } else {
    console.log('Gemini not available (set GEMINI_API_KEY to enable)');
  }

  // Initialize OSC
  initOsc(oscConfig);
  console.log('OSC initialized');

  // Create visible preview window
  createMainWindow();
  console.log('Preview window created');

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
});
