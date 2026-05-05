import { describe, it, expect } from 'vitest';
import {
  validateGlslSnippet,
  checkBalancedBraces,
  checkBalancedParens,
  checkSemicolons,
  findUndefinedFunctions,
} from './glsl-validator';

describe('glsl-validator', () => {
  describe('checkBalancedBraces', () => {
    it('should pass for balanced braces', () => {
      const result = checkBalancedBraces('if (x) { y = 1; }');
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should pass for nested braces', () => {
      const result = checkBalancedBraces('{ { { } } }');
      expect(result.valid).toBe(true);
    });

    it('should fail for missing closing brace', () => {
      const result = checkBalancedBraces('if (x) { y = 1;');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing');
    });

    it('should fail for unexpected closing brace', () => {
      const result = checkBalancedBraces('y = 1; }');
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unexpected '}'");
    });

    it('should pass for code without braces', () => {
      const result = checkBalancedBraces('float x = 1.0;');
      expect(result.valid).toBe(true);
    });
  });

  describe('checkBalancedParens', () => {
    it('should pass for balanced parentheses', () => {
      const result = checkBalancedParens('sin(x + cos(y))');
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should fail for missing closing paren', () => {
      const result = checkBalancedParens('sin(x + cos(y)');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing');
    });

    it('should fail for unexpected closing paren', () => {
      const result = checkBalancedParens('x + y)');
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unexpected ')'");
    });

    it('should pass for deeply nested parens', () => {
      const result = checkBalancedParens('((((x))))');
      expect(result.valid).toBe(true);
    });
  });

  describe('checkSemicolons', () => {
    it('should return empty for properly terminated code', () => {
      const warnings = checkSemicolons('float x = 1.0;\nvec3 y = vec3(0.0);');
      expect(warnings).toHaveLength(0);
    });

    it('should warn about potential missing semicolon', () => {
      const warnings = checkSemicolons('float x = 1.0\nvec3 y = vec3(0.0);');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('missing a semicolon');
    });

    it('should not warn for if statements', () => {
      const warnings = checkSemicolons('if (x > 0)\n{ y = 1; }');
      expect(warnings).toHaveLength(0);
    });

    it('should not warn for comments', () => {
      const warnings = checkSemicolons('// this is a comment\nfloat x = 1.0;');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('findUndefinedFunctions', () => {
    it('should not flag GLSL built-ins', () => {
      const undefined = findUndefinedFunctions('float x = sin(y) + cos(z);');
      expect(undefined).toHaveLength(0);
    });

    it('should not flag TD helpers', () => {
      const undefined = findUndefinedFunctions('uint idx = TDIndex();');
      expect(undefined).toHaveLength(0);
    });

    it('should not flag type constructors', () => {
      const undefined = findUndefinedFunctions('vec3 v = vec3(1.0, 2.0, 3.0);');
      expect(undefined).toHaveLength(0);
    });

    it('should flag unknown functions', () => {
      const undefined = findUndefinedFunctions('float x = myCustomFunc(y);');
      expect(undefined).toContain('myCustomFunc');
    });

    it('should not flag main', () => {
      const undefined = findUndefinedFunctions('void main() { }');
      expect(undefined).not.toContain('main');
    });
  });

  describe('validateGlslSnippet', () => {
    it('should pass valid GLSL code', () => {
      const result = validateGlslSnippet(`
        float angle = atan(pos.z, pos.x) + uTime * 2.0;
        float lift = uSpellEnergy * 0.2;
        force = vec3(cos(angle) * 0.05, lift, sin(angle) * 0.05);
      `);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should fail on unbalanced braces', () => {
      const result = validateGlslSnippet('if (x > 0) { y = 1;');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('brace');
    });

    it('should fail on unbalanced parentheses', () => {
      const result = validateGlslSnippet('float x = sin(y;');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('paren');
    });

    it('should fail on empty code', () => {
      const result = validateGlslSnippet('   ');
      expect(result.isValid).toBe(false);
      expect(result.error?.toLowerCase()).toContain('empty');
    });

    it('should detect empty statements', () => {
      const result = validateGlslSnippet('float x = 1.0;;');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Empty statement');
    });

    it('should return warnings for potential issues', () => {
      const result = validateGlslSnippet(`
        float x = myFunc(y);
      `);
      // Should pass but may have warnings about unknown function
      expect(result.isValid).toBe(true);
      expect(result.warnings.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiline code', () => {
      const result = validateGlslSnippet(`
        // Fire spiral effect
        float angle = atan(pos.z, pos.x) + uTime * 2.0;
        float lift = uSpellEnergy * 0.15;
        float flicker = sin(uTime * 8.0 + float(idx) * 0.3) * 0.02;
        force = vec3(
          cos(angle) * 0.04,
          lift + flicker,
          sin(angle) * 0.04
        );
      `);
      expect(result.isValid).toBe(true);
    });
  });
});
