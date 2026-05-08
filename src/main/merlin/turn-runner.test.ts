import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const {
  mockPushCastParams,
  mockPushParticleParams,
  mockPushSpellCast,
  mockPushMerlinState,
  mockRequestScreenshot,
  mockGetLatestMetrics,
  mockGetLatestVisibility,
  mockGetLastCompileSuccess,
  mockGetLastSpritePush,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockPushCastParams: vi.fn(() => true),
  mockPushParticleParams: vi.fn(() => true),
  mockPushSpellCast: vi.fn(() => true),
  mockPushMerlinState: vi.fn(() => true),
  mockRequestScreenshot: vi.fn(),
  mockGetLatestMetrics: vi.fn(() => ({ fps: 60, particleCount: 500, coverage: 0.4 })),
  mockGetLatestVisibility: vi.fn(() => ({
    visibleParticles: 200,
    culledParticles: 0,
    avgBrightness: 0.15,
    renderVsWebcamDiff: 0.08,
  })),
  mockGetLastCompileSuccess: vi.fn<(zone: string) => boolean>(() => true),
  mockGetLastSpritePush: vi.fn<() => {
    assetId: string;
    texturePath: string;
    description?: string;
    assetType: 'flipbook' | 'single';
    pushedAt: number;
  } | null>(() => null),
  mockReadFileSync: vi.fn(() => Buffer.from('fake-png-bytes')),
}));

vi.mock('../td-bridge', () => ({
  pushCastParams: mockPushCastParams,
  pushParticleParams: mockPushParticleParams,
  pushSpellCast: mockPushSpellCast,
  pushMerlinState: mockPushMerlinState,
  pushZoneUpdateWithValidation: vi.fn(),
}));

vi.mock('../td-bridge/connection', () => ({
  send: vi.fn(() => true),
}));

vi.mock('../td-bridge/metrics', () => ({
  requestScreenshot: mockRequestScreenshot,
  getLatestMetrics: mockGetLatestMetrics,
  getLatestVisibility: mockGetLatestVisibility,
}));

vi.mock('./zone-state', () => ({
  zoneStateManager: {
    getLastCompileSuccess: mockGetLastCompileSuccess,
  },
}));

vi.mock('./td-state-mirror', () => ({
  getLastSpritePush: mockGetLastSpritePush,
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('./gemini-events', () => ({
  emitGeminiTurn: vi.fn(),
}));

// Tiny envelope so the captureTemporalFrames sleeps don't drag tests out
// to ~1s each. Real values are tested via integration; the dispatch logic
// is what these unit tests assert.
vi.mock('./reset-td', () => ({
  BASELINE_CAST_PARAMS: { riseMs: 5, fallMs: 5, peakEnergy: 1.0 },
  BASELINE_FLIPBOOK: { atlasCols: 1, atlasRows: 1, frameCount: 1, playbackMode: 'loop', frameDuration: 0.1, driveSource: 'age' },
}));

import { dispatchToolCalls } from './turn-runner';
import type { TurnDispatchContext } from './turn-runner';
import type { MerlinToolCall } from './types';

// set_cast_params doesn't read from session state, so a minimal cast keeps
// this test focused on dispatch + push wiring.
function makeCtx(): TurnDispatchContext {
  return { state: {} as TurnDispatchContext['state'] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPushCastParams.mockReturnValue(true);
  mockPushParticleParams.mockReturnValue(true);
  mockPushSpellCast.mockReturnValue(true);
  mockPushMerlinState.mockReturnValue(true);
  mockGetLastCompileSuccess.mockReturnValue(true);
  mockGetLastSpritePush.mockReturnValue(null);
  mockRequestScreenshot.mockImplementation(async () => ({
    base64: 'fakebase64',
    width: 1280,
    height: 720,
  }));
});

describe('dispatchToolCalls — set_cast_params', () => {
  it('forwards args verbatim to pushCastParams and returns success', async () => {
    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 150, fallMs: 2000, peakEnergy: 0.7 },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-1', 'live', new Map());

    expect(mockPushCastParams).toHaveBeenCalledWith({
      riseMs: 150,
      fallMs: 2000,
      peakEnergy: 0.7,
    });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      name: 'set_cast_params',
      response: { success: true, params: { riseMs: 150, fallMs: 2000, peakEnergy: 0.7 } },
    });
  });

  it('passes through partial args (only riseMs)', async () => {
    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 800 },
    };

    await dispatchToolCalls([call], makeCtx(), 'turn-2', 'live', new Map());

    expect(mockPushCastParams).toHaveBeenCalledWith({ riseMs: 800 });
  });

  it('reports failure when push returns false (TD disconnected)', async () => {
    mockPushCastParams.mockReturnValue(false);

    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 600 },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-3', 'live', new Map());

    expect(result.toolResults[0].response).toMatchObject({
      success: false,
      error: expect.stringMatching(/not connected/i),
    });
  });
});

describe('dispatchToolCalls — request_visual_feedback', () => {
  /**
   * Helper: dispatch the tool call. The mock for ./reset-td shrinks
   * BASELINE_CAST_PARAMS to riseMs/fallMs ≈ 5ms each, so the helper's
   * two sleeps total ~7.5ms — fast enough to use real timers without
   * test bloat (no fake-timer / dynamic-import pitfalls).
   */
  async function dispatchAndDrainTimers(call: MerlinToolCall, turnId: string) {
    return dispatchToolCalls([call], makeCtx(), turnId, 'live', new Map());
  }

  it('captures 3 frames in order (idle, peak, afterglow)', async () => {
    const call: MerlinToolCall = {
      name: 'request_visual_feedback',
      args: { intent: 'fire rising in spirals' },
    };

    const result = await dispatchAndDrainTimers(call, 'turn-rvf-1');

    expect(mockRequestScreenshot).toHaveBeenCalledTimes(3);
    expect(result.extraImages).toHaveLength(3);
    expect(result.toolResults).toHaveLength(1);
    const response = result.toolResults[0].response as {
      success: boolean;
      frames: Record<string, { width: number; height: number }>;
    };
    expect(response.success).toBe(true);
    expect(Object.keys(response.frames)).toEqual(['idle', 'peak', 'afterglow']);
  });

  it('fires pushCastParams + pushSpellCast before the peak frame, pushMerlinState before afterglow', async () => {
    const call: MerlinToolCall = {
      name: 'request_visual_feedback',
      args: { intent: 'crystalline shield' },
    };

    await dispatchAndDrainTimers(call, 'turn-rvf-2');

    // Cast envelope forced to BASELINE_CAST_PARAMS — values come from
    // the mocked reset-td module (tiny envelope for fast tests).
    expect(mockPushCastParams).toHaveBeenCalledWith(
      expect.objectContaining({ peakEnergy: 1.0 }),
    );
    // Cast triggered (mode_float=1.0 in TD)
    expect(mockPushSpellCast).toHaveBeenCalledTimes(1);
    // Idle restore (mode_float=-1.0) before afterglow
    expect(mockPushMerlinState).toHaveBeenCalledWith({ active: true, phase: 'idle' });
  });

  it('refuses ALL captures when any zone has lastCompileSuccess === false', async () => {
    mockGetLastCompileSuccess.mockImplementation((zone: string) =>
      zone === 'force_field' ? false : true
    );
    const call: MerlinToolCall = {
      name: 'request_visual_feedback',
      args: { intent: 'fire' },
    };

    const result = await dispatchAndDrainTimers(call, 'turn-rvf-3');

    expect(mockRequestScreenshot).not.toHaveBeenCalled();
    expect(mockPushSpellCast).not.toHaveBeenCalled();
    expect(result.toolResults[0].response).toMatchObject({
      success: false,
      error: expect.stringMatching(/force_field/),
    });
  });

  it('attaches active sprite as a fourth inline image when one is recorded', async () => {
    mockGetLastSpritePush.mockReturnValue({
      assetId: 'sprite-uuid',
      texturePath: '/fake/sprite.png',
      description: 'glowing ember',
      assetType: 'flipbook',
      pushedAt: Date.now(),
    });
    const call: MerlinToolCall = {
      name: 'request_visual_feedback',
      args: { intent: 'fire' },
    };

    const result = await dispatchAndDrainTimers(call, 'turn-rvf-4');

    expect(result.extraImages).toHaveLength(4); // 3 frames + 1 sprite
    const response = result.toolResults[0].response as {
      active_sprite: { description: string; assetType: string } | null;
    };
    expect(response.active_sprite).toMatchObject({
      description: 'glowing ember',
      assetType: 'flipbook',
    });
  });

  it('returns failure if all 3 screenshot calls timeout', async () => {
    mockRequestScreenshot.mockResolvedValue(null);
    const call: MerlinToolCall = {
      name: 'request_visual_feedback',
      args: { intent: 'fire' },
    };

    const result = await dispatchAndDrainTimers(call, 'turn-rvf-5');

    expect(result.toolResults[0].response).toMatchObject({
      success: false,
      error: expect.stringMatching(/timed out/i),
    });
  });
});

describe('dispatchToolCalls — set_particle_params', () => {
  it('forwards args verbatim to pushParticleParams and returns success', async () => {
    const call: MerlinToolCall = {
      name: 'set_particle_params',
      args: {
        maxCount: 1500,
        lifespan: 6.0,
        emitRate: 250,
        spawnRadius: 0.35,
        blendMode: 'alpha',
      },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-pp-1', 'live', new Map());

    expect(mockPushParticleParams).toHaveBeenCalledWith({
      maxCount: 1500,
      lifespan: 6.0,
      emitRate: 250,
      spawnRadius: 0.35,
      blendMode: 'alpha',
    });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      name: 'set_particle_params',
      response: {
        success: true,
        params: { maxCount: 1500, blendMode: 'alpha' },
      },
    });
  });

  it('passes through partial args (only blendMode)', async () => {
    const call: MerlinToolCall = {
      name: 'set_particle_params',
      args: { blendMode: 'alpha' },
    };

    await dispatchToolCalls([call], makeCtx(), 'turn-pp-2', 'live', new Map());

    expect(mockPushParticleParams).toHaveBeenCalledWith({ blendMode: 'alpha' });
  });

  it('reports failure when push returns false (TD disconnected)', async () => {
    mockPushParticleParams.mockReturnValue(false);

    const call: MerlinToolCall = {
      name: 'set_particle_params',
      args: { maxCount: 200 },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-pp-3', 'live', new Map());

    expect(result.toolResults[0].response).toMatchObject({
      success: false,
      error: expect.stringMatching(/not connected/i),
    });
  });
});
