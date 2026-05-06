/**
 * TD Bridge Protocol
 *
 * Handles parsing and dispatching of inbound messages from TouchDesigner.
 */

import type { TDInboundMessage, TDBridgeState, TDBridgeCallbacks } from './types';
import { zoneStateManager } from '../merlin/zone-state';
import { updateMetrics, updateVisibility, handleScreenshotResponse } from './metrics';

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Handle an inbound message from TouchDesigner
 */
export function handleInbound(
  message: TDInboundMessage,
  state: TDBridgeState,
  callbacks: TDBridgeCallbacks
): void {
  switch (message.type) {
    case 'td_ready':
      console.log(`[TDBridge ${ts()}] TD ready:`, message.capabilities);
      state.tdReady = true;
      state.capabilities = message.capabilities;
      callbacks.onReady?.(message.capabilities);
      break;

    case 'compile_result':
      if (message.success) {
        console.log(`[TDBridge ${ts()}] Zone "${message.zone}" compiled`);
      } else {
        console.error(`[TDBridge ${ts()}] Zone "${message.zone}" failed:`, message.error);
      }
      // Update zone state manager
      zoneStateManager.handleCompileResult(message.zone, message.success, message.error);
      // Notify callback for UI updates
      callbacks.onCompileResult?.({
        zone: message.zone,
        success: message.success,
        error: message.error,
      });
      break;

    case 'metrics':
      // Store metrics in metrics module
      updateMetrics({
        fps: message.fps,
        particle_count: message.particle_count,
        coverage: message.coverage,
      });
      // Also call callback for UI updates
      callbacks.onMetrics?.({
        fps: message.fps,
        particle_count: message.particle_count,
        coverage: message.coverage,
      });
      break;

    case 'visibility':
      // Store visibility metrics
      updateVisibility({
        visible_particles: message.visible_particles,
        culled_particles: message.culled_particles,
        avg_brightness: message.avg_brightness,
      });
      break;

    case 'screenshot_result':
      // Handle screenshot response
      handleScreenshotResponse({
        base64: message.base64,
        width: message.width,
        height: message.height,
      });
      break;

    case 'pong':
      // Heartbeat acknowledged - no action needed
      break;

    case 'sprite_reset':
      // TD acknowledges a reset_sprite — no action needed; the
      // sidebar already shows the reset outcome.
      break;

    default:
      console.log(`[TDBridge ${ts()}] Unknown message type:`, (message as { type: string }).type);
  }
}
