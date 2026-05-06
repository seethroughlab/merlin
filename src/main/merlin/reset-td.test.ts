import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const {
  mockPushZoneUpdateWithValidation,
  mockPushFlipbookConfig,
  mockPushResetSprite,
} = vi.hoisted(() => ({
  mockPushZoneUpdateWithValidation: vi.fn<(zone: string, code: string) => Promise<{ success: boolean; error?: string }>>(() =>
    Promise.resolve({ success: true })
  ),
  mockPushFlipbookConfig: vi.fn(() => true),
  mockPushResetSprite: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushZoneUpdateWithValidation: mockPushZoneUpdateWithValidation,
  pushFlipbookConfig: mockPushFlipbookConfig,
  pushResetSprite: mockPushResetSprite,
}));

const ALL_ZONES = [
  'force_field',
  'color_over_life',
  'size_over_life',
  'spawn_behavior',
  'velocity_modifier',
  'post_fx',
  'billboard_pixel',
  'billboard_vertex',
];

vi.mock('./test-shader', () => ({
  getMarkerBearingZones: () => ALL_ZONES,
}));

const { mockRecordFlipbookConfigPush } = vi.hoisted(() => ({
  mockRecordFlipbookConfigPush: vi.fn(),
}));

vi.mock('./td-state-mirror', () => ({
  recordFlipbookConfigPush: mockRecordFlipbookConfigPush,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPushZoneUpdateWithValidation.mockResolvedValue({ success: true });
  mockPushFlipbookConfig.mockReturnValue(true);
  mockPushResetSprite.mockReturnValue(true);
});

describe('resetTDBaseline', () => {
  it('happy path: pushes 8 zones, sprite, flipbook', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(10); // 8 zones + sprite + flipbook
    expect(result.steps.every(s => s.status === 'ok')).toBe(true);

    // Each marker-bearing zone got a push
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(8);
    for (const zone of ALL_ZONES) {
      expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledWith(zone, expect.any(String));
    }

    expect(mockPushResetSprite).toHaveBeenCalledTimes(1);
    expect(mockPushFlipbookConfig).toHaveBeenCalledWith({
      atlasCols: 1, atlasRows: 1, frameCount: 1,
      playbackMode: 'loop', frameDuration: 0.1, driveSource: 'age',
    });
  });

  it('classifies "zone not found" as skipped, not failure', async () => {
    mockPushZoneUpdateWithValidation.mockImplementation(async (zone) => {
      if (zone === 'post_fx') {
        return { success: false, error: 'zone not found: post_fx' };
      }
      return { success: true };
    });

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(result.success).toBe(true);
    const step = result.steps.find(s => s.label === 'zone:post_fx');
    expect(step?.status).toBe('skipped');
    expect(step?.note).toMatch(/not found/i);
    expect(result.steps.filter(s => s.status === 'error')).toHaveLength(0);
  });

  it('post_fx gets the explicit pass-through, others get a no-op comment', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    await resetTDBaseline();

    const postFxCall = mockPushZoneUpdateWithValidation.mock.calls.find(([z]) => z === 'post_fx');
    const forceFieldCall = mockPushZoneUpdateWithValidation.mock.calls.find(([z]) => z === 'force_field');

    expect(postFxCall).toBeDefined();
    expect(postFxCall![1]).toContain('texture(sTD2DInputs[0]');
    expect(forceFieldCall).toBeDefined();
    expect(forceFieldCall![1]).toMatch(/^\/\/\s/);
    expect(forceFieldCall![1].trim().length).toBeGreaterThan(0);
  });

  it('records flipbook into the mirror on push success', async () => {
    const { resetTDBaseline } = await import('./reset-td');
    await resetTDBaseline();

    expect(mockRecordFlipbookConfigPush).toHaveBeenCalledWith(expect.objectContaining({
      atlasCols: 1, frameCount: 1,
    }));
  });

  it('does NOT record into the mirror when push fails (TD disconnected)', async () => {
    mockPushFlipbookConfig.mockReturnValue(false);

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(mockRecordFlipbookConfigPush).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    const fbStep = result.steps.find(s => s.label === 'flipbook');
    expect(fbStep?.status).toBe('error');
    expect(fbStep?.error).toMatch(/not connected/i);
  });

  it('partial failure: continues attempting remaining steps', async () => {
    mockPushResetSprite.mockReturnValue(false);

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(result.success).toBe(false);
    expect(result.steps.find(s => s.label === 'sprite')?.status).toBe('error');
    // flipbook still attempted after the sprite step fails
    expect(mockPushFlipbookConfig).toHaveBeenCalled();
  });

  it('zone push failure is recorded but does not stop the loop', async () => {
    mockPushZoneUpdateWithValidation
      .mockResolvedValueOnce({ success: false, error: 'compile error' })
      .mockResolvedValue({ success: true });

    const { resetTDBaseline } = await import('./reset-td');
    const result = await resetTDBaseline();

    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(8);
    const failedStep = result.steps.find(s => s.label === 'zone:force_field');
    expect(failedStep?.status).toBe('error');
    expect(failedStep?.error).toBe('compile error');
    expect(result.success).toBe(false);
  });
});
