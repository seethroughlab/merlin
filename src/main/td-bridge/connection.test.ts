import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// === Mocks ===

// Lightweight stand-ins for ws.WebSocketServer and ws.WebSocket. Tests
// drive event handlers directly to simulate TD connect/disconnect/
// message flows without touching the network.
class MockWebSocket extends EventEmitter {
  public readyState: number = 1; // OPEN
  public sentMessages: string[] = [];
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public pingCalled = 0;

  send = vi.fn((data: string) => {
    this.sentMessages.push(data);
  });

  ping = vi.fn(() => {
    this.pingCalled++;
  });

  close = vi.fn((code?: number, reason?: string) => {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    this.emit('close', code ?? 1000, reason ?? '');
  });
}

class MockWebSocketServer extends EventEmitter {
  public closed = false;
  public port: number;

  constructor(opts: { port: number }) {
    super();
    this.port = opts.port;
    // Defer "ready" emit to next tick so the caller can wire handlers.
    setImmediate(() => this.emit('listening'));
  }

  close = vi.fn(() => {
    this.closed = true;
  });

  triggerError(err: NodeJS.ErrnoException): void {
    this.emit('error', err);
  }

  triggerConnection(ws: MockWebSocket): void {
    this.emit('connection', ws);
  }
}

let currentServer: MockWebSocketServer | null = null;

vi.mock('ws', () => {
  return {
    WebSocketServer: class WrappedServer extends MockWebSocketServer {
      constructor(opts: { port: number }) {
        super(opts);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        currentServer = self;
      }
    },
    WebSocket: {
      OPEN: 1,
      CLOSED: 3,
    },
  };
});

// Stub the protocol dispatcher so handleInbound is observable here.
const handleInboundMock = vi.fn();
vi.mock('./protocol', () => ({
  handleInbound: (...args: unknown[]) => handleInboundMock(...args),
}));

// === Helpers ===

async function freshModule(): Promise<typeof import('./connection')> {
  vi.resetModules();
  return await import('./connection');
}

async function tick(): Promise<void> {
  // Let setImmediate / microtasks resolve.
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentServer = null;
});

afterEach(() => {
  // Make sure no module-level intervals leak between tests.
  vi.useRealTimers();
});

describe('startServer', () => {
  it('opens a server on the given port', async () => {
    const mod = await freshModule();
    mod.startServer(9001);
    expect(currentServer?.port).toBe(9001);
    expect(mod.isConnected()).toBe(false); // no client yet
  });

  it('soft-fails when port is in use (EADDRINUSE)', async () => {
    const mod = await freshModule();
    const onError = vi.fn();
    mod.startServer(9002, { onError });
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    currentServer!.triggerError(err as NodeJS.ErrnoException);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('in use'));
    // App remains usable; state.connected stays false rather than throwing.
    expect(mod.isConnected()).toBe(false);
  });

  it('surfaces non-EADDRINUSE server errors via onError', async () => {
    const mod = await freshModule();
    const onError = vi.fn();
    mod.startServer(9003, { onError });
    const err = Object.assign(new Error('boom'), { code: 'EOTHER' });
    currentServer!.triggerError(err as NodeJS.ErrnoException);
    expect(onError).toHaveBeenCalledWith('boom');
  });
});

describe('client connect / disconnect', () => {
  it('marks connected on TD connection and fires onConnect', async () => {
    const mod = await freshModule();
    const onConnect = vi.fn();
    mod.startServer(9004, { onConnect });
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    expect(onConnect).toHaveBeenCalled();
    expect(mod.isConnected()).toBe(true);
  });

  it('rejects a second concurrent client', async () => {
    const mod = await freshModule();
    mod.startServer(9005);
    const first = new MockWebSocket();
    currentServer!.triggerConnection(first);
    const second = new MockWebSocket();
    currentServer!.triggerConnection(second);
    expect(second.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('counts as reconnect when a new client arrives while the previous is half-closed', async () => {
    // The bumped reconnectCount path fires when `client` is non-null
    // but its socket is no longer OPEN — i.e. TD's reconnect arrived
    // before the underlying close event reached us. Simulate that by
    // flipping readyState to CLOSED without emitting 'close'.
    const mod = await freshModule();
    mod.startServer(9006);
    const first = new MockWebSocket();
    currentServer!.triggerConnection(first);
    first.readyState = 3; // CLOSED, but no 'close' event yet
    const second = new MockWebSocket();
    currentServer!.triggerConnection(second);
    expect(mod.getConnectionStats().connected).toBe(true);
    expect(mod.getConnectionStats().reconnectCount).toBe(1);
  });

  it('fires onDisconnect when client emits close', async () => {
    const mod = await freshModule();
    const onDisconnect = vi.fn();
    mod.startServer(9007, { onDisconnect });
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    ws.emit('close', 1000, 'normal');
    expect(onDisconnect).toHaveBeenCalled();
    expect(mod.isConnected()).toBe(false);
  });
});

describe('inbound messages', () => {
  it('routes JSON messages through handleInbound', async () => {
    const mod = await freshModule();
    mod.startServer(9008);
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'td_ready', capabilities: { x: 1 } })));
    expect(handleInboundMock).toHaveBeenCalledWith(
      { type: 'td_ready', capabilities: { x: 1 } },
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('silently handles malformed JSON without crashing', async () => {
    const mod = await freshModule();
    mod.startServer(9009);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    expect(() => ws.emit('message', Buffer.from('not json'))).not.toThrow();
    expect(err).toHaveBeenCalled();
  });

  it('handles application-level pong without dispatching to protocol', async () => {
    const mod = await freshModule();
    mod.startServer(9010);
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })));
    expect(handleInboundMock).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('returns false when no client is connected', async () => {
    const mod = await freshModule();
    mod.startServer(9011);
    expect(mod.send({ type: 'noop' })).toBe(false);
  });

  it('serializes and sends to the connected client', async () => {
    const mod = await freshModule();
    mod.startServer(9012);
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    const ok = mod.send({ type: 'request_screenshot' });
    expect(ok).toBe(true);
    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'request_screenshot' });
  });
});

describe('stopServer', () => {
  it('closes the client and server and resets state', async () => {
    const mod = await freshModule();
    mod.startServer(9013);
    const ws = new MockWebSocket();
    currentServer!.triggerConnection(ws);
    expect(mod.isConnected()).toBe(true);
    mod.stopServer();
    expect(currentServer!.closed).toBe(true);
    expect(ws.close).toHaveBeenCalled();
    expect(mod.isConnected()).toBe(false);
    expect(mod.getConnectionStats().reconnectCount).toBe(0);
  });
});

describe('getConnectionStats / resetReconnectCount', () => {
  it('exposes current connection state', async () => {
    const mod = await freshModule();
    mod.startServer(9014);
    const stats = mod.getConnectionStats();
    expect(stats.connected).toBe(false);
    expect(stats.tdReady).toBe(false);
    expect(stats.reconnectCount).toBe(0);
  });

  it('resetReconnectCount clears the counter', async () => {
    const mod = await freshModule();
    mod.startServer(9015);
    const first = new MockWebSocket();
    currentServer!.triggerConnection(first);
    first.readyState = 3; // half-closed — see "counts as reconnect" case above
    currentServer!.triggerConnection(new MockWebSocket());
    expect(mod.getConnectionStats().reconnectCount).toBe(1);
    mod.resetReconnectCount();
    expect(mod.getConnectionStats().reconnectCount).toBe(0);
  });
});

// Suppress the "listening" microtask warning if no test triggered it.
afterEach(async () => {
  await tick();
});
