import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const {
  mockPushZoneUpdateWithValidation,
  mockPushFlipbookConfig,
  mockPushRenderMode,
  mockPushResetSprite,
  mockPushParticleSpellProgram,
} = vi.hoisted(() => ({
  mockPushZoneUpdateWithValidation: vi.fn<(zone: string, code: string) => Promise<{ success: boolean; error?: string }>>(() =>
    Promise.resolve({ success: true })
  ),
  mockPushFlipbookConfig: vi.fn(() => true),
  mockPushRenderMode: vi.fn(() => true),
  mockPushResetSprite: vi.fn(() => true),
  mockPushParticleSpellProgram: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushZoneUpdateWithValidation: mockPushZoneUpdateWithValidation,
  pushFlipbookConfig: mockPushFlipbookConfig,
  pushRenderMode: mockPushRenderMode,
  pushResetSprite: mockPushResetSprite,
  pushParticleSpellProgram: mockPushParticleSpellProgram,
}));

const { mockCreateIdleProgram } = vi.hoisted(() => ({
  mockCreateIdleProgram: vi.fn(() => ({ archetype: 'breathing_aura_mist', mode: 'idle', energy: 0.1 })),
}));

vi.mock('./particle-program', () => ({
  createIdleProgram: mockCreateIdleProgram,
}));

const ALL_ZONES = [
  'force_field',
  'color_over_life',
  'size_over_life',
  'spawn_behavior',
  'velocity_modifier',
  'post_fx',
  'material_pixel',
  'billboard_pixel',
  'billboard_vertex',
];

vi.mock('./test-shader', () => ({
  getMarkerBearingZones: () => ALL_ZONES,
}));

const { mockRecordRenderModePush, mockRecordFlipbookConfigPush } = vi.hoisted(() => ({
  mockRecordRenderModePush: vi.fn(),
  mockRecordFlipbookConfigPush: vi.fn(),
}));

vi.mock('./td-state-mirror', () => ({
  recordRenderModePush: mockRecordRenderModePush,
  recordFlipbookConfigPush: mockRecordFlipbookConfigPush,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPushZoneUpdateWithValidation.mockResolvedValue({ success: true });
  mockPushFlipbookConfig.mockReturnValue(true);
  mockPushRenderMode.mockReturnValue(true);
  mockPushResetSprite.mockReturnValue(true);
  mockPushParticleSpellProgram.mockReturnValue(true);
});

describe('resetTDBaseline', () => {
  it('happy path: pushes 9 zones, sprite, render mode, flipbook, idle program', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(13); // 9 zones + sprite + render + flipbook + idle
    expect(result.steps.every(s => s.ok)).toBe(true);

    // Each marker-bearing zone got a push
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(9);
    for (const zone of ALL_ZONES) {
      expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledWith(zone, expect.any(String));
    }

    expect(mockPushResetSprite).toHaveBeenCalledTimes(1);
    expect(mockPushRenderMode).toHaveBeenCalledWith('mesh');
    expect(mockPushFlipbookConfig).toHaveBeenCalledWith({
      atlasCols: 1, atlasRows: 1, frameCount: 1,
      playbackMode: 'loop', frameDuration: 0.1, driveSource: 'age',
    });
    expect(mockPushParticleSpellProgram).toHaveBeenCalledWith('idle', expect.any(Object));
  });

  it('post_fx gets the explicit pass-through, others get empty code', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    await resetTDBaseline();

    const postFxCall = mockPushZoneUpdateWithValidation.mock.calls.find(([z]) => z === 'post_fx');
    const forceFieldCall = mockPushZoneUpdateWithValidation.mock.calls.find(([z]) => z === 'force_field');

    expect(postFxCall).toBeDefined();
    expect(postFxCall![1]).toContain('texture(sTD2DInputs[0]');
    expect(forceFieldCall).toBeDefined();
    expect(forceFieldCall![1]).toBe('');
  });

  it('records render mode and flipbook into the mirror on push success', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    await resetTDBaseline();

    expect(mockRecordRenderModePush).toHaveBeenCalledWith('mesh');
    expect(mockRecordFlipbookConfigPush).toHaveBeenCalledWith(expect.objectContaining({
      atlasCols: 1, frameCount: 1,
    }));
  });

  it('does NOT record into the mirror when push fails (TD disconnected)', async () => {
    mockPushRenderMode.mockReturnValue(false);
    mockPushFlipbookConfig.mockReturnValue(false);

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(mockRecordRenderModePush).not.toHaveBeenCalled();
    expect(mockRecordFlipbookConfigPush).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    const renderStep = result.steps.find(s => s.label === 'render_mode');
    expect(renderStep?.ok).toBe(false);
    expect(renderStep?.error).toMatch(/not connected/i);
  });

  it('partial failure: continues attempting remaining steps', async () => {
    // Sprite reset fails but everything else works
    mockPushResetSprite.mockReturnValue(false);

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(result.success).toBe(false);
    expect(result.steps.find(s => s.label === 'sprite')?.ok).toBe(false);
    // render / flipbook / idle still attempted
    expect(mockPushRenderMode).toHaveBeenCalled();
    expect(mockPushFlipbookConfig).toHaveBeenCalled();
    expect(mockPushParticleSpellProgram).toHaveBeenCalled();
  });

  it('zone push failure is recorded but does not stop the loop', async () => {
    // First zone fails; subsequent zones still attempted
    mockPushZoneUpdateWithValidation
      .mockResolvedValueOnce({ success: false, error: 'compile error' })
      .mockResolvedValue({ success: true });

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(9);
    const failedStep = result.steps.find(s => s.label === 'zone:force_field');
    expect(failedStep?.ok).toBe(false);
    expect(failedStep?.error).toBe('compile error');
    expect(result.success).toBe(false);
  });
});
