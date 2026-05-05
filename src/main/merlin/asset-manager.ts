/**
 * Asset Manager for Sprite Storage
 *
 * Manages storage and retrieval of sprite assets (single sprites and flipbook atlases).
 * Assets are stored in the user data directory: ~/.parlor/assets/sprites/
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const ts = () => new Date().toISOString().slice(11, 23);

// ============ TYPES ============

export type SpriteAssetType = 'single' | 'flipbook';
export type PlaybackMode = 'loop' | 'once' | 'pingpong' | 'random';
export type DriveSource = 'age' | 'life' | 'velocity' | 'id' | 'time';

export interface SpriteAsset {
  assetId: string;
  assetType: SpriteAssetType;
  texturePath: string;
  frameCount: number;
  atlasCols: number;
  atlasRows: number;
  width: number;
  height: number;
  createdAt: number;
  metadata?: {
    prompt?: string;
    style?: string;
    animation?: string;
    element?: string;
    intent?: string;
  };
}

export interface FlipbookConfig {
  atlasCols: number;
  atlasRows: number;
  frameCount: number;
  playbackMode: PlaybackMode;
  frameDuration: number;
  driveSource: DriveSource;
}

// Flipbook layouts: frameCount → (cols, rows)
export const FLIPBOOK_LAYOUTS: Record<number, [number, number]> = {
  4: [2, 2],
  8: [4, 2],
  9: [3, 3],
  12: [4, 3],
  16: [4, 4],
  25: [5, 5],
};

// ============ ASSET MANAGER ============

const ASSETS_DIR = 'assets';
const SPRITES_DIR = 'sprites';
const MANIFEST_FILE = 'manifest.json';

interface AssetManifest {
  version: '1.0';
  assets: Record<string, SpriteAsset>;
}

let manifest: AssetManifest | null = null;

/**
 * Get the assets directory path
 */
function getAssetsDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, ASSETS_DIR, SPRITES_DIR);
}

/**
 * Get the manifest file path
 */
function getManifestPath(): string {
  return path.join(getAssetsDir(), MANIFEST_FILE);
}

/**
 * Ensure assets directory exists
 */
function ensureAssetsDir(): void {
  const dir = getAssetsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[AssetManager ${ts()}] Created assets directory: ${dir}`);
  }
}

/**
 * Load the asset manifest
 */
function loadManifest(): AssetManifest {
  if (manifest) return manifest;

  ensureAssetsDir();
  const manifestPath = getManifestPath();

  if (fs.existsSync(manifestPath)) {
    try {
      const data = fs.readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(data) as AssetManifest;
      console.log(`[AssetManager ${ts()}] Loaded manifest with ${Object.keys(manifest.assets).length} assets`);
    } catch (e) {
      console.error(`[AssetManager ${ts()}] Failed to load manifest:`, e);
      manifest = { version: '1.0', assets: {} };
    }
  } else {
    manifest = { version: '1.0', assets: {} };
  }

  return manifest;
}

/**
 * Save the asset manifest
 */
function saveManifest(): void {
  if (!manifest) return;

  ensureAssetsDir();
  const manifestPath = getManifestPath();

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error(`[AssetManager ${ts()}] Failed to save manifest:`, e);
  }
}

/**
 * Save a sprite to disk and register in manifest
 */
export function saveSprite(
  imageData: Buffer,
  options: {
    assetType: SpriteAssetType;
    frameCount?: number;
    atlasCols?: number;
    atlasRows?: number;
    width: number;
    height: number;
    metadata?: SpriteAsset['metadata'];
  }
): SpriteAsset {
  ensureAssetsDir();
  const m = loadManifest();

  const assetId = randomUUID();
  const filename = `${assetId}.png`;
  const texturePath = path.join(getAssetsDir(), filename);

  // Write image to disk
  fs.writeFileSync(texturePath, imageData);

  // Determine grid layout
  const frameCount = options.frameCount ?? 1;
  let atlasCols = options.atlasCols ?? 1;
  let atlasRows = options.atlasRows ?? 1;

  if (frameCount > 1 && options.assetType === 'flipbook') {
    const layout = FLIPBOOK_LAYOUTS[frameCount];
    if (layout) {
      [atlasCols, atlasRows] = layout;
    }
  }

  const asset: SpriteAsset = {
    assetId,
    assetType: options.assetType,
    texturePath,
    frameCount,
    atlasCols,
    atlasRows,
    width: options.width,
    height: options.height,
    createdAt: Date.now(),
    metadata: options.metadata,
  };

  m.assets[assetId] = asset;
  saveManifest();

  console.log(`[AssetManager ${ts()}] Saved sprite: ${assetId} (${options.width}x${options.height}, ${frameCount} frames)`);
  return asset;
}

/**
 * Load a sprite asset by ID
 */
export function loadSprite(assetId: string): SpriteAsset | null {
  const m = loadManifest();
  const asset = m.assets[assetId];

  if (!asset) {
    console.warn(`[AssetManager ${ts()}] Asset not found: ${assetId}`);
    return null;
  }

  // Verify file exists
  if (!fs.existsSync(asset.texturePath)) {
    console.warn(`[AssetManager ${ts()}] Asset file missing: ${asset.texturePath}`);
    return null;
  }

  return asset;
}

/**
 * List all sprite assets
 */
export function listSprites(): SpriteAsset[] {
  const m = loadManifest();
  return Object.values(m.assets).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a sprite asset
 */
export function deleteSprite(assetId: string): boolean {
  const m = loadManifest();
  const asset = m.assets[assetId];

  if (!asset) {
    return false;
  }

  // Delete file
  try {
    if (fs.existsSync(asset.texturePath)) {
      fs.unlinkSync(asset.texturePath);
    }
  } catch (e) {
    console.error(`[AssetManager ${ts()}] Failed to delete file:`, e);
  }

  // Remove from manifest
  delete m.assets[assetId];
  saveManifest();

  console.log(`[AssetManager ${ts()}] Deleted sprite: ${assetId}`);
  return true;
}

/**
 * Get the default soft-dot sprite path
 * Returns the built-in default or generates one if missing
 */
export function getDefaultSpritePath(): string {
  const defaultPath = path.join(getAssetsDir(), 'default-sprite.png');

  if (!fs.existsSync(defaultPath)) {
    // Generate a simple soft-dot sprite
    const defaultSprite = generateDefaultSprite();
    ensureAssetsDir();
    fs.writeFileSync(defaultPath, defaultSprite);
    console.log(`[AssetManager ${ts()}] Created default sprite`);
  }

  return defaultPath;
}

/**
 * Generate a simple radial gradient soft-dot sprite (256x256)
 * This creates a basic PNG with a white center fading to transparent edges
 */
function generateDefaultSprite(): Buffer {
  // PNG header and basic structure for a 256x256 RGBA image
  // This is a simplified implementation - in production you'd use sharp or canvas
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);

  const centerX = size / 2;
  const centerY = size / 2;
  const maxRadius = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const normalizedDist = Math.min(distance / maxRadius, 1);

      // Smooth falloff (quadratic ease-out)
      const alpha = Math.max(0, 1 - normalizedDist * normalizedDist);
      const value = Math.round(alpha * 255);

      const idx = (y * size + x) * 4;
      pixels[idx] = 255;     // R (white)
      pixels[idx + 1] = 255; // G
      pixels[idx + 2] = 255; // B
      pixels[idx + 3] = value; // A (radial gradient)
    }
  }

  // Create a minimal PNG file
  // Note: In a real implementation, use sharp or pngjs for proper PNG encoding
  // This returns raw RGBA data - the actual PNG encoding would need a library
  return Buffer.from(pixels);
}

/**
 * Clear all sprite assets
 */
export function clearAllSprites(): void {
  const m = loadManifest();

  for (const asset of Object.values(m.assets)) {
    try {
      if (fs.existsSync(asset.texturePath)) {
        fs.unlinkSync(asset.texturePath);
      }
    } catch (e) {
      // Continue clearing
    }
  }

  manifest = { version: '1.0', assets: {} };
  saveManifest();

  console.log(`[AssetManager ${ts()}] Cleared all sprites`);
}

/**
 * Get flipbook config from a sprite asset
 */
export function getFlipbookConfig(
  asset: SpriteAsset,
  options?: {
    playbackMode?: PlaybackMode;
    frameDuration?: number;
    driveSource?: DriveSource;
  }
): FlipbookConfig {
  return {
    atlasCols: asset.atlasCols,
    atlasRows: asset.atlasRows,
    frameCount: asset.frameCount,
    playbackMode: options?.playbackMode ?? 'loop',
    frameDuration: options?.frameDuration ?? 0.1,
    driveSource: options?.driveSource ?? 'age',
  };
}

/**
 * Get the assets directory for external access
 */
export function getSpritesDirectory(): string {
  ensureAssetsDir();
  return getAssetsDir();
}
