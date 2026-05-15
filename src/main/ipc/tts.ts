/**
 * TTS IPC: Gemini batch generation + Live API streaming.
 *
 * `stream-speech` is one-way and renderer-driven: the renderer
 * gates on its own readiness state (ttsReady, inFlightSpeechPromise,
 * etc.) before firing each chunk so all "should we speak right now?"
 * logic stays co-located with the Web Audio scheduling and continuous-
 * listening state that depends on it.
 */

import { ipcMain } from 'electron';
import type { MainContext } from './types';
import { generateMerlinSpeech as generateSpeech, isTTSAvailable } from '../tts';
import { isLiveTTSConnected, streamSpeech } from '../tts-live';

export function registerTTSIPC(_ctx: MainContext): void {
  // Batch generation (used by paths that want the full audio buffer
  // back synchronously rather than streamed). Currently only the
  // standalone TTS test path; the live session uses stream-speech.
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
        (mood as 'mysterious' | 'warm' | 'intense' | 'playful') || 'mysterious',
      );
      const endTimestamp = new Date().toISOString().slice(11, 23);
      console.log(`[TTS ${endTimestamp}] IPC complete in ${Date.now() - startTime}ms`);
      return result;
    } catch (error) {
      console.error('[TTS] Generation failed:', error);
      throw error;
    }
  });

  // Streaming via Gemini Live API. Fire-and-forget — the renderer's
  // LiveTTS WebSocket receives audio chunks back over a separate IPC
  // channel and schedules them with Web Audio.
  ipcMain.on('stream-speech', (_event, text: string, mood?: string) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    console.log(`[LiveTTS ${timestamp}] Stream request for mood "${mood || 'mysterious'}"...`);
    if (!isLiveTTSConnected()) {
      console.log(`[LiveTTS ${timestamp}] Not connected, request will be queued`);
    }
    streamSpeech(text, mood || 'mysterious');
  });
}
