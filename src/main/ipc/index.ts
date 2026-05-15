/**
 * Barrel for IPC registrars. The main-process bootstrap calls
 * `registerAllIPC(ctx)` once during `app.whenReady()`.
 *
 * Registration order matters because some handlers are fired by the
 * renderer before others (e.g. tracking frames may start streaming
 * before the merlin handlers are needed). Listed bottom-up: system
 * IPC first, then Merlin live, then test mode, then TTS.
 */

import type { MainContext } from './types';
import { registerSystemIPC } from './system';
import { registerMerlinIPC } from './merlin';
import { registerMerlinTestIPC } from './merlin-test';
import { registerTTSIPC } from './tts';

export type { MainContext, MainContextRefs } from './types';

export function registerAllIPC(ctx: MainContext): void {
  registerSystemIPC(ctx);
  registerMerlinIPC(ctx);
  registerMerlinTestIPC(ctx);
  registerTTSIPC(ctx);
}
