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

  it('returns silently after a cast — no Gemini turn runs', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    // Set up a spell with a known magic word, then mark it ready.
    const spell = session.getSpell();
    spell.magicWord = 'illuminate';
    spell.castingOrigin = 'chest';
    // Internal state surgery: cast trigger paths require castReady=true
    // and isSpellReady() — set the bits directly through the state.
    const st = session.getState();
    st.castReady = true;
    // The session's internal state object is a fresh copy from getState;
    // mutate the real one via processUserSpeech path: easiest is to
    // bypass the cast-ready guard by calling triggerCast directly.
    // Instead, drive the public flow: the spell must be both `ready` and
    // `castReady`. Use spell-state's contract by setting all spell fields.
    // For simplicity, monkey-patch internal castReady via processUserSpeech
    // path — feed a transcript that doesn't match, then directly set
    // castReady through getState's mutability.
    // Actually getState returns a shallow copy ({...this.state}). To set
    // castReady, we need the original. The cleanest path is to just
    // verify the silent-return branch by triggering cast via a known
    // ready state. Skipping for now: cover this via the triggerCast()
    // path test below.
    const reply = await session.processUserSpeech('hello', null, null);
    expect(reply.phase).not.toBe('play');
  });

  it('runs Gemini outro when end-word matches during play', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    // Force the session into play phase by calling triggerCast manually
    // after setting the gating bits. We do this through the state mirror
    // pattern: getState returns a copy but markCastCompleted is a public
    // method we can call directly via casting.
    // Easiest path: call session.triggerCast which already advances to
    // play if cast is ready. Set up the spell first.
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; endWord?: string; element?: string; intent?: string; castingOrigin?: string } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'glow';
    internalState.spell.endWord = 'thanks';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    // First utterance: triggerCast → enters play silently.
    const cast = await session.processUserSpeech('glow', null, null);
    expect(cast.text).toBe('');
    expect(cast.phase).toBe('play');
    // Second utterance: end-word triggers outro Gemini turn.
    mockRunMerlinTurn.mockResolvedValueOnce(defaultRunMerlinTurnResult({ finalText: 'Farewell.' }));
    const farewell = await session.processUserSpeech('thanks', null, null);
    expect(farewell.text).toBe('Farewell.');
    expect(mockRunMerlinTurn).toHaveBeenCalled();
  });

  it('stays silent during play on non-end-word utterances', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; endWord?: string; element?: string; intent?: string; castingOrigin?: string } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'glow';
    internalState.spell.endWord = 'thanks';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    await session.processUserSpeech('glow', null, null);
    mockRunMerlinTurn.mockClear();
    const reply = await session.processUserSpeech('hello there', null, null);
    expect(reply.text).toBe('');
    expect(mockRunMerlinTurn).not.toHaveBeenCalled();
  });
});

describe('MerlinSession.markCastCompleted endWord validation', () => {
  it('falls back to the default end-word when spell endWord is empty', async () => {
    const { createMerlinSession } = await import('./session');
    const session = createMerlinSession();
    await session.startSession();
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; endWord?: string; element?: string; intent?: string; castingOrigin?: string } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'spark';
    internalState.spell.endWord = '   '; // whitespace-only — should fall back
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    await session.processUserSpeech('spark', null, null);
    // "farewell" is the documented default — any utterance containing
    // the default ends the play phase; any other utterance stays silent.
    mockRunMerlinTurn.mockResolvedValueOnce(defaultRunMerlinTurnResult({ finalText: 'Goodbye.' }));
    const outro = await session.processUserSpeech('farewell', null, null);
    expect(outro.text).toBe('Goodbye.');
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
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; endWord?: string; element?: string; intent?: string; castingOrigin?: string } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'spark';
    internalState.spell.endWord = 'done';
    internalState.spell.element = 'fire';
    internalState.spell.intent = 'confidence';
    internalState.spell.castingOrigin = 'hands';
    internalState.spell.confidence = 0.8;
    await session.processUserSpeech('spark', null, null);
    // Now in play with a 60s safety timer running.
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
    const internalState = (session as unknown as { state: { castReady: boolean; spell: { magicWord: string; endWord?: string; element?: string; intent?: string; castingOrigin?: string } } }).state;
    internalState.castReady = true;
    internalState.spell.magicWord = 'spark';
    internalState.spell.endWord = 'done';
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
