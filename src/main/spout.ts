/**
 * Spout Output for TouchDesigner
 *
 * Sends video frames via Spout using GPU texture sharing.
 * Supports multiple senders (e.g., video + mask).
 */

import { BrowserWindow } from 'electron';

// Dynamic import for the native addon
let TextureSender: any = null;
let sendTextureFromPaintEvent: any = null;
let moduleLoaded = false;

// Map of sender name -> sender instance
const senders: Map<string, any> = new Map();

interface SpoutSenderConfig {
  name: string;
  width: number;
  height: number;
}

/**
 * Load the texture-bridge module (only once)
 */
async function loadModule(): Promise<boolean> {
  if (moduleLoaded) return true;

  try {
    const textureBridge = await import('@napolab/texture-bridge-core');
    TextureSender = textureBridge.TextureSender;
    sendTextureFromPaintEvent = textureBridge.sendTextureFromPaintEvent;
    moduleLoaded = true;
    return true;
  } catch (error) {
    console.error('Failed to load texture-bridge:', error);
    return false;
  }
}

/**
 * Create a Spout sender
 */
export async function createSpoutSender(config: SpoutSenderConfig): Promise<boolean> {
  if (!await loadModule()) {
    return false;
  }

  try {
    const sender = new TextureSender(config.name, config.width, config.height);
    senders.set(config.name, sender);
    console.log(`Spout sender created: ${config.name} (${config.width}x${config.height})`);
    return true;
  } catch (error) {
    console.error(`Failed to create Spout sender ${config.name}:`, error);
    return false;
  }
}

/**
 * Wire up paint events from a BrowserWindow to a specific Spout sender
 */
export function wireWindowToSender(win: BrowserWindow, senderName: string, frameRate: number = 30): void {
  const sender = senders.get(senderName);
  if (!sender) {
    console.log(`Spout sender ${senderName} not found, skipping window wiring`);
    return;
  }

  win.webContents.setFrameRate(frameRate);

  win.webContents.on('paint', (event) => {
    const texture = (event as any).texture;
    if (!texture) return;

    try {
      sendTextureFromPaintEvent(sender, texture.textureInfo);
    } catch (error) {
      // Silently ignore frame errors
    } finally {
      texture.release?.();
    }
  });

  console.log(`Window wired to Spout sender: ${senderName}`);
}

/**
 * Resize a Spout sender (recreates with new dimensions)
 */
export async function resizeSpoutSender(name: string, width: number, height: number): Promise<boolean> {
  const sender = senders.get(name);
  if (!sender) {
    console.log(`Spout sender ${name} not found for resize`);
    return false;
  }

  try {
    // Dispose old sender
    sender.dispose?.();
    senders.delete(name);

    // Create new sender with updated dimensions
    const newSender = new TextureSender(name, width, height);
    senders.set(name, newSender);
    console.log(`Spout sender resized: ${name} (${width}x${height})`);
    return true;
  } catch (error) {
    console.error(`Failed to resize Spout sender ${name}:`, error);
    return false;
  }
}

/**
 * Rename a Spout sender
 * Note: The texture-bridge library may not support renaming directly,
 * so this updates our internal tracking. The actual Spout name shown
 * in TouchDesigner depends on whether the library supports setName.
 */
export function renameSpoutSender(oldName: string, newName: string): boolean {
  const sender = senders.get(oldName);
  if (!sender) {
    console.log(`Spout sender ${oldName} not found`);
    return false;
  }

  try {
    // Try to rename if the sender supports it
    if (typeof sender.setName === 'function') {
      sender.setName(newName);
    }
    // Update our internal map
    senders.delete(oldName);
    senders.set(newName, sender);
    console.log(`Spout sender renamed: ${oldName} -> ${newName}`);
    return true;
  } catch (error) {
    console.error(`Failed to rename Spout sender:`, error);
    return false;
  }
}

/**
 * Close a specific Spout sender
 */
export function closeSender(name: string): void {
  const sender = senders.get(name);
  if (sender) {
    try {
      sender.dispose?.();
    } catch (error) {
      // Ignore cleanup errors
    }
    senders.delete(name);
  }
}

/**
 * Close all Spout senders
 */
export function closeAllSpout(): void {
  for (const [name, sender] of senders) {
    try {
      sender.dispose?.();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  senders.clear();
}

/**
 * Check if Spout module is available
 */
export function isSpoutAvailable(): boolean {
  return moduleLoaded;
}

// Legacy exports for compatibility
export async function initSpout(config: { enabled: boolean; senderName: string; width: number; height: number }): Promise<boolean> {
  if (!config.enabled) {
    console.log('Spout disabled');
    return false;
  }
  return createSpoutSender({ name: config.senderName, width: config.width, height: config.height });
}

export function wireSpoutToWindow(win: BrowserWindow): void {
  wireWindowToSender(win, 'Parlor', 30);
}

export function closeSpout(): void {
  closeAllSpout();
}
