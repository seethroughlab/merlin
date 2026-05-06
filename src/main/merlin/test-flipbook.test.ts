import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockPushFlipbookConfig } = vi.hoisted(() => ({
  mockPushFlipbookConfig: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushFlipbookConfig: mockPushFlipbookConfig,
}));

import { applyFlipbookConfig, getCurrentMirroredState } from './test-flipbook';
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
  mockPushFlipbookConfig.mockReturnValue(true);
  resetMirror();
});

describe('applyFlipbookConfig', () => {
  it('pushes the config and records into the mirror on success', () => {
    const result = applyFlipbookConfig(fullConfig);

    expect(mockPushFlipbookConfig).toHaveBeenCalledWith(fullConfig);
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.state.flipbook).toEqual(fullConfig);
    expect(result.state.lastSource).toBe('flipbook_config');
    expect(result.state.lastUpdatedAt).not.toBeNull();
  });

  it('does not record when push fails (TD disconnected)', () => {
    mockPushFlipbookConfig.mockReturnValue(false);

    const result = applyFlipbookConfig(fullConfig);

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.state.flipbook).toEqual(DEFAULT_MIRROR.flipbook);
    expect(result.state.lastUpdatedAt).toBeNull();
  });
});

describe('mirror isolation', () => {
  it('returned state is a deep copy — mutating it does not leak', () => {
    applyFlipbookConfig(fullConfig);
    const snapshot = getCurrentMirroredState();
    snapshot.flipbook.atlasCols = 99;

    const fresh = getCurrentMirroredState();
    expect(fresh.flipbook.atlasCols).toBe(fullConfig.atlasCols);
  });
});
