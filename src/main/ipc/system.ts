/**
 * System-level IPC: tracking input, gesture events, analysis IPC,
 * bridge/TD status, settings, Spout sender rename + portrait toggle,
 * participant (Claude) generation, and the Conversation Tester
 * transcript saver. "Everything not Merlin or TTS."
 */

import { ipcMain } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MainContext } from './types';
import type {
  TrackingFrame,
  BodyLanguageAnalysis,
  MicroExpressionAnalysis,
} from '../../shared/types';
import {
  isConnected as isTDConnected,
  isTDReady,
  pushOrientationUpdate,
  pushTrackingFrame,
  state as tdState,
} from '../td-bridge';
import { analyzeMicroExpressions, analyzeBodyLanguage, isGeminiAvailable } from '../merlin/gemini-analysis';
import { getAllSettings, setSetting } from '../settings';
import { resizeSpoutSender, wireWindowToSender } from '../spout';
import { generateParticipantLine, isParticipantLLMAvailable, type ParticipantRequest } from '../participant';
import { pushFaceEvent } from '../merlin/face-event-buffer';
import { PORTS } from '../config';

export function registerSystemIPC(ctx: MainContext): void {
  // Tracking frames. Only accept from the main preview window — the
  // Spout / mask windows render the same scene but mustn't double-push.
  ipcMain.on('tracking-frame', (event, data: TrackingFrame) => {
    const mw = ctx.getMainWindow();
    if (mw && event.sender.id === mw.webContents.id) {
      if (isTDConnected()) {
        pushTrackingFrame(data);
      }
    }
  });

  // Face-gesture trigger events (mouth_open, smile, brow_raise, eye_closed).
  // Buffered for Gemini's get_face_events tool + the per-turn context
  // summarizer.
  ipcMain.on('face-gesture', (event, evt: { kind: string; edge: 'start' | 'end'; score: number; timestamp: number }) => {
    const mw = ctx.getMainWindow();
    if (!mw || event.sender.id !== mw.webContents.id) return;
    console.log(`[FaceGesture ${ctx.ts()}] ${evt.kind} ${evt.edge} score=${evt.score.toFixed(2)}`);
    pushFaceEvent(evt.kind, evt.edge, evt.score);
  });

  // Renderer's response to a request-analysis push (resolves the
  // promise stored in pendingAnalysisRequests by requestFreshAnalysis).
  ipcMain.on('analysis-result', (_event, data: { requestId: string; result: unknown }) => {
    const resolver = ctx.refs.pendingAnalysisRequests.get(data.requestId);
    if (resolver) {
      console.log(`[Analysis ${ctx.ts()}] Received result for ${data.requestId}`);
      ctx.refs.pendingAnalysisRequests.delete(data.requestId);
      resolver(data.result);
    }
  });

  // Filmstrip analyses (renderer composites the strip image and POSTs it here).
  ipcMain.handle('analyze-face-strip', async (_event, imageDataUrl: string) => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }
    console.log('Analyzing face strip...');
    const startTime = Date.now();
    try {
      const analysis = await analyzeMicroExpressions(imageDataUrl);
      console.log(`Face analysis complete in ${Date.now() - startTime}ms`);
      console.log('Result:', JSON.stringify(analysis, null, 2));
      return analysis;
    } catch (error) {
      console.error('Face strip analysis failed:', error);
      throw error;
    }
  });

  ipcMain.handle('analyze-skeleton-strip', async (_event, imageDataUrl: string) => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }
    console.log('Analyzing skeleton strip for body language...');
    const startTime = Date.now();
    try {
      const analysis = await analyzeBodyLanguage(imageDataUrl);
      console.log(`Body language analysis complete in ${Date.now() - startTime}ms`);
      console.log('Result:', JSON.stringify(analysis, null, 2));
      return analysis;
    } catch (error) {
      console.error('Skeleton strip analysis failed:', error);
      throw error;
    }
  });

  // Spout sender renaming (sidebar text input).
  ipcMain.handle('rename-spout-sender', async (_event, oldName: string, newName: string) => {
    console.log(`Renaming Spout sender: ${oldName} -> ${newName}`);
    try {
      const { renameSpoutSender } = await import('../spout');
      return renameSpoutSender(oldName, newName);
    } catch (error) {
      console.error('Failed to rename Spout sender:', error);
      return false;
    }
  });

  // Bridge / TD status reads.
  ipcMain.handle('get-bridge-stats', () => ({
    connected: isTDConnected(),
    port: PORTS.TD_BRIDGE,
  }));

  ipcMain.handle('td-get-status', () => ({
    connected: isTDConnected(),
    ready: isTDReady(),
    capabilities: tdState.capabilities,
  }));

  // Settings persistence (electron-store).
  ipcMain.handle('get-settings', () => getAllSettings());

  ipcMain.handle('save-setting', (_event, key: string, value: unknown) => {
    setSetting(key as keyof ReturnType<typeof getAllSettings>, value as never);
    return true;
  });

  // Claude-as-participant for the Conversation Tester. Returns null
  // when ANTHROPIC_API_KEY is unset; the renderer falls back to the
  // preset's canned script in that case.
  ipcMain.handle('generate-participant-line', async (_event, req: ParticipantRequest) => {
    try {
      const line = await generateParticipantLine(req);
      return { ok: true, line, available: isParticipantLLMAvailable() };
    } catch (err) {
      console.error('[Participant] generate failed:', err);
      return { ok: false, error: String(err), available: isParticipantLLMAvailable() };
    }
  });

  ipcMain.handle('participant-llm-available', () => isParticipantLLMAvailable());

  // Save a Conversation Tester transcript to logs/ so Claude (or any
  // external caller) can read it without copy/paste from the renderer
  // console.
  ipcMain.handle('save-conversation-transcript', (_event, payload: { id: string; json: string }) => {
    try {
      const logsDir = join(process.cwd(), 'logs');
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      const safeId = (payload.id || 'unnamed').replace(/[^a-zA-Z0-9_-]/g, '_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(logsDir, `conversation-test-${stamp}-${safeId}.json`);
      writeFileSync(path, payload.json, 'utf8');
      console.log(`[ConversationTest] Transcript saved: ${path}`);
      return { ok: true, path };
    } catch (err) {
      console.error('[ConversationTest] Failed to save transcript:', err);
      return { ok: false, error: String(err) };
    }
  });

  // Portrait toggle: resize Spout senders + windows + the TD-side
  // sampler, then broadcast the new orientation to every window so the
  // canvas dimensions stay coherent.
  ipcMain.on('set-portrait-mode', async (_event, portrait: boolean) => {
    console.log(`Portrait mode: ${portrait}`);

    const width = portrait ? 720 : 1280;
    const height = portrait ? 1280 : 720;

    await resizeSpoutSender('Merlin', width, height);
    await resizeSpoutSender('Merlin Mask', width, height);

    const spoutWindow = ctx.getSpoutWindow();
    if (spoutWindow && !spoutWindow.isDestroyed()) {
      spoutWindow.setSize(width, height);
      wireWindowToSender(spoutWindow, 'Merlin', 30);
    }
    const maskWindow = ctx.getMaskWindow();
    if (maskWindow && !maskWindow.isDestroyed()) {
      maskWindow.setSize(width, height);
      wireWindowToSender(maskWindow, 'Merlin Mask', 30);
    }

    for (const win of [ctx.getMainWindow(), spoutWindow, maskWindow]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('portrait-mode-changed', portrait);
      }
    }

    if (isTDConnected()) {
      pushOrientationUpdate(portrait, width, height);
      console.log(`Sent orientation to TD: ${portrait ? 'portrait' : 'landscape'} ${width}x${height}`);
    }
  });

  // Cached body/face analysis push from the renderer. Read by
  // processUserSpeech the next time it runs.
  ipcMain.on('merlin-update-analysis', (_event, data: {
    body?: Partial<BodyLanguageAnalysis>;
    face?: Partial<MicroExpressionAnalysis>;
  }) => {
    if (data.body) ctx.refs.lastBodyAnalysis = data.body;
    if (data.face) ctx.refs.lastFaceAnalysis = data.face;
  });
}
