/**
 * Shader Test Presets
 *
 * Named natural-language scenarios for the Shaders tab. Selecting one
 * pre-fills the Intent/Element/Energy form so a developer can quickly
 * try Gemini against a known starting point. Imported by the renderer
 * via the shared types module.
 */

import type { ShaderTestPreset } from './types';

export const SHADER_TEST_PRESETS: ShaderTestPreset[] = [
  { id: 'fire-eruption',  label: 'Fire eruption',  intent: 'confidence',     element: 'fire',    energy: 0.9 },
  { id: 'calm-breath',    label: 'Calm breath',    intent: 'calm',           element: 'air',     energy: 0.3 },
  { id: 'cosmic-drift',   label: 'Cosmic drift',   intent: 'wonder',         element: 'cosmic',  energy: 0.5 },
  { id: 'crystal-shield', label: 'Crystal shield', intent: 'protection',     element: 'crystal', energy: 0.7 },
  { id: 'water-ripple',   label: 'Water ripple',   intent: 'clarity',        element: 'water',   energy: 0.5 },
  { id: 'shadow-release', label: 'Shadow release', intent: 'release',        element: 'shadow',  energy: 0.6 },
];
