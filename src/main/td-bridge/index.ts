/**
 * TD Bridge
 *
 * WebSocket bridge for communicating with TouchDesigner.
 * Parlor runs the server; TD connects as a client.
 */

// Re-export types
export * from './types';

// Re-export connection functions
export { startServer, stopServer, isConnected, isTDReady, state, send, getConnectionStats, resetReconnectCount } from './connection';

// Re-export metrics functions
export {
  getLatestMetrics,
  getAverageFps,
  getAverageParticleCount,
  getMetricsHistory,
  getLatestScreenshot,
  getLatestVisibility,
  getMetricsSummary,
  requestScreenshot,
  clearMetrics,
} from './metrics';
export type { TDMetrics, TDScreenshot, VisibilityMetrics } from './metrics';

// Re-export push methods
export {
  pushMoodUpdate,
  pushSceneParams,
  pushRevealEffect,
  pushAuraUpdate,
  pushSkeletonAugment,
  pushZoneUpdate,
  pushZoneUpdateWithValidation,
  pushOrientationUpdate,
  pushTrackingFrame,
  pushMerlinState,
  pushAnalysisUpdate,
  // Particle spell program push methods
  pushParticleSpellProgram,
  pushSpellCharge,
  pushSpellCast,
  // Sprite system push methods
  pushSpriteTexture,
  pushFlipbookConfig,
  pushRenderMode,
} from './push';

// Re-export push types
export type { MerlinStateUpdate, ZoneUpdateResult } from './push';

// Re-export insight visual functions
export {
  getPhaseVisualConfig,
  getInsightVisualEffect,
  calculateAccumulatedState,
  getAccumulatedSceneParams,
  INSIGHT_COLORS,
  MOOD_COLORS,
  PHASE_COLORS,
} from './insight-visuals';

// Re-export phase transition functions
export {
  resetVisualState,
  triggerPhaseTransition,
  applySessionStartVisuals,
  applySessionEndVisuals,
  updateVisualsForInsight,
  getCurrentVisualState,
} from './phase-transitions';

import { startServer, stopServer } from './connection';
import type { TDBridgeCallbacks } from './types';

/**
 * Initialize the TD Bridge WebSocket server
 */
export function initTDBridge(callbacks: TDBridgeCallbacks = {}): void {
  startServer(8001, callbacks);
}

/**
 * Shutdown the TD Bridge
 */
export function closeTDBridge(): void {
  stopServer();
}
