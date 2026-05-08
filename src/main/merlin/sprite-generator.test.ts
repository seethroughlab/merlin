import { describe, it, expect } from 'vitest';
import {
  buildSpritePrompt,
  buildFlipbookPrompt,
  buildSpritePromptFromSpell,
  validateSpriteImage,
  validateFlipbookAtlas,
  SpriteGenerationError,
} from './sprite-generator';

describe('sprite-generator', () => {
  describe('buildSpritePrompt', () => {
    it('should include description in prompt', () => {
      const prompt = buildSpritePrompt('glowing orb');

      expect(prompt).toContain('glowing orb');
    });

    it('should include default style when not provided', () => {
      const prompt = buildSpritePrompt('spark');

      expect(prompt).toContain('soft and glowing');
    });

    it('should include custom style when provided', () => {
      const prompt = buildSpritePrompt('crystal', 'sharp crystalline');

      expect(prompt).toContain('sharp crystalline');
    });

    it('should include default size (512x512)', () => {
      const prompt = buildSpritePrompt('particle');

      expect(prompt).toContain('512x512');
    });

    it('should include custom size when provided', () => {
      const prompt = buildSpritePrompt('particle', undefined, 1024);

      expect(prompt).toContain('1024x1024');
    });

    it('should mention black background requirement', () => {
      const prompt = buildSpritePrompt('orb');

      expect(prompt).toContain('BLACK background');
      expect(prompt).toContain('RGB 0,0,0');
    });

    it('should mention additive blending', () => {
      const prompt = buildSpritePrompt('spark');

      expect(prompt).toContain('additive blending');
      expect(prompt).toContain('black = transparent');
    });

    it('should request PNG format', () => {
      const prompt = buildSpritePrompt('ember');

      expect(prompt).toContain('PNG format');
    });

    it('should mention centered object', () => {
      const prompt = buildSpritePrompt('sphere');

      expect(prompt).toContain('centered');
    });

    it('should mention radial falloff', () => {
      const prompt = buildSpritePrompt('glow');

      expect(prompt).toContain('Radially symmetric');
      expect(prompt).toContain('soft falloff');
    });
  });

  describe('buildFlipbookPrompt', () => {
    it('should include description in prompt', () => {
      const prompt = buildFlipbookPrompt('pulsing orb');

      expect(prompt).toContain('pulsing orb');
    });

    it('should include grid dimensions', () => {
      const prompt = buildFlipbookPrompt('spark', 'glowing', 16, 4, 4);

      expect(prompt).toContain('4x4');
    });

    it('should include frame count', () => {
      const prompt = buildFlipbookPrompt('spark', 'soft', 9, 3, 3);

      expect(prompt).toContain('9 animation frames');
    });

    it('should calculate total dimensions', () => {
      // 4x4 grid with 256px cells = 1024x1024
      const prompt = buildFlipbookPrompt('spark', 'soft', 16, 4, 4);

      expect(prompt).toContain('1024x1024 pixels total');
    });

    it('should mention cell size', () => {
      const prompt = buildFlipbookPrompt('orb', 'soft', 9, 3, 3);

      expect(prompt).toContain('256x256 pixels');
    });

    it('should include custom style', () => {
      const prompt = buildFlipbookPrompt('crystal', 'sharp icy', 4, 2, 2);

      expect(prompt).toContain('sharp icy');
    });

    it('should mention animation progression', () => {
      const prompt = buildFlipbookPrompt('spark', 'soft', 16, 4, 4);

      expect(prompt).toContain('Frame 1');
      expect(prompt).toContain('Frame 16');
      expect(prompt).toContain('START state');
      expect(prompt).toContain('END/loop point');
    });

    it('should mention black background', () => {
      const prompt = buildFlipbookPrompt('glow', 'soft', 4, 2, 2);

      expect(prompt).toContain('PURE BLACK background');
      expect(prompt).toContain('RGB 0,0,0');
    });

    it('should request left-to-right top-to-bottom layout', () => {
      const prompt = buildFlipbookPrompt('particle', 'soft', 9, 3, 3);

      expect(prompt).toContain('left-to-right, top-to-bottom');
    });
  });

  describe('buildSpritePromptFromSpell', () => {
    it('should include element style for fire', () => {
      const prompt = buildSpritePromptFromSpell('energize', 'fire');

      expect(prompt).toContain('warm orange glow');
      expect(prompt).toContain('flickering');
    });

    it('should include element style for water', () => {
      const prompt = buildSpritePromptFromSpell('calm', 'water');

      expect(prompt).toContain('soft blue');
      expect(prompt).toContain('rippling');
    });

    it('should include element style for earth', () => {
      const prompt = buildSpritePromptFromSpell('protect', 'earth');

      expect(prompt).toContain('earthy brown');
      expect(prompt).toContain('crystalline');
    });

    it('should include element style for air', () => {
      const prompt = buildSpritePromptFromSpell('transform', 'air');

      expect(prompt).toContain('ethereal white');
      expect(prompt).toContain('wisps');
    });

    it('should include element style for light', () => {
      const prompt = buildSpritePromptFromSpell('manifest', 'light');

      expect(prompt).toContain('brilliant golden');
      expect(prompt).toContain('radiance');
    });

    it('should include element style for shadow', () => {
      const prompt = buildSpritePromptFromSpell('calm', 'shadow');

      expect(prompt).toContain('deep purple');
      expect(prompt).toContain('darkness');
    });

    it('should include element style for energy', () => {
      const prompt = buildSpritePromptFromSpell('energize', 'energy');

      expect(prompt).toContain('electric blue-white');
      expect(prompt).toContain('crackling');
    });

    it('should include intent style for calm', () => {
      const prompt = buildSpritePromptFromSpell('calm', 'water');

      expect(prompt).toContain('gentle pulsing');
      expect(prompt).toContain('serene');
    });

    it('should include intent style for energize', () => {
      const prompt = buildSpritePromptFromSpell('energize', 'fire');

      expect(prompt).toContain('dynamic spiraling');
      expect(prompt).toContain('vibrant');
    });

    it('should include intent style for protect', () => {
      const prompt = buildSpritePromptFromSpell('protect', 'earth');

      expect(prompt).toContain('geometric shield');
      expect(prompt).toContain('strong');
    });

    it('should include intent style for transform', () => {
      const prompt = buildSpritePromptFromSpell('transform', 'air');

      expect(prompt).toContain('shifting morphing');
      expect(prompt).toContain('fluid');
    });

    it('should include intent style for manifest', () => {
      const prompt = buildSpritePromptFromSpell('manifest', 'light');

      expect(prompt).toContain('crystallizing');
      expect(prompt).toContain('forming');
    });

    it('should include intent style for connect', () => {
      const prompt = buildSpritePromptFromSpell('connect', 'energy');

      expect(prompt).toContain('interconnected');
      expect(prompt).toContain('weaving');
    });

    it('should use fallback for unknown element', () => {
      const prompt = buildSpritePromptFromSpell('calm', 'unknown');

      expect(prompt).toContain('mystical glowing orb');
    });

    it('should use fallback for unknown intent', () => {
      const prompt = buildSpritePromptFromSpell('unknown', 'fire');

      expect(prompt).toContain('magical particle');
    });

    it('should include custom style override', () => {
      const prompt = buildSpritePromptFromSpell('calm', 'water', 'icy crystalline');

      expect(prompt).toContain('icy crystalline');
    });
  });

  describe('validateSpriteImage', () => {
    // Valid PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const validPngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('should accept valid PNG with sufficient data', () => {
      // Create a buffer with valid PNG signature + padding
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      const result = validateSpriteImage(validPng);

      expect(result.isValid).toBe(true);
      expect(result.message).toContain('Valid PNG');
    });

    it('should reject image data that is too small', () => {
      const tinyData = Buffer.from([1, 2, 3, 4, 5]);

      const result = validateSpriteImage(tinyData);

      expect(result.isValid).toBe(false);
      expect(result.message).toContain('too small');
    });

    it('should accept JPEG (Gemini-3.x default)', () => {
      const jpegData = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(200),
      ]);
      const result = validateSpriteImage(jpegData);
      expect(result.isValid).toBe(true);
      expect(result.message).toContain('JPEG');
    });

    it('should reject unrecognized formats (e.g. GIF)', () => {
      const gifData = Buffer.concat([
        Buffer.from('GIF89a'),
        Buffer.alloc(200),
      ]);
      const result = validateSpriteImage(gifData);
      expect(result.isValid).toBe(false);
      expect(result.message).toMatch(/unrecognized/i);
    });

    it('should reject random data without a known signature', () => {
      // Use deterministic non-magic-matching bytes to avoid flaking
      const data = Buffer.alloc(500, 0x42);
      const result = validateSpriteImage(data);
      expect(result.isValid).toBe(false);
      expect(result.message).toMatch(/unrecognized/i);
    });

    it('should return processedData when valid', () => {
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      const result = validateSpriteImage(validPng);

      expect(result.processedData).toBeDefined();
      expect(result.processedData?.length).toBe(validPng.length);
    });

    it('should accept custom expected size parameter', () => {
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      // Should not throw with custom size
      const result = validateSpriteImage(validPng, 512);

      expect(result.isValid).toBe(true);
    });
  });

  describe('validateFlipbookAtlas', () => {
    const validPngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('should accept valid PNG atlas', () => {
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      const result = validateFlipbookAtlas(validPng, 4, 4);

      expect(result.isValid).toBe(true);
      expect(result.message).toContain('PNG atlas');
    });

    it('should accept JPEG atlas (Gemini-3.x default)', () => {
      const jpegData = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(200),
      ]);
      const result = validateFlipbookAtlas(jpegData, 3, 3);
      expect(result.isValid).toBe(true);
      expect(result.message).toContain('JPEG');
    });

    it('should reject atlas that is too small', () => {
      const tinyData = Buffer.from([1, 2, 3]);

      const result = validateFlipbookAtlas(tinyData, 4, 4);

      expect(result.isValid).toBe(false);
      expect(result.message).toContain('too small');
    });

    it('should reject unrecognized formats (e.g. GIF)', () => {
      const gifData = Buffer.concat([
        Buffer.from('GIF89a'),
        Buffer.alloc(200),
      ]);
      const result = validateFlipbookAtlas(gifData, 3, 3);
      expect(result.isValid).toBe(false);
      expect(result.message).toMatch(/unrecognized/i);
    });

    it('should return processedData when valid', () => {
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      const result = validateFlipbookAtlas(validPng, 2, 2);

      expect(result.processedData).toBeDefined();
    });

    it('should accept various grid sizes', () => {
      const validPng = Buffer.concat([validPngSignature, Buffer.alloc(200)]);

      // 2x2 grid (4 frames)
      expect(validateFlipbookAtlas(validPng, 2, 2).isValid).toBe(true);
      // 3x3 grid (9 frames)
      expect(validateFlipbookAtlas(validPng, 3, 3).isValid).toBe(true);
      // 4x4 grid (16 frames)
      expect(validateFlipbookAtlas(validPng, 4, 4).isValid).toBe(true);
    });
  });

  describe('SpriteGenerationError', () => {
    it('should have correct name', () => {
      const error = new SpriteGenerationError('test error');

      expect(error.name).toBe('SpriteGenerationError');
    });

    it('should include message', () => {
      const error = new SpriteGenerationError('Generation failed');

      expect(error.message).toBe('Generation failed');
    });

    it('should be instanceof Error', () => {
      const error = new SpriteGenerationError('test');

      expect(error).toBeInstanceOf(Error);
    });

    it('should have stack trace', () => {
      const error = new SpriteGenerationError('test');

      expect(error.stack).toBeDefined();
    });
  });
});
