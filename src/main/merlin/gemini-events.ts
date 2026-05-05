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
import type { GeminiTurn } from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

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
  try {
    mainWindow.webContents.send('gemini-conversation', payload);
  } catch (e) {
    console.warn(`[GeminiEvents ${ts()}] Failed to emit turn ${turn.id}: ${e}`);
  }
}
