import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockHandleCompileResult } = vi.hoisted(() => ({
  mockHandleCompileResult: vi.fn(),
}));

vi.mock('../merlin/zone-state', () => ({
  zoneStateManager: {
    handleCompileResult: mockHandleCompileResult,
  },
}));

const { mockUpdateMetrics, mockUpdateVisibility, mockHandleScreenshotResponse, mockHandleSpriteLoaded } = vi.hoisted(() => ({
  mockUpdateMetrics: vi.fn(),
  mockUpdateVisibility: vi.fn(),
  mockHandleScreenshotResponse: vi.fn(),
  mockHandleSpriteLoaded: vi.fn(),
}));

vi.mock('./metrics', () => ({
  updateMetrics: mockUpdateMetrics,
  updateVisibility: mockUpdateVisibility,
  handleScreenshotResponse: mockHandleScreenshotResponse,
  handleSpriteLoaded: mockHandleSpriteLoaded,
}));

import { handleInbound } from './protocol';
import type { TDBridgeState, TDBridgeCallbacks, TDInboundMessage } from './types';

function freshState(): TDBridgeState {
  return {
    connected: true,
    tdReady: false,
    capabilities: null,
    lastMessageTime: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleInbound', () => {
  describe('td_ready', () => {
    it('marks state.tdReady and stores capabilities, fires onReady callback', () => {
      const state = freshState();
      const onReady = vi.fn();
      const callbacks: TDBridgeCallbacks = { onReady };
      const msg: TDInboundMessage = {
        type: 'td_ready',
        capabilities: { shadersSupported: true } as never,
      };
      handleInbound(msg, state, callbacks);
      expect(state.tdReady).toBe(true);
      expect(state.capabilities).toEqual({ shadersSupported: true });
      expect(onReady).toHaveBeenCalledWith({ shadersSupported: true });
    });
  });

  describe('compile_result', () => {
    it('routes success to zone-state and onCompileResult callback', () => {
      const onCompileResult = vi.fn();
      const msg: TDInboundMessage = {
        type: 'compile_result',
        zone: 'force_field',
        success: true,
      };
      handleInbound(msg, freshState(), { onCompileResult });
      expect(mockHandleCompileResult).toHaveBeenCalledWith('force_field', true, undefined);
      expect(onCompileResult).toHaveBeenCalledWith({
        zone: 'force_field',
        success: true,
        error: undefined,
      });
    });

    it('forwards compile failure including the error string', () => {
      const onCompileResult = vi.fn();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const msg: TDInboundMessage = {
        type: 'compile_result',
        zone: 'post_fx',
        success: false,
        error: 'undefined identifier uFoo',
      };
      handleInbound(msg, freshState(), { onCompileResult });
      expect(mockHandleCompileResult).toHaveBeenCalledWith('post_fx', false, 'undefined identifier uFoo');
      expect(onCompileResult).toHaveBeenCalledWith({
        zone: 'post_fx',
        success: false,
        error: 'undefined identifier uFoo',
      });
      expect(err).toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('persists metrics and fires onMetrics', () => {
      const onMetrics = vi.fn();
      const msg: TDInboundMessage = {
        type: 'metrics',
        fps: 58.7,
        particle_count: 12000,
        coverage: 0.34,
      };
      handleInbound(msg, freshState(), { onMetrics });
      expect(mockUpdateMetrics).toHaveBeenCalledWith({
        fps: 58.7,
        particle_count: 12000,
        coverage: 0.34,
      });
      expect(onMetrics).toHaveBeenCalledWith({
        fps: 58.7,
        particle_count: 12000,
        coverage: 0.34,
      });
    });
  });

  describe('visibility', () => {
    it('forwards all fields including optional render_vs_webcam_diff', () => {
      const msg: TDInboundMessage = {
        type: 'visibility',
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.42,
        render_vs_webcam_diff: 0.07,
      };
      handleInbound(msg, freshState(), {});
      expect(mockUpdateVisibility).toHaveBeenCalledWith({
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.42,
        render_vs_webcam_diff: 0.07,
      });
    });

    it('omits render_vs_webcam_diff when TD does not send it', () => {
      const msg: TDInboundMessage = {
        type: 'visibility',
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.42,
      };
      handleInbound(msg, freshState(), {});
      expect(mockUpdateVisibility).toHaveBeenCalledWith({
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.42,
      });
    });
  });

  describe('screenshot_result', () => {
    it('hands the screenshot to handleScreenshotResponse', () => {
      const msg: TDInboundMessage = {
        type: 'screenshot_result',
        base64: 'aGVsbG8=',
        width: 1280,
        height: 720,
      };
      handleInbound(msg, freshState(), {});
      expect(mockHandleScreenshotResponse).toHaveBeenCalledWith({
        base64: 'aGVsbG8=',
        width: 1280,
        height: 720,
      });
    });
  });

  describe('sprite_loaded', () => {
    it('forwards success to handleSpriteLoaded and onSpriteLoaded', () => {
      const onSpriteLoaded = vi.fn();
      const msg: TDInboundMessage = {
        type: 'sprite_loaded',
        assetId: 'sprite_42',
        success: true,
      };
      handleInbound(msg, freshState(), { onSpriteLoaded });
      expect(mockHandleSpriteLoaded).toHaveBeenCalledWith({
        assetId: 'sprite_42',
        success: true,
        error: undefined,
      });
      expect(onSpriteLoaded).toHaveBeenCalledWith({
        assetId: 'sprite_42',
        success: true,
        error: undefined,
      });
    });

    it('forwards failure including the error and logs a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onSpriteLoaded = vi.fn();
      const msg: TDInboundMessage = {
        type: 'sprite_loaded',
        assetId: 'sprite_99',
        success: false,
        error: 'file not found',
      };
      handleInbound(msg, freshState(), { onSpriteLoaded });
      expect(mockHandleSpriteLoaded).toHaveBeenCalledWith({
        assetId: 'sprite_99',
        success: false,
        error: 'file not found',
      });
      expect(onSpriteLoaded).toHaveBeenCalledWith({
        assetId: 'sprite_99',
        success: false,
        error: 'file not found',
      });
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('pong / sprite_reset', () => {
    it('handles pong without side effects', () => {
      handleInbound({ type: 'pong' } as TDInboundMessage, freshState(), {});
      expect(mockHandleCompileResult).not.toHaveBeenCalled();
      expect(mockUpdateMetrics).not.toHaveBeenCalled();
    });

    it('handles sprite_reset without side effects', () => {
      handleInbound({ type: 'sprite_reset' } as TDInboundMessage, freshState(), {});
      expect(mockHandleCompileResult).not.toHaveBeenCalled();
    });
  });

  describe('unknown message type', () => {
    it('logs and ignores', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      handleInbound({ type: 'something_new' } as unknown as TDInboundMessage, freshState(), {});
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('TDBridge'),
        'Unknown message type:',
        'something_new',
      );
    });
  });
});
