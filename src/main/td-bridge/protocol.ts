/**
 * TD Bridge Protocol
 *
 * Handles parsing and dispatching of inbound messages from TouchDesigner.
 */

import type { TDInboundMessage, TDBridgeState, TDBridgeCallbacks } from './types';
import { zoneStateManager } from '../merlin/zone-state';
import { updateMetrics, updateVisibility, handleScreenshotResponse, handleSpriteLoaded } from './metrics';
import { log } from '../logger';

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
      log.info('TDBridge', 'TD ready:', message.capabilities);
      state.tdReady = true;
      state.capabilities = message.capabilities;
      callbacks.onReady?.(message.capabilities);
      break;

    case 'compile_result':
      if (message.success) {
        log.info('TDBridge', `Zone "${message.zone}" compiled`);
      } else {
        log.error('TDBridge', `Zone "${message.zone}" failed:`, message.error);
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
        ...(typeof message.render_vs_webcam_diff === 'number'
          ? { render_vs_webcam_diff: message.render_vs_webcam_diff }
          : {}),
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

    case 'sprite_loaded':
      // TD confirms a sprite_texture push was received and applied
      // (texture cooked, sprite_switch flipped). Resolve any waiter
      // (so generate_sprite doesn't return until the GPU has the new
      // texture), and call the UI callback.
      if (!message.success) {
        log.warn(
          'TDBridge',
          `sprite_loaded reported failure for asset ${message.assetId}:`,
          message.error,
        );
      }
      handleSpriteLoaded({
        assetId: message.assetId,
        success: message.success,
        error: message.error,
      });
      callbacks.onSpriteLoaded?.({
        assetId: message.assetId,
        success: message.success,
        error: message.error,
      });
      break;

    default:
      log.info('TDBridge', 'Unknown message type:', (message as { type: string }).type);
  }
}
