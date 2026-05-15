/**
 * Shared shape passed from the main-process bootstrap (`src/main/index.ts`)
 * into each IPC registrar. The handlers were lifted out of `index.ts`
 * into topical files (`system.ts`, `merlin.ts`, etc.); they need read +
 * write access to the bootstrap's mutable state, so we pass that state
 * via a `MainContext` rather than pulling handler bodies back into
 * `index.ts` or smuggling state through module-level singletons.
 *
 * Conventions:
 * - Window references can be re-assigned (close + reopen), so they're
 *   exposed via getters that always return the current value rather
 *   than a captured reference.
 * - Other mutable values (`session`, `lastBodyAnalysis`, …) live in a
 *   single `refs` bag. Handlers both read (`ctx.refs.session?.getState()`)
 *   and write (`ctx.refs.session = null`). One bag beats a wall of
 *   getter/setter pairs.
 * - Helpers that need to stay co-located with the bootstrap's local
 *   state (`broadcastMerlinUpdate`, `createMerlinSession`) are exposed
 *   as methods on the context rather than imported separately.
 */

import type { BrowserWindow } from 'electron';
import type { MerlinSession } from '../merlin';
import type {
  BodyLanguageAnalysis,
  MicroExpressionAnalysis,
  MerlinUIUpdate,
} from '../../shared/types';

export interface MainContextRefs {
  session: MerlinSession | null;
  lastBodyAnalysis: Partial<BodyLanguageAnalysis> | null;
  lastFaceAnalysis: Partial<MicroExpressionAnalysis> | null;
  pendingAnalysisRequests: Map<string, (result: unknown) => void>;
}

export interface MainContext {
  getMainWindow(): BrowserWindow | null;
  getSpoutWindow(): BrowserWindow | null;
  getMaskWindow(): BrowserWindow | null;

  refs: MainContextRefs;

  /** Short timestamp helper (HH:MM:SS.mmm) used in log lines. */
  ts(): string;

  /** Broadcast a Merlin UI update to every live BrowserWindow. */
  broadcastMerlinUpdate(update: MerlinUIUpdate): void;

  /** Construct a fresh MerlinSession (wired up with all the bootstrap callbacks). */
  createMerlinSession(): MerlinSession;
}
