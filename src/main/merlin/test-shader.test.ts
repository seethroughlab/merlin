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

// Gemini SDK mock
const { mockGenerateContent, mockGetGenerativeModel } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockGetGenerativeModel: vi.fn(),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel = mockGetGenerativeModel;
  },
  FunctionCallingMode: { ANY: 'ANY' },
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
  mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  mockPushZoneUpdateWithValidation.mockResolvedValue({ success: true, warnings: [] });
});

describe('testShaderGeneration', () => {
  it('defaults to all 9 marker-bearing zones when zones is omitted', async () => {
    const expected = [
      'force_field', 'color_over_life', 'size_over_life',
      'spawn_behavior', 'velocity_modifier', 'post_fx',
      'material_pixel', 'billboard_pixel', 'billboard_vertex',
    ];
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(expected));

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
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(subset));

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
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(['billboard_vertex']));

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
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(['force_field', 'post_fx']));

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
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(['force_field', 'billboard_pixel']));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field'],
    });

    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].zone).toBe('force_field');
    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledTimes(1);
  });

  it('surfaces per-zone push failures via status + error', async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(['force_field']));
    mockPushZoneUpdateWithValidation.mockResolvedValueOnce({ success: false, error: 'compile error' });

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field'],
    });

    expect(result.zones[0].status).toBe('error');
    expect(result.zones[0].error).toBe('compile error');
  });

  it('reports overall failure when fewer zones returned than requested', async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiCallsForZones(['force_field']));

    const { testShaderGeneration } = await import('./test-shader');
    const result = await testShaderGeneration({
      intent: 'calm', element: 'air', energy: 0.3,
      zones: ['force_field', 'post_fx'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 of 2/);
  });
});
