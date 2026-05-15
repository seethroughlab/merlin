import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mocks ===

// @google/genai mock: a fake Chat with a controllable sendMessage that
// records calls and returns whatever the test queues.
const { mockSendMessage, mockChatsCreate } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockChatsCreate: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    chats = { create: mockChatsCreate };
  },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO' },
  Type: { STRING: 'STRING', OBJECT: 'OBJECT', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY' },
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' },
}));

vi.mock('./system-prompts', () => ({
  MERLIN_SYSTEM_PROMPT: 'merlin-system',
  MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT: 'visual-author-system',
  INTRO_WITH_IMAGE_PROMPT: 'intro-prompt',
  MERLIN_CLOSING_PROMPT: 'closing-prompt',
}));

vi.mock('./tool-definitions', () => ({
  MERLIN_TOOLS: [{ name: 'set_zone_shader' }],
  MERLIN_VISUAL_AUTHOR_TOOLS: [{ name: 'set_zone_shader' }, { name: 'generate_sprite' }, { name: 'request_visual_feedback' }],
}));

// === Helpers ===

function geminiTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  };
}

function geminiToolResponse(name: string, args: Record<string, unknown>, id?: string) {
  return {
    candidates: [{
      content: {
        parts: [{
          functionCall: id ? { name, args, id } : { name, args },
        }],
      },
      finishReason: 'STOP',
    }],
  };
}

function geminiEmptyResponse() {
  return { candidates: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockChatsCreate.mockReturnValue({ sendMessage: mockSendMessage });
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe('MerlinChat.initChat', () => {
  it('builds a visual-author chat by default', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    const chat = new MerlinChat();
    chat.initChat();
    expect(mockChatsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          systemInstruction: 'visual-author-system',
        }),
      }),
    );
  });

  it('builds a merlin chat when mode=merlin', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    const chat = new MerlinChat();
    chat.initChat({ mode: 'merlin' });
    expect(mockChatsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          systemInstruction: 'merlin-system',
        }),
      }),
    );
  });
});

describe('MerlinChat.startChat', () => {
  it('starts a session and parses a plain text response', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('Welcome, traveler.'));
    const chat = new MerlinChat();
    const result = await chat.startChat();
    expect(result.text).toBe('Welcome, traveler.');
    expect(result.toolCalls).toEqual([]);
    expect(chat.isActive()).toBe(true);
  });

  it('parses tool calls when Gemini emits a functionCall', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(
      geminiToolResponse('set_zone_shader', { zone: 'force_field', glsl_code: '// x' }, 'call_1'),
    );
    const chat = new MerlinChat();
    const result = await chat.startChat();
    expect(result.toolCalls).toEqual([
      { name: 'set_zone_shader', args: { zone: 'force_field', glsl_code: '// x' }, id: 'call_1' },
    ]);
  });
});

describe('MerlinChat.startChatWithImage', () => {
  it('passes the inline image as the first part', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('I see you.'));
    const chat = new MerlinChat();
    await chat.startChatWithImage('FAKEBASE64==');
    expect(mockSendMessage).toHaveBeenCalledWith({
      message: [
        { inlineData: { mimeType: 'image/jpeg', data: 'FAKEBASE64==' } },
        { text: 'intro-prompt' },
      ],
    });
  });
});

describe('MerlinChat.sendMessage', () => {
  it('throws when chat is not started', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    const chat = new MerlinChat();
    await expect(chat.sendMessage('hi')).rejects.toThrow(/not started/i);
  });

  it('passes per-call config when allowedTools is supplied', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('ok'));
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('reply'));
    const chat = new MerlinChat();
    await chat.startChat();
    // startChat defaults to 'merlin' mode whose mocked tool set is
    // [set_zone_shader]. Use a name from that registry so the filter
    // actually keeps a tool.
    await chat.sendMessage('hello', { allowedTools: ['set_zone_shader'] });
    const lastCall = mockSendMessage.mock.calls.at(-1)?.[0];
    expect(lastCall.config).toBeDefined();
    expect(lastCall.config.tools[0].functionDeclarations).toEqual([
      { name: 'set_zone_shader' },
    ]);
  });
});

describe('MerlinChat.sendToolResults', () => {
  it('builds a functionResponse part per result', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('ok'));
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('thanks'));
    const chat = new MerlinChat();
    await chat.startChat();
    await chat.sendToolResults([
      { name: 'set_zone_shader', response: { ok: true }, callId: 'call_a' },
      { name: 'generate_sprite', response: { assetId: 'x' } },
    ]);
    const lastCall = mockSendMessage.mock.calls.at(-1)?.[0];
    expect(Array.isArray(lastCall.message)).toBe(true);
    expect(lastCall.message[0]).toEqual({
      functionResponse: { id: 'call_a', name: 'set_zone_shader', response: { ok: true } },
    });
    expect(lastCall.message[1]).toEqual({
      functionResponse: { name: 'generate_sprite', response: { assetId: 'x' } },
    });
  });

  it('attaches an image to the matching callId', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('ok'));
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('thanks'));
    const chat = new MerlinChat();
    await chat.startChat();
    await chat.sendToolResults(
      [{ name: 'request_visual_feedback', response: { ok: true }, callId: 'rvf' }],
      [{ callId: 'rvf', mimeType: 'image/png', base64: 'IMGDATA' }],
    );
    const lastCall = mockSendMessage.mock.calls.at(-1)?.[0];
    expect(lastCall.message[0].functionResponse.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'IMGDATA' } },
    ]);
  });

  it('attaches orphan images (no callId) to the first response in the batch', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('ok'));
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('thanks'));
    const chat = new MerlinChat();
    await chat.startChat();
    await chat.sendToolResults(
      [
        { name: 'first_tool', response: { a: 1 } },
        { name: 'second_tool', response: { b: 2 } },
      ],
      [{ mimeType: 'image/png', base64: 'IMG' }],
    );
    const lastCall = mockSendMessage.mock.calls.at(-1)?.[0];
    expect(lastCall.message[0].functionResponse.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'IMG' } },
    ]);
    expect(lastCall.message[1].functionResponse.parts).toBeUndefined();
  });
});

describe('parseResult edge cases', () => {
  it('returns "No response generated" when candidates is empty', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiEmptyResponse());
    const chat = new MerlinChat();
    const result = await chat.startChat();
    expect(result.text).toBe('No response generated');
    expect(result.finishReason).toBe('ERROR');
  });

  it('joins multi-part text into a single string', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce({
      candidates: [{
        content: { parts: [{ text: 'first ' }, { text: 'second' }] },
        finishReason: 'STOP',
      }],
    });
    const chat = new MerlinChat();
    const result = await chat.startChat();
    expect(result.text).toBe('first second');
  });
});

describe('error handling via withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on a 429 and eventually returns the response', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage
      .mockRejectedValueOnce({ status: 429, message: 'rate limit' })
      .mockResolvedValueOnce(geminiTextResponse('after retry'));
    const chat = new MerlinChat();
    const promise = chat.startChat();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.text).toBe('after retry');
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('throws non-retryable auth errors without retrying', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockRejectedValueOnce({ status: 401, message: 'unauthorized' });
    const chat = new MerlinChat();
    await expect(chat.startChat()).rejects.toEqual({ status: 401, message: 'unauthorized' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('endSession', () => {
  it('sends the closing prompt and returns "Session was not active" when not active', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    const chat = new MerlinChat();
    const text = await chat.endSession();
    expect(text).toBe('Session was not active.');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends the closing prompt when active', async () => {
    const { MerlinChat } = await import('./gemini-chat');
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('ok'));
    mockSendMessage.mockResolvedValueOnce(geminiTextResponse('Farewell, traveler.'));
    const chat = new MerlinChat();
    await chat.startChat();
    const text = await chat.endSession();
    expect(text).toBe('Farewell, traveler.');
    expect(mockSendMessage.mock.calls.at(-1)?.[0]).toEqual({ message: 'closing-prompt' });
    expect(chat.isActive()).toBe(false);
  });
});
