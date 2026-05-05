/**
 * Particle Spell Program Generator
 *
 * Maps SpellState to concrete ParticleSpellProgram for buildup and release modes.
 * Each archetype defines distinct visual behaviors for both modes.
 */

import { v4 as uuidv4 } from 'uuid';
import type { SpellState, SpellIntent, SpellElement, CastingOrigin } from '../../shared/types';
import type {
  ParticleSpellProgram,
  ParticleSpellArchetype,
  SpellVisualMode,
  ZoneParams,
  CastEnvelope,
  SpellPalette,
} from './types';

// ===== Constants =====

export const BUILDUP_ENERGY_MAX = 0.55;
export const RELEASE_ENERGY_PEAK = 1.0;
export const RELEASE_ENERGY_FLOOR = 0.2;

export const DEFAULT_CAST_ENVELOPE: CastEnvelope = {
  ignitionMs: 400,
  projectionMs: 1200,
  afterglowMs: 2900,
  peakIntensity: 1.0,
};

/**
 * MediaPipe landmark indices for each casting origin
 */
export const CASTING_LANDMARKS: Record<CastingOrigin, number[]> = {
  hands: [15, 16, 17, 18, 19, 20, 21, 22], // wrists and fingers
  heart: [11, 12],                          // shoulders (chest center)
  eyes: [1, 2, 3, 4, 5, 6],                // eye landmarks
  whole_body: [11, 12, 23, 24],            // torso corners
  wand: [15, 16],                           // wrist positions (future)
};

// ===== Element Palettes =====

const ELEMENT_PALETTES: Record<SpellElement, SpellPalette> = {
  fire: { primary: '#FF6B35', secondary: '#FF8C42', accent: '#FFD93D' },
  water: { primary: '#4ECDC4', secondary: '#6BE3D9', accent: '#A8E6CF' },
  air: { primary: '#A8DADC', secondary: '#C9E4E7', accent: '#F1FAEE' },
  earth: { primary: '#8B4513', secondary: '#A0522D', accent: '#DEB887' },
  light: { primary: '#FFD700', secondary: '#FFF8DC', accent: '#FFFFF0' },
  shadow: { primary: '#4A0E4E', secondary: '#6B2D5C', accent: '#8B5A7C' },
  crystal: { primary: '#E0E7FF', secondary: '#C7D2FE', accent: '#A5B4FC' },
  storm: { primary: '#5C5CFF', secondary: '#7B7BFF', accent: '#9999FF' },
  flora: { primary: '#2D6A4F', secondary: '#40916C', accent: '#52B788' },
  cosmic: { primary: '#9B5DE5', secondary: '#B185DB', accent: '#C9A7EB' },
};

const DEFAULT_PALETTE: SpellPalette = {
  primary: '#8B5CF6',
  secondary: '#A78BFA',
  accent: '#C4B5FD',
};

export function getPaletteForElement(element: SpellElement | null): SpellPalette {
  if (!element) {
    return DEFAULT_PALETTE;
  }
  return ELEMENT_PALETTES[element];
}

// ===== Archetype Configurations =====

interface ArchetypeConfig {
  name: ParticleSpellArchetype;
  intents: SpellIntent[];
  elements: SpellElement[];
  defaultOrigin: CastingOrigin;
  buildup: {
    zones: Partial<Record<string, ZoneParams>>;
  };
  release: {
    zones: Partial<Record<string, ZoneParams>>;
    envelope?: Partial<CastEnvelope>;
  };
}

const ARCHETYPE_CONFIGS: ArchetypeConfig[] = [
  // ===== RISING EMBERS =====
  // For confidence, transformation, focus - warm upward particles from hands
  {
    name: 'rising_embers',
    intents: ['confidence', 'transformation', 'focus'],
    elements: ['fire', 'light'],
    defaultOrigin: 'hands',
    buildup: {
      zones: {
        spawn: {
          spawnRadius: 0.15,
          spawnRate: 1.0,
        },
        force: {
          forceDirection: 'inward',
          forceStrength: 0.3,
          turbulence: 0.2,
        },
        velmod: {
          velocityScale: 0.8,
          damping: 0.1,
        },
        size: {
          baseSize: 0.03,
          sizeVariation: 0.3,
        },
        color: {
          saturation: 0.7,
          brightness: 0.8,
          alphaFade: 0.7,
        },
      },
    },
    release: {
      zones: {
        spawn: {
          spawnRadius: 0.25,
          spawnRate: 3.0,
        },
        force: {
          forceDirection: 'outward',
          forceStrength: 0.9,
          turbulence: 0.5,
        },
        velmod: {
          velocityScale: 2.5,
          damping: 0.05,
        },
        size: {
          baseSize: 0.06,
          sizeVariation: 0.5,
        },
        color: {
          saturation: 1.0,
          brightness: 1.0,
          alphaFade: 0.9,
        },
      },
      envelope: {
        ignitionMs: 350,
        projectionMs: 1000,
        afterglowMs: 2500,
      },
    },
  },

  // ===== BREATHING AURA MIST =====
  // For calm, release, joy - cool expanding mist from heart
  {
    name: 'breathing_aura_mist',
    intents: ['calm', 'release', 'joy'],
    elements: ['water', 'air'],
    defaultOrigin: 'heart',
    buildup: {
      zones: {
        spawn: {
          spawnRadius: 0.25,
          spawnRate: 0.7,
        },
        force: {
          forceDirection: 'tangential',
          forceStrength: 0.15,
          orbitSpeed: 0.3,
          turbulence: 0.1,
        },
        velmod: {
          velocityScale: 0.5,
          damping: 0.2,
        },
        size: {
          baseSize: 0.04,
          sizeVariation: 0.2,
        },
        color: {
          saturation: 0.5,
          brightness: 0.7,
          alphaFade: 0.5,
        },
      },
    },
    release: {
      zones: {
        spawn: {
          spawnRadius: 0.4,
          spawnRate: 2.0,
        },
        force: {
          forceDirection: 'outward',
          forceStrength: 0.6,
          turbulence: 0.15,
        },
        velmod: {
          velocityScale: 1.8,
          damping: 0.1,
        },
        size: {
          baseSize: 0.07,
          sizeVariation: 0.3,
        },
        color: {
          saturation: 0.8,
          brightness: 0.9,
          alphaFade: 0.8,
        },
      },
      envelope: {
        ignitionMs: 500,
        projectionMs: 1500,
        afterglowMs: 3500,
      },
    },
  },

  // ===== ORBITING STARDUST =====
  // For creativity, wonder, clarity - sparkly orbits around hands
  {
    name: 'orbiting_stardust',
    intents: ['creativity', 'wonder', 'clarity'],
    elements: ['cosmic', 'crystal', 'light'],
    defaultOrigin: 'hands',
    buildup: {
      zones: {
        spawn: {
          spawnRadius: 0.2,
          spawnRate: 1.2,
        },
        force: {
          forceDirection: 'tangential',
          forceStrength: 0.4,
          orbitSpeed: 0.6,
          turbulence: 0.15,
        },
        velmod: {
          velocityScale: 1.0,
          damping: 0.05,
        },
        size: {
          baseSize: 0.025,
          sizeVariation: 0.4,
        },
        color: {
          saturation: 0.8,
          brightness: 0.9,
          alphaFade: 0.6,
        },
      },
    },
    release: {
      zones: {
        spawn: {
          spawnRadius: 0.35,
          spawnRate: 2.5,
        },
        force: {
          forceDirection: 'outward',
          forceStrength: 0.85,
          orbitSpeed: 1.5,
          turbulence: 0.4,
        },
        velmod: {
          velocityScale: 2.2,
          damping: 0.02,
        },
        size: {
          baseSize: 0.05,
          sizeVariation: 0.6,
        },
        color: {
          saturation: 1.0,
          brightness: 1.0,
          alphaFade: 0.95,
        },
      },
      envelope: {
        ignitionMs: 300,
        projectionMs: 1100,
        afterglowMs: 2800,
      },
    },
  },
];

// ===== Archetype Selection =====

/**
 * Select the best archetype for a spell based on intent and element
 */
export function selectArchetype(spell: SpellState): ParticleSpellArchetype {
  // If visualArchetype is already set and valid, use it
  if (spell.visualArchetype) {
    const valid = ARCHETYPE_CONFIGS.find((c) => c.name === spell.visualArchetype);
    if (valid) return spell.visualArchetype as ParticleSpellArchetype;
  }

  // Find best match based on intent
  if (spell.intent) {
    for (const config of ARCHETYPE_CONFIGS) {
      if (config.intents.includes(spell.intent)) {
        return config.name;
      }
    }
  }

  // Fallback: match by element
  if (spell.element) {
    for (const config of ARCHETYPE_CONFIGS) {
      if (config.elements.includes(spell.element)) {
        return config.name;
      }
    }
  }

  // Default to breathing_aura_mist (most neutral)
  return 'breathing_aura_mist';
}

/**
 * Get the configuration for an archetype
 */
export function getArchetypeConfig(archetype: ParticleSpellArchetype): ArchetypeConfig {
  return ARCHETYPE_CONFIGS.find((c) => c.name === archetype) || ARCHETYPE_CONFIGS[1];
}

// ===== Program Generation =====

/**
 * Create a buildup program from spell state
 * Energy is clamped to BUILDUP_ENERGY_MAX (0.55)
 */
export function createBuildupProgram(spell: SpellState): ParticleSpellProgram {
  const archetype = selectArchetype(spell);
  const config = getArchetypeConfig(archetype);
  const palette = spell.palette
    ? { primary: spell.palette, secondary: spell.palette, accent: spell.palette }
    : getPaletteForElement(spell.element);
  const origin = spell.castingOrigin || config.defaultOrigin;

  // Clamp energy to buildup maximum
  const energy = Math.min(spell.energy, BUILDUP_ENERGY_MAX);

  return {
    version: '1.0',
    spellId: uuidv4(),
    timestamp: Date.now(),
    intent: spell.intent,
    element: spell.element,
    archetype,
    mode: 'buildup',
    energy,
    energyFloor: 0.1,
    energyCeiling: BUILDUP_ENERGY_MAX,
    castingOrigin: origin,
    castingLandmarks: CASTING_LANDMARKS[origin],
    palette,
    zones: config.buildup.zones,
  };
}

/**
 * Create a release program from spell state
 * Energy starts at peak and includes cast envelope
 */
export function createReleaseProgram(spell: SpellState): ParticleSpellProgram {
  const archetype = selectArchetype(spell);
  const config = getArchetypeConfig(archetype);
  const palette = spell.palette
    ? { primary: spell.palette, secondary: spell.palette, accent: spell.palette }
    : getPaletteForElement(spell.element);
  const origin = spell.castingOrigin || config.defaultOrigin;

  const envelope: CastEnvelope = {
    ...DEFAULT_CAST_ENVELOPE,
    ...config.release.envelope,
  };

  return {
    version: '1.0',
    spellId: uuidv4(),
    timestamp: Date.now(),
    intent: spell.intent,
    element: spell.element,
    archetype,
    mode: 'release',
    energy: RELEASE_ENERGY_PEAK,
    energyFloor: RELEASE_ENERGY_FLOOR,
    energyCeiling: RELEASE_ENERGY_PEAK,
    castingOrigin: origin,
    castingLandmarks: CASTING_LANDMARKS[origin],
    palette,
    zones: config.release.zones,
    castEnvelope: envelope,
  };
}

/**
 * Create an idle program (ambient particles before session starts)
 */
export function createIdleProgram(): ParticleSpellProgram {
  return {
    version: '1.0',
    spellId: uuidv4(),
    timestamp: Date.now(),
    intent: null,
    element: null,
    archetype: 'breathing_aura_mist',
    mode: 'idle',
    energy: 0.2,
    energyFloor: 0.1,
    energyCeiling: 0.3,
    castingOrigin: null,
    castingLandmarks: [],
    palette: DEFAULT_PALETTE,
    zones: {
      spawn: { spawnRadius: 0.3, spawnRate: 0.5 },
      force: { forceDirection: 'tangential', forceStrength: 0.1, orbitSpeed: 0.2 },
      velmod: { velocityScale: 0.4, damping: 0.3 },
      size: { baseSize: 0.03, sizeVariation: 0.2 },
      color: { saturation: 0.5, brightness: 0.6, alphaFade: 0.4 },
    },
  };
}

/**
 * Calculate total cast duration from envelope
 */
export function getCastDuration(envelope: CastEnvelope): number {
  return envelope.ignitionMs + envelope.projectionMs + envelope.afterglowMs;
}
