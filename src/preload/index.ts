import { contextBridge, ipcRenderer } from 'electron';
import type { TrackingFrame, MicroExpressionAnalysis, BodyLanguageAnalysis, OscStats } from '@shared/types';

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

  // Rename a Spout sender
  renameSpoutSender: (oldName: string, newName: string): Promise<boolean> => {
    return ipcRenderer.invoke('rename-spout-sender', oldName, newName);
  },

  // Get OSC statistics (config + send rate)
  getOscStats: (): Promise<OscStats> => {
    return ipcRenderer.invoke('get-osc-stats');
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
      renameSpoutSender: (oldName: string, newName: string) => Promise<boolean>;
      getOscStats: () => Promise<OscStats>;
      setPortraitMode: (portrait: boolean) => void;
      onPortraitModeChanged: (callback: (portrait: boolean) => void) => void;
      platform: NodeJS.Platform;
    };
  }
}
