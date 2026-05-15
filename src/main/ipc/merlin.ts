/**
 * Merlin live-session IPC: startSession, processUserSpeech,
 * background cast trigger, end, get-state, plus the persistence
 * handlers (list/save/load/delete a session).
 */

import { ipcMain } from 'electron';
import type { MainContext } from './types';
import {
  isConnected as isTDConnected,
  pushMerlinState,
  pushZoneUpdateWithValidation,
} from '../td-bridge';
import { isGeminiAvailable } from '../merlin/gemini-analysis';
import { clearFaceEventBuffer } from '../merlin/face-event-buffer';
import {
  saveSessionState,
  loadSessionState,
  applySessionState,
  listSavedSessions,
  deleteSession,
} from '../merlin/state-persistence';

export function registerMerlinIPC(ctx: MainContext): void {
  // Start a Merlin session.
  ipcMain.handle('merlin-start', async () => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }

    console.log(`[Merlin ${ctx.ts()}] Starting session...`);
    // Drop any stale face events from a previous participant before the
    // new session starts emitting its own.
    clearFaceEventBuffer();
    ctx.refs.session = ctx.createMerlinSession();

    try {
      const response = await ctx.refs.session.startSession();

      if (isTDConnected()) {
        pushMerlinState({
          active: true,
          phase: response.phase,
          spell: response.spell,
        });
      }

      ctx.broadcastMerlinUpdate({
        phase: response.phase,
        turnCount: 0,
        spell: response.spell,
        isListening: false,
        isProcessing: false,
      });

      return response;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Failed to start session:`, error);
      ctx.refs.session = null;
      throw error;
    }
  });

  // Process user speech for the current session turn.
  ipcMain.handle('merlin-process-speech', async (_event, transcript: string) => {
    if (!ctx.refs.session || !ctx.refs.session.isActive()) {
      throw new Error('Merlin session not active');
    }

    console.log(`[Merlin ${ctx.ts()}] Processing: "${transcript}"`);

    try {
      const response = await ctx.refs.session.processUserSpeech(
        transcript,
        ctx.refs.lastBodyAnalysis,
        ctx.refs.lastFaceAnalysis,
      );

      const state = ctx.refs.session.getState();

      if (isTDConnected()) {
        pushMerlinState({
          active: true,
          phase: response.phase,
          spell: response.spell,
        });
      }

      ctx.broadcastMerlinUpdate({
        phase: response.phase,
        turnCount: state.turnCount,
        spell: response.spell,
        isListening: false,
        isProcessing: false,
      });

      return response;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Failed to process speech:`, error);
      throw error;
    }
  });

  // Background cast trigger — the renderer's armed local matcher fires
  // this the moment the participant says the magic word. Bypasses
  // Gemini entirely. Subsequent re-casts during the play phase reset
  // the inactivity timer in MerlinSession.triggerCast().
  ipcMain.handle('merlin-trigger-cast', async () => {
    if (!ctx.refs.session || !ctx.refs.session.isActive()) {
      return { ok: false, reason: 'session not active' };
    }
    console.log(`[Merlin ${ctx.ts()}] Background cast trigger fired`);
    ctx.refs.session.triggerCast();
    const spell = ctx.refs.session.getSpell();
    const state = ctx.refs.session.getState();
    if (isTDConnected()) {
      pushMerlinState({ active: true, phase: state.phase, spell });
    }
    ctx.broadcastMerlinUpdate({
      phase: state.phase,
      turnCount: state.turnCount,
      spell,
      isListening: false,
      isProcessing: false,
    });
    return { ok: true, phase: state.phase };
  });

  // End the current session.
  ipcMain.handle('merlin-end', async () => {
    if (!ctx.refs.session) {
      return { text: 'Session was not active.', phase: 'idle', spell: null };
    }

    console.log(`[Merlin ${ctx.ts()}] Ending session...`);

    try {
      const response = await ctx.refs.session.endSession();

      if (isTDConnected()) {
        pushMerlinState({
          active: false,
          phase: 'idle',
        });
      }

      ctx.broadcastMerlinUpdate({
        phase: 'idle',
        turnCount: 0,
        spell: response.spell,
        isListening: false,
        isProcessing: false,
      });

      ctx.refs.session = null;
      return response;
    } catch (error) {
      console.error('[Merlin] Failed to end session:', error);
      ctx.refs.session = null;
      throw error;
    }
  });

  // Read the current session state (used by the renderer's sidebar
  // refresh + by the session-save handler).
  ipcMain.handle('merlin-get-state', () => {
    if (!ctx.refs.session) return null;
    return {
      state: ctx.refs.session.getState(),
      spell: ctx.refs.session.getSpell(),
      history: ctx.refs.session.getConversationHistory(),
      isActive: ctx.refs.session.isActive(),
    };
  });

  // ============ SESSION PERSISTENCE ============

  ipcMain.handle('merlin-list-sessions', async () => listSavedSessions());

  ipcMain.handle('merlin-save-session', async (_event, name?: string) => {
    const state = ctx.refs.session?.getState();
    if (!state) return { success: false, error: 'No active session' };
    const id = `session_${Date.now()}`;
    const ok = saveSessionState(id, state.spell, name ? { name } : undefined);
    return { success: ok, sessionId: id };
  });

  ipcMain.handle('merlin-load-session', async (_event, sessionId: string) => {
    const state = loadSessionState(sessionId);
    if (!state) return { success: false, error: 'Session not found' };
    applySessionState(state);
    const zoneResults: Record<string, boolean> = {};
    for (const [zone, code] of Object.entries(state.zones)) {
      if (code) {
        const result = await pushZoneUpdateWithValidation(zone, code);
        zoneResults[zone] = result.success;
      }
    }
    return { success: true, spell: state.spell, zoneResults };
  });

  ipcMain.handle('merlin-delete-session', async (_event, sessionId: string) => ({
    success: deleteSession(sessionId),
  }));
}
