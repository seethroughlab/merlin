/**
 * HTTP trigger for the Conversation Tester.
 *
 * Listens on localhost:8765 so an external caller (e.g. Claude via curl
 * or the dev from a terminal) can kick off a preset run without having
 * to open the Shift+T panel and click Run.
 *
 * Flow:
 *   1. POST /run-conversation  body: { presetId, claudeDriven? }
 *   2. Main forwards via IPC to the renderer's runner
 *   3. Renderer runs the test, saves the transcript, signals completion
 *   4. Main resolves the HTTP response with the transcript path
 *
 * Returns { ok: false } if no run completes within 5 minutes.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { PORTS } from './config';

const PORT = Number(process.env.MERLIN_TEST_TRIGGER_PORT ?? PORTS.CONVERSATION_TEST);
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingRun {
  resolve: (result: { ok: boolean; transcriptPath?: string; error?: string }) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingRun>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function nextRequestId(): string {
  return `cvr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function startConversationTestTrigger(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on('conversation-test-complete', (_event, payload: { requestId: string; transcriptPath?: string; error?: string }) => {
    const entry = pending.get(payload.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(payload.requestId);
    if (payload.error) {
      entry.resolve({ ok: false, error: payload.error });
    } else {
      entry.resolve({ ok: true, transcriptPath: payload.transcriptPath });
    }
  });

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/run-conversation') {
      try {
        const raw = await readBody(req);
        const { presetId, claudeDriven } = JSON.parse(raw || '{}') as {
          presetId?: string;
          claudeDriven?: boolean;
        };
        if (!presetId) {
          respondJson(res, 400, { ok: false, error: 'presetId required' });
          return;
        }
        const win = getMainWindow();
        if (!win) {
          respondJson(res, 503, { ok: false, error: 'main window not available' });
          return;
        }
        const requestId = nextRequestId();
        const result = await new Promise<{ ok: boolean; transcriptPath?: string; error?: string }>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve({ ok: false, error: 'timeout waiting for run to complete' });
          }, RUN_TIMEOUT_MS);
          pending.set(requestId, { resolve, timer });
          win.webContents.send('conversation-test-trigger', {
            requestId,
            presetId,
            claudeDriven: claudeDriven ?? true,
          });
        });
        respondJson(res, result.ok ? 200 : 500, result);
      } catch (err) {
        respondJson(res, 500, { ok: false, error: String(err) });
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      respondJson(res, 200, { ok: true });
      return;
    }
    respondJson(res, 404, { ok: false, error: 'not found' });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[ConversationTestTrigger] Port ${PORT} in use; trigger HTTP disabled.`);
    } else {
      console.error('[ConversationTestTrigger] Server error:', err);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ConversationTestTrigger] Listening on http://127.0.0.1:${PORT}`);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
