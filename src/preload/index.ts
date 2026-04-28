import { contextBridge, ipcRenderer } from 'electron';
import type {
  TrackingFrame,
  MicroExpressionAnalysis,
  BodyLanguageAnalysis,
  OscStats,
  VoiceCommandResult,
  MentalistResponse,
  MentalistUIUpdate,
  MentalistSessionInfo,
  TTSResult,
} from '@shared/types';

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Send tracking data to main process
  sendTrackingFrame: (frame: TrackingFrame) => {
    ipcRenderer.send('tracking-frame', frame);
  },

  // Analyze face strip with Gemini (micro-expressions)
  analyzeFaceStrip: (imageDataUrl: string): Promise<MicroExpressionAnalysis> => {
    return ipcRenderer.invoke('analyze-face-strip', imageDataUrl);
  },

  // Analyze skeleton strip with Gemini (body language)
  analyzeSkeletonStrip: (imageDataUrl: string): Promise<BodyLanguageAnalysis> => {
    return ipcRenderer.invoke('analyze-skeleton-strip', imageDataUrl);
  },

  // Interpret voice command with Gemini
  interpretVoiceCommand: (transcript: string): Promise<VoiceCommandResult> => {
    return ipcRenderer.invoke('interpret-voice-command', transcript);
  },

  // Rename a Spout sender
  renameSpoutSender: (oldName: string, newName: string): Promise<boolean> => {
    return ipcRenderer.invoke('rename-spout-sender', oldName, newName);
  },

  // Get OSC statistics (config + send rate)
  getOscStats: (): Promise<OscStats> => {
    return ipcRenderer.invoke('get-osc-stats');
  },

  // Get all saved settings
  getSettings: (): Promise<Record<string, unknown>> => {
    return ipcRenderer.invoke('get-settings');
  },

  // Save a single setting
  saveSetting: (key: string, value: unknown): Promise<boolean> => {
    return ipcRenderer.invoke('save-setting', key, value);
  },

  // Set portrait mode (broadcasts to all windows)
  setPortraitMode: (portrait: boolean) => {
    ipcRenderer.send('set-portrait-mode', portrait);
  },

  // Listen for portrait mode changes from other windows
  onPortraitModeChanged: (callback: (portrait: boolean) => void) => {
    ipcRenderer.on('portrait-mode-changed', (_event, portrait: boolean) => {
      callback(portrait);
    });
  },

  // ============ MENTALIST ============

  // Start mentalist session
  mentalistStart: (): Promise<MentalistResponse> => {
    return ipcRenderer.invoke('mentalist-start');
  },

  // Process user speech in mentalist session
  mentalistProcessSpeech: (transcript: string): Promise<MentalistResponse> => {
    return ipcRenderer.invoke('mentalist-process-speech', transcript);
  },

  // End mentalist session
  mentalistEnd: (): Promise<MentalistResponse> => {
    return ipcRenderer.invoke('mentalist-end');
  },

  // Get mentalist session state
  mentalistGetState: (): Promise<MentalistSessionInfo | null> => {
    return ipcRenderer.invoke('mentalist-get-state');
  },

  // Update cached analysis for mentalist
  mentalistUpdateAnalysis: (data: {
    body?: Partial<BodyLanguageAnalysis>;
    face?: Partial<MicroExpressionAnalysis>;
  }) => {
    ipcRenderer.send('mentalist-update-analysis', data);
  },

  // Listen for mentalist UI updates
  onMentalistUpdate: (callback: (update: MentalistUIUpdate) => void) => {
    ipcRenderer.on('mentalist-update', (_event, update: MentalistUIUpdate) => {
      callback(update);
    });
  },

  // Listen for analysis requests from main process (when Gemini tools need fresh data)
  onRequestAnalysis: (callback: (data: { type: 'face' | 'body'; requestId: string }) => void) => {
    ipcRenderer.on('request-analysis', (_event, data: { type: 'face' | 'body'; requestId: string }) => {
      callback(data);
    });
  },

  // Send analysis result back to main process
  sendAnalysisResult: (requestId: string, result: unknown) => {
    ipcRenderer.send('analysis-result', { requestId, result });
  },

  // Listen for auto-end signal when session completes
  onMentalistAutoEnd: (callback: () => void) => {
    ipcRenderer.on('mentalist-auto-end', () => {
      callback();
    });
  },

  // ============ TTS ============

  // Generate speech using Gemini TTS (batch mode - waits for full audio)
  generateSpeech: (text: string, mood?: string): Promise<TTSResult> => {
    return ipcRenderer.invoke('generate-speech', text, mood);
  },

  // Request streaming speech via Live API
  streamSpeech: (text: string, mood?: string) => {
    ipcRenderer.send('stream-speech', text, mood);
  },

  // Listen for streaming audio chunks
  onTTSAudioChunk: (callback: (chunk: { audioBase64: string; sampleRate: number; channels: number }) => void) => {
    ipcRenderer.on('tts-audio-chunk', (_event, chunk) => {
      callback(chunk);
    });
  },

  // Listen for TTS completion
  onTTSComplete: (callback: () => void) => {
    ipcRenderer.on('tts-complete', () => {
      callback();
    });
  },

  // Platform info
  platform: process.platform,
});

// Type declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      sendTrackingFrame: (frame: TrackingFrame) => void;
      analyzeFaceStrip: (imageDataUrl: string) => Promise<MicroExpressionAnalysis>;
      analyzeSkeletonStrip: (imageDataUrl: string) => Promise<BodyLanguageAnalysis>;
      interpretVoiceCommand: (transcript: string) => Promise<VoiceCommandResult>;
      renameSpoutSender: (oldName: string, newName: string) => Promise<boolean>;
      getOscStats: () => Promise<OscStats>;
      getSettings: () => Promise<Record<string, unknown>>;
      saveSetting: (key: string, value: unknown) => Promise<boolean>;
      setPortraitMode: (portrait: boolean) => void;
      onPortraitModeChanged: (callback: (portrait: boolean) => void) => void;
      // Mentalist
      mentalistStart: () => Promise<MentalistResponse>;
      mentalistProcessSpeech: (transcript: string) => Promise<MentalistResponse>;
      mentalistEnd: () => Promise<MentalistResponse>;
      mentalistGetState: () => Promise<MentalistSessionInfo | null>;
      mentalistUpdateAnalysis: (data: {
        body?: Partial<BodyLanguageAnalysis>;
        face?: Partial<MicroExpressionAnalysis>;
      }) => void;
      onMentalistUpdate: (callback: (update: MentalistUIUpdate) => void) => void;
      onRequestAnalysis: (callback: (data: { type: 'face' | 'body'; requestId: string }) => void) => void;
      sendAnalysisResult: (requestId: string, result: unknown) => void;
      onMentalistAutoEnd: (callback: () => void) => void;
      // TTS
      generateSpeech: (text: string, mood?: string) => Promise<TTSResult>;
      streamSpeech: (text: string, mood?: string) => void;
      onTTSAudioChunk: (callback: (chunk: { audioBase64: string; sampleRate: number; channels: number }) => void) => void;
      onTTSComplete: (callback: () => void) => void;
      platform: NodeJS.Platform;
    };
  }
}
