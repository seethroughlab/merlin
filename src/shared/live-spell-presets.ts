/**
 * Live Spell Test Presets
 *
 * Pre-written spell descriptions for the Live Spell tab dropdown.
 * Selecting one drops the prompt into the textarea — the dev can then
 * tweak it before clicking Run, or just run as-is. Each preset is a
 * realistic example of the kind of free-text request the live Merlin
 * experience would produce, exercising different elements, intents,
 * casting origins, and shape language so we can compare Gemini's
 * creative output across a range of inputs.
 */

import type { LiveSpellTestPreset } from './types';

export const LIVE_SPELL_PRESETS: LiveSpellTestPreset[] = [
  {
    id: 'fire-from-eyes',
    label: 'Fire from the eyes',
    prompt: 'Make a fire spell that emits from my eyes — angry red flame curling upward like I am seeing through it.',
  },
  {
    id: 'protective-shield',
    label: 'Protective shield, exploding outward',
    prompt: 'A slow-pulsing protective shield made of soft blue light around my whole body, that explodes outward in a bright shockwave when I release.',
  },
  {
    id: 'cosmic-wonder',
    label: 'Cosmic wonder, slow drift',
    prompt: 'A spell of cosmic wonder — galaxy dust and faint starlight drifting around my hands very slowly, like I am holding the night sky.',
  },
  {
    id: 'water-healing',
    label: 'Water healing, hands cupped',
    prompt: 'A gentle healing spell flowing from my cupped hands like water — soft turquoise drops that fall and disappear before they hit the ground.',
  },
  {
    id: 'shadow-release',
    label: 'Shadow release, dark spiral',
    prompt: 'A release spell — heavy black smoke spiraling away from my chest, like I am letting go of something that was inside me.',
  },
  {
    id: 'lightning-summon',
    label: 'Lightning summon, sharp & loud',
    prompt: 'Summon lightning — sharp white-hot bolts that crackle around my body and gather into my right hand, ready to throw.',
  },
  {
    id: 'flora-bloom',
    label: 'Flora bloom from chest',
    prompt: 'A growth spell — green vines and tiny flowers blooming outward from the center of my chest, twisting in the air like they are alive.',
  },
  {
    id: 'crystal-formation',
    label: 'Crystal formation, slow & ordered',
    prompt: 'A crystal formation spell — sharp angular shards of pale violet light slowly assembling into a geometric structure in front of me.',
  },
];
