import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendMessage, mockChatsCreate } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockChatsCreate: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    chats = { create: mockChatsCreate };
  },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO', NONE: 'NONE' },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockChatsCreate.mockReturnValue({ sendMessage: mockSendMessage });
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

const TOOL_DEF = {
  name: 'set_zone_shader',
  description: 'Push GLSL to a zone',
  parameters: { type: 'OBJECT', properties: {} },
};

describe('startSingleToolChat', () => {
  it('creates a chat configured to force exactly the supplied tool via FunctionCallingConfigMode.ANY', async () => {
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    startSingleToolChat(TOOL_DEF as never);

    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    const cfg = mockChatsCreate.mock.calls[0][0];
    expect(cfg.model).toBe('gemini-3-flash-preview');
    expect(cfg.config.tools).toEqual([{ functionDeclarations: [TOOL_DEF] }]);
    expect(cfg.config.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(cfg.config.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['set_zone_shader']);
  });

  it('propagates systemInstruction and model options when provided', async () => {
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    startSingleToolChat(TOOL_DEF as never, {
      systemInstruction: 'you are a shader generator',
      model: 'gemini-3-flash-test',
    });
    const cfg = mockChatsCreate.mock.calls[0][0];
    expect(cfg.model).toBe('gemini-3-flash-test');
    expect(cfg.config.systemInstruction).toBe('you are a shader generator');
  });

  it('omits systemInstruction from the create config when not provided', async () => {
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    startSingleToolChat(TOOL_DEF as never);
    const cfg = mockChatsCreate.mock.calls[0][0];
    expect('systemInstruction' in cfg.config).toBe(false);
  });

  it('throws when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    expect(() => startSingleToolChat(TOOL_DEF as never)).toThrow(/GEMINI_API_KEY/);
  });
});

describe('GeminiChatHandle.send', () => {
  it('extracts a text-only response with an empty toolCalls array', async () => {
    mockSendMessage.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok ' }, { text: 'cool' }] } }],
    });
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    const handle = startSingleToolChat(TOOL_DEF as never);
    const result = await handle.send('hi');
    expect(result.text).toBe('ok cool');
    expect(result.toolCalls).toEqual([]);
    expect(result.rawParts).toHaveLength(2);
  });

  it('extracts a single tool call with name + args', async () => {
    mockSendMessage.mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: 'set_zone_shader', args: { zone: 'force_field', code: '// ...' } },
          }],
        },
      }],
    });
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    const handle = startSingleToolChat(TOOL_DEF as never);
    const result = await handle.send('do it');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([
      { name: 'set_zone_shader', args: { zone: 'force_field', code: '// ...' } },
    ]);
  });

  it('extracts multiple tool calls and preserves emission order', async () => {
    mockSendMessage.mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { text: 'lemme do two things' },
            { functionCall: { name: 'set_zone_shader', args: { zone: 'a' } } },
            { functionCall: { name: 'set_zone_shader', args: { zone: 'b' } } },
          ],
        },
      }],
    });
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    const handle = startSingleToolChat(TOOL_DEF as never);
    const result = await handle.send('go');
    expect(result.toolCalls.map(t => t.args.zone)).toEqual(['a', 'b']);
    expect(result.text).toBe('lemme do two things');
  });

  it('defaults missing args to an empty object', async () => {
    mockSendMessage.mockResolvedValue({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'set_zone_shader' } }] },
      }],
    });
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    const handle = startSingleToolChat(TOOL_DEF as never);
    const result = await handle.send('go');
    expect(result.toolCalls).toEqual([{ name: 'set_zone_shader', args: {} }]);
  });

  it('handles an empty candidates list gracefully', async () => {
    mockSendMessage.mockResolvedValue({ candidates: [] });
    const { startSingleToolChat } = await import('./gemini-chat-helper');
    const handle = startSingleToolChat(TOOL_DEF as never);
    const result = await handle.send('go');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.rawParts).toEqual([]);
  });
});
