/**
 * TD Bridge Connection
 *
 * WebSocket server for TouchDesigner communication.
 * Parlor acts as the server; TD connects as a client.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { TDBridgeState, TDBridgeCallbacks } from './types';
import { handleInbound } from './protocol';

const DEFAULT_PORT = 8001;
const PING_INTERVAL_MS = 30000;

let wss: WebSocketServer | null = null;
let client: WebSocket | null = null; // Single TD client
let pingInterval: NodeJS.Timeout | null = null;
let callbacks: TDBridgeCallbacks = {};

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
export function startServer(port = DEFAULT_PORT, cbs: TDBridgeCallbacks = {}): void {
  callbacks = cbs;

  wss = new WebSocketServer({ port });
  console.log(`[TDBridge ${ts()}] WebSocket server started on port ${port}`);

  wss.on('connection', handleConnection);
  wss.on('error', (error) => {
    console.error(`[TDBridge ${ts()}] Server error:`, error);
    callbacks.onError?.(error.message);
  });

  // Start ping interval
  pingInterval = setInterval(sendPing, PING_INTERVAL_MS);
}

/**
 * Handle new WebSocket connection
 */
function handleConnection(ws: WebSocket): void {
  // Only allow one TD client at a time
  if (client) {
    console.log(`[TDBridge ${ts()}] Rejecting new connection (already connected)`);
    ws.close(1008, 'Only one TouchDesigner client allowed');
    return;
  }

  client = ws;
  state.connected = true;
  state.lastMessageTime = Date.now();
  console.log(`[TDBridge ${ts()}] TouchDesigner connected`);
  callbacks.onConnect?.();

  ws.on('message', (data) => handleMessage(data.toString()));

  ws.on('close', () => {
    console.log(`[TDBridge ${ts()}] TouchDesigner disconnected`);
    client = null;
    state.connected = false;
    state.tdReady = false;
    state.capabilities = null;
    callbacks.onDisconnect?.();
  });

  ws.on('error', (error) => {
    console.error(`[TDBridge ${ts()}] Client error:`, error);
    callbacks.onError?.(error.message);
  });
}

/**
 * Handle incoming message from TD
 */
function handleMessage(raw: string): void {
  state.lastMessageTime = Date.now();

  try {
    const message = JSON.parse(raw);
    handleInbound(message, state, callbacks);
  } catch (error) {
    console.error(`[TDBridge ${ts()}] Failed to parse message:`, raw);
  }
}

/**
 * Send ping to keep connection alive
 */
function sendPing(): void {
  if (client && client.readyState === WebSocket.OPEN) {
    send({ type: 'ping' });
  }
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
