/**
 * Gemini Live API TTS Module
 *
 * Streaming text-to-speech using WebSocket connection.
 * Sends audio chunks as they're generated for low-latency playback.
 */

import WebSocket, { MessageEvent, ErrorEvent, CloseEvent } from 'ws';
import { BrowserWindow } from 'electron';

// Live API model - must use native audio model for voice selection to work
// gemini-2.5-flash-native-audio-preview-12-2025 supports 30 HD voices
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

let ws: WebSocket | null = null;
let mainWindow: BrowserWindow | null = null;
let isConnected = false;
let pendingText: string | null = null;
let currentMood: string = 'wizard';  // Default to wizard voice for Merlin
let lastActivityTime: number = 0;
let apiKeyCache: string | null = null;

// Reconnect if idle for more than 2 minutes (server times out around 5 minutes)
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

// Voice mapping for different moods
// Available Gemini voices with characteristics:
// - Gacrux: Mature (old wizard)
// - Algenib: Gravelly (wizened)
// - Sadaltager: Knowledgeable (wise)
// - Charon: Informative
// - Sulafat: Warm
const MOOD_VOICES: Record<string, string> = {
  mysterious: 'Algenib',
  revelation: 'Sadaltager',
  warm: 'Sulafat',
  contemplative: 'Algenib',
  tension: 'Algenib',
  intense: 'Algenib',
  playful: 'Puck',
  wizard: 'Algenib',       // Gravelly voice - deep, wizened
  merlin: 'Algenib',       // Merlin specifically
};

/**
 * Initialize the Live API connection
 */
export function initLiveTTS(window: BrowserWindow): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set - Live TTS disabled');
    return false;
  }

  mainWindow = window;
  apiKeyCache = apiKey;
  connect(apiKey);
  return true;
}

/**
 * Connect to Gemini Live API
 */
function connect(apiKey: string): void {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[LiveTTS ${ts()}] Connecting...`);

  // Capture socket reference locally to avoid race conditions
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    // Check if this socket is still the current one (could have been replaced)
    if (ws !== socket) {
      console.log(`[LiveTTS ${ts()}] Stale socket opened, closing`);
      socket.close();
      return;
    }

    console.log(`[LiveTTS ${ts()}] Connected`);
    isConnected = true;
    lastActivityTime = Date.now();

    // Send config message for TTS
    const voice = MOOD_VOICES[currentMood] || 'Gacrux';
    console.log(`[LiveTTS ${ts()}] Configuring with mood="${currentMood}" -> voice="${voice}" on model="${MODEL_NAME}"`);
    const configMessage = {
      setup: {
        model: `models/${MODEL_NAME}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: 'You are a text-to-speech system. Read the EXACT text given to you, word for word. Speak quickly and confidently. Do not slow down for emphasis, do not pause between sentences, do not add breathy or contemplative weight to the delivery. Fast, clean, direct.' }],
        },
      },
    };
    socket.send(JSON.stringify(configMessage));
    console.log(`[LiveTTS ${ts()}] Setup message sent:`, JSON.stringify(configMessage, null, 2).slice(0, 500));

    // If there's pending text, send it now
    if (pendingText) {
      sendTextInternal(pendingText);
      pendingText = null;
    }
  };

  socket.onmessage = (event: MessageEvent) => {
    // Ignore messages from stale sockets
    if (ws !== socket) return;

    try {
      lastActivityTime = Date.now();
      const response = JSON.parse(event.data.toString());
      console.log(`[LiveTTS ${ts()}] Received:`, JSON.stringify(response).slice(0, 200));

      // Handle errors
      if (response.error) {
        console.error(`[LiveTTS ${ts()}] API Error:`, response.error);
        return;
      }

      // Handle audio chunks
      if (response.serverContent?.modelTurn?.parts) {
        for (const part of response.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            const dataLen = part.inlineData.data.length;
            console.log(`[LiveTTS ${ts()}] Sending audio chunk (${dataLen} bytes) to renderer`);
            // Send audio chunk to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('tts-audio-chunk', {
                audioBase64: part.inlineData.data,
                sampleRate: 24000,
                channels: 1,
              });
            }
          }
        }
      }

      // Handle turn complete
      if (response.serverContent?.turnComplete) {
        console.log(`[LiveTTS ${ts()}] Turn complete`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tts-complete');
        }
      }

      // Handle setup complete
      if (response.setupComplete) {
        console.log(`[LiveTTS ${ts()}] Setup complete`);
      }
    } catch (error) {
      console.error('[LiveTTS] Parse error:', error);
    }
  };

  socket.onerror = (error: ErrorEvent) => {
    console.error(`[LiveTTS ${ts()}] Error:`, error.message);
  };

  socket.onclose = (event: CloseEvent) => {
    console.log(`[LiveTTS ${ts()}] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);

    // Only update state if this is still the current socket
    if (ws === socket) {
      isConnected = false;
      ws = null;

      // Only reconnect if it wasn't a normal closure or auth error
      if (event.code !== 1000 && event.code !== 1008) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            console.log(`[LiveTTS ${ts()}] Reconnecting...`);
            connect(apiKey);
          }
        }, 5000);
      }
    }
  };
}

/**
 * Check if connection is stale (idle too long)
 */
function isConnectionStale(): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return true;
  return Date.now() - lastActivityTime > IDLE_TIMEOUT_MS;
}

/**
 * Refresh connection if stale
 */
function refreshConnectionIfNeeded(): void {
  if (isConnectionStale() && apiKeyCache) {
    const ts = () => new Date().toISOString().slice(11, 23);
    console.log(`[LiveTTS ${ts()}] Connection stale (idle ${Math.round((Date.now() - lastActivityTime) / 1000)}s), reconnecting...`);
    if (ws) {
      ws.close();
      ws = null;
    }
    isConnected = false;
    connect(apiKeyCache);
  }
}

/**
 * Send text to generate speech (internal)
 */
function sendTextInternal(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[LiveTTS ${ts()}] Sending: "${text.slice(0, 50)}..."`);

  // Wrap text with explicit read instruction to ensure verbatim reading
  const wrappedText = `READ THIS EXACT TEXT ALOUD, WORD FOR WORD: "${text}"`;

  // Send text via realtimeInput for TTS
  const message = {
    realtimeInput: {
      text: wrappedText,
    },
  };
  ws.send(JSON.stringify(message));
  lastActivityTime = Date.now();
  console.log(`[LiveTTS ${ts()}] Message sent via realtimeInput, waiting for audio...`);
}

/**
 * Generate streaming speech from text
 */
export function streamSpeech(text: string, mood: string = 'mysterious'): boolean {
  const ts = () => new Date().toISOString().slice(11, 23);
  currentMood = mood;

  // Check for stale connection and reconnect proactively
  if (isConnectionStale()) {
    console.log(`[LiveTTS ${ts()}] Stream request for mood "${mood}"...`);
    pendingText = text;
    refreshConnectionIfNeeded();
    return false;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Queue text for when connection is ready
    pendingText = text;
    return false;
  }

  console.log(`[LiveTTS ${ts()}] Stream request for mood "${mood}"...`);
  sendTextInternal(text);
  return true;
}

/**
 * Check if Live TTS is connected
 */
export function isLiveTTSConnected(): boolean {
  return isConnected && ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Close the connection
 */
export function closeLiveTTS(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
  mainWindow = null;
}
