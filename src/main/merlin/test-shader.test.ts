import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

type MockPushResult = { success: boolean; error?: string; warnings?: string[] };
const { mockPushZoneUpdateWithValidation } = vi.hoisted(() => ({
  mockPushZoneUpdateWithValidation: vi.fn<(zone: string, code: string) => Promise<MockPushResult>>(() =>
    Promise.resolve({ success: true, warnings: [] as string[] })
  ),
}));

vi.mock('../td-bridge', () => ({
  pushZoneUpdateWithValidation: mockPushZoneUpdateWithValidation,
}));

const { mockLoadTemplate, mockZoneTemplateFiles } = vi.hoisted(() => ({
  mockLoadTemplate: vi.fn((zone: string) => `// fake template for ${zone}\n// {zone_code}`),
  mockZoneTemplateFiles: {
    force_field: 'pop_force.glsl',
    color_over_life: 'pop_color.glsl',
    size_over_life: 'pop_size.glsl',
    spawn_behavior: 'pop_spawn.glsl',
    velocity_modifier: 'pop_velmod.glsl',
    post_fx: 'top_postfx.glsl',
    material_pixel: 'mat_pixel.glsl',
    billboard_vertex: 'mat_billboard_vertex.glsl',
    billboard_pixel: 'mat_billboard_pixel.glsl',
  },
}));

vi.mock('./shader-templates', () => ({
  loadTemplate: mockLoadTemplate,
  ZONE_TEMPLATE_FILES: mockZoneTemplateFiles,
}));

vi.mock('./zone-registry', () => ({
  ZONE_CONTRACTS: {
    force_field: { description: 'forces', modifies: 'force', availableVars: ['pos'], uniforms: ['uTime'], maxLines: 25 },
    color_over_life: { description: 'colors', modifies: 'color', availableVars: ['life'], uniforms: ['uTime'], maxLines: 20, bannedKeywords: ['discard'] },
    size_over_life: { description: 'size', modifies: 'size', availableVars: ['life'], uniforms: ['uTime'], maxLines: 15 },
    spawn_behavior: { description: 'spawn', modifies: ['pos', 'vel'], availableVars: ['seed'], uniforms: ['uDeltaTime'], maxLines: 20 },
    velocity_modifier: { description: 'vel mod', modifies: 'vel', availableVars: ['vel'], uniforms: ['uTime'], maxLines: 20 },
    post_fx: { description: 'post', modifies: 'color', availableVars: ['uv'], uniforms: ['uTime'], maxLines: 30, bannedKeywords: ['discard'] },
    material_pixel: { description: 'mat', modifies: ['color', 'emission'], availableVars: ['uv'], uniforms: ['uTime'], maxLines: 35 },
    billboard_pixel: { description: 'billboard', modifies: ['brightness'], availableVars: ['albedo'], uniforms: ['uTime'], maxLines: 25 },
  },
}));

// Gemini SDK mock — chat-based as of Phase 5.
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

function geminiCallsForZones(zones: string[]) {
  return {
    response: {
      candidates: [
        {
          content: {
            parts: zones.map((zone) => ({
              functionCall: {
                name: 'set_zone_shader',
                args: { zone, glsl_code: `// snippet for ${zone}`, description: `desc for ${zone}` },
              },
            })),
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
  mockPushZoneUpdateWithValidation.mockResolvedValue({ success: true, warnings: [] });
});

describe('testShaderGeneration', () => {
  it('defaults to all 9 marker-bearing zones when zones is omitted', async () => {
    const expected = [
      'force_field', 'color_over_life', 'size_over_life',
      'spawn_behavior', 'velocity_modifier', 'post_fx',
      'material_pixel', 'billboard_pixel', 'billboard_vertex',
    ];
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(expected));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({ intent: 'calm', element: 'air', energy: 0.5 });

    expect(result.success).toBe(true);
    expect(result.zones).toHaveLength(9);
    expect(result.zones.map(z => z.zone).sort()).toEqual([...expected].sort());

    // Tool config built with all 9 — confirm via the model call
    const modelArgs = mockGetGenerativeModel.mock.calls[0][0];
    const toolEnum = modelArgs.tools[0].functionDeclarations[0].parameters.properties.zone.enum;
    expect(toolEnum.sort()).toEqual([...expected].sort());

    // Each returned zone went through pushZoneUpdateWithValidation
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(9);
  });

  it('honors explicit zone subset', async () => {
    const subset = ['force_field', 'post_fx'];
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(subset));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'wonder',
      element: 'cosmic',
      energy: 0.5,
      zones: subset,
    });

    expect(result.success).toBe(true);
    expect(result.zones.map(z => z.zone)).toEqual(subset);

    const modelArgs = mockGetGenerativeModel.mock.calls[0][0];
    const toolEnum = modelArgs.tools[0].functionDeclarations[0].parameters.properties.zone.enum;
    expect(toolEnum).toEqual(subset);

    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(2);
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledWith('force_field', expect.any(String));
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledWith('post_fx', expect.any(String));
  });

  it('billboard_vertex is now allowed (Phase 4 added the marker)', async () => {
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(['billboard_vertex']));

    const { testShaderGeneration } = await import('./test-shader');
    await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field', 'billboard_vertex'],
    });

    const modelArgs = mockGetGenerativeModel.mock.calls[0][0];
    const toolEnum = modelArgs.tools[0].functionDeclarations[0].parameters.properties.zone.enum;
    expect(toolEnum).toEqual(['force_field', 'billboard_vertex']);
  });

  it('loads templates from disk for each selected zone', async () => {
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(['force_field', 'post_fx']));

    const { testShaderGeneration } = await import('./test-shader');
    await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field', 'post_fx'],
    });

    expect(mockLoadTemplate).toHaveBeenCalledWith('force_field');
    expect(mockLoadTemplate).toHaveBeenCalledWith('post_fx');
  });

  it('drops Gemini tool calls for zones not in the requested set', async () => {
    // Gemini overshoots and returns force_field + billboard_pixel even though
    // we only asked for force_field.
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(['force_field', 'billboard_pixel']));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field'],
    });

    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].zone).toBe('force_field');
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(1);
  });

  it('retries on compile failure and surfaces final error after 3 attempts', async () => {
    // All 3 attempts (initial + 2 retries) fail; sendMessage keeps
    // returning the same shape so each retry has new code to push.
    mockSendMessage.mockResolvedValue(geminiCallsForZones(['force_field']));
    mockPushZoneUpdateWithValidation.mockResolvedValue({ success: false, error: 'compile error' });

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field'],
    });

    expect(result.zones[0].status).toBe('error');
    expect(result.zones[0].error).toBe('compile error');
    // Initial attempt + 2 retries = 3 total push calls for the failing zone
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(3);
    // Initial sendMessage + 2 retry sendMessages = 3 total
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
  });

  it('succeeds when retry succeeds after initial failure', async () => {
    mockSendMessage.mockResolvedValue(geminiCallsForZones(['force_field']));
    mockPushZoneUpdateWithValidation
      .mockResolvedValueOnce({ success: false, error: 'compile error' })
      .mockResolvedValueOnce({ success: true, warnings: [] });

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field'],
    });

    expect(result.zones[0].status).toBe('active');
    expect(result.success).toBe(true);
    // 1 retry happened, so 2 push calls + 2 sendMessage calls
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports overall failure when fewer zones returned than requested', async () => {
    mockSendMessage.mockResolvedValueOnce(geminiCallsForZones(['force_field']));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field', 'post_fx'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 of 2/);
  });
});
