/**
 * Gemini Events Publisher
 *
 * Tiny event bus that lets test-mode and live-session Gemini callers
 * progressively emit conversation activity to the renderer. The
 * sidebar's #merlin-conversation div listens for these events and
 * renders rich turn cards (system prompt, user prompt, tool calls,
 * per-zone push results, retry markers).
 *
 * Each turn has a stable `id` so progressive emissions for the same
 * turn merge into a single card on the renderer side.
 */

import type { BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type { GeminiToolCall, GeminiTurn } from '../../shared/types';
import { log } from '../logger';

/**
 * Maximum length for any string field inside a tool-call's args before
 * it gets truncated. The renderer only renders a one-line summary, so
 * shipping multi-KB GLSL snippets across IPC is wasteful.
 */
const TOOL_CALL_STRING_MAX = 500;

/**
 * Recursively truncate any string values longer than TOOL_CALL_STRING_MAX
 * in a tool-call's args object. Returns a new object — does not mutate.
 */
function truncateToolCallArgs(call: GeminiToolCall): GeminiToolCall {
  return { name: call.name, args: truncateValue(call.args) as Record<string, unknown> };
}

function truncateValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_CALL_STRING_MAX) {
      return value.slice(0, TOOL_CALL_STRING_MAX) + '… (truncated)';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(truncateValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateValue(v);
    }
    return out;
  }
  return value;
}

let mainWindow: BrowserWindow | null = null;

/**
 * Wire the publisher to the main BrowserWindow. Called once on app boot.
 */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

/**
 * Generate a fresh turn id. Use this when starting a new conversation
 * turn so subsequent emit calls can be associated with it.
 */
export function nextTurnId(): string {
  return uuidv4();
}

/**
 * Emit a partial GeminiTurn. The renderer merges partials by `id`.
 * The first emission for a turn should include `source` and may include
 * `systemPrompt` / `userPrompt`. Later emissions can carry response
 * text, tool calls, push results, retry markers, or a `final: true`.
 */
export function emitGeminiTurn(turn: Partial<GeminiTurn> & Pick<GeminiTurn, 'id' | 'source'>): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload: Partial<GeminiTurn> & Pick<GeminiTurn, 'id' | 'source'> = {
    ...turn,
    createdAt: turn.createdAt ?? Date.now(),
  };
  // Truncate long string fields in tool-call args (e.g. multi-KB
  // glsl_code) so the IPC payload stays small. The renderer only
  // shows a one-line arg summary anyway.
  if (payload.toolCalls) {
    payload.toolCalls = payload.toolCalls.map(truncateToolCallArgs);
  }
  try {
    mainWindow.webContents.send('gemini-conversation', payload);
  } catch (e) {
    log.warn('GeminiEvents', `Failed to emit turn ${turn.id}: ${e}`);
  }
}
