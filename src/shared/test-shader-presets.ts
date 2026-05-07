/**
 * Shader Test Presets
 *
 * Named natural-language scenarios for the Shaders tab. Selecting one
 * pre-fills the prompt textarea so a developer can quickly try Gemini
 * against a known starting point without retyping.
 */

import type { ShaderTestPreset } from './types';

export const SHADER_TEST_PRESETS: ShaderTestPreset[] = [
  { id: 'fire-eruption',  label: 'Fire eruption',  prompt: 'A "confidence" spell with "fire" element at 0.9 energy — intense eruption, scorching orange plasma blasting upward from the chest' },
  { id: 'calm-breath',    label: 'Calm breath',    prompt: 'A "calm" spell with "air" element at 0.3 energy — gentle breathing, pale blue wisps drifting slowly outward and dissipating' },
  { id: 'cosmic-drift',   label: 'Cosmic drift',   prompt: 'A "wonder" spell with "cosmic" element at 0.5 energy — galaxy dust and faint starlight spiraling lazily around the body' },
  { id: 'crystal-shield', label: 'Crystal shield', prompt: 'A "protection" spell with "crystal" element at 0.7 energy — sharp angular violet shards assembling into a defensive formation around the user' },
  { id: 'water-ripple',   label: 'Water ripple',   prompt: 'A "clarity" spell with "water" element at 0.5 energy — cool blue droplets flowing outward from the hands in expanding ripple rings' },
  { id: 'shadow-release', label: 'Shadow release', prompt: 'A "release" spell with "shadow" element at 0.6 energy — heavy black smoke spiraling away from the chest and dissolving into the air' },
];
