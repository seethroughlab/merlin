/**
 * TTS Module - Gemini TTS
 *
 * High-quality text-to-speech using Google Gemini TTS API.
 * Supports both batch mode (waits for full audio) and streaming mode (plays chunks as received).
 */

import type { TTSResult } from '../../shared/types';

// State
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let isCurrentlySpeaking = false;
let useStreamingMode = true; // Enable streaming via Gemini Live API

// Streaming state
let streamingQueue: AudioBuffer[] = [];
let isStreamingActive = false;
let streamingResolve: (() => void) | null = null;
let nextPlayTime = 0;

// Callbacks
let onSpeakingChange: ((speaking: boolean) => void) | null = null;
let statusCallback: ((status: TTSStatus) => void) | null = null;

export interface TTSStatus {
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'speaking' | 'error';
  message: string;
}

/**
 * Initialize TTS (creates Web Audio context)
 * @returns true if successful
 */
export async function initTTS(): Promise<boolean> {
  updateStatus({ state: 'loading', message: 'Initializing Gemini TTS...' });

  try {
    // Create audio context (will be resumed on first user interaction)
    audioContext = new AudioContext({ sampleRate: 24000 });

    console.log('Gemini TTS initialized (Web Audio API ready)');
    updateStatus({ state: 'ready', message: 'TTS ready' });
    return true;
  } catch (error) {
    console.error('Failed to initialize TTS:', error);
    updateStatus({ state: 'error', message: `TTS init failed: ${error}` });
    return false;
  }
}

/**
 * Check if TTS is ready
 */
export function isTTSReady(): boolean {
  return audioContext !== null;
}

/**
 * Check if currently speaking
 */
export function isSpeaking(): boolean {
  return isCurrentlySpeaking;
}

/**
 * Convert base64 PCM to AudioBuffer
 */
function pcmToAudioBuffer(
  base64Data: string,
  sampleRate: number,
  channels: number
): AudioBuffer {
  // Decode base64 to binary
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Convert to Int16 samples (PCM 16-bit)
  const int16Array = new Int16Array(bytes.buffer);

  // Create AudioBuffer
  const numSamples = int16Array.length;
  const audioBuffer = audioContext!.createBuffer(channels, numSamples, sampleRate);
  const channelData = audioBuffer.getChannelData(0);

  // Convert Int16 to Float32 (-1 to 1)
  for (let i = 0; i < numSamples; i++) {
    channelData[i] = int16Array[i] / 32768;
  }

  return audioBuffer;
}

/**
 * Play an AudioBuffer
 */
function playAudioBuffer(buffer: AudioBuffer): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) {
      resolve();
      return;
    }

    // Resume audio context if suspended (required for autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    // Create source node
    currentSource = audioContext.createBufferSource();
    currentSource.buffer = buffer;
    currentSource.connect(audioContext.destination);

    currentSource.onended = () => {
      currentSource = null;
      isCurrentlySpeaking = false;
      notifySpeakingChange(false);
      updateStatus({ state: 'ready', message: 'TTS ready' });
      resolve();
    };

    isCurrentlySpeaking = true;
    notifySpeakingChange(true);
    currentSource.start();
  });
}

/**
 * Speak text aloud using Gemini TTS
 * @param text Text to speak
 * @param mood Merlin mood for voice selection (mysterious, warm, tension, revelation, contemplative)
 * @returns Promise that resolves when speech completes
 */
export async function speak(
  text: string,
  mood: string = 'mysterious'
): Promise<void> {
  if (!audioContext) {
    console.error('TTS not initialized');
    return;
  }

  if (!window.electronAPI) {
    console.error('Electron API not available');
    return;
  }

  // Stop any current speech
  stop();

  try {
    updateStatus({ state: 'generating', message: 'Generating speech...' });
    const startTime = Date.now();
    const timestamp = new Date().toISOString().slice(11, 23);
    console.log(`[TTS ${timestamp}] Speaking with mood "${mood}": "${text.slice(0, 50)}..."`);

    // Generate speech via main process
    const result: TTSResult = await window.electronAPI.generateSpeech(text, mood);

    // Convert PCM to AudioBuffer
    const audioBuffer = pcmToAudioBuffer(
      result.audioBase64,
      result.sampleRate,
      result.channels
    );

    const playTimestamp = new Date().toISOString().slice(11, 23);
    console.log(`[TTS ${playTimestamp}] Playing ${audioBuffer.duration.toFixed(1)}s of audio (generated in ${Date.now() - startTime}ms)`);
    updateStatus({ state: 'speaking', message: 'Speaking...' });

    // Play the audio
    await playAudioBuffer(audioBuffer);

  } catch (error) {
    console.error('TTS speak error:', error);
    isCurrentlySpeaking = false;
    notifySpeakingChange(false);
    updateStatus({ state: 'error', message: `TTS error: ${error}` });
  }
}

/**
 * Stop current speech
 */
export function stop(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // Ignore errors if already stopped
    }
    currentSource = null;
  }
  isCurrentlySpeaking = false;
  notifySpeakingChange(false);
}

/**
 * Register callback for speaking state changes
 */
export function onSpeakingStateChange(callback: (speaking: boolean) => void): void {
  onSpeakingChange = callback;
}

/**
 * Close and cleanup TTS
 */
export function closeTTS(): void {
  stop();
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  console.log('TTS closed');
}

// --- Internal functions ---

function updateStatus(status: TTSStatus): void {
  if (statusCallback) {
    statusCallback(status);
  }
}

function notifySpeakingChange(speaking: boolean): void {
  if (onSpeakingChange) {
    onSpeakingChange(speaking);
  }
}

/**
 * Register status change callback
 */
export function onTTSStatus(callback: (status: TTSStatus) => void): void {
  statusCallback = callback;
}

// ============ STREAMING MODE ============

/**
 * Set whether to use streaming mode (Live API) or batch mode
 */
export function setStreamingMode(enabled: boolean): void {
  useStreamingMode = enabled;
}

/**
 * Initialize streaming TTS listeners
 */
export function initStreamingTTS(): void {
  if (!window.electronAPI) return;

  // Listen for audio chunks from Live API
  window.electronAPI.onTTSAudioChunk((chunk) => {
    if (!audioContext) return;

    const timestamp = new Date().toISOString().slice(11, 23);

    // First chunk - start speaking
    if (!isStreamingActive) {
      isStreamingActive = true;
      isCurrentlySpeaking = true;
      notifySpeakingChange(true);
      updateStatus({ state: 'speaking', message: 'Speaking (streaming)...' });
      nextPlayTime = audioContext.currentTime;
      console.log(`[TTS ${timestamp}] First audio chunk received - starting playback`);
    }

    // Convert chunk to AudioBuffer and queue for playback
    const audioBuffer = pcmToAudioBuffer(chunk.audioBase64, chunk.sampleRate, 1);
    playStreamingChunk(audioBuffer);
  });

  // Listen for completion
  window.electronAPI.onTTSComplete(() => {
    const timestamp = new Date().toISOString().slice(11, 23);
    console.log(`[TTS ${timestamp}] Stream complete`);

    // Wait for all queued audio to finish, then resolve
    if (audioContext && nextPlayTime > audioContext.currentTime) {
      const remainingTime = (nextPlayTime - audioContext.currentTime) * 1000;
      setTimeout(() => {
        finishStreaming();
      }, remainingTime);
    } else {
      finishStreaming();
    }
  });

  console.log('Streaming TTS initialized');
}

/**
 * Play a single audio chunk in the stream
 */
function playStreamingChunk(buffer: AudioBuffer): void {
  if (!audioContext) return;

  // Resume audio context if suspended
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  // Schedule this chunk to play after previous chunks
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  // Schedule playback
  const startTime = Math.max(nextPlayTime, audioContext.currentTime);
  source.start(startTime);

  // Update next play time
  nextPlayTime = startTime + buffer.duration;
}

/**
 * Finish streaming playback
 */
function finishStreaming(): void {
  isStreamingActive = false;
  isCurrentlySpeaking = false;
  notifySpeakingChange(false);
  updateStatus({ state: 'ready', message: 'TTS ready' });
  streamingQueue = [];

  if (streamingResolve) {
    streamingResolve();
    streamingResolve = null;
  }
}

/**
 * Speak text using streaming mode (Live API)
 */
export async function speakStreaming(text: string, mood: string = 'mysterious'): Promise<void> {
  if (!audioContext) {
    console.error('TTS not initialized');
    return;
  }

  if (!window.electronAPI) {
    console.error('Electron API not available');
    return;
  }

  // IMPORTANT: do NOT call stopStreaming() here. The chunk path (initial
  // Gemini text during tool dispatch) and the spokenText path (post-tool
  // remainder) both call this function for the SAME logical turn. If we
  // stopped on the second call we'd reset nextPlayTime to 0 — already-
  // scheduled AudioBufferSourceNodes from the chunk keep playing
  // unconditionally (Web Audio fires once .start() is called), so the
  // new schedule overlaps the old: two voices on top of each other.
  // Letting nextPlayTime carry forward makes the remainder's chunks
  // queue cleanly after the chunk's last buffer.
  //
  // Callers that genuinely want to interrupt speech should call
  // stopStreaming() explicitly first (e.g., closeTTS, stopMerlinMode).

  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[TTS ${timestamp}] Requesting streaming speech with mood "${mood}": "${text.slice(0, 50)}..."`);

  updateStatus({ state: 'generating', message: 'Generating speech (streaming)...' });

  // Request streaming speech
  window.electronAPI.streamSpeech(text, mood);

  // Return a promise that resolves when speech completes
  return new Promise((resolve) => {
    streamingResolve = resolve;
  });
}

/**
 * Stop streaming playback
 */
export function stopStreaming(): void {
  isStreamingActive = false;
  streamingQueue = [];
  nextPlayTime = 0;

  if (streamingResolve) {
    streamingResolve();
    streamingResolve = null;
  }
}

/**
 * Check if streaming mode is enabled
 */
export function isStreamingEnabled(): boolean {
  return useStreamingMode;
}
