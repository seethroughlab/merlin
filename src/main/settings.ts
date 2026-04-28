/**
 * Settings Store
 *
 * Persists app settings using electron-store.
 * Settings are saved to the app's userData directory.
 */

import Store from 'electron-store';

/**
 * Window bounds configuration
 */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

/**
 * All persisted app settings
 */
export interface AppSettings {
  windowBounds: WindowBounds;
  // Detection toggles
  detectPose: boolean;
  detectFace: boolean;
  detectSegment: boolean;
  // Draw toggles
  drawPose: boolean;
  drawFace: boolean;
  drawSegment: boolean;
  // Camera/output
  isPortraitMode: boolean;
  spoutVideoName: string;
  spoutMaskName: string;
  // Analysis settings
  autoAnalyzeFace: boolean;
  faceAnalysisInterval: number;
  autoAnalyzeBody: boolean;
  bodyAnalysisInterval: number;
  // Device selection
  selectedCameraId?: string;
  selectedMicrophoneId?: string;
}

/**
 * Default settings
 */
const defaults: AppSettings = {
  windowBounds: {
    x: undefined,
    y: undefined,
    width: 1280,
    height: 720,
    isMaximized: false,
  },
  // Detection - all enabled by default
  detectPose: true,
  detectFace: true,
  detectSegment: true,
  // Drawing - all enabled by default
  drawPose: true,
  drawFace: true,
  drawSegment: true,
  // Camera
  isPortraitMode: false,
  spoutVideoName: 'Parlor',
  spoutMaskName: 'Parlor Mask',
  // Analysis - disabled by default
  autoAnalyzeFace: false,
  faceAnalysisInterval: 10000,
  autoAnalyzeBody: false,
  bodyAnalysisInterval: 15000,
  // Device selection - undefined means use system default
  selectedCameraId: undefined,
  selectedMicrophoneId: undefined,
};

/**
 * The settings store instance
 */
export const store = new Store<AppSettings>({
  name: 'settings',
  defaults,
});

/**
 * Get all settings as an object (for sending to renderer)
 */
export function getAllSettings(): AppSettings {
  return store.store;
}

/**
 * Update a single setting
 */
export function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): void {
  store.set(key, value);
}

/**
 * Get a single setting
 */
export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return store.get(key);
}
