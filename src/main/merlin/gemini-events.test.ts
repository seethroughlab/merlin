import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setMainWindow, emitGeminiTurn, nextTurnId } from './gemini-events';

function makeWindow(opts: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: { send: vi.fn() },
  };
}

beforeEach(() => {
  // Reset publisher state by passing a new window in each test.
});

describe('nextTurnId', () => {
  it('returns a unique-ish string per call', () => {
    const a = nextTurnId();
    const b = nextTurnId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe('emitGeminiTurn', () => {
  it('sends to the gemini-conversation channel with the expected payload', () => {
    const win = makeWindow();
    setMainWindow(win as unknown as Electron.BrowserWindow);

    const id = nextTurnId();
    emitGeminiTurn({ id, source: 'test_shader', userPrompt: 'hello' });

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = win.webContents.send.mock.calls[0];
    expect(channel).toBe('gemini-conversation');
    expect(payload.id).toBe(id);
    expect(payload.source).toBe('test_shader');
    expect(payload.userPrompt).toBe('hello');
    expect(typeof payload.createdAt).toBe('number');
  });

  it('preserves an explicit createdAt instead of overriding it', () => {
    const win = makeWindow();
    setMainWindow(win as unknown as Electron.BrowserWindow);

    emitGeminiTurn({ id: 'x', source: 'live', createdAt: 12345 });
    expect(win.webContents.send.mock.calls[0][1].createdAt).toBe(12345);
  });

  it('no-ops when the window is destroyed', () => {
    const win = makeWindow({ destroyed: true });
    setMainWindow(win as unknown as Electron.BrowserWindow);

    emitGeminiTurn({ id: 'x', source: 'live' });
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('truncates long string fields inside tool-call args', () => {
    const win = makeWindow();
    setMainWindow(win as unknown as Electron.BrowserWindow);

    const long = 'a'.repeat(1000);
    emitGeminiTurn({
      id: 'x',
      source: 'test_shader',
      toolCalls: [{ name: 'set_zone_shader', args: { zone: 'force_field', glsl_code: long, description: 'short desc' } }],
    });

    const payload = win.webContents.send.mock.calls[0][1];
    expect(payload.toolCalls[0].args.glsl_code.length).toBeLessThan(long.length);
    expect(payload.toolCalls[0].args.glsl_code.endsWith('… (truncated)')).toBe(true);
    // Short strings are left alone
    expect(payload.toolCalls[0].args.description).toBe('short desc');
    // Non-string fields are unchanged
    expect(payload.toolCalls[0].args.zone).toBe('force_field');
  });

  it('truncates nested string fields recursively', () => {
    const win = makeWindow();
    setMainWindow(win as unknown as Electron.BrowserWindow);

    const long = 'b'.repeat(800);
    emitGeminiTurn({
      id: 'x',
      source: 'test_live_spell',
      toolCalls: [{ name: 'set_zone_shader', args: { zone: 'force_field', glsl_code: long, description: '#ff0000' } }],
    });

    const payload = win.webContents.send.mock.calls[0][1];
    expect(payload.toolCalls[0].args.glsl_code.length).toBeLessThan(long.length);
    expect(payload.toolCalls[0].args.description).toBe('#ff0000');
  });

  it('emits each call separately when called multiple times for the same turn id', () => {
    const win = makeWindow();
    setMainWindow(win as unknown as Electron.BrowserWindow);

    const id = nextTurnId();
    emitGeminiTurn({ id, source: 'live', userPrompt: 'hi' });
    emitGeminiTurn({ id, source: 'live', responseText: 'reply' });
    emitGeminiTurn({ id, source: 'live', final: true });

    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });

  it('swallows webContents.send throws so callers do not crash', () => {
    const win = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(() => { throw new Error('boom'); }) },
    };
    setMainWindow(win as unknown as Electron.BrowserWindow);

    expect(() => emitGeminiTurn({ id: 'x', source: 'live' })).not.toThrow();
  });
});
