/**
 * TD Bridge
 *
 * WebSocket bridge for communicating with TouchDesigner.
 * Parlor runs the server; TD connects as a client.
 */

// Re-export types
export * from './types';

// Re-export connection functions
export { startServer, stopServer, isConnected, isTDReady, state, send } from './connection';

// Re-export push methods
export {
  pushMoodUpdate,
  pushSceneParams,
  pushRevealEffect,
  pushAuraUpdate,
  pushSkeletonAugment,
} from './push';

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
