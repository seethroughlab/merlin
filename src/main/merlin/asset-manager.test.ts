import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mocks that can be referenced in vi.mock factories
const { mockFs, mockGetPath, mockRandomUUID } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  mockGetPath: vi.fn(),
  mockRandomUUID: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

// Mock fs module
vi.mock('fs', () => mockFs);

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}));

describe('asset-manager', () => {
  // Dynamic imports to reset module state between tests
  let saveSprite: typeof import('./asset-manager').saveSprite;
  let loadSprite: typeof import('./asset-manager').loadSprite;
  let listSprites: typeof import('./asset-manager').listSprites;
  let deleteSprite: typeof import('./asset-manager').deleteSprite;
  let getFlipbookConfig: typeof import('./asset-manager').getFlipbookConfig;
  let getDefaultSpritePath: typeof import('./asset-manager').getDefaultSpritePath;
  let clearAllSprites: typeof import('./asset-manager').clearAllSprites;
  let getSpritesDirectory: typeof import('./asset-manager').getSpritesDirectory;
  let FLIPBOOK_LAYOUTS: typeof import('./asset-manager').FLIPBOOK_LAYOUTS;
  type SpriteAsset = import('./asset-manager').SpriteAsset;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module to clear cached manifest
    vi.resetModules();

    // Re-import after reset
    const module = await import('./asset-manager');
    saveSprite = module.saveSprite;
    loadSprite = module.loadSprite;
    listSprites = module.listSprites;
    deleteSprite = module.deleteSprite;
    getFlipbookConfig = module.getFlipbookConfig;
    getDefaultSpritePath = module.getDefaultSpritePath;
    clearAllSprites = module.clearAllSprites;
    getSpritesDirectory = module.getSpritesDirectory;
    FLIPBOOK_LAYOUTS = module.FLIPBOOK_LAYOUTS;

    // Default: directories exist
    mockFs.existsSync.mockReturnValue(true);
    mockGetPath.mockReturnValue('/mock/user/data');
    mockRandomUUID.mockReturnValue('test-uuid-1234');
    // Default empty manifest
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets: {} }));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('FLIPBOOK_LAYOUTS', () => {
    it('should have correct layout for 4 frames', () => {
      expect(FLIPBOOK_LAYOUTS[4]).toEqual([2, 2]);
    });

    it('should have correct layout for 9 frames', () => {
      expect(FLIPBOOK_LAYOUTS[9]).toEqual([3, 3]);
    });

    it('should have correct layout for 16 frames', () => {
      expect(FLIPBOOK_LAYOUTS[16]).toEqual([4, 4]);
    });

    it('should have correct layout for 25 frames', () => {
      expect(FLIPBOOK_LAYOUTS[25]).toEqual([5, 5]);
    });
  });

  describe('saveSprite', () => {
    it('should create assets directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'single',
        width: 256,
        height: 256,
      });

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('sprites'),
        { recursive: true }
      );
    });

    it('should write image to disk with UUID filename', () => {
      mockRandomUUID.mockReturnValue('unique-asset-id');
      const imageData = Buffer.from([1, 2, 3, 4]);

      saveSprite(imageData, {
        assetType: 'single',
        width: 256,
        height: 256,
      });

      // Should write the image file
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('unique-asset-id.png'),
        imageData
      );
    });

    it('should save manifest after writing image', () => {
      saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'single',
        width: 256,
        height: 256,
      });

      // Should write manifest (second writeFileSync call)
      const writeCalls = mockFs.writeFileSync.mock.calls;
      const manifestCall = writeCalls.find((call) =>
        (call[0] as string).includes('manifest.json')
      );
      expect(manifestCall).toBeDefined();
    });

    it('should return asset with correct properties', () => {
      mockRandomUUID.mockReturnValue('my-asset-id');

      const asset = saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'single',
        width: 128,
        height: 128,
        metadata: { prompt: 'glowing orb', style: 'soft' },
      });

      expect(asset.assetId).toBe('my-asset-id');
      expect(asset.assetType).toBe('single');
      expect(asset.width).toBe(128);
      expect(asset.height).toBe(128);
      expect(asset.frameCount).toBe(1);
      expect(asset.metadata?.prompt).toBe('glowing orb');
    });

    it('should use flipbook layout for multi-frame sprites', () => {
      const asset = saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'flipbook',
        frameCount: 16,
        width: 512,
        height: 512,
      });

      expect(asset.frameCount).toBe(16);
      expect(asset.atlasCols).toBe(4);
      expect(asset.atlasRows).toBe(4);
    });

    it('should use custom grid when frameCount has no predefined layout', () => {
      // Use frameCount=6 which is not in FLIPBOOK_LAYOUTS
      const asset = saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'flipbook',
        frameCount: 6,
        atlasCols: 3,
        atlasRows: 2,
        width: 384,
        height: 256,
      });

      expect(asset.atlasCols).toBe(3);
      expect(asset.atlasRows).toBe(2);
      expect(asset.frameCount).toBe(6);
    });

    it('should include createdAt timestamp', () => {
      const before = Date.now();
      const asset = saveSprite(Buffer.from([1, 2, 3]), {
        assetType: 'single',
        width: 256,
        height: 256,
      });
      const after = Date.now();

      expect(asset.createdAt).toBeGreaterThanOrEqual(before);
      expect(asset.createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe('loadSprite', () => {
    it('should return null for non-existent asset', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets: {} }));

      const result = loadSprite('nonexistent-id');

      expect(result).toBeNull();
    });

    it('should return asset when it exists', () => {
      const mockAsset: SpriteAsset = {
        assetId: 'existing-id',
        assetType: 'single',
        texturePath: '/mock/path/existing-id.png',
        frameCount: 1,
        atlasCols: 1,
        atlasRows: 1,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { 'existing-id': mockAsset } })
      );
      mockFs.existsSync.mockReturnValue(true);

      const result = loadSprite('existing-id');

      expect(result).not.toBeNull();
      expect(result?.assetId).toBe('existing-id');
      expect(result?.width).toBe(256);
    });

    it('should return null if texture file is missing', () => {
      const mockAsset: SpriteAsset = {
        assetId: 'orphan-id',
        assetType: 'single',
        texturePath: '/mock/path/orphan-id.png',
        frameCount: 1,
        atlasCols: 1,
        atlasRows: 1,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { 'orphan-id': mockAsset } })
      );
      // First call for manifest, subsequent calls for file check
      mockFs.existsSync
        .mockReturnValueOnce(true) // manifest exists
        .mockReturnValueOnce(false); // texture file missing

      const result = loadSprite('orphan-id');

      expect(result).toBeNull();
    });
  });

  describe('listSprites', () => {
    it('should return empty array when no assets', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets: {} }));

      const result = listSprites();

      expect(result).toHaveLength(0);
    });

    it('should return all assets sorted by createdAt descending', () => {
      const assets = {
        'id-1': {
          assetId: 'id-1',
          assetType: 'single',
          texturePath: '/path/1.png',
          frameCount: 1,
          atlasCols: 1,
          atlasRows: 1,
          width: 256,
          height: 256,
          createdAt: 1000,
        },
        'id-2': {
          assetId: 'id-2',
          assetType: 'flipbook',
          texturePath: '/path/2.png',
          frameCount: 9,
          atlasCols: 3,
          atlasRows: 3,
          width: 384,
          height: 384,
          createdAt: 3000,
        },
        'id-3': {
          assetId: 'id-3',
          assetType: 'single',
          texturePath: '/path/3.png',
          frameCount: 1,
          atlasCols: 1,
          atlasRows: 1,
          width: 128,
          height: 128,
          createdAt: 2000,
        },
      };

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets }));

      const result = listSprites();

      expect(result).toHaveLength(3);
      expect(result[0].assetId).toBe('id-2'); // newest first
      expect(result[1].assetId).toBe('id-3');
      expect(result[2].assetId).toBe('id-1'); // oldest last
    });
  });

  describe('deleteSprite', () => {
    it('should return false for non-existent asset', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets: {} }));

      const result = deleteSprite('nonexistent');

      expect(result).toBe(false);
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should delete file and return true', () => {
      const mockAsset: SpriteAsset = {
        assetId: 'delete-me',
        assetType: 'single',
        texturePath: '/mock/path/delete-me.png',
        frameCount: 1,
        atlasCols: 1,
        atlasRows: 1,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { 'delete-me': mockAsset } })
      );
      mockFs.existsSync.mockReturnValue(true);

      const result = deleteSprite('delete-me');

      expect(result).toBe(true);
      expect(mockFs.unlinkSync).toHaveBeenCalledWith('/mock/path/delete-me.png');
    });

    it('should update manifest after deletion', () => {
      const mockAsset: SpriteAsset = {
        assetId: 'delete-me',
        assetType: 'single',
        texturePath: '/mock/path/delete-me.png',
        frameCount: 1,
        atlasCols: 1,
        atlasRows: 1,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { 'delete-me': mockAsset } })
      );
      mockFs.existsSync.mockReturnValue(true);

      deleteSprite('delete-me');

      // Should write updated manifest
      const manifestCall = mockFs.writeFileSync.mock.calls.find((call) =>
        (call[0] as string).includes('manifest.json')
      );
      expect(manifestCall).toBeDefined();
      const manifestData = JSON.parse(manifestCall![1] as string);
      expect(manifestData.assets['delete-me']).toBeUndefined();
    });

    it('should handle file deletion error gracefully', () => {
      const mockAsset: SpriteAsset = {
        assetId: 'delete-error',
        assetType: 'single',
        texturePath: '/mock/path/delete-error.png',
        frameCount: 1,
        atlasCols: 1,
        atlasRows: 1,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { 'delete-error': mockAsset } })
      );
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw, should still return true (removed from manifest)
      const result = deleteSprite('delete-error');
      expect(result).toBe(true);
    });
  });

  describe('getFlipbookConfig', () => {
    it('should return config with asset grid dimensions', () => {
      const asset: SpriteAsset = {
        assetId: 'flipbook-1',
        assetType: 'flipbook',
        texturePath: '/path/flipbook.png',
        frameCount: 16,
        atlasCols: 4,
        atlasRows: 4,
        width: 512,
        height: 512,
        createdAt: 1000,
      };

      const config = getFlipbookConfig(asset);

      expect(config.atlasCols).toBe(4);
      expect(config.atlasRows).toBe(4);
      expect(config.frameCount).toBe(16);
    });

    it('should use default playback options', () => {
      const asset: SpriteAsset = {
        assetId: 'flipbook-1',
        assetType: 'flipbook',
        texturePath: '/path/flipbook.png',
        frameCount: 9,
        atlasCols: 3,
        atlasRows: 3,
        width: 384,
        height: 384,
        createdAt: 1000,
      };

      const config = getFlipbookConfig(asset);

      expect(config.playbackMode).toBe('loop');
      expect(config.frameDuration).toBe(0.1);
      expect(config.driveSource).toBe('age');
    });

    it('should use custom playback options when provided', () => {
      const asset: SpriteAsset = {
        assetId: 'flipbook-1',
        assetType: 'flipbook',
        texturePath: '/path/flipbook.png',
        frameCount: 4,
        atlasCols: 2,
        atlasRows: 2,
        width: 256,
        height: 256,
        createdAt: 1000,
      };

      const config = getFlipbookConfig(asset, {
        playbackMode: 'pingpong',
        frameDuration: 0.05,
        driveSource: 'velocity',
      });

      expect(config.playbackMode).toBe('pingpong');
      expect(config.frameDuration).toBe(0.05);
      expect(config.driveSource).toBe('velocity');
    });
  });

  describe('getDefaultSpritePath', () => {
    it('should return path in assets directory', () => {
      mockFs.existsSync.mockReturnValue(true);

      const result = getDefaultSpritePath();

      expect(result).toContain('default-sprite.png');
      expect(result).toContain('sprites');
    });

    it('should create default sprite if missing', () => {
      // First few calls check assets dir, then check for default sprite file
      mockFs.existsSync.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('default-sprite.png')) {
          return false; // default sprite missing
        }
        return true; // assets dir exists
      });

      getDefaultSpritePath();

      // Should write the default sprite
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('default-sprite.png'),
        expect.any(Buffer)
      );
    });
  });

  describe('clearAllSprites', () => {
    it('should delete all asset files', () => {
      const assets = {
        'id-1': {
          assetId: 'id-1',
          assetType: 'single',
          texturePath: '/path/1.png',
          frameCount: 1,
          atlasCols: 1,
          atlasRows: 1,
          width: 256,
          height: 256,
          createdAt: 1000,
        },
        'id-2': {
          assetId: 'id-2',
          assetType: 'single',
          texturePath: '/path/2.png',
          frameCount: 1,
          atlasCols: 1,
          atlasRows: 1,
          width: 256,
          height: 256,
          createdAt: 2000,
        },
      };

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0', assets }));
      mockFs.existsSync.mockReturnValue(true);

      clearAllSprites();

      expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('should save empty manifest', () => {
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0', assets: { id: {} } })
      );
      mockFs.existsSync.mockReturnValue(true);

      clearAllSprites();

      const manifestCall = mockFs.writeFileSync.mock.calls.find((call) =>
        (call[0] as string).includes('manifest.json')
      );
      expect(manifestCall).toBeDefined();
      const manifestData = JSON.parse(manifestCall![1] as string);
      expect(Object.keys(manifestData.assets)).toHaveLength(0);
    });
  });

  describe('getSpritesDirectory', () => {
    it('should return sprites directory path', () => {
      mockGetPath.mockReturnValue('/user/data');

      const result = getSpritesDirectory();

      expect(result).toContain('sprites');
      // Path may use OS-specific separators
      expect(result.replace(/\\/g, '/')).toContain('user/data');
    });

    it('should create directory if missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      getSpritesDirectory();

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('manifest error handling', () => {
    it('should handle corrupt manifest gracefully', () => {
      mockFs.readFileSync.mockReturnValue('not valid json');

      // Should not throw
      const result = listSprites();

      expect(result).toHaveLength(0);
    });

    it('should create new manifest if read fails', () => {
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      // Should not throw, should work with empty manifest
      const result = listSprites();

      expect(result).toHaveLength(0);
    });
  });
});
