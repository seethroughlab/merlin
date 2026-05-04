/**
 * Whisper Voice Command Module
 *
 * Push-to-talk voice input with VAD (Voice Activity Detection).
 * Uses Transformers.js to run Whisper locally with WebGPU acceleration.
 */

import { pipeline, AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { getSelectedMicrophoneId, onMicrophoneChange } from '../devices';

// State
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;

let isRecording = false;
let isModelLoaded = false;
let isContinuousMode = false;
let isCapturingUtterance = false; // True when VAD has detected speech start

// Configuration
const SAMPLE_RATE = 16000;
let silenceThreshold = 0.025; // RMS threshold for voice detection (increased to reduce false positives)
let silenceTimeout = 1500; // ms of silence to auto-stop
let maxRecordingTime = 30000; // max recording time in ms

// Common phantom words that Whisper hallucinates from background noise
// Only filter very short/common words that are unlikely to be intentional
const PHANTOM_WORDS = new Set([
  'you', 'yes', 'bye', 'hi', 'oh', 'um', 'uh', 'ah', 'hmm',
  'yeah', 'no', 'so', 'the', 'a', 'i', 'it', 'is',
  'huh', 'mm', 'mhm', 'uh-huh',
]);

// Callbacks
let onStatusChange: ((status: VoiceStatus) => void) | null = null;
let onTranscript: ((transcript: string) => void) | null = null;
let onSpeechStart: (() => void) | null = null;

// Recording state
let audioChunks: Float32Array[] = [];
let lastVoiceTime = 0;
let silenceTimer: number | null = null;
let recordingStartTime = 0;
let maxRecordingTimer: number | null = null;

export interface VoiceStatus {
  state: 'idle' | 'loading' | 'ready' | 'listening' | 'recording' | 'processing' | 'error';
  message: string;
  isVoiceDetected?: boolean;
}

export interface VoiceConfig {
  silenceThreshold?: number;
  silenceTimeout?: number;
  maxRecordingTime?: number;
  model?: string;
}

/**
 * Initialize Whisper model with WebGPU acceleration
 */
export async function initWhisper(config?: VoiceConfig): Promise<boolean> {
  if (config?.silenceThreshold) silenceThreshold = config.silenceThreshold;
  if (config?.silenceTimeout) silenceTimeout = config.silenceTimeout;
  if (config?.maxRecordingTime) maxRecordingTime = config.maxRecordingTime;

  const modelId = config?.model || 'onnx-community/whisper-small.en';

  updateStatus({ state: 'loading', message: `Loading Whisper (${modelId.split('/').pop()})...` });

  try {
    // Check for WebGPU support
    const gpu = (navigator as any).gpu;
    const hasWebGPU = !!gpu;
    const device = hasWebGPU ? 'webgpu' : 'wasm';

    console.log(`Initializing Whisper with ${device} backend...`);

    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelId,
      { device }
    );

    isModelLoaded = true;
    console.log('Whisper initialized successfully');
    updateStatus({ state: 'ready', message: 'Voice ready (Shift+M for Merlin)' });

    // Hot-swap mic stream when user changes microphone selection
    onMicrophoneChange(() => {
      if (isContinuousMode) {
        console.log('[whisper] Mic changed; restarting continuous listener');
        restartContinuousListening();
      }
    });

    return true;
  } catch (error) {
    console.error('Failed to initialize Whisper:', error);
    updateStatus({ state: 'error', message: `Whisper load failed: ${error}` });
    return false;
  }
}

/**
 * Build audio constraints honoring the user-selected microphone.
 */
function buildMicConstraints(): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    sampleRate: SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
  };
  const micId = getSelectedMicrophoneId();
  if (micId) {
    audio.deviceId = { exact: micId };
  }
  return { audio };
}

/**
 * Restart the continuous listener with the current mic selection.
 * Safe to call when not active (no-op).
 */
async function restartContinuousListening(): Promise<void> {
  if (!isContinuousMode) return;
  const cb = onTranscript;
  stopContinuousListening();
  // Small delay to let audio context tear down before re-acquiring
  await new Promise((r) => setTimeout(r, 100));
  await startContinuousListening(cb ?? undefined);
}

/**
 * Check if Whisper model is loaded
 */
export function isWhisperReady(): boolean {
  return isModelLoaded && transcriber !== null;
}

/**
 * Start recording (push-to-talk)
 */
export async function startRecording(): Promise<boolean> {
  if (!isModelLoaded || !transcriber) {
    console.error('Whisper not initialized');
    updateStatus({ state: 'error', message: 'Whisper not loaded' });
    return false;
  }

  if (isRecording) {
    console.log('Already recording');
    return true;
  }

  try {
    // Request microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());

    // Create audio context
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Load audio worklet for processing
    const workletUrl = createAudioWorkletUrl();
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    // Create worklet node
    workletNode = new AudioWorkletNode(audioContext, 'voice-processor');

    // Connect microphone to worklet
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(workletNode);

    // Handle audio data from worklet
    workletNode.port.onmessage = (event) => {
      if (!isRecording) return;

      const { audioData, rms } = event.data;
      handleAudioChunk(new Float32Array(audioData), rms);
    };

    // Reset state
    audioChunks = [];
    lastVoiceTime = Date.now();
    recordingStartTime = Date.now();
    isRecording = true;

    updateStatus({ state: 'recording', message: 'Listening...', isVoiceDetected: false });

    // Start silence detection
    startSilenceDetection();

    // Set max recording timeout
    maxRecordingTimer = window.setTimeout(() => {
      console.log('Max recording time reached');
      stopRecording();
    }, maxRecordingTime);

    console.log('Recording started');
    return true;
  } catch (error) {
    console.error('Failed to start recording:', error);
    updateStatus({ state: 'error', message: `Mic error: ${error}` });
    return false;
  }
}

/**
 * Stop recording and transcribe
 */
export async function stopRecording(): Promise<string | null> {
  if (!isRecording) {
    return null;
  }

  isRecording = false;

  // Clear timers
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  // Disconnect audio nodes
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  // Check if we have audio
  if (audioChunks.length === 0) {
    console.log('No audio recorded');
    updateStatus({ state: 'ready', message: 'No audio captured' });
    return null;
  }

  // Combine audio chunks
  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audioData = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    audioData.set(chunk, offset);
    offset += chunk.length;
  }
  audioChunks = [];

  // Check minimum audio length (at least 0.3 seconds)
  const durationSec = audioData.length / SAMPLE_RATE;
  if (durationSec < 0.3) {
    console.log(`Audio too short: ${durationSec.toFixed(2)}s`);
    updateStatus({ state: 'ready', message: 'Too short' });
    return null;
  }

  console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Processing ${durationSec.toFixed(2)}s of audio...`);
  updateStatus({ state: 'processing', message: 'Transcribing...' });

  try {
    if (!transcriber) throw new Error('Transcriber not available');

    const result = await transcriber(audioData, {
      return_timestamps: false,
    });

    const transcript = (result as { text: string }).text.trim();
    console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Transcript: "${transcript}"`);

    // Filter out phantom words (common Whisper hallucinations from noise)
    const normalizedTranscript = transcript.toLowerCase().replace(/[.,!?]/g, '');
    const isPhantom = PHANTOM_WORDS.has(normalizedTranscript) || transcript.length < 3;

    if (isPhantom) {
      console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Ignoring phantom: "${transcript}"`);
      updateStatus({ state: 'ready', message: 'No speech detected' });
      return null;
    }

    if (transcript && onTranscript) {
      onTranscript(transcript);
    }

    updateStatus({ state: 'ready', message: transcript ? `"${transcript.slice(0, 30)}..."` : 'No speech detected' });
    return transcript || null;
  } catch (error) {
    console.error('Transcription error:', error);
    updateStatus({ state: 'error', message: `Transcription failed: ${error}` });
    return null;
  }
}

/**
 * Cancel recording without transcribing
 */
export function cancelRecording(): void {
  if (!isRecording) return;

  isRecording = false;
  audioChunks = [];

  // Clear timers
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  // Disconnect audio
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  updateStatus({ state: 'ready', message: 'Cancelled' });
  console.log('Recording cancelled');
}

/**
 * Check if currently recording
 */
export function isVoiceRecording(): boolean {
  return isRecording;
}

/**
 * Register status change callback
 */
export function onVoiceStatus(callback: (status: VoiceStatus) => void): void {
  onStatusChange = callback;
}

/**
 * Register transcript callback
 */
export function onVoiceTranscript(callback: (transcript: string) => void): void {
  onTranscript = callback;
}

/**
 * Close and cleanup
 */
export function closeWhisper(): void {
  stopContinuousListening();
  cancelRecording();
  transcriber = null;
  isModelLoaded = false;
  console.log('Whisper closed');
}

/**
 * Set the transcript callback (useful for switching between voice command mode and mentalist mode)
 */
export function setTranscriptCallback(callback: ((transcript: string) => void) | null): void {
  onTranscript = callback;
}

/**
 * Set callback for when speech starts (VAD detects voice)
 * Useful for starting analysis capture before transcript is ready
 */
export function setSpeechStartCallback(callback: (() => void) | null): void {
  onSpeechStart = callback;
}

/**
 * Start continuous listening mode with VAD
 * Automatically detects speech, records, transcribes, and restarts
 * @param transcriptCallback Optional callback to use instead of the global one
 */
export async function startContinuousListening(transcriptCallback?: (transcript: string) => void): Promise<boolean> {
  // Set transcript callback if provided
  if (transcriptCallback) {
    onTranscript = transcriptCallback;
  }
  if (!isModelLoaded || !transcriber) {
    console.error('Whisper not initialized');
    updateStatus({ state: 'error', message: 'Whisper not loaded' });
    return false;
  }

  if (isContinuousMode) {
    console.log('Already in continuous listening mode');
    return true;
  }

  try {
    // Request microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());

    // Create audio context
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Load audio worklet for processing
    const workletUrl = createAudioWorkletUrl();
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    // Create worklet node
    workletNode = new AudioWorkletNode(audioContext, 'voice-processor');

    // Connect microphone to worklet
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(workletNode);

    // Handle audio data from worklet
    workletNode.port.onmessage = (event) => {
      if (!isContinuousMode) return;

      const { audioData, rms } = event.data;
      handleContinuousAudioChunk(new Float32Array(audioData), rms);
    };

    // Initialize state
    isContinuousMode = true;
    isCapturingUtterance = false;
    audioChunks = [];

    updateStatus({ state: 'listening', message: 'Listening...', isVoiceDetected: false });
    console.log('Continuous listening started');
    return true;
  } catch (error) {
    console.error('Failed to start continuous listening:', error);
    updateStatus({ state: 'error', message: `Mic error: ${error}` });
    return false;
  }
}

/**
 * Stop continuous listening mode
 */
export function stopContinuousListening(): void {
  if (!isContinuousMode) return;

  isContinuousMode = false;
  isCapturingUtterance = false;
  audioChunks = [];

  // Clear timers
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  // Disconnect audio
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  updateStatus({ state: 'ready', message: 'Listening stopped' });
  console.log('Continuous listening stopped');
}

/**
 * Check if in continuous listening mode
 */
export function isContinuousListening(): boolean {
  return isContinuousMode;
}

// --- Internal functions ---

/**
 * Handle audio chunk in continuous listening mode
 */
function handleContinuousAudioChunk(audioData: Float32Array, rms: number): void {
  const isVoice = rms > silenceThreshold;

  if (!isCapturingUtterance) {
    // Waiting for speech to start
    if (isVoice) {
      // Speech detected - start capturing
      isCapturingUtterance = true;
      audioChunks = [audioData];
      lastVoiceTime = Date.now();
      recordingStartTime = Date.now();

      updateStatus({ state: 'recording', message: 'Recording...', isVoiceDetected: true });
      console.log(`[VAD ${new Date().toISOString().slice(11, 23)}] Speech started`);

      // Notify listeners that speech has started (for preemptive analysis capture)
      if (onSpeechStart) {
        onSpeechStart();
      }

      // Start silence detection for end of utterance
      startContinuousSilenceDetection();

      // Set max recording timeout
      maxRecordingTimer = window.setTimeout(() => {
        console.log('Max recording time reached');
        finishUtterance();
      }, maxRecordingTime);
    } else {
      // Still waiting for speech
      updateStatus({ state: 'listening', message: 'Listening...', isVoiceDetected: false });
    }
  } else {
    // Currently capturing utterance
    audioChunks.push(audioData);

    if (isVoice) {
      lastVoiceTime = Date.now();
    }

    updateStatus({
      state: 'recording',
      message: isVoice ? 'Recording...' : 'Waiting for more...',
      isVoiceDetected: isVoice,
    });
  }
}

/**
 * Start silence detection for continuous mode
 */
function startContinuousSilenceDetection(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }

  silenceTimer = window.setTimeout(() => {
    if (!isContinuousMode || !isCapturingUtterance) return;

    const silenceDuration = Date.now() - lastVoiceTime;
    const recordingDuration = Date.now() - recordingStartTime;

    // Need at least some speech and enough silence to end
    if (recordingDuration > 500 && silenceDuration >= silenceTimeout) {
      console.log(`[VAD ${new Date().toISOString().slice(11, 23)}] Speech ended after ${silenceDuration}ms of silence`);
      finishUtterance();
    } else {
      // Continue checking
      startContinuousSilenceDetection();
    }
  }, 100);
}

/**
 * Finish capturing an utterance and transcribe
 */
async function finishUtterance(): Promise<void> {
  if (!isCapturingUtterance) return;

  isCapturingUtterance = false;

  // Clear timers
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  // Check if we have audio
  if (audioChunks.length === 0) {
    console.log('No audio captured');
    if (isContinuousMode) {
      updateStatus({ state: 'listening', message: 'Listening...', isVoiceDetected: false });
    }
    return;
  }

  // Combine audio chunks
  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audioData = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    audioData.set(chunk, offset);
    offset += chunk.length;
  }
  audioChunks = [];

  // Check minimum audio length
  const durationSec = audioData.length / SAMPLE_RATE;
  if (durationSec < 0.3) {
    console.log(`Audio too short: ${durationSec.toFixed(2)}s`);
    if (isContinuousMode) {
      updateStatus({ state: 'listening', message: 'Listening...', isVoiceDetected: false });
    }
    return;
  }

  console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Processing ${durationSec.toFixed(2)}s of audio...`);
  updateStatus({ state: 'processing', message: 'Transcribing...' });

  try {
    if (!transcriber) throw new Error('Transcriber not available');

    const result = await transcriber(audioData, {
      return_timestamps: false,
    });

    const transcript = (result as { text: string }).text.trim();
    console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Transcript: "${transcript}"`);

    // Filter out phantom words (common Whisper hallucinations from noise)
    const normalizedTranscript = transcript.toLowerCase().replace(/[.,!?]/g, '');
    const isPhantom = PHANTOM_WORDS.has(normalizedTranscript) || transcript.length < 3;

    if (isPhantom) {
      console.log(`[Whisper ${new Date().toISOString().slice(11, 23)}] Ignoring phantom: "${transcript}"`);
    } else if (transcript && onTranscript) {
      onTranscript(transcript);
    }

    // Resume listening if still in continuous mode
    if (isContinuousMode) {
      updateStatus({
        state: 'listening',
        message: transcript ? `"${transcript.slice(0, 20)}..." - Listening...` : 'Listening...',
        isVoiceDetected: false,
      });
    }
  } catch (error) {
    console.error('Transcription error:', error);
    updateStatus({ state: 'error', message: `Transcription failed: ${error}` });

    // Resume listening after error if still in continuous mode
    if (isContinuousMode) {
      setTimeout(() => {
        if (isContinuousMode) {
          updateStatus({ state: 'listening', message: 'Listening...', isVoiceDetected: false });
        }
      }, 1000);
    }
  }
}

function updateStatus(status: VoiceStatus): void {
  if (onStatusChange) {
    onStatusChange(status);
  }
}

function handleAudioChunk(audioData: Float32Array, rms: number): void {
  audioChunks.push(audioData);

  const isVoice = rms > silenceThreshold;
  if (isVoice) {
    lastVoiceTime = Date.now();
  }

  // Update status with voice detection indicator
  if (isRecording) {
    updateStatus({
      state: 'recording',
      message: isVoice ? 'Listening...' : 'Waiting for voice...',
      isVoiceDetected: isVoice,
    });
  }
}

function startSilenceDetection(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }

  silenceTimer = window.setTimeout(() => {
    if (!isRecording) return;

    const silenceDuration = Date.now() - lastVoiceTime;
    const recordingDuration = Date.now() - recordingStartTime;

    // Only auto-stop if we've recorded for at least 1 second
    // and there's been enough silence
    if (recordingDuration > 1000 && silenceDuration >= silenceTimeout) {
      console.log(`Auto-stopping after ${silenceDuration}ms of silence`);
      stopRecording();
    } else {
      // Continue checking
      startSilenceDetection();
    }
  }, 100);
}

/**
 * Create a data URL for the AudioWorklet processor
 */
function createAudioWorkletUrl(): string {
  const processorCode = `
    class VoiceProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.bufferSize = 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
      }

      process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const inputData = input[0];

        // Add samples to buffer
        for (let i = 0; i < inputData.length; i++) {
          this.buffer[this.bufferIndex++] = inputData[i];

          if (this.bufferIndex >= this.bufferSize) {
            // Calculate RMS
            let sum = 0;
            for (let j = 0; j < this.bufferSize; j++) {
              sum += this.buffer[j] * this.buffer[j];
            }
            const rms = Math.sqrt(sum / this.bufferSize);

            // Send buffer to main thread
            this.port.postMessage({
              audioData: this.buffer.slice(),
              rms: rms,
            });

            this.bufferIndex = 0;
          }
        }

        return true;
      }
    }

    registerProcessor('voice-processor', VoiceProcessor);
  `;

  const blob = new Blob([processorCode], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
