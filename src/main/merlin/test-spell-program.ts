/**
 * Test Spell Program Generation
 *
 * Standalone entry point for the Shift+T Spell Program tab. Lets a
 * developer free-text-prompt Gemini to interpret a description into a
 * ParticleSpellProgram payload, then pushes via pushParticleSpellProgram.
 *
 * Pipeline:
 *  1. Gemini-2.5-flash with GENERATE_SPELL_PROGRAM_TOOL forced ON.
 *  2. Coerce the loosely-typed args (archetype enum / hex palette /
 *     zoneOverrides with long→short name translation / castEnvelope).
 *  3. Build a synthetic SpellState seed from the user's intent /
 *     element / castingOrigin hints + Gemini's choices.
 *  4. Run createBuildupProgram / createReleaseProgram to get a
 *     fully-populated default program.
 *  5. Override with Gemini's coerced choices (anything not supplied
 *     stays at the default).
 *  6. Push via pushParticleSpellProgram and return the result.
 */

import {
  GoogleGenerativeAI,
  FunctionCallingMode,
} from '@google/generative-ai';
import { GENERATE_SPELL_PROGRAM_TOOL } from './prompts';
import {
  createBuildupProgram,
  createReleaseProgram,
  BUILDUP_ENERGY_MAX,
  RELEASE_ENERGY_PEAK,
} from './particle-program';
import { pushParticleSpellProgram } from '../td-bridge';
import type {
  CastEnvelope,
  ParticleSpellArchetype,
  ParticleSpellProgram,
  ShaderZoneName,
  SpellPalette,
  ZoneParams,
} from './types';
import type { SpellState } from '../../shared/types';
import type {
  SpellProgramTestInput,
  SpellProgramTestResult,
} from '../../shared/types';

const ts = () => new Date().toISOString().slice(11, 23);

const VALID_ARCHETYPES: readonly ParticleSpellArchetype[] = [
  'rising_embers',
  'breathing_aura_mist',
  'orbiting_stardust',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Long zone name (used in test panels & prompt text) → short name (used in ParticleSpellProgram.zones). */
const ZONE_LONG_TO_SHORT: Record<string, ShaderZoneName> = {
  spawn_behavior: 'spawn',
  force_field: 'force',
  velocity_modifier: 'velmod',
  size_over_life: 'size',
  color_over_life: 'color',
};

const VALID_FORCE_DIRECTIONS = new Set(['inward', 'outward', 'tangential', 'upward']);

let genAI: GoogleGenerativeAI | null = null;

function ensureGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function coercePalette(raw: unknown): SpellPalette | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const fields = ['primary', 'secondary', 'accent'] as const;
  const out: Partial<SpellPalette> = {};
  for (const k of fields) {
    const v = obj[k];
    if (typeof v === 'string' && HEX_RE.test(v)) (out as Record<string, string>)[k] = v;
  }
  if (out.primary && out.secondary && out.accent) return out as SpellPalette;
  return undefined;
}

function coerceZoneParams(raw: unknown): Partial<ZoneParams> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<ZoneParams> = {};
  const numericRanges: Array<[keyof ZoneParams, number, number]> = [
    ['spawnRadius', 0.1, 0.5],
    ['spawnRate', 0.5, 3.0],
    ['forceStrength', 0, 1],
    ['orbitSpeed', 0, 2],
    ['turbulence', 0, 1],
    ['velocityScale', 0.5, 3.0],
    ['damping', 0, 1],
    ['baseSize', 0.01, 0.15],
    ['sizeVariation', 0, 1],
    ['saturation', 0, 1],
    ['brightness', 0, 1],
    ['alphaFade', 0, 1],
  ];
  for (const [key, lo, hi] of numericRanges) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      (out as Record<string, number>)[key] = clamp(v, lo, hi);
    }
  }
  if (typeof o.forceDirection === 'string' && VALID_FORCE_DIRECTIONS.has(o.forceDirection)) {
    out.forceDirection = o.forceDirection as ZoneParams['forceDirection'];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceZoneOverrides(raw: unknown): Partial<Record<ShaderZoneName, ZoneParams>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<Record<ShaderZoneName, ZoneParams>> = {};
  for (const [longName, value] of Object.entries(o)) {
    const short = ZONE_LONG_TO_SHORT[longName];
    if (!short) {
      console.warn(`[TestSpellProgram ${ts()}] Dropping unknown zone override: ${longName}`);
      continue;
    }
    const params = coerceZoneParams(value);
    if (params) out[short] = params as ZoneParams;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceCastEnvelope(raw: unknown): Partial<CastEnvelope> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<CastEnvelope> = {};
  for (const key of ['ignitionMs', 'projectionMs', 'afterglowMs'] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out[key] as number) = v;
  }
  if (typeof o.peakIntensity === 'number' && Number.isFinite(o.peakIntensity)) {
    out.peakIntensity = clamp(o.peakIntensity, 0, 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface CoercedArgs {
  archetype?: ParticleSpellArchetype;
  energy?: number;
  palette?: SpellPalette;
  zoneOverrides?: Partial<Record<ShaderZoneName, ZoneParams>>;
  castEnvelope?: Partial<CastEnvelope>;
}

export function coerceGeminiArgs(raw: Record<string, unknown>): CoercedArgs {
  const out: CoercedArgs = {};

  if (typeof raw.archetype === 'string' && (VALID_ARCHETYPES as readonly string[]).includes(raw.archetype)) {
    out.archetype = raw.archetype as ParticleSpellArchetype;
  }
  if (typeof raw.energy === 'number' && Number.isFinite(raw.energy)) {
    out.energy = clamp(raw.energy, 0, 1);
  }
  const palette = coercePalette(raw.palette);
  if (palette) out.palette = palette;
  const zo = coerceZoneOverrides(raw.zoneOverrides);
  if (zo) out.zoneOverrides = zo;
  const env = coerceCastEnvelope(raw.castEnvelope);
  if (env) out.castEnvelope = env;

  return out;
}

/** Build a synthetic SpellState that drives createBuildup/Release defaults. */
function buildSeed(input: SpellProgramTestInput, args: CoercedArgs): SpellState {
  return {
    intent: input.intent ?? null,
    element: input.element ?? null,
    tone: null,
    energy: args.energy ?? (input.mode === 'release' ? RELEASE_ENERGY_PEAK : BUILDUP_ENERGY_MAX),
    complexity: 0.5,
    castingOrigin: input.castingOrigin ?? null,
    visualArchetype: args.archetype ?? null,
    palette: args.palette?.primary ?? null,
    magicWord: null,
    confidence: 0.5,
  };
}

/** Apply Gemini's coerced overrides on top of a default program. */
function mergeOverrides(
  base: ParticleSpellProgram,
  args: CoercedArgs,
  mode: 'buildup' | 'release'
): ParticleSpellProgram {
  const merged: ParticleSpellProgram = { ...base, zones: { ...base.zones } };

  if (args.archetype) merged.archetype = args.archetype;
  if (args.energy !== undefined) {
    const cap = mode === 'buildup' ? BUILDUP_ENERGY_MAX : RELEASE_ENERGY_PEAK;
    merged.energy = clamp(args.energy, 0, cap);
  }
  if (args.palette) merged.palette = args.palette;
  if (args.zoneOverrides) {
    for (const [shortName, params] of Object.entries(args.zoneOverrides)) {
      const key = shortName as ShaderZoneName;
      merged.zones[key] = { ...(merged.zones[key] ?? {}), ...params };
    }
  }
  if (mode === 'release' && args.castEnvelope && merged.castEnvelope) {
    merged.castEnvelope = { ...merged.castEnvelope, ...args.castEnvelope };
  }

  return merged;
}

/**
 * Generate and push a spell program from a free-text prompt.
 */
export async function generateSpellProgramWithGemini(
  input: SpellProgramTestInput
): Promise<SpellProgramTestResult> {
  console.log(
    `[TestSpellProgram ${ts()}] mode=${input.mode} prompt="${input.prompt}" ` +
    `intent=${input.intent ?? '-'} element=${input.element ?? '-'} origin=${input.castingOrigin ?? '-'}`
  );

  if (!input.prompt || !input.prompt.trim()) {
    return { success: false, pushed: false, error: 'Prompt is required' };
  }

  let coerced: CoercedArgs = {};
  let rawArgs: Record<string, unknown> | null = null;

  try {
    const ai = ensureGenAI();
    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ functionDeclarations: [GENERATE_SPELL_PROGRAM_TOOL] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: ['set_spell_program'],
        },
      },
    });

    const userPrompt =
      `Spell description: "${input.prompt}"\n` +
      `Mode: ${input.mode}` +
      (input.intent ? `\nIntent: ${input.intent}` : '') +
      (input.element ? `\nElement: ${input.element}` : '') +
      (input.castingOrigin ? `\nCasting origin: ${input.castingOrigin}` : '') +
      `\n\nCall set_spell_program once with the visual parameters that best embody this spell.`;

    const response = await model.generateContent(userPrompt);
    const candidate = response.response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      if ('functionCall' in part && part.functionCall?.name === 'set_spell_program') {
        rawArgs = (part.functionCall.args ?? {}) as Record<string, unknown>;
        break;
      }
    }

    if (!rawArgs) {
      return {
        success: false,
        pushed: false,
        error: 'Gemini did not call set_spell_program',
      };
    }

    coerced = coerceGeminiArgs(rawArgs);
    console.log(`[TestSpellProgram ${ts()}] Gemini chose: ${JSON.stringify(coerced)}`);
  } catch (e) {
    return {
      success: false,
      pushed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Build defaults via the live program builders, then merge overrides.
  const seed = buildSeed(input, coerced);
  const base = input.mode === 'release' ? createReleaseProgram(seed) : createBuildupProgram(seed);
  const program = mergeOverrides(base, coerced, input.mode);

  const pushed = pushParticleSpellProgram(input.mode, program);

  return {
    success: true,
    pushed,
    program: program as unknown as Record<string, unknown>,
    geminiArgs: rawArgs as Record<string, unknown>,
  };
}
