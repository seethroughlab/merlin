import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockPushRenderMode, mockPushFlipbookConfig } = vi.hoisted(() => ({
  mockPushRenderMode: vi.fn(() => true),
  mockPushFlipbookConfig: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushRenderMode: mockPushRenderMode,
  pushFlipbookConfig: mockPushFlipbookConfig,
}));

import {
  setRenderMode,
  applyFlipbookConfig,
  getCurrentMirroredState,
} from './test-render-mode';
import { resetMirror, DEFAULT_MIRROR } from './td-state-mirror';
import type { SpriteFlipbookConfig } from '../../shared/types';

const fullConfig: SpriteFlipbookConfig = {
  atlasCols: 4,
  atlasRows: 4,
  frameCount: 16,
  playbackMode: 'pingpong',
  frameDuration: 0.05,
  driveSource: 'time',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPushRenderMode.mockReturnValue(true);
  mockPushFlipbookConfig.mockReturnValue(true);
  resetMirror();
});

describe('setRenderMode', () => {
  it('pushes the mode and records into the mirror on success', () => {
    const result = setRenderMode('billboard');

    expect(mockPushRenderMode).toHaveBeenCalledWith('billboard');
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.state.renderMode).toBe('billboard');
    expect(result.state.lastSource).toBe('render_mode');
    expect(result.state.lastUpdatedAt).not.toBeNull();
  });

  it('does not record into the mirror when push fails (TD disconnected)', () => {
    mockPushRenderMode.mockReturnValue(false);

    const result = setRenderMode('billboard');

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.state.renderMode).toBe(DEFAULT_MIRROR.renderMode);
    expect(result.state.lastUpdatedAt).toBeNull();
  });
});

describe('applyFlipbookConfig', () => {
  it('pushes the config and records into the mirror on success', () => {
    const result = applyFlipbookConfig(fullConfig);

    expect(mockPushFlipbookConfig).toHaveBeenCalledWith(fullConfig);
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.state.flipbook).toEqual(fullConfig);
    expect(result.state.lastSource).toBe('flipbook_config');
  });

  it('does not record when push fails', () => {
    mockPushFlipbookConfig.mockReturnValue(false);

    const result = applyFlipbookConfig(fullConfig);

    expect(result.pushed).toBe(false);
    expect(result.state.flipbook).toEqual(DEFAULT_MIRROR.flipbook);
    expect(result.state.lastUpdatedAt).toBeNull();
  });
});

describe('mirror isolation', () => {
  it('returned state is a deep copy — mutating it does not leak', () => {
    setRenderMode('billboard');
    const snapshot = getCurrentMirroredState();
    snapshot.renderMode = 'mesh';
    snapshot.flipbook.atlasCols = 99;

    const fresh = getCurrentMirroredState();
    expect(fresh.renderMode).toBe('billboard');
    expect(fresh.flipbook.atlasCols).toBe(DEFAULT_MIRROR.flipbook.atlasCols);
  });

  it('flipbook push then render-mode push: both fields reflected, last_source is render_mode', () => {
    applyFlipbookConfig(fullConfig);
    setRenderMode('billboard');

    const state = getCurrentMirroredState();
    expect(state.flipbook).toEqual(fullConfig);
    expect(state.renderMode).toBe('billboard');
    expect(state.lastSource).toBe('render_mode');
  });
});
