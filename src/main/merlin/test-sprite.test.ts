import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockGenerateSpriteSync, mockGenerateFlipbookSync, mockGetSpriteGenerator } = vi.hoisted(() => ({
  mockGenerateSpriteSync: vi.fn(),
  mockGenerateFlipbookSync: vi.fn(),
  mockGetSpriteGenerator: vi.fn(),
}));

vi.mock('./sprite-generator', () => ({
  getSpriteGenerator: mockGetSpriteGenerator,
}));

const { mockGetFlipbookConfig } = vi.hoisted(() => ({
  mockGetFlipbookConfig: vi.fn(),
}));

vi.mock('./asset-manager', () => ({
  getFlipbookConfig: mockGetFlipbookConfig,
}));

const { mockPushSpriteTexture, mockPushFlipbookConfig } = vi.hoisted(() => ({
  mockPushSpriteTexture: vi.fn(() => true),
  mockPushFlipbookConfig: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushSpriteTexture: mockPushSpriteTexture,
  pushFlipbookConfig: mockPushFlipbookConfig,
}));

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(() => Buffer.from('fake-png-bytes')),
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

// Gemini SDK mock
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

vi.mock('./prompts', () => ({
  GENERATE_SPRITE_TOOL: { name: 'generate_sprite' },
}));

// === Helpers ===

function makeSpriteAsset(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'fake-id',
    assetType: 'single' as const,
    texturePath: '/fake/path/sprite.png',
    frameCount: 1,
    atlasCols: 1,
    atlasRows: 1,
    width: 256,
    height: 256,
    createdAt: 1700000000,
    ...overrides,
  };
}

function makeFlipbookAsset(overrides: Record<string, unknown> = {}) {
  return makeSpriteAsset({
    assetType: 'flipbook' as const,
    frameCount: 16,
    atlasCols: 4,
    atlasRows: 4,
    texturePath: '/fake/path/atlas.png',
    width: 512,
    height: 512,
    ...overrides,
  });
}

function makeFlipbookConfig(overrides: Record<string, unknown> = {}) {
  return {
    atlasCols: 4,
    atlasRows: 4,
    frameCount: 16,
    playbackMode: 'loop' as const,
    frameDuration: 0.1,
    driveSource: 'age' as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockGetSpriteGenerator.mockReturnValue({
    generateSpriteSync: mockGenerateSpriteSync,
    generateFlipbookSync: mockGenerateFlipbookSync,
  });
  mockStartChat.mockReturnValue({ sendMessage: mockSendMessage });
  mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat });
});

describe('generateSpriteDirect', () => {
  it('routes to single-sprite path when no animation and no frameCount', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    mockGenerateSpriteSync.mockResolvedValue({ success: true, asset: makeSpriteAsset() });

    const result = await generateSpriteDirect({ description: 'glowing orb' });

    expect(mockGenerateSpriteSync).toHaveBeenCalledWith('glowing orb', { style: undefined });
    expect(mockGenerateFlipbookSync).not.toHaveBeenCalled();
    expect(mockPushSpriteTexture).toHaveBeenCalledWith('fake-id', '/fake/path/sprite.png');
    expect(mockPushFlipbookConfig).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.assetType).toBe('single');
    expect(result.pushed).toEqual({ texture: true, flipbook: false });
    expect(result.previewPng).toBe(Buffer.from('fake-png-bytes').toString('base64'));
  });

  it('routes to flipbook path when animation is set', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    mockGenerateFlipbookSync.mockResolvedValue({
      success: true,
      asset: makeFlipbookAsset(),
      flipbookConfig: makeFlipbookConfig(),
    });

    const result = await generateSpriteDirect({
      description: 'fire',
      animation: 'flicker',
      frameCount: 16,
      playbackMode: 'pingpong',
      driveSource: 'time',
      frameDuration: 0.05,
    });

    expect(mockGenerateFlipbookSync).toHaveBeenCalledWith('fire', {
      frameCount: 16,
      style: undefined,
      animation: 'flicker',
      playbackMode: 'pingpong',
      driveSource: 'time',
      frameDuration: 0.05,
    });
    expect(mockGenerateSpriteSync).not.toHaveBeenCalled();
    expect(mockPushSpriteTexture).toHaveBeenCalledWith('fake-id', '/fake/path/atlas.png');
    expect(mockPushFlipbookConfig).toHaveBeenCalledWith(makeFlipbookConfig());
    expect(result.assetType).toBe('flipbook');
    expect(result.pushed).toEqual({ texture: true, flipbook: true });
  });

  it('routes to flipbook path when frameCount > 1 even without animation', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    mockGenerateFlipbookSync.mockResolvedValue({
      success: true,
      asset: makeFlipbookAsset(),
      flipbookConfig: makeFlipbookConfig(),
    });

    await generateSpriteDirect({ description: 'orb', frameCount: 9 });

    expect(mockGenerateFlipbookSync).toHaveBeenCalled();
    expect(mockGenerateSpriteSync).not.toHaveBeenCalled();
  });

  it('reports texture push false when TD is disconnected (single)', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    mockGenerateSpriteSync.mockResolvedValue({ success: true, asset: makeSpriteAsset() });
    mockPushSpriteTexture.mockReturnValueOnce(false);

    const result = await generateSpriteDirect({ description: 'orb' });

    expect(result.success).toBe(true);
    expect(result.pushed.texture).toBe(false);
  });

  it('reports failure when generator returns success=false', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    mockGenerateSpriteSync.mockResolvedValue({ success: false, error: 'Imagen failed' });

    const result = await generateSpriteDirect({ description: 'orb' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Imagen failed');
    expect(mockPushSpriteTexture).not.toHaveBeenCalled();
  });

  it('falls back to getFlipbookConfig when generator omits flipbookConfig', async () => {
    const { generateSpriteDirect } = await import('./test-sprite');
    const fallbackConfig = makeFlipbookConfig({ frameDuration: 0.25 });
    mockGenerateFlipbookSync.mockResolvedValue({ success: true, asset: makeFlipbookAsset() });
    mockGetFlipbookConfig.mockReturnValue(fallbackConfig);

    const result = await generateSpriteDirect({ description: 'fire', animation: 'flicker' });

    expect(mockGetFlipbookConfig).toHaveBeenCalled();
    expect(result.flipbookConfig).toEqual(fallbackConfig);
    expect(mockPushFlipbookConfig).toHaveBeenCalledWith(fallbackConfig);
  });
});

describe('coerceGeminiArgs', () => {
  it('keeps valid fields and drops invalid ones', async () => {
    const { coerceGeminiArgs } = await import('./test-sprite');

    const spec = coerceGeminiArgs({
      description: 'shield',
      style: 'crystalline',
      animation: 'pulse',
      frameCount: 9,
      playbackMode: 'once',
      driveSource: 'life',
    });

    expect(spec).toEqual({
      description: 'shield',
      style: 'crystalline',
      animation: 'pulse',
      frameCount: 9,
      playbackMode: 'once',
      driveSource: 'life',
    });
  });

  it('drops out-of-range frameCount and unknown enum values', async () => {
    const { coerceGeminiArgs } = await import('./test-sprite');

    const spec = coerceGeminiArgs({
      description: 'shield',
      frameCount: 7, // not in {4,8,9,12,16,25}
      playbackMode: 'forever', // unknown
      driveSource: 'gravity', // unknown
    });

    expect(spec.description).toBe('shield');
    expect(spec.frameCount).toBeUndefined();
    expect(spec.playbackMode).toBeUndefined();
    expect(spec.driveSource).toBeUndefined();
  });

  it('throws when description is missing', async () => {
    const { coerceGeminiArgs } = await import('./test-sprite');
    expect(() => coerceGeminiArgs({})).toThrow();
  });
});

describe('generateSpriteWithGemini', () => {
  it('parses Gemini tool args, attaches geminiArgs, and delegates to direct path', async () => {
    const { generateSpriteWithGemini } = await import('./test-sprite');

    mockSendMessage.mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'generate_sprite',
                    args: {
                      description: 'protective shield',
                      animation: 'pulse',
                      frameCount: 9,
                      playbackMode: 'once',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    mockGenerateFlipbookSync.mockResolvedValue({
      success: true,
      asset: makeFlipbookAsset({ frameCount: 9, atlasCols: 3, atlasRows: 3 }),
      flipbookConfig: makeFlipbookConfig({ frameCount: 9, atlasCols: 3, atlasRows: 3, playbackMode: 'once' }),
    });

    const result = await generateSpriteWithGemini('a slow-pulsing protective shield, 9 frames, plays once');

    expect(result.success).toBe(true);
    expect(result.assetType).toBe('flipbook');
    expect(result.geminiArgs).toEqual({
      description: 'protective shield',
      animation: 'pulse',
      frameCount: 9,
      playbackMode: 'once',
    });
    // Confirms it went down the flipbook path via the coerced args
    expect(mockGenerateFlipbookSync).toHaveBeenCalled();
  });

  it('returns failure when Gemini does not call the tool', async () => {
    const { generateSpriteWithGemini } = await import('./test-sprite');

    mockSendMessage.mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ text: 'I cannot help with that.' }] } },
        ],
      },
    });

    const result = await generateSpriteWithGemini('something');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not call/i);
    expect(mockGenerateSpriteSync).not.toHaveBeenCalled();
    expect(mockGenerateFlipbookSync).not.toHaveBeenCalled();
  });
});
