import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the connection module
const { mockSend, mockIsConnected } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockIsConnected: vi.fn(() => true),
}));

vi.mock('./connection', () => ({
  send: mockSend,
  isConnected: mockIsConnected,
}));

// Mock the GLSL validator
type MockValidationResult = { isValid: boolean; error?: string | null; warnings: string[] };
const { mockValidateGlslSnippet } = vi.hoisted(() => ({
  mockValidateGlslSnippet: vi.fn<() => MockValidationResult>(() => ({ isValid: true, warnings: [] as string[] })),
}));

vi.mock('../merlin/glsl-validator', () => ({
  validateGlslSnippet: mockValidateGlslSnippet,
}));

// Mock the zone registry
const { mockValidateZoneCode, mockIsValidZoneName, MockZoneValidationError } = vi.hoisted(() => ({
  mockValidateZoneCode: vi.fn(),
  mockIsValidZoneName: vi.fn(() => true),
  MockZoneValidationError: class ZoneValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ZoneValidationError';
    }
  },
}));

vi.mock('../merlin/zone-registry', () => ({
  validateZoneCode: mockValidateZoneCode,
  isValidZoneName: mockIsValidZoneName,
  ZoneValidationError: MockZoneValidationError,
}));

// Mock the zone state manager
const { mockZoneStateManager } = vi.hoisted(() => ({
  mockZoneStateManager: {
    updateZone: vi.fn(),
    waitForCompileResult: vi.fn(() => Promise.resolve(true)),
    getZoneError: vi.fn<() => string | null>(() => null),
    rollbackZone: vi.fn<() => string | null>(() => null),
  },
}));

vi.mock('../merlin/zone-state', () => ({
  zoneStateManager: mockZoneStateManager,
}));

import {
  pushZoneUpdate,
  pushZoneUpdateWithValidation,
  pushOrientationUpdate,
  pushMerlinState,
  pushSpellCast,
  pushSpriteTexture,
  pushFlipbookConfig,
} from './push';
import type { FlipbookConfigMessage } from './types';

describe('push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReturnValue(true);
    mockIsConnected.mockReturnValue(true);
  });

  describe('guardedSend behavior', () => {
    it('should return false when not connected', () => {
      mockIsConnected.mockReturnValue(false);

      const result = pushZoneUpdate('force_field', '// snippet');

      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should call send when connected', () => {
      mockIsConnected.mockReturnValue(true);

      const result = pushZoneUpdate('force_field', '// snippet');

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('pushZoneUpdate', () => {
    it('should send zone update message', () => {
      pushZoneUpdate('force_field', 'float force = 1.0;');

      expect(mockSend).toHaveBeenCalledWith({
        type: 'zone_update',
        zone: 'force_field',
        zone_code: 'float force = 1.0;',
      });
    });

    it('should return false when disconnected', () => {
      mockIsConnected.mockReturnValue(false);

      const result = pushZoneUpdate('color_over_life', 'color = vec3(1.0);');

      expect(result).toBe(false);
    });
  });

  describe('pushZoneUpdateWithValidation', () => {
    beforeEach(() => {
      mockValidateGlslSnippet.mockReturnValue({ isValid: true, warnings: [] });
      mockValidateZoneCode.mockImplementation(() => {});
      mockIsValidZoneName.mockReturnValue(true);
      mockZoneStateManager.waitForCompileResult.mockResolvedValue(true);
    });

    it('should reject invalid zone names', async () => {
      mockIsValidZoneName.mockReturnValue(false);

      const result = await pushZoneUpdateWithValidation('invalid_zone', 'code');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown zone');
    });

    it('should reject invalid GLSL syntax', async () => {
      mockValidateGlslSnippet.mockReturnValue({
        isValid: false,
        error: 'Unbalanced braces',
        warnings: [],
      });

      const result = await pushZoneUpdateWithValidation('force_field', 'bad { code');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unbalanced braces');
    });

    it('should reject zone contract violations', async () => {
      mockValidateZoneCode.mockImplementation(() => {
        throw new MockZoneValidationError('Banned keyword: discard');
      });

      const result = await pushZoneUpdateWithValidation('force_field', 'discard;');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Banned keyword: discard');
    });

    it('should fail when not connected', async () => {
      mockIsConnected.mockReturnValue(false);

      const result = await pushZoneUpdateWithValidation('force_field', 'valid code');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not connected to TouchDesigner');
    });

    it('should fail when send fails', async () => {
      mockSend.mockReturnValue(false);

      const result = await pushZoneUpdateWithValidation('force_field', 'valid code');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to send to TouchDesigner');
    });

    it('should succeed with valid code and successful compile', async () => {
      const result = await pushZoneUpdateWithValidation('force_field', 'float x = 1.0;');

      expect(result.success).toBe(true);
      expect(mockZoneStateManager.updateZone).toHaveBeenCalledWith('force_field', 'float x = 1.0;');
      expect(mockSend).toHaveBeenCalledWith({
        type: 'zone_update',
        zone: 'force_field',
        zone_code: 'float x = 1.0;',
      });
    });

    it('should include warnings in result', async () => {
      mockValidateGlslSnippet.mockReturnValue({
        isValid: true,
        warnings: ['Variable shadowing detected'],
      });

      const result = await pushZoneUpdateWithValidation('force_field', 'float x = 1.0;');

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(['Variable shadowing detected']);
    });

    it('should rollback on compile failure', async () => {
      mockZoneStateManager.waitForCompileResult.mockResolvedValue(false);
      mockZoneStateManager.getZoneError.mockReturnValue('GLSL compile error');
      mockZoneStateManager.rollbackZone.mockReturnValue('previous code');

      const result = await pushZoneUpdateWithValidation('force_field', 'bad glsl');

      expect(result.success).toBe(false);
      expect(result.error).toBe('GLSL compile error');
      expect(mockZoneStateManager.rollbackZone).toHaveBeenCalledWith('force_field');
      // Should re-send the previous code
      expect(mockSend).toHaveBeenLastCalledWith({
        type: 'zone_update',
        zone: 'force_field',
        zone_code: 'previous code',
      });
    });

    it('should handle rollback with no previous code', async () => {
      mockZoneStateManager.waitForCompileResult.mockResolvedValue(false);
      mockZoneStateManager.rollbackZone.mockReturnValue(null);

      const result = await pushZoneUpdateWithValidation('force_field', 'bad glsl');

      expect(result.success).toBe(false);
      // Should not attempt to send null code
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should use custom timeout', async () => {
      await pushZoneUpdateWithValidation('force_field', 'code', { timeoutMs: 5000 });

      expect(mockZoneStateManager.waitForCompileResult).toHaveBeenCalledWith('force_field', 5000);
    });
  });

  describe('pushOrientationUpdate', () => {
    it('should send orientation update message', () => {
      pushOrientationUpdate(true, 1080, 1920);

      expect(mockSend).toHaveBeenCalledWith({
        type: 'orientation_update',
        portrait: true,
        width: 1080,
        height: 1920,
      });
    });

    it('should send landscape orientation', () => {
      pushOrientationUpdate(false, 1920, 1080);

      expect(mockSend).toHaveBeenCalledWith({
        type: 'orientation_update',
        portrait: false,
        width: 1920,
        height: 1080,
      });
    });
  });

  describe('pushMerlinState', () => {
    it('should send merlin state with spell details', () => {
      pushMerlinState({
        active: true,
        phase: 'casting',
        spell: {
          intent: 'energize',
          element: 'fire',
          energy: 0.8,
          castingOrigin: 'right_hand',
          palette: 'warm',
          confidence: 0.95,
        },
      });

      expect(mockSend).toHaveBeenCalledWith({
        type: 'merlin_state',
        active: true,
        phase: 'casting',
        spell: {
          intent: 'energize',
          element: 'fire',
          energy: 0.8,
          castingOrigin: 'right_hand',
          palette: 'warm',
          confidence: 0.95,
        },
      });
    });

    it('should send inactive state', () => {
      pushMerlinState({ active: false });

      expect(mockSend).toHaveBeenCalledWith({
        type: 'merlin_state',
        active: false,
      });
    });
  });

  describe('pushSpellCast', () => {
    it('should send spell cast message', () => {
      const envelope = { ignitionMs: 400, projectionMs: 1200, afterglowMs: 2900, peakIntensity: 1.0 };

      pushSpellCast('whole_body', 1.0, 4500, envelope);

      expect(mockSend).toHaveBeenCalledWith({
        type: 'spell_cast',
        origin: 'whole_body',
        intensity: 1.0,
        durationMs: 4500,
        envelope,
      });
    });
  });

  describe('pushSpriteTexture', () => {
    it('should send sprite texture message', () => {
      pushSpriteTexture('sprite_001', '/path/to/sprite.png');

      expect(mockSend).toHaveBeenCalledWith({
        type: 'sprite_texture',
        assetId: 'sprite_001',
        texturePath: '/path/to/sprite.png',
      });
    });

    it('should return false when disconnected', () => {
      mockIsConnected.mockReturnValue(false);

      const result = pushSpriteTexture('sprite_002', '/path/to/texture.png');

      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return true on successful send', () => {
      const result = pushSpriteTexture('sprite_003', '/assets/particle.png');

      expect(result).toBe(true);
    });
  });

  describe('pushFlipbookConfig', () => {
    it('should send flipbook config with all fields', () => {
      const config: FlipbookConfigMessage = {
        atlasCols: 4,
        atlasRows: 4,
        frameCount: 16,
        playbackMode: 'loop',
        frameDuration: 0.033,
        driveSource: 'age',
      };

      pushFlipbookConfig(config);

      expect(mockSend).toHaveBeenCalledWith({
        type: 'flipbook_config',
        config,
      });
    });

    it('should send pingpong playback mode', () => {
      const config: FlipbookConfigMessage = {
        atlasCols: 3,
        atlasRows: 3,
        frameCount: 9,
        playbackMode: 'pingpong',
        frameDuration: 0.05,
        driveSource: 'life',
      };

      pushFlipbookConfig(config);

      expect(mockSend).toHaveBeenCalledWith({
        type: 'flipbook_config',
        config: expect.objectContaining({
          playbackMode: 'pingpong',
          driveSource: 'life',
        }),
      });
    });

    it('should return false when disconnected', () => {
      mockIsConnected.mockReturnValue(false);

      const config: FlipbookConfigMessage = {
        atlasCols: 2,
        atlasRows: 2,
        frameCount: 4,
        playbackMode: 'once',
        frameDuration: 0.1,
        driveSource: 'velocity',
      };

      const result = pushFlipbookConfig(config);

      expect(result).toBe(false);
    });

    it('should handle different drive sources', () => {
      const driveSources = ['age', 'life', 'velocity', 'id', 'time'] as const;

      driveSources.forEach((driveSource) => {
        mockSend.mockClear();

        const config: FlipbookConfigMessage = {
          atlasCols: 4,
          atlasRows: 4,
          frameCount: 16,
          playbackMode: 'loop',
          frameDuration: 0.033,
          driveSource,
        };

        pushFlipbookConfig(config);

        expect(mockSend).toHaveBeenCalledWith({
          type: 'flipbook_config',
          config: expect.objectContaining({ driveSource }),
        });
      });
    });
  });

});
