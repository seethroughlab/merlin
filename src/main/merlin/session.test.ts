import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mocks ===

// MerlinChat: stub the constructor + minimum methods session.ts uses.
const { mockChatIsActive, mockChatStartChat, mockChatStartChatWithImage, mockChatSendMessage, mockChatEndSession } = vi.hoisted(() => ({
  mockChatIsActive: vi.fn(),
  mockChatStartChat: vi.fn(),
  mockChatStartChatWithImage: vi.fn(),
  mockChatSendMessage: vi.fn(),
  mockChatEndSession: vi.fn(),
}));

vi.mock('./gemini-chat', () => ({
  MerlinChat: class MockMerlinChat {
    isActive = mockChatIsActive;
    startChat = mockChatStartChat;
    startChatWithImage = mockChatStartChatWithImage;
    sendMessage = mockChatSendMessage;
    endSession = mockChatEndSession;
  },
}));

// turn-runner: stub runMerlinTurn / dispatchToolCalls.
const { mockRunMerlinTurn, mockDispatchToolCalls } = vi.hoisted(() => ({
  mockRunMerlinTurn: vi.fn(),
  mockDispatchToolCalls: vi.fn(),
}));

vi.mock('./turn-runner', () => ({
  runMerlinTurn: mockRunMerlinTurn,
  dispatchToolCalls: mockDispatchToolCalls,
}));

// td-bridge: pushSpellCast and pushZoneUpdateWithValidation.
const { mockPushSpellCast, mockPushZoneUpdateWithValidation } = vi.hoisted(() => ({
  mockPushSpellCast: vi.fn(),
  mockPushZoneUpdateWithValidation: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('../td-bridge', () => ({
  pushSpellCast: mockPushSpellCast,
  pushZoneUpdateWithValidation: mockPushZoneUpdateWithValidation,
}));

vi.mock('./reset-td', () => ({
  resetTDBaseline: vi.fn(() => Promise.resolve()),
}));

vi.mock('./gemini-events', () => ({
  emitGeminiTurn: vi.fn(),
  nextTurnId: () => 'test-turn-id',
}));

vi.mock('./face-event-buffer', () => ({
  summarizeRecentFaceActivity: vi.fn(() => null),
}));

vi.mock('./prompts', () => ({
  createTurnContext: (transcript: string) => `ctx:${transcript}`,
}));

// === Helpers ===

function defaultRunMerlinTurnResult(overrides: Partial<{
  finalText: string;
  fullText: string;
  streamedAny: boolean;
}> = {}) {
  return {
    finalText: 'Gemini response',
    fullText: 'Gemini response',
    streamedAny: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChatIsActive.mockReturnValue(true);
  mockRunMerlinTurn.mockResolvedValue(defaultRunMerlinTurnResult());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MerlinSession.startSession', () => {
  it('moves to intro phase and fires onPhaseChange', async () => {
    const { createMerlinSession } = await import('./session');
    const onPhaseChange = vi.fn();
    mockChatStartChat.mockResolvedValueOnce({ text: 'Welcome', toolCalls: [], finishReason: 'STOP' });
    const session = createMerlinSession({ onPhaseChange });
    const result = await session.startSession();
    expect(result.phase).toBe('intro');
    expect(onPhaseChange).toHaveBeenCalledWith('intro');
    expect(result.text).toBe('Welcome');
  });

  it('uses startChatWithImage when capture callback yields a frame', async () => {
    const { createMerlinSession } = await import('./session');
    mockChatStartChatWithImage.mockResolvedValueOnce({ text: 'I see you', toolCalls: [], finishReason: 'STOP' });
    const onCaptureFrame = vi.fn(() => Promise.resolve('BASE64DATA'));
    const session = createMerlinSession({ onCaptureFrame });
    await session.startSession();
    expect(mockChatStartChatWithImage).toHaveBeenCalledWith('BASE64DATA');
    expect(mockChatStartChat).not.toHaveBeenCalled();
  });
});

describe('MerlinSession.processUserSpeech', () => {
  beforeEach(() => {
    mockChatStartChat.mockResolvedValue({ text: 'Welcome', toolCalls: [], finishReason: 'STOP' });
  });

  it('throws when chat is not active', async () => {
    const { createMerlinSession } = await import('./session');
    mockChatIsActive.mockReturnValue(false);
    const session = createMerlinSession();
    await expect(session.processUserSpeech('hi', null, null)).rejects.toThrow(/not started/i);
  });

  it('runs a normal Gemini turn when there is no magic-word match', async () => {
    const { createMerlinSession } = await import('./session');
    mockRunMerlinTurn.mockResolvedValueOnce(defaultRunMerlinTurnResult({ finalText: 'reply' }));
    const session = createMerlinSession();
    await session.startSession();
    const response = await session.processUserSpeech('what is this?', null, null);
    expect(mockRunMerlinTurn).toHaveBeenCalled();
    expect(response.text).toBe('reply');
  });

  it('does not advance to play on a non-magic-word utterance', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    const reply = await session.processUserSpeech('hello', null, null);
    expect(reply.phase).not.toBe('play');
  });

  it('runs Gemini on first cast to produce a welcome line', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; element?: string; intent?: string; castingOrigin?: string; confidence: number } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'glow';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    mockRunMerlinTurn.mockResolvedValueOnce(defaultRunMerlinTurnResult({ finalText: 'Your spell is alive.' }));
    const cast = await session.processUserSpeech('glow', null, null);
    expect(cast.text).toBe('Your spell is alive.');
    expect(cast.phase).toBe('play');
    expect(mockRunMerlinTurn).toHaveBeenCalled();
  });

  it('stays silent during play after the welcome line', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; element?: string; intent?: string; castingOrigin?: string; confidence: number } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'glow';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    // First cast: Gemini runs for welcome line
    await session.processUserSpeech('glow', null, null);
    mockRunMerlinTurn.mockClear();
    // Subsequent speech in play is silent — no Gemini
    const reply = await session.processUserSpeech('hello there', null, null);
    expect(reply.text).toBe('');
    expect(mockRunMerlinTurn).not.toHaveBeenCalled();
  });
});


describe('MerlinSession.endSession', () => {
  it('clears the play-safety timer so it cannot fire after end', async () => {
    vi.useFakeTimers();
    const { createMerlinSession } = await import('./session');
    const onSessionComplete = vi.fn();
    mockChatStartChat.mockResolvedValue({ text: 'Welcome', toolCalls: [], finishReason: 'STOP' });
    mockChatEndSession.mockResolvedValue('Goodbye.');
    const session = createMerlinSession({ onSessionComplete });
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; element?: string; intent?: string; castingOrigin?: string; confidence: number } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'spark';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    await session.processUserSpeech('spark', null, null);
    // Now in play with a 60s inactivity timer running.
    await session.endSession();
    // Fast-forward past the timer; onSessionComplete must NOT fire from
    // a leftover timeout because we cleared it in endSession.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onSessionComplete).not.toHaveBeenCalled();
  });

  it('returns early without a second outro if cast already completed', async () => {
    const { createMerlinSession } = await import('./session');
    mockChatStartChat.mockResolvedValue({ text: 'Welcome', toolCalls: [], finishReason: 'STOP' });
    const session = createMerlinSession();
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; element?: string; intent?: string; castingOrigin?: string; confidence: number } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'spark';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    await session.processUserSpeech('spark', null, null);
    // Cast fired → state.castCompleted=true.
    const result = await session.endSession();
    expect(result.text).toBe('');
    expect(mockChatEndSession).not.toHaveBeenCalled();
  });
});

describe('MerlinSession.getConversationHistory cap', () => {
  it('keeps the history bounded across many turns', async () => {
    const { createMerlinSession } = await import('./session');
    mockChatStartChat.mockResolvedValue({ text: 'Welcome', toolCalls: [], finishReason: 'STOP' });
    const session = createMerlinSession();
    await session.startSession();
    mockRunMerlinTurn.mockResolvedValue(defaultRunMerlinTurnResult({ finalText: 'reply' }));
    // 150 turns push 300 messages — should clip down to 200.
    for (let i = 0; i < 150; i++) {
      await session.processUserSpeech(`turn-${i}`, null, null);
    }
    const history = session.getConversationHistory();
    expect(history.length).toBeLessThanOrEqual(200);
    // Most recent entries should be retained.
    const recent = history.slice(-2).map(h => h.content);
    expect(recent.some(c => c.includes('turn-149'))).toBe(true);
  });
});
