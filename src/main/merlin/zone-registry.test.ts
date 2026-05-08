import { describe, it, expect } from 'vitest';
import {
  isValidZoneName,
  getZoneContract,
  getZoneVariables,
  extractIdentifiers,
  validateZoneCode,
  getZoneSummary,
  ZoneValidationError,
  ZONE_NAMES,
  ZONE_CONTRACTS,
} from './zone-registry';

describe('zone-registry', () => {
  describe('ZONE_NAMES', () => {
    it('should contain all expected zones', () => {
      expect(ZONE_NAMES).toContain('force_field');
      expect(ZONE_NAMES).toContain('color_over_life');
      expect(ZONE_NAMES).toContain('size_over_life');
      expect(ZONE_NAMES).toContain('spawn_behavior');
      expect(ZONE_NAMES).toContain('velocity_modifier');
      expect(ZONE_NAMES).toContain('post_fx');
      expect(ZONE_NAMES).toContain('billboard_vertex');
      expect(ZONE_NAMES).toContain('billboard_pixel');
    });

    it('should have 8 zones', () => {
      expect(ZONE_NAMES).toHaveLength(8);
    });
  });

  describe('isValidZoneName', () => {
    it('should return true for valid zone names', () => {
      expect(isValidZoneName('force_field')).toBe(true);
      expect(isValidZoneName('color_over_life')).toBe(true);
      expect(isValidZoneName('post_fx')).toBe(true);
    });

    it('should return false for invalid zone names', () => {
      expect(isValidZoneName('invalid_zone')).toBe(false);
      expect(isValidZoneName('')).toBe(false);
      expect(isValidZoneName('Force_Field')).toBe(false); // case sensitive
    });
  });

  describe('getZoneContract', () => {
    it('should return contract for valid zone', () => {
      const contract = getZoneContract('force_field');
      expect(contract).not.toBeNull();
      expect(contract?.description).toMatch(/forces/i);
      expect(contract?.modifies).toBe('force');
      expect(contract?.maxLines).toBe(25);
    });

    it('should return null for invalid zone', () => {
      expect(getZoneContract('nonexistent')).toBeNull();
    });

    it('should include availableVars and uniforms', () => {
      const contract = getZoneContract('color_over_life');
      expect(contract?.availableVars).toContain('color');
      expect(contract?.uniforms).toContain('uTime');
      expect(contract?.uniforms).toContain('uSpellEnergy');
    });

    it('should include banned keywords when defined', () => {
      const contract = getZoneContract('color_over_life');
      expect(contract?.bannedKeywords).toContain('discard');
    });
  });

  describe('getZoneVariables', () => {
    it('should return modifies as array', () => {
      const vars = getZoneVariables('force_field');
      expect(vars.modifies).toEqual(['force']);
    });

    it('should handle zones with multiple modifies', () => {
      const vars = getZoneVariables('spawn_behavior');
      expect(vars.modifies).toContain('pos');
      expect(vars.modifies).toContain('vel');
    });

    it('should return empty arrays for invalid zone', () => {
      const vars = getZoneVariables('invalid');
      expect(vars.modifies).toEqual([]);
      expect(vars.availableVars).toEqual([]);
    });

    it('should return available vars', () => {
      const vars = getZoneVariables('size_over_life');
      expect(vars.availableVars).toContain('age');
      expect(vars.availableVars).toContain('life');
      expect(vars.availableVars).toContain('size');
    });
  });

  describe('extractIdentifiers', () => {
    it('should extract variable names', () => {
      const ids = extractIdentifiers('float x = y + z;');
      expect(ids).toContain('float');
      expect(ids).toContain('x');
      expect(ids).toContain('y');
      expect(ids).toContain('z');
    });

    it('should ignore single-line comments', () => {
      const ids = extractIdentifiers('float x = 1.0; // comment with y');
      expect(ids).toContain('x');
      expect(ids).not.toContain('comment');
      expect(ids).not.toContain('with');
    });

    it('should ignore multi-line comments', () => {
      const ids = extractIdentifiers('float x = 1.0; /* y z */ float a = 2.0;');
      expect(ids).toContain('x');
      expect(ids).toContain('a');
      expect(ids).not.toContain('y');
      expect(ids).not.toContain('z');
    });

    it('should extract function names', () => {
      const ids = extractIdentifiers('float x = sin(y) + cos(z);');
      expect(ids).toContain('sin');
      expect(ids).toContain('cos');
    });

    it('should handle underscore identifiers', () => {
      const ids = extractIdentifiers('float my_var = other_var;');
      expect(ids).toContain('my_var');
      expect(ids).toContain('other_var');
    });
  });

  describe('validateZoneCode', () => {
    it('should pass valid code', () => {
      const code = 'force = vec3(0.0, 0.1, 0.0);';
      expect(() => validateZoneCode('force_field', code)).not.toThrow();
    });

    it('should throw for unknown zone', () => {
      expect(() => validateZoneCode('invalid_zone', 'code')).toThrow(ZoneValidationError);
      expect(() => validateZoneCode('invalid_zone', 'code')).toThrow('Unknown zone name');
    });

    it('should throw for empty code', () => {
      expect(() => validateZoneCode('force_field', '')).toThrow(ZoneValidationError);
      expect(() => validateZoneCode('force_field', '   ')).toThrow('Empty code snippet');
    });

    it('should throw for code exceeding max lines', () => {
      const tooManyLines = Array(30).fill('float x = 1.0;').join('\n');
      expect(() => validateZoneCode('force_field', tooManyLines)).toThrow(ZoneValidationError);
      expect(() => validateZoneCode('force_field', tooManyLines)).toThrow('max is 25');
    });

    it('should throw for banned keywords', () => {
      expect(() => validateZoneCode('color_over_life', 'discard;')).toThrow(ZoneValidationError);
      expect(() => validateZoneCode('color_over_life', 'discard;')).toThrow("Banned keyword 'discard'");
    });

    it('should ignore empty lines when counting', () => {
      const codeWithBlanks = 'float x = 1.0;\n\n\nfloat y = 2.0;\n\n';
      expect(() => validateZoneCode('size_over_life', codeWithBlanks)).not.toThrow();
    });

    it('should pass post_fx zone code', () => {
      const postFxCode = `vec3 bloom = color.rgb * 0.5;
color.rgb += bloom * uBloomIntensity;`;
      expect(() => validateZoneCode('post_fx', postFxCode)).not.toThrow();
    });

    it('should pass post_fx zone code that uses the blurred input', () => {
      // Verifies the bloom blur input is exposed via the contract:
      // `blurred` is a template-declared local from sTD2DInputs[1].
      const postFxCode = `color.rgb += blurred.rgb * uBloomIntensity * uSpellEnergy;`;
      expect(() => validateZoneCode('post_fx', postFxCode)).not.toThrow();
    });

    it('should pass color_over_life zone code that uses the sprite palette', () => {
      // Verifies the sprite palette uniforms are exposed via the contract:
      // uSpriteColor1/uSpriteColor2 are vec3 uniforms wired from extracted sprite colors.
      const code = `color.rgb = mix(uSpriteColor2, uSpriteColor1, life);`;
      expect(() => validateZoneCode('color_over_life', code)).not.toThrow();
    });
  });

  describe('palette uniforms', () => {
    it('should list uSpriteColor1/uSpriteColor2 in color_over_life uniforms', () => {
      expect(ZONE_CONTRACTS.color_over_life.uniforms).toContain('uSpriteColor1');
      expect(ZONE_CONTRACTS.color_over_life.uniforms).toContain('uSpriteColor2');
    });

    it('should list uSpriteColor1/uSpriteColor2 in size_over_life uniforms', () => {
      expect(ZONE_CONTRACTS.size_over_life.uniforms).toContain('uSpriteColor1');
      expect(ZONE_CONTRACTS.size_over_life.uniforms).toContain('uSpriteColor2');
    });

    it('should list uSpriteColor1/uSpriteColor2 in billboard_pixel uniforms', () => {
      expect(ZONE_CONTRACTS.billboard_pixel.uniforms).toContain('uSpriteColor1');
      expect(ZONE_CONTRACTS.billboard_pixel.uniforms).toContain('uSpriteColor2');
    });
  });

  describe('ZoneValidationError', () => {
    it('should include zone name in message', () => {
      const error = new ZoneValidationError('force_field', 'test error');
      expect(error.message).toContain('force_field');
      expect(error.message).toContain('test error');
      expect(error.zone).toBe('force_field');
    });

    it('should have correct name', () => {
      const error = new ZoneValidationError('test', 'msg');
      expect(error.name).toBe('ZoneValidationError');
    });
  });

  describe('getZoneSummary', () => {
    it('should return formatted summary', () => {
      const summary = getZoneSummary();
      expect(summary).toContain('force_field');
      expect(summary).toContain('Apply forces to particles');
      expect(summary).toContain('modifies: force');
      expect(summary).toContain('max 25 lines');
    });

    it('should include all zones', () => {
      const summary = getZoneSummary();
      for (const zoneName of ZONE_NAMES) {
        expect(summary).toContain(zoneName);
      }
    });

    it('should handle zones with multiple modifies', () => {
      const summary = getZoneSummary();
      expect(summary).toContain('pos, vel'); // spawn_behavior
    });
  });

  describe('ZONE_CONTRACTS completeness', () => {
    it('should have contract for every zone name', () => {
      for (const zoneName of ZONE_NAMES) {
        expect(ZONE_CONTRACTS[zoneName]).toBeDefined();
        expect(ZONE_CONTRACTS[zoneName].description).toBeTruthy();
        expect(ZONE_CONTRACTS[zoneName].maxLines).toBeGreaterThan(0);
      }
    });

    it('should have valid modifies for each zone', () => {
      for (const zoneName of ZONE_NAMES) {
        const contract = ZONE_CONTRACTS[zoneName];
        const modifies = Array.isArray(contract.modifies) ? contract.modifies : [contract.modifies];
        expect(modifies.length).toBeGreaterThan(0);
      }
    });
  });
});
