/**
 * TD Bridge Connection
 *
 * WebSocket server for TouchDesigner communication.
 * Merlin acts as the server; TD connects as a client.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { TDBridgeState, TDBridgeCallbacks } from './types';
import { handleInbound } from './protocol';
import { PORTS } from '../config';

const DEFAULT_PORT = PORTS.TD_BRIDGE;
const PING_INTERVAL_MS = 30000;
const STALE_TIMEOUT_MS = 60000; // Consider connection stale if no message in 60s
const PONG_TIMEOUT_MS = 10000; // Expect pong within 10s of ping

let wss: WebSocketServer | null = null;
let client: WebSocket | null = null; // Single TD client
let pingInterval: NodeJS.Timeout | null = null;
let staleCheckInterval: NodeJS.Timeout | null = null;
let pongTimeout: NodeJS.Timeout | null = null;
let callbacks: TDBridgeCallbacks = {};
let awaitingPong = false;
let reconnectCount = 0;

export const state: TDBridgeState = {
  connected: false,
  tdReady: false,
  capabilities: null,
  lastMessageTime: 0,
};

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Start the WebSocket server
 */
export function startServer(port: number = DEFAULT_PORT, cbs: TDBridgeCallbacks = {}): void {
  callbacks = cbs;

  wss = new WebSocketServer({ port });
  console.log(`[TDBridge ${ts()}] WebSocket server started on port ${port}`);

  wss.on('connection', handleConnection);
  wss.on('error', (error: NodeJS.ErrnoException) => {
    // EADDRINUSE: another process owns the port. Normally `predev`
    // (scripts/kill-stale-merlin.cjs) reaps stale Merlin instances before we
    // get here, but a third-party listener or a missed kill can still hit
    // this path. Soft-fail so the rest of the app keeps running — Merlin
    // is usable without TD bridge, just degraded.
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[TDBridge ${ts()}] Port ${port} is in use — TD bridge disabled. ` +
          `If a stale Merlin is holding it, restart dev (predev should reap it).`
      );
      state.connected = false;
      callbacks.onError?.(`TD bridge port ${port} in use`);
      return;
    }
    console.error(`[TDBridge ${ts()}] Server error:`, error);
    callbacks.onError?.(error.message);
  });

  // Start ping interval
  pingInterval = setInterval(sendPing, PING_INTERVAL_MS);

  // Start stale connection check
  staleCheckInterval = setInterval(checkStaleConnection, STALE_TIMEOUT_MS / 2);
}

/**
 * Handle new WebSocket connection
 */
function handleConnection(ws: WebSocket): void {
  // Only allow one TD client at a time
  if (client && client.readyState === WebSocket.OPEN) {
    console.log(`[TDBridge ${ts()}] Rejecting new connection (already connected)`);
    ws.close(1008, 'Only one TouchDesigner client allowed');
    return;
  }

  // If we had a previous client, this is a reconnection
  if (client) {
    reconnectCount++;
    console.log(`[TDBridge ${ts()}] TouchDesigner reconnecting (attempt #${reconnectCount})`);
    // Clean up old client
    try {
      client.close();
    } catch {
      // Ignore close errors on stale client
    }
  }

  client = ws;
  state.connected = true;
  state.lastMessageTime = Date.now();
  awaitingPong = false;

  if (pongTimeout) {
    clearTimeout(pongTimeout);
    pongTimeout = null;
  }

  const isReconnect = reconnectCount > 0;
  console.log(`[TDBridge ${ts()}] TouchDesigner ${isReconnect ? 're' : ''}connected`);
  callbacks.onConnect?.();

  ws.on('message', (data) => handleMessage(data.toString()));

  ws.on('close', (code, reason) => {
    console.log(`[TDBridge ${ts()}] TouchDesigner disconnected (code: ${code}, reason: ${reason || 'none'})`);
    client = null;
    state.connected = false;
    state.tdReady = false;
    state.capabilities = null;
    awaitingPong = false;
    callbacks.onDisconnect?.();
  });

  ws.on('error', (error) => {
    console.error(`[TDBridge ${ts()}] Client error:`, error);
    callbacks.onError?.(error.message);
  });

  // Handle native pong frames
  ws.on('pong', () => {
    awaitingPong = false;
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
  });
}

/**
 * Handle incoming message from TD
 */
function handleMessage(raw: string): void {
  state.lastMessageTime = Date.now();

  try {
    const message = JSON.parse(raw);

    // Handle application-level pong
    if (message.type === 'pong') {
      awaitingPong = false;
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
      return;
    }

    handleInbound(message, state, callbacks);
  } catch (error) {
    console.error(`[TDBridge ${ts()}] Failed to parse message:`, raw);
  }
}

/**
 * Check for stale connection
 */
function checkStaleConnection(): void {
  if (!state.connected || !client) {
    return;
  }

  const elapsed = Date.now() - state.lastMessageTime;
  if (elapsed > STALE_TIMEOUT_MS) {
    console.warn(`[TDBridge ${ts()}] Connection stale (no message for ${Math.round(elapsed / 1000)}s)`);
    callbacks.onError?.('Connection stale - no response from TouchDesigner');

    // Close the stale connection to allow reconnection
    if (client) {
      client.close(1001, 'Connection stale');
    }
  }
}

/**
 * Send ping to keep connection alive
 */
function sendPing(): void {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return;
  }

  // If we're still awaiting a previous pong, connection is likely dead
  if (awaitingPong) {
    console.warn(`[TDBridge ${ts()}] No pong received for previous ping, connection may be dead`);
    callbacks.onError?.('No ping response from TouchDesigner');
    return;
  }

  // Send both native ping and application-level ping
  // Native ping/pong is handled by WebSocket protocol
  try {
    client.ping();
  } catch {
    // Ignore ping errors
  }

  // Also send application-level ping for TD's ws_callbacks.py
  send({ type: 'ping' });
  awaitingPong = true;

  // Set timeout for pong response
  pongTimeout = setTimeout(() => {
    if (awaitingPong) {
      console.warn(`[TDBridge ${ts()}] Pong timeout - no response within ${PONG_TIMEOUT_MS / 1000}s`);
      awaitingPong = false;
    }
  }, PONG_TIMEOUT_MS);
}

/**
 * Send a message to TouchDesigner
 */
export function send(message: object): boolean {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    client.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error(`[TDBridge ${ts()}] Send failed:`, error);
    return false;
  }
}

/**
 * Stop the WebSocket server
 */
export function stopServer(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  if (staleCheckInterval) {
    clearInterval(staleCheckInterval);
    staleCheckInterval = null;
  }

  if (pongTimeout) {
    clearTimeout(pongTimeout);
    pongTimeout = null;
  }

  if (client) {
    client.close();
    client = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  state.connected = false;
  state.tdReady = false;
  awaitingPong = false;
  reconnectCount = 0;
  console.log(`[TDBridge ${ts()}] Server stopped`);
}

/**
 * Check if TD is connected
 */
export function isConnected(): boolean {
  return state.connected && client?.readyState === WebSocket.OPEN;
}

/**
 * Check if TD has sent ready signal
 */
export function isTDReady(): boolean {
  return state.tdReady;
}

/**
 * Get connection statistics
 */
export function getConnectionStats(): {
  connected: boolean;
  tdReady: boolean;
  reconnectCount: number;
  lastMessageTime: number;
  timeSinceLastMessage: number;
} {
  return {
    connected: state.connected,
    tdReady: state.tdReady,
    reconnectCount,
    lastMessageTime: state.lastMessageTime,
    timeSinceLastMessage: state.lastMessageTime ? Date.now() - state.lastMessageTime : 0,
  };
}

/**
 * Reset reconnect counter (e.g., when user manually reconnects)
 */
export function resetReconnectCount(): void {
  reconnectCount = 0;
}
