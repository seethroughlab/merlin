import { describe, it, expect } from 'vitest';
import {
  getZoneExample,
  getRandomExample,
  getAllExamplesForZone,
  formatExamplesForPrompt,
} from './zone-examples';
import type { SpellElement } from '../../shared/types';

describe('zone-examples', () => {
  const ALL_ELEMENTS: SpellElement[] = [
    'fire', 'water', 'air', 'earth', 'light',
    'shadow', 'crystal', 'storm', 'flora', 'cosmic',
  ];

  describe('getZoneExample', () => {
    it('should return example for force_field + fire', () => {
      const example = getZoneExample('force_field', 'fire');
      expect(example).not.toBeNull();
      expect(example?.code).toContain('force');
      expect(example?.description).toBeTruthy();
    });

    it('should return example for color_over_life + water', () => {
      const example = getZoneExample('color_over_life', 'water');
      expect(example).not.toBeNull();
      expect(example?.code).toContain('color');
    });

    it('should return example for size_over_life + cosmic', () => {
      const example = getZoneExample('size_over_life', 'cosmic');
      expect(example).not.toBeNull();
      expect(example?.code).toContain('size');
    });

    it('should return null for unknown zone', () => {
      expect(getZoneExample('unknown_zone', 'fire')).toBeNull();
    });

    it('should have examples for all elements in force_field', () => {
      for (const element of ALL_ELEMENTS) {
        const example = getZoneExample('force_field', element);
        expect(example).not.toBeNull();
        expect(example?.description).toBeTruthy();
      }
    });

    it('should have examples for all elements in color_over_life', () => {
      for (const element of ALL_ELEMENTS) {
        const example = getZoneExample('color_over_life', element);
        expect(example).not.toBeNull();
      }
    });

    it('should have examples for all elements in size_over_life', () => {
      for (const element of ALL_ELEMENTS) {
        const example = getZoneExample('size_over_life', element);
        expect(example).not.toBeNull();
      }
    });

    it('should return post_fx examples for some elements', () => {
      expect(getZoneExample('post_fx', 'fire')).not.toBeNull();
      expect(getZoneExample('post_fx', 'light')).not.toBeNull();
      expect(getZoneExample('post_fx', 'shadow')).not.toBeNull();
      expect(getZoneExample('post_fx', 'cosmic')).not.toBeNull();
    });

    it('should return null for velocity_modifier (no examples)', () => {
      expect(getZoneExample('velocity_modifier', 'fire')).toBeNull();
    });
  });

  describe('getRandomExample', () => {
    it('should return example for force_field', () => {
      const result = getRandomExample('force_field');
      expect(result).not.toBeNull();
      expect(result?.element).toBeTruthy();
      expect(result?.example.code).toBeTruthy();
    });

    it('should return example for color_over_life', () => {
      const result = getRandomExample('color_over_life');
      expect(result).not.toBeNull();
      expect(ALL_ELEMENTS).toContain(result?.element);
    });

    it('should return null for zone with no examples', () => {
      const result = getRandomExample('velocity_modifier');
      expect(result).toBeNull();
    });

    it('should return null for unknown zone', () => {
      const result = getRandomExample('nonexistent_zone');
      expect(result).toBeNull();
    });
  });

  describe('getAllExamplesForZone', () => {
    it('should return all 10 examples for force_field', () => {
      const examples = getAllExamplesForZone('force_field');
      expect(examples).toHaveLength(10);
    });

    it('should return all 10 examples for color_over_life', () => {
      const examples = getAllExamplesForZone('color_over_life');
      expect(examples).toHaveLength(10);
    });

    it('should return all 10 examples for size_over_life', () => {
      const examples = getAllExamplesForZone('size_over_life');
      expect(examples).toHaveLength(10);
    });

    it('should return partial examples for post_fx', () => {
      const examples = getAllExamplesForZone('post_fx');
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.length).toBeLessThan(10);
    });

    it('should return empty array for zone without examples', () => {
      const examples = getAllExamplesForZone('spawn_behavior');
      expect(examples).toHaveLength(0);
    });

    it('should include element with each example', () => {
      const examples = getAllExamplesForZone('force_field');
      for (const item of examples) {
        expect(ALL_ELEMENTS).toContain(item.element);
        expect(item.example.code).toBeTruthy();
        expect(item.example.description).toBeTruthy();
      }
    });
  });

  describe('formatExamplesForPrompt', () => {
    it('should format examples with header', () => {
      const formatted = formatExamplesForPrompt('force_field', 2);
      expect(formatted).toContain('### force_field examples:');
    });

    it('should include code blocks', () => {
      const formatted = formatExamplesForPrompt('force_field', 1);
      expect(formatted).toContain('```glsl');
      expect(formatted).toContain('```');
    });

    it('should include element names', () => {
      const formatted = formatExamplesForPrompt('force_field', 3);
      // Should have some element names (exact ones depend on order)
      expect(formatted).toMatch(/\*\*(fire|water|air|earth|light|shadow|crystal|storm|flora|cosmic)\*\*/);
    });

    it('should limit examples to maxExamples', () => {
      const formatted = formatExamplesForPrompt('force_field', 2);
      const codeBlockCount = (formatted.match(/```glsl/g) || []).length;
      expect(codeBlockCount).toBe(2);
    });

    it('should return empty string for zone without examples', () => {
      const formatted = formatExamplesForPrompt('velocity_modifier');
      expect(formatted).toBe('');
    });

    it('should include descriptions', () => {
      const formatted = formatExamplesForPrompt('color_over_life', 1);
      // Check for some description text (any non-empty description)
      expect(formatted.length).toBeGreaterThan(50);
    });

    it('should default to 3 examples', () => {
      const formatted = formatExamplesForPrompt('force_field');
      const codeBlockCount = (formatted.match(/```glsl/g) || []).length;
      expect(codeBlockCount).toBe(3);
    });
  });

  describe('example code quality', () => {
    it('force_field examples should modify force variable', () => {
      const examples = getAllExamplesForZone('force_field');
      for (const { example } of examples) {
        expect(example.code).toMatch(/force/);
      }
    });

    it('color_over_life examples should modify color variable', () => {
      const examples = getAllExamplesForZone('color_over_life');
      for (const { example } of examples) {
        expect(example.code).toMatch(/color/);
      }
    });

    it('size_over_life examples should modify size variable', () => {
      const examples = getAllExamplesForZone('size_over_life');
      for (const { example } of examples) {
        expect(example.code).toMatch(/size/);
      }
    });

    it('examples should use uniforms like uTime and uSpellEnergy', () => {
      const forceExamples = getAllExamplesForZone('force_field');
      const usesUniforms = forceExamples.some(
        ({ example }) => example.code.includes('uTime') || example.code.includes('uSpellEnergy')
      );
      expect(usesUniforms).toBe(true);
    });
  });
});
