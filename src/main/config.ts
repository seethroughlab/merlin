/**
 * Centralized configuration for the Merlin main process.
 *
 * Hosts ports, timeouts, and retry counts that were previously
 * sprinkled as literals across modules. When a value lives here, the
 * call site imports it instead of inlining the number — making
 * "what port does X use?" answerable with a single grep.
 *
 * Convention: this file holds cross-module knobs (anything touched by
 * more than one file, anything a deployer or operator would tune).
 * Module-local timings that have strong contextual meaning — e.g.
 * `PLAY_PHASE_MAX_MS` and `DEFAULT_CAST_ENVELOPE` in `merlin/session.ts`
 * — stay near their callers where the rationale is documented in
 * context. When in doubt: if a new contributor would have to read two
 * files to understand what the number does, put it here.
 *
 * Note: `scripts/kill-stale-merlin.cjs` keeps its own literal because
 * predev runs before the TS build. Keep the two in sync.
 */

export const PORTS = {
  /** WebSocket port the TD bridge listens on for the TouchDesigner client. */
  TD_BRIDGE: 8001,
  /** HTTP trigger port for the Conversation Tester (curl-driven preset runs). */
  CONVERSATION_TEST: 8765,
} as const;

export const TIMEOUTS = {
  /** Default screenshot round-trip timeout. */
  TD_SCREENSHOT_MS: 5000,
  /** Default sprite-load ACK timeout. Image IO from TD's movieFileIn TOP isn't compute-bound. */
  TD_SPRITE_LOAD_MS: 8000,
  /** Default GLSL compile result timeout. TD's _info DAT writeback can stall briefly under load. */
  TD_COMPILE_RESULT_MS: 5000,
} as const;

export const RETRY = {
  /** Max attempts (including the first) for retryable API failures. */
  MAX_ATTEMPTS: 3,
  /** Initial backoff delay before the first retry. */
  BASE_DELAY_MS: 1000,
  /** Hard cap on any individual backoff delay. */
  MAX_DELAY_MS: 10_000,
} as const;
