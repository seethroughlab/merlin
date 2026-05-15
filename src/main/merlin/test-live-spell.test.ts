import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockInitChat, mockSendMessage, mockSendToolResults } = vi.hoisted(() => ({
  mockInitChat: vi.fn(),
  mockSendMessage: vi.fn(),
  mockSendToolResults: vi.fn(),
}));

vi.mock('./gemini-chat', () => ({
  MerlinChat: class {
    initChat = mockInitChat;
    sendMessage = mockSendMessage;
    sendToolResults = mockSendToolResults;
  },
}));

vi.mock('./gemini-events', () => ({
  emitGeminiTurn: vi.fn(),
  nextTurnId: () => 'test-live-spell-turn-id',
}));

const { mockPushZoneUpdateWithValidation } = vi.hoisted(() => ({
  mockPushZoneUpdateWithValidation: vi.fn(),
}));

vi.mock('../td-bridge', () => ({
  pushZoneUpdateWithValidation: mockPushZoneUpdateWithValidation,
}));

// system-prompts.ts pulls shader templates from disk via electron.app at module
// load. Stub it so static imports of session-context (for ALLOWED_TOOLS_PER_PHASE)
// don't crash under vitest where `electron.app` is undefined.
vi.mock('./shader-templates', () => ({
  formatTemplatesForSystemPrompt: () => '',
  formatTemplateForPrompt: () => '',
  loadTemplate: () => '',
  ZONE_TEMPLATE_FILES: {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockInitChat.mockReturnValue(undefined);
  mockPushZoneUpdateWithValidation.mockResolvedValue({ success: true });
});

describe('testLiveSpell', () => {
  it('rejects empty prompt before calling Gemini', async () => {
    const { testLiveSpell } = await import('./test-live-spell');
    const result = await testLiveSpell({ prompt: '   ' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
    expect(mockInitChat).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('runs Gemini single-turn-no-tools and returns finalText', async () => {
    mockSendMessage.mockResolvedValueOnce({
      text: 'A protective shield, you say.',
      toolCalls: [],
      finishReason: 'STOP',
    });

    const { testLiveSpell } = await import('./test-live-spell');
    const result = await testLiveSpell({ prompt: 'a protective shield' });

    expect(mockInitChat).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('a protective shield', expect.any(Object));
    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(0);
    expect(result.finalText).toMatch(/protective shield/);
  });

  it('dispatches tool calls and loops until Gemini stops calling tools', async () => {
    // Gemini calls set_spell_profile, then on second send (with tool result) returns plain text.
    mockSendMessage.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        { name: 'set_spell_profile', args: { intent: 'transformation', element: 'fire', energy: 0.7 } },
      ],
      finishReason: 'TOOL',
    });
    mockSendToolResults.mockResolvedValueOnce({
      text: 'A spell of transformation, ignited.',
      toolCalls: [],
      finishReason: 'STOP',
    });

    const { testLiveSpell } = await import('./test-live-spell');
    const result = await testLiveSpell({ prompt: 'turn me into something stronger' });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendToolResults).toHaveBeenCalledTimes(1);
    // set_spell_profile is metadata-only — it should NOT push zone code.
    expect(mockPushZoneUpdateWithValidation).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toMatch(/transformation/);
    expect((result.finalSpell as Record<string, unknown>).intent).toBe('transformation');
  });

  it('routes set_zone_shader through pushZoneUpdateWithValidation', async () => {
    mockSendMessage.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        { name: 'set_zone_shader', args: { zone: 'force_field', glsl_code: '// snippet', description: 'd' } },
      ],
      finishReason: 'TOOL',
    });
    mockSendToolResults.mockResolvedValueOnce({
      text: 'Done.',
      toolCalls: [],
      finishReason: 'STOP',
    });

    const { testLiveSpell } = await import('./test-live-spell');
    await testLiveSpell({ prompt: 'a swirling vortex' });

    expect(mockPushZoneUpdateWithValidation).toHaveBeenCalledWith('force_field', '// snippet');
  });

  it('returns failure when chat throws', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Gemini unavailable'));

    const { testLiveSpell } = await import('./test-live-spell');
    const result = await testLiveSpell({ prompt: 'spell' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Gemini unavailable/);
  });
});
