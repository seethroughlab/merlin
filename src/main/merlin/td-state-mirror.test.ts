import { describe, it, expect, beforeEach } from 'vitest';

import {
  DEFAULT_MIRROR,
  getMirroredState,
  recordFlipbookConfigPush,
  recordSpriteTexturePush,
  getLastSpritePush,
  resetMirror,
} from './td-state-mirror';
import type { SpriteFlipbookConfig } from '../../shared/types';
import type { Palette } from './palette';

const SAMPLE_FLIPBOOK: SpriteFlipbookConfig = {
  atlasCols: 4,
  atlasRows: 4,
  frameCount: 16,
  playbackMode: 'loop',
  frameDuration: 0.05,
  driveSource: 'age',
};

const SAMPLE_PALETTE: Palette = [
  { r: 0.9, g: 0.3, b: 0.1 },
  { r: 0.2, g: 0.4, b: 0.8 },
];

describe('td-state-mirror', () => {
  beforeEach(() => {
    resetMirror();
  });

  describe('initial state', () => {
    it('returns the documented 1x1 baseline before any push', () => {
      const s = getMirroredState();
      expect(s.flipbook).toEqual(DEFAULT_MIRROR.flipbook);
      expect(s.lastUpdatedAt).toBeNull();
      expect(s.lastSource).toBeNull();
    });

    it('has no sprite recorded before any push', () => {
      expect(getLastSpritePush()).toBeNull();
    });
  });

  describe('recordFlipbookConfigPush', () => {
    it('overwrites flipbook + stamps updatedAt + tags source', () => {
      const before = Date.now();
      recordFlipbookConfigPush(SAMPLE_FLIPBOOK);
      const s = getMirroredState();
      expect(s.flipbook).toEqual(SAMPLE_FLIPBOOK);
      expect(s.lastSource).toBe('flipbook_config');
      expect(s.lastUpdatedAt).not.toBeNull();
      expect(s.lastUpdatedAt!).toBeGreaterThanOrEqual(before);
    });

    it('returns a deep copy — caller mutation must not affect internal state', () => {
      recordFlipbookConfigPush(SAMPLE_FLIPBOOK);
      const snapshot = getMirroredState();
      snapshot.flipbook.frameCount = 999;
      expect(getMirroredState().flipbook.frameCount).toBe(SAMPLE_FLIPBOOK.frameCount);
    });
  });

  describe('recordSpriteTexturePush + getLastSpritePush', () => {
    it('round-trips required fields and timestamps the push', () => {
      const before = Date.now();
      recordSpriteTexturePush({
        assetId: 'sprite_abc123',
        texturePath: '/tmp/merlin-assets/sprite_abc123.png',
        description: 'a glowing ember',
        assetType: 'flipbook',
        palette: SAMPLE_PALETTE,
      });
      const got = getLastSpritePush();
      expect(got).not.toBeNull();
      expect(got!.assetId).toBe('sprite_abc123');
      expect(got!.texturePath).toBe('/tmp/merlin-assets/sprite_abc123.png');
      expect(got!.description).toBe('a glowing ember');
      expect(got!.assetType).toBe('flipbook');
      expect(got!.palette).toEqual(SAMPLE_PALETTE);
      expect(got!.pushedAt).toBeGreaterThanOrEqual(before);
    });

    it('always returns the most recent push (last write wins)', () => {
      recordSpriteTexturePush({
        assetId: 'first',
        texturePath: '/tmp/first.png',
        assetType: 'single',
      });
      recordSpriteTexturePush({
        assetId: 'second',
        texturePath: '/tmp/second.png',
        assetType: 'flipbook',
      });
      expect(getLastSpritePush()!.assetId).toBe('second');
    });

    it('returns a deep copy — caller mutation must not affect internal record', () => {
      recordSpriteTexturePush({
        assetId: 'orig',
        texturePath: '/tmp/orig.png',
        assetType: 'single',
      });
      const got = getLastSpritePush();
      got!.assetId = 'mutated';
      expect(getLastSpritePush()!.assetId).toBe('orig');
    });
  });

  describe('resetMirror', () => {
    it('clears both flipbook state and last sprite push', () => {
      recordFlipbookConfigPush(SAMPLE_FLIPBOOK);
      recordSpriteTexturePush({
        assetId: 'x',
        texturePath: '/tmp/x.png',
        assetType: 'single',
      });
      resetMirror();
      const s = getMirroredState();
      expect(s.flipbook).toEqual(DEFAULT_MIRROR.flipbook);
      expect(s.lastUpdatedAt).toBeNull();
      expect(s.lastSource).toBeNull();
      expect(getLastSpritePush()).toBeNull();
    });
  });
});
