import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @google/genai mock: a fake `models.generateContent` we can program
// per-test. The module under test holds a singleton GoogleGenAI built
// the first time `ensureGenAI()` runs, so we resetModules() per test
// to get a fresh singleton wired to the freshly-cleared mock.
const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

// withRetry forwards on the first call when the inner promise resolves;
// stub it to call through so we don't sit through real backoff in tests.
vi.mock('../retry', () => ({
  withRetry: <T>(fn: () => Promise<T>) => fn(),
}));

function geminiTextResponse(text: string) {
  return { text };
}

const VALID_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe('isGeminiAvailable', () => {
  it('returns true when GEMINI_API_KEY is set', async () => {
    const { isGeminiAvailable } = await import('./gemini-analysis');
    expect(isGeminiAvailable()).toBe(true);
  });

  it('returns false when GEMINI_API_KEY is unset', async () => {
    delete process.env.GEMINI_API_KEY;
    const { isGeminiAvailable } = await import('./gemini-analysis');
    expect(isGeminiAvailable()).toBe(false);
  });
});

describe('analyzeMicroExpressions', () => {
  it('calls Gemini with the micro-expression prompt + image part and parses JSON', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiTextResponse(JSON.stringify({
        valence: 0.4,
        arousal: 0.6,
        primaryEmotion: 'wonder',
        confidence: 0.85,
        microExpressions: [],
        description: 'A subtle widening of the eyes.',
      })),
    );

    const { analyzeMicroExpressions } = await import('./gemini-analysis');
    const result = await analyzeMicroExpressions(VALID_DATA_URL);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3-flash-preview');
    // The contents array carries one user message with text + inlineData parts.
    const parts = call.contents[0].parts;
    expect(parts[0].text).toMatch(/micro-expression analysis/i);
    expect(parts[1].inlineData.mimeType).toBe('image/png');
    expect(typeof parts[1].inlineData.data).toBe('string');

    expect(result.primaryEmotion).toBe('wonder');
    expect(result.valence).toBe(0.4);
    expect(result.rawResponse).toContain('wonder');
  });

  it('throws on an invalid data URL', async () => {
    const { analyzeMicroExpressions } = await import('./gemini-analysis');
    await expect(analyzeMicroExpressions('not-a-data-url')).rejects.toThrow(/Invalid image data URL/);
  });

  it('throws when the model returns no JSON object', async () => {
    mockGenerateContent.mockResolvedValue(geminiTextResponse("I can't help with that."));
    const { analyzeMicroExpressions } = await import('./gemini-analysis');
    await expect(analyzeMicroExpressions(VALID_DATA_URL)).rejects.toThrow(/Invalid response format/);
  });
});

describe('analyzeBodyLanguage', () => {
  it('coerces missing or non-numeric fields to documented defaults', async () => {
    // Model omits everything except a single nonsense field — defaults
    // should fill in the gaps without throwing.
    mockGenerateContent.mockResolvedValue(geminiTextResponse(JSON.stringify({
      unrelated: 'foo',
    })));

    const { analyzeBodyLanguage } = await import('./gemini-analysis');
    const result = await analyzeBodyLanguage(VALID_DATA_URL);

    expect(result.openness).toBe(0);
    expect(result.tension).toBe(0);
    expect(result.engagement).toBe(0);
    expect(result.primaryPosture).toBe('unknown');
    expect(result.gestureTypes).toEqual([]);
    expect(result.movementLevel).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.observations).toEqual([]);
    expect(result.description).toBe('No description available');
  });

  it('passes valid fields through and preserves rawResponse', async () => {
    const rawJson = JSON.stringify({
      openness: 0.7,
      tension: 0.2,
      engagement: 0.8,
      primaryPosture: 'expansive',
      gestureTypes: ['raise_hands', 'lean_in'],
      movementLevel: 0.5,
      confidence: 0.9,
      observations: ['shoulders relaxed'],
      description: 'They appear engaged and open.',
    });
    mockGenerateContent.mockResolvedValue(geminiTextResponse(rawJson));

    const { analyzeBodyLanguage } = await import('./gemini-analysis');
    const result = await analyzeBodyLanguage(VALID_DATA_URL);

    expect(result.openness).toBe(0.7);
    expect(result.primaryPosture).toBe('expansive');
    expect(result.gestureTypes).toEqual(['raise_hands', 'lean_in']);
    expect(result.rawResponse).toBe(rawJson);
  });

  it('uses the body-language prompt, not the micro-expression prompt', async () => {
    mockGenerateContent.mockResolvedValue(geminiTextResponse('{}'));
    const { analyzeBodyLanguage } = await import('./gemini-analysis');
    await analyzeBodyLanguage(VALID_DATA_URL);
    const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(promptText).toMatch(/body language/i);
    expect(promptText).not.toMatch(/micro-expression analysis/i);
  });
});
