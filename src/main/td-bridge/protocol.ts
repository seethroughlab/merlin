/**
 * TD Bridge Protocol
 *
 * Handles parsing and dispatching of inbound messages from TouchDesigner.
 */

import type { TDInboundMessage, TDBridgeState, TDBridgeCallbacks } from './types';

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
      break;

    case 'metrics':
      callbacks.onMetrics?.({
        fps: message.fps,
        particle_count: message.particle_count,
        coverage: message.coverage,
      });
      break;

    case 'pong':
      // Heartbeat acknowledged - no action needed
      break;

    default:
      console.log(`[TDBridge ${ts()}] Unknown message type:`, (message as { type: string }).type);
  }
}
