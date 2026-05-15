import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @anthropic-ai/sdk. The default export is a class; the only
// surface we exercise is `messages.create`.
const { mockMessagesCreate } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockMessagesCreate };
  },
}));

function anthropicTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('isParticipantLLMAvailable', () => {
  it('returns true when ANTHROPIC_API_KEY is set', async () => {
    const { isParticipantLLMAvailable } = await import('./participant');
    expect(isParticipantLLMAvailable()).toBe(true);
  });

  it('returns false when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { isParticipantLLMAvailable } = await import('./participant');
    expect(isParticipantLLMAvailable()).toBe(false);
  });
});

describe('generateParticipantLine', () => {
  it('returns null when no ANTHROPIC_API_KEY is configured (no SDK call)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateParticipantLine } = await import('./participant');
    const result = await generateParticipantLine({
      characterDescription: 'a nervous student',
      history: [],
    });
    expect(result).toBeNull();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns the model text, trimmed of wrapping quotes', async () => {
    mockMessagesCreate.mockResolvedValue(anthropicTextResponse('"I feel a little uncertain."'));
    const { generateParticipantLine } = await import('./participant');
    const result = await generateParticipantLine({
      characterDescription: 'a nervous student',
      history: [],
    });
    expect(result).toBe('I feel a little uncertain.');
  });

  it('strips YOU: / ME: / PARTICIPANT: prefixes the model sometimes adds', async () => {
    const { generateParticipantLine } = await import('./participant');
    mockMessagesCreate.mockResolvedValueOnce(anthropicTextResponse('YOU: still nervous.'));
    expect(await generateParticipantLine({ characterDescription: 'x', history: [] })).toBe('still nervous.');

    mockMessagesCreate.mockResolvedValueOnce(anthropicTextResponse('ME: feeling okay'));
    expect(await generateParticipantLine({ characterDescription: 'x', history: [] })).toBe('feeling okay');

    mockMessagesCreate.mockResolvedValueOnce(anthropicTextResponse('PARTICIPANT : breathing slow'));
    expect(await generateParticipantLine({ characterDescription: 'x', history: [] })).toBe('breathing slow');
  });

  it('includes the expectedSpell intent/element hint in the user content when provided', async () => {
    mockMessagesCreate.mockResolvedValue(anthropicTextResponse('ok'));
    const { generateParticipantLine } = await import('./participant');
    await generateParticipantLine({
      characterDescription: 'a nervous student',
      expectedSpell: { intent: 'protection', element: 'fire' },
      history: [],
    });
    const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toMatch(/protection/);
    expect(userContent).toMatch(/fire/);
    expect(userContent).toMatch(/internal direction/i);
  });

  it('appends the closing-turn instructions when closing=true', async () => {
    mockMessagesCreate.mockResolvedValue(anthropicTextResponse('held breath'));
    const { generateParticipantLine } = await import('./participant');
    await generateParticipantLine({
      characterDescription: 'x',
      history: [],
      closing: true,
    });
    const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toMatch(/closing turn/i);
    expect(userContent).toMatch(/do not say the magic word/i);
  });

  it('renders the transcript with WIZARD: and YOU: prefixes for each prior turn', async () => {
    mockMessagesCreate.mockResolvedValue(anthropicTextResponse('answer'));
    const { generateParticipantLine } = await import('./participant');
    await generateParticipantLine({
      characterDescription: 'x',
      history: [
        { speaker: 'merlin', text: 'tell me what brought you here' },
        { speaker: 'participant', text: 'I just finished my PhD' },
        { speaker: 'merlin', text: 'and how does that feel' },
      ],
    });
    const userContent = mockMessagesCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('WIZARD: tell me what brought you here');
    expect(userContent).toContain('YOU: I just finished my PhD');
    expect(userContent).toContain('WIZARD: and how does that feel');
  });

  it('returns null (does not throw) when the SDK call rejects', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('429 rate limit'));
    const { generateParticipantLine } = await import('./participant');
    const result = await generateParticipantLine({
      characterDescription: 'x',
      history: [],
    });
    expect(result).toBeNull();
  });

  it('uses the documented model and short max_tokens', async () => {
    mockMessagesCreate.mockResolvedValue(anthropicTextResponse('ok'));
    const { generateParticipantLine } = await import('./participant');
    await generateParticipantLine({ characterDescription: 'x', history: [] });
    const params = mockMessagesCreate.mock.calls[0][0];
    expect(params.model).toBe('claude-haiku-4-5-20251001');
    expect(params.max_tokens).toBe(200);
    expect(params.system).toMatch(/actor playing a participant/i);
  });
});
