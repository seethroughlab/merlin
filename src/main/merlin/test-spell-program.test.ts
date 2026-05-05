import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockPushParticleSpellProgram } = vi.hoisted(() => ({
  mockPushParticleSpellProgram: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushParticleSpellProgram: mockPushParticleSpellProgram,
}));

const { mockCreateBuildupProgram, mockCreateReleaseProgram } = vi.hoisted(() => ({
  mockCreateBuildupProgram: vi.fn(),
  mockCreateReleaseProgram: vi.fn(),
}));

vi.mock('./particle-program', () => ({
  createBuildupProgram: mockCreateBuildupProgram,
  createReleaseProgram: mockCreateReleaseProgram,
  BUILDUP_ENERGY_MAX: 0.55,
  RELEASE_ENERGY_PEAK: 1.0,
}));

vi.mock('./prompts', () => ({
  GENERATE_SPELL_PROGRAM_TOOL: { name: 'set_spell_program' },
}));

const { mockSendMessage, mockStartChat, mockGetGenerativeModel } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockStartChat: vi.fn(),
  mockGetGenerativeModel: vi.fn(),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel = mockGetGenerativeModel;
  },
  FunctionCallingMode: { ANY: 'ANY' },
}));

vi.mock('./gemini-events', () => ({
  emitGeminiTurn: vi.fn(),
  nextTurnId: () => 'test-turn-id',
}));

// === Helpers ===

function makeBuildupBase() {
  return {
    version: '1.0',
    spellId: 'fake-id',
    timestamp: 1700000000,
    intent: null,
    element: null,
    archetype: 'breathing_aura_mist',
    mode: 'buildup',
    energy: 0.3,
    energyFloor: 0.1,
    energyCeiling: 0.55,
    castingOrigin: 'hands',
    castingLandmarks: [15, 16],
    palette: { primary: '#8B5CF6', secondary: '#A78BFA', accent: '#C4B5FD' },
    zones: { force: { forceStrength: 0.4 } },
  };
}

function makeReleaseBase() {
  return {
    ...makeBuildupBase(),
    mode: 'release',
    energy: 1.0,
    energyFloor: 0.2,
    energyCeiling: 1.0,
    castEnvelope: { ignitionMs: 400, projectionMs: 1200, afterglowMs: 2900, peakIntensity: 0.9 },
  };
}

function geminiToolCall(args: Record<string, unknown>) {
  return {
    response: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'set_spell_program', args } }],
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockStartChat.mockReturnValue({ sendMessage: mockSendMessage });
  mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat });
  mockCreateBuildupProgram.mockReturnValue(makeBuildupBase());
  mockCreateReleaseProgram.mockReturnValue(makeReleaseBase());
  mockPushParticleSpellProgram.mockReturnValue(true);
});

describe('coerceGeminiArgs', () => {
  it('keeps valid archetype, energy, palette, zoneOverrides', async () => {
    const { coerceGeminiArgs } = await import('./test-spell-program');
    const out = coerceGeminiArgs({
      archetype: 'rising_embers',
      energy: 0.7,
      palette: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' },
      zoneOverrides: {
        force_field: { forceStrength: 0.6, forceDirection: 'upward' },
        color_over_life: { saturation: 0.8 },
      },
    });

    expect(out.archetype).toBe('rising_embers');
    expect(out.energy).toBe(0.7);
    expect(out.palette).toEqual({ primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' });
    // Long names map to short
    expect(out.zoneOverrides).toEqual({
      force: { forceStrength: 0.6, forceDirection: 'upward' },
      color: { saturation: 0.8 },
    });
  });

  it('drops invalid archetype, malformed hex, unknown zone, out-of-range numbers clamped', async () => {
    const { coerceGeminiArgs } = await import('./test-spell-program');
    const out = coerceGeminiArgs({
      archetype: 'fire_explosion', // invalid
      energy: 5, // clamped to 1
      palette: { primary: 'red', secondary: '#abc', accent: '#0000ff' }, // bad
      zoneOverrides: {
        unknown_zone: { saturation: 0.5 }, // dropped
        force_field: { forceStrength: 99 }, // clamped to 1
      },
    });

    expect(out.archetype).toBeUndefined();
    expect(out.energy).toBe(1);
    expect(out.palette).toBeUndefined(); // incomplete (primary/secondary invalid)
    expect(out.zoneOverrides).toEqual({ force: { forceStrength: 1 } });
  });

  it('honors castEnvelope and clamps peakIntensity', async () => {
    const { coerceGeminiArgs } = await import('./test-spell-program');
    const out = coerceGeminiArgs({
      castEnvelope: {
        ignitionMs: 500,
        projectionMs: 1500,
        afterglowMs: 2000,
        peakIntensity: 1.5, // clamped to 1
      },
    });

    expect(out.castEnvelope).toEqual({
      ignitionMs: 500,
      projectionMs: 1500,
      afterglowMs: 2000,
      peakIntensity: 1,
    });
  });
});

describe('generateSpellProgramWithGemini', () => {
  it('rejects empty prompts before any Gemini call', async () => {
    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({ prompt: '   ', mode: 'buildup' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('buildup: clamps Gemini energy to BUILDUP_ENERGY_MAX', async () => {
    mockSendMessage.mockResolvedValueOnce(geminiToolCall({ archetype: 'rising_embers', energy: 0.95 }));

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'a calm bubble',
      mode: 'buildup',
    });

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    const program = result.program as Record<string, unknown>;
    expect(program.archetype).toBe('rising_embers');
    expect(program.energy).toBeLessThanOrEqual(0.55);
    expect(mockPushParticleSpellProgram).toHaveBeenCalledWith('buildup', expect.any(Object));
  });

  it('release: castEnvelope from Gemini overrides default', async () => {
    mockSendMessage.mockResolvedValueOnce(
      geminiToolCall({
        castEnvelope: { ignitionMs: 200, projectionMs: 800, afterglowMs: 1500, peakIntensity: 0.7 },
      })
    );

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'sharp release',
      mode: 'release',
    });

    expect(result.success).toBe(true);
    expect(mockCreateReleaseProgram).toHaveBeenCalled();
    expect(mockCreateBuildupProgram).not.toHaveBeenCalled();
    const program = result.program as Record<string, unknown>;
    const env = program.castEnvelope as Record<string, number>;
    expect(env.ignitionMs).toBe(200);
    expect(env.projectionMs).toBe(800);
    expect(env.peakIntensity).toBe(0.7);
  });

  it('buildup: ignores castEnvelope (release-only)', async () => {
    mockSendMessage.mockResolvedValueOnce(
      geminiToolCall({
        castEnvelope: { ignitionMs: 999, projectionMs: 999, afterglowMs: 999, peakIntensity: 1.0 },
      })
    );

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'a ramp',
      mode: 'buildup',
    });

    expect(result.success).toBe(true);
    // base buildup program has no castEnvelope and we shouldn't add one
    const program = result.program as Record<string, unknown>;
    expect(program.castEnvelope).toBeUndefined();
  });

  it('zoneOverrides merge into base program zones (long->short name translation)', async () => {
    mockSendMessage.mockResolvedValueOnce(
      geminiToolCall({
        zoneOverrides: {
          force_field: { forceStrength: 0.9 },
          color_over_life: { saturation: 0.2 },
        },
      })
    );

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'tweaked',
      mode: 'buildup',
    });

    const program = result.program as Record<string, unknown>;
    const zones = program.zones as Record<string, Record<string, unknown>>;
    // Base had force.forceStrength = 0.4; override should bump to 0.9
    expect(zones.force.forceStrength).toBe(0.9);
    expect(zones.color.saturation).toBe(0.2);
  });

  it('reports pushed=false when TD is disconnected', async () => {
    mockSendMessage.mockResolvedValueOnce(geminiToolCall({ archetype: 'rising_embers' }));
    mockPushParticleSpellProgram.mockReturnValueOnce(false);

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'something',
      mode: 'buildup',
    });

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(false);
  });

  it('returns failure when Gemini does not call the tool', async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'I cannot help.' }] } }],
      },
    });

    const { generateSpellProgramWithGemini } = await import('./test-spell-program');
    const result = await generateSpellProgramWithGemini({
      prompt: 'something',
      mode: 'buildup',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not call/i);
    expect(mockPushParticleSpellProgram).not.toHaveBeenCalled();
  });
});
