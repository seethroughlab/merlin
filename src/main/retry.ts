/**
 * Exponential-backoff retry helper for external API calls.
 *
 * Used by gemini-chat, sprite-generator, and gemini.ts to ride out
 * transient failures from Gemini / Imagen — rate limits (429), server
 * errors (5xx), and network blips — without crashing the session. Auth
 * errors (401/403), 4xx other than 429, and the absence of an API key
 * are not retryable.
 */

export interface RetryOptions {
  /** Max attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Initial delay before first retry, ms. Default 1000. Doubles each retry. */
  baseDelayMs?: number;
  /** Hard cap on any single delay so a long backoff doesn't stall the UI. Default 10s. */
  maxDelayMs?: number;
  /** Label used in log lines so callers can tell which API was retrying. */
  label?: string;
}

/**
 * Decide whether an error is worth retrying. The @google/genai SDK
 * surfaces HTTP failures with the status code in `.status` or embedded
 * in the message; node-side network failures use the standard errno
 * codes. We intentionally don't retry 4xx other than 429 — those usually
 * mean a bug in our request (bad model name, bad params) and retrying
 * just delays the inevitable.
 */
export function isRetryableError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e.status === 'number') {
    return e.status === 429 || (e.status >= 500 && e.status < 600);
  }
  const msg = (e.message ?? '').toLowerCase();
  if (/\b(429|rate.?limit|quota|resource_exhausted)\b/.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg) && /server|internal|unavailable|gateway/.test(msg)) return true;
  if (typeof e.code === 'string') {
    if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(e.code)) {
      return true;
    }
  }
  if (/econnreset|etimedout|fetch failed|network/i.test(msg)) return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const label = opts.label ?? 'retry';

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[retry:${label}] attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 120)}). Retrying in ${delay}ms.`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
