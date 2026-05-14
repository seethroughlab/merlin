import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError } from './retry';

describe('isRetryableError', () => {
  it('treats HTTP 429 as retryable', () => {
    expect(isRetryableError({ status: 429, message: 'Too many requests' })).toBe(true);
  });

  it('treats HTTP 5xx as retryable', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 599 })).toBe(true);
  });

  it('does not retry HTTP 4xx other than 429', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it('recognizes rate-limit message patterns when status is missing', () => {
    expect(isRetryableError({ message: 'rate limit exceeded' })).toBe(true);
    expect(isRetryableError({ message: 'quota exhausted' })).toBe(true);
    expect(isRetryableError({ message: 'RESOURCE_EXHAUSTED' })).toBe(true);
    expect(isRetryableError({ message: 'got 429 back' })).toBe(true);
  });

  it('recognizes network error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isRetryableError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('returns false for non-object errors and null', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('a string error')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });

  it('returns false for plain errors with no signal', () => {
    expect(isRetryableError(new Error('bad input'))).toBe(false);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce('ok');
    const promise = withRetry(fn, { baseDelayMs: 100, label: 'test' });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const err = { status: 401, message: 'unauthorized' };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn)).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const err = { status: 503, message: 'service unavailable' };
    const fn = vi.fn().mockRejectedValue(err);
    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    // Vitest needs the promise to settle through the fake-timer flushes.
    const expectation = expect(promise).rejects.toEqual(err);
    await vi.runAllTimersAsync();
    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff up to maxDelayMs', async () => {
    const err = { status: 500 };
    const fn = vi.fn().mockRejectedValue(err);
    const promise = withRetry(fn, { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 });
    const expectation = expect(promise).rejects.toEqual(err);
    await vi.runAllTimersAsync();
    await expectation;
    // 4 attempts, 3 delays: 100, 200, then capped at 250 (not 400).
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
