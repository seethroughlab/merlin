import { contextBridge, ipcRenderer } from 'electron';
import type {
  TrackingFrame,
  MicroExpressionAnalysis,
  BodyLanguageAnalysis,
  BridgeStats,
  VoiceCommandResult,
  MerlinResponse,
  MerlinUIUpdate,
  TTSResult,
  TestShaderConfig,
  TestShaderResult,
  SpriteTestSpec,
  SpriteTestResult,
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

  // Get WebSocket bridge statistics
  getBridgeStats: (): Promise<BridgeStats> => {
    return ipcRenderer.invoke('get-bridge-stats');
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

  // ============ MERLIN ============

  // Start Merlin session
  merlinStart: (): Promise<MerlinResponse> => {
    return ipcRenderer.invoke('merlin-start');
  },

  // Process user speech in Merlin session
  merlinProcessSpeech: (transcript: string): Promise<MerlinResponse> => {
    return ipcRenderer.invoke('merlin-process-speech', transcript);
  },

  // End Merlin session
  merlinEnd: (): Promise<MerlinResponse> => {
    return ipcRenderer.invoke('merlin-end');
  },

  // Get Merlin session state
  merlinGetState: (): Promise<{ phase: string; turnCount: number; spell: unknown; isActive: boolean } | null> => {
    return ipcRenderer.invoke('merlin-get-state');
  },

  // Update cached analysis for Merlin
  merlinUpdateAnalysis: (data: {
    body?: Partial<BodyLanguageAnalysis>;
    face?: Partial<MicroExpressionAnalysis>;
  }) => {
    ipcRenderer.send('merlin-update-analysis', data);
  },

  // Listen for Merlin UI updates
  onMerlinUpdate: (callback: (update: MerlinUIUpdate) => void) => {
    ipcRenderer.on('merlin-update', (_event, update: MerlinUIUpdate) => {
      callback(update);
    });
  },

  // Listen for auto-end signal when Merlin session completes
  onMerlinAutoEnd: (callback: () => void) => {
    ipcRenderer.on('merlin-auto-end', () => {
      callback();
    });
  },

  // Test shader generation (Shift+T debug mode)
  merlinTestShader: (config: TestShaderConfig): Promise<TestShaderResult> => {
    return ipcRenderer.invoke('merlin-test-shader', config);
  },

  // Test sprite generation - direct spec (Shift+T Sprites tab)
  merlinTestSpriteDirect: (spec: SpriteTestSpec): Promise<SpriteTestResult> => {
    return ipcRenderer.invoke('merlin-test-sprite-direct', spec);
  },

  // Test sprite generation - Gemini-interpretation mode
  merlinTestSpriteGemini: (prompt: string): Promise<SpriteTestResult> => {
    return ipcRenderer.invoke('merlin-test-sprite-gemini', prompt);
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

  // ============ TD BRIDGE ============

  // Get TD connection status
  tdGetStatus: (): Promise<{ connected: boolean; ready: boolean; capabilities: unknown }> => {
    return ipcRenderer.invoke('td-get-status');
  },

  // Push mood update to TD
  tdPushMood: (mood: string, color?: string, intensity?: number) => {
    ipcRenderer.send('td-push-mood', { mood, color, intensity });
  },

  // Push scene parameters to TD
  tdPushScene: (params: {
    particle_intensity?: string;
    particle_behavior?: string;
    particle_color?: string;
    aura_color?: string;
    aura_size?: number;
    background_mood?: string;
  }) => {
    ipcRenderer.send('td-push-scene', params);
  },

  // Push reveal effect to TD
  tdPushReveal: (effect_type: string, intensity: number, duration: number, landmark?: number) => {
    ipcRenderer.send('td-push-reveal', { effect_type, intensity, duration, landmark });
  },

  // Listen for TD status changes
  onTDStatus: (callback: (status: { connected: boolean; ready: boolean; capabilities?: unknown }) => void) => {
    ipcRenderer.on('td-status', (_event, status) => {
      callback(status);
    });
    return () => ipcRenderer.removeAllListeners('td-status');
  },

  // Listen for zone compile results
  onZoneCompileResult: (callback: (result: { zone: string; success: boolean; error?: string }) => void) => {
    ipcRenderer.on('zone-compile-result', (_event, result) => {
      callback(result);
    });
    return () => ipcRenderer.removeAllListeners('zone-compile-result');
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
      getBridgeStats: () => Promise<BridgeStats>;
      getSettings: () => Promise<Record<string, unknown>>;
      saveSetting: (key: string, value: unknown) => Promise<boolean>;
      setPortraitMode: (portrait: boolean) => void;
      onPortraitModeChanged: (callback: (portrait: boolean) => void) => void;
      // Analysis requests
      onRequestAnalysis: (callback: (data: { type: 'face' | 'body'; requestId: string }) => void) => void;
      sendAnalysisResult: (requestId: string, result: unknown) => void;
      // Merlin
      merlinStart: () => Promise<MerlinResponse>;
      merlinProcessSpeech: (transcript: string) => Promise<MerlinResponse>;
      merlinEnd: () => Promise<MerlinResponse>;
      merlinGetState: () => Promise<{ phase: string; turnCount: number; spell: unknown; isActive: boolean } | null>;
      merlinUpdateAnalysis: (data: {
        body?: Partial<BodyLanguageAnalysis>;
        face?: Partial<MicroExpressionAnalysis>;
      }) => void;
      onMerlinUpdate: (callback: (update: MerlinUIUpdate) => void) => void;
      onMerlinAutoEnd: (callback: () => void) => void;
      merlinTestShader: (config: TestShaderConfig) => Promise<TestShaderResult>;
      merlinTestSpriteDirect: (spec: SpriteTestSpec) => Promise<SpriteTestResult>;
      merlinTestSpriteGemini: (prompt: string) => Promise<SpriteTestResult>;
      // TTS
      generateSpeech: (text: string, mood?: string) => Promise<TTSResult>;
      streamSpeech: (text: string, mood?: string) => void;
      onTTSAudioChunk: (callback: (chunk: { audioBase64: string; sampleRate: number; channels: number }) => void) => void;
      onTTSComplete: (callback: () => void) => void;
      // TD Bridge
      tdGetStatus: () => Promise<{ connected: boolean; ready: boolean; capabilities: unknown }>;
      tdPushMood: (mood: string, color?: string, intensity?: number) => void;
      tdPushScene: (params: {
        particle_intensity?: string;
        particle_behavior?: string;
        particle_color?: string;
        aura_color?: string;
        aura_size?: number;
        background_mood?: string;
      }) => void;
      tdPushReveal: (effect_type: string, intensity: number, duration: number, landmark?: number) => void;
      onTDStatus: (callback: (status: { connected: boolean; ready: boolean; capabilities?: unknown }) => void) => () => void;
      onZoneCompileResult: (callback: (result: { zone: string; success: boolean; error?: string }) => void) => () => void;
      platform: NodeJS.Platform;
    };
  }
}
