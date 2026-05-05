/**
 * Test Shader Generation
 *
 * Standalone function to test Gemini's shader generation without a
 * full Merlin conversation session. Now covers all marker-bearing zones
 * (the user picks a subset via Shaders-tab checkboxes); reads templates
 * from disk via shader-templates.loadTemplate so there is no inline
 * template drift.
 */

import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  FunctionDeclaration,
  SchemaType,
} from '@google/generative-ai';
import { pushZoneUpdateWithValidation } from '../td-bridge';
import { loadTemplate, ZONE_TEMPLATE_FILES } from './shader-templates';
import { ZONE_CONTRACTS } from './zone-registry';
import type {
  TestShaderConfig,
  TestShaderResult,
  ZoneShaderResult,
} from '../../shared/types';

let genAI: GoogleGenerativeAI | null = null;

function ensureGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * billboard_vertex has no {zone_code} marker today, so the WS pipeline
 * would fail to merge a snippet into it. Phase 4 will close this gap.
 */
const ZONES_WITHOUT_MARKER = new Set(['billboard_vertex']);

/**
 * All zones the test panel can ask Gemini to fill (marker-bearing).
 */
export function getMarkerBearingZones(): string[] {
  return Object.keys(ZONE_TEMPLATE_FILES).filter((z) => !ZONES_WITHOUT_MARKER.has(z));
}

/**
 * Resolve the user's zone selection to an explicit list. Empty / missing
 * config.zones defaults to all marker-bearing zones. Unknown or
 * marker-less zones are dropped with a warning.
 */
function resolveZones(zones: string[] | undefined): string[] {
  const all = getMarkerBearingZones();
  if (!zones || zones.length === 0) return all;
  const allowed = new Set(all);
  const resolved = zones.filter((z) => {
    if (!allowed.has(z)) {
      console.warn(`[TestShader ${ts()}] Dropping unsupported zone: ${z}`);
      return false;
    }
    return true;
  });
  return resolved.length > 0 ? resolved : all;
}

/**
 * Global guidance — applies to every zone. The per-zone variable lists
 * and templates are appended dynamically by buildSystemPrompt.
 */
const SYSTEM_PROMPT_HEADER = `You are a GLSL shader author for a particle system in TouchDesigner.
Given a spell intent, element, and energy level, generate expressive visual effects.

## How It Works

You write CODE SNIPPETS that get injected into shader templates at the {zone_code} placeholder.
The templates already have default behavior — your snippet can:
- REPLACE the defaults (assign new values to force / color / size / etc.)
- MODIFY the defaults (add to or multiply existing values)

## Common Uniforms

- uTime (float): current time in seconds
- uSpellEnergy (float): spell intensity 0-1
- uSpellMode (float): -1=idle, 0=buildup, 1=release
(Per-zone uniforms are listed below.)

## Element Visual Patterns

- fire: upward spirals, orange→red gradients, flickering size
- water: wave motion, blue-green→teal, smooth sine waves
- air: circular swirling, light pastels, wispy/fading
- earth: downward pull, browns/greens, stable/grounded
- light: radiant expansion, golden-white, pulsing brightness
- shadow: contracting inward, deep purples, fading edges
- cosmic: orbital patterns, star blues/purples, scattered dust
- storm: chaotic forces, electric blue/white, varied sizes
- crystal: geometric angles, prismatic rainbow, sharp edges
- flora: organic curves, greens/pinks, budding/growing

## Rules

1. Call set_zone_shader once for EACH requested zone (the user prompt lists which).
2. Write ONLY the snippet code — no void main() or output statements.
3. REPLACE or MODIFY the template's variables shown below.
4. Match the visual style to BOTH the intent AND element.
5. Use uSpellEnergy to modulate overall intensity.
6. CRITICAL: keep comments SHORT (<60 chars) or use /* block */ style — long line-comments that wrap will break compilation.

## Common Pitfalls — AVOID THESE

### 1. Random seeds must include time for spawn shaders
Particle IDs are REUSED when particles die and respawn. Using only the
particle ID for randomization produces static patterns.
\`\`\`glsl
// BAD — particle ID 0 always spawns at the same position
float seed = fract(sin(float(idx) * 12.9898) * 43758.5453);
// GOOD — position varies each time the particle is born
float seed = fract(sin((uTime + float(idx) * 0.001) * 12.9898) * 43758.5453);
\`\`\`

### 2. Use uTime for animation, not static patterns
\`\`\`glsl
// BAD — static pattern
float wave = sin(pos.x * 10.0);
// GOOD — animated pattern
float wave = sin(pos.x * 10.0 + uTime * 2.0);
\`\`\`

### 3. Visible motion requires appropriate force magnitudes
- < 0.01: appears static
- 0.03-0.15: gentle motion
- 0.15-0.3: energetic
- > 0.5: too fast to perceive

### 4. Balance damping with forces
If using velocity damping elsewhere, ensure forces are strong enough to overcome it.`;

/**
 * Build the per-zone variable/uniform/template section for the system prompt.
 */
function buildPerZoneSection(zones: string[]): string {
  const lines: string[] = ['## Available Variables Per Zone', ''];
  for (const zone of zones) {
    const contract = ZONE_CONTRACTS[zone as keyof typeof ZONE_CONTRACTS];
    if (!contract) continue;
    const modifies = Array.isArray(contract.modifies) ? contract.modifies.join(', ') : contract.modifies;
    lines.push(`### ${zone}`);
    lines.push(`- description: ${contract.description}`);
    lines.push(`- modifies: ${modifies}`);
    lines.push(`- vars: ${contract.availableVars.join(', ')}`);
    lines.push(`- uniforms: ${contract.uniforms.join(', ')}`);
    if (contract.bannedKeywords && contract.bannedKeywords.length > 0) {
      lines.push(`- banned keywords: ${contract.bannedKeywords.join(', ')}`);
    }
    lines.push(`- max lines: ${contract.maxLines}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Append the actual on-disk templates so Gemini sees the {zone_code}
 * insertion point in context. Uses loadTemplate so any edit to the
 * disk template is picked up on the next generation.
 */
function buildTemplatesSection(zones: string[]): string {
  const lines: string[] = ['## Templates (your snippet replaces {zone_code})', ''];
  for (const zone of zones) {
    const tpl = loadTemplate(zone);
    if (!tpl) {
      lines.push(`### ${zone}: (template missing — skip)`);
      lines.push('');
      continue;
    }
    lines.push(`### ${zone} (${ZONE_TEMPLATE_FILES[zone]}):`);
    lines.push('```glsl');
    lines.push(tpl);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function buildSystemPrompt(zones: string[]): string {
  return [
    SYSTEM_PROMPT_HEADER,
    '',
    buildPerZoneSection(zones),
    buildTemplatesSection(zones),
  ].join('\n');
}

function buildToolDefinition(zones: string[]): FunctionDeclaration {
  return {
    name: 'set_zone_shader',
    description: 'Set custom GLSL code for a particle zone',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        zone: {
          type: 'string' as SchemaType,
          enum: zones,
          description: 'Which shader zone to customize',
        },
        glsl_code: {
          type: 'string' as SchemaType,
          description: 'GLSL snippet replacing the {zone_code} placeholder. Use the variables and uniforms listed for this zone in the system prompt.',
        },
        description: {
          type: 'string' as SchemaType,
          description: 'Brief description of the visual effect',
        },
      },
      required: ['zone', 'glsl_code', 'description'],
    },
  };
}

/**
 * Generate test shaders using Gemini.
 *
 * - `config.zones` selects which zones Gemini is asked to fill. When
 *   omitted or empty, defaults to all marker-bearing zones (8 today).
 * - Each returned tool call is routed through `pushZoneUpdateWithValidation`
 *   for the same validate→push→wait-for-compile→rollback flow as the
 *   live session.
 */
export async function testShaderGeneration(config: TestShaderConfig): Promise<TestShaderResult> {
  const selectedZones = resolveZones(config.zones);
  console.log(
    `[TestShader ${ts()}] Starting: intent=${config.intent} element=${config.element} ` +
    `energy=${config.energy} zones=[${selectedZones.join(', ')}]`
  );

  try {
    const ai = ensureGenAI();
    const tool = buildToolDefinition(selectedZones);

    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(selectedZones),
      tools: [{ functionDeclarations: [tool] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: ['set_zone_shader'],
        },
      },
    });

    const prompt =
      `Generate shaders for a "${config.intent}" spell with "${config.element}" element ` +
      `at ${config.energy.toFixed(1)} energy.\n\n` +
      `Create expressive, creative GLSL that embodies this combination. ` +
      `Call set_zone_shader once for each of these zones: ${selectedZones.join(', ')}.`;

    console.log(`[TestShader ${ts()}] Sending prompt to Gemini (${selectedZones.length} zones)...`);
    const result = await model.generateContent(prompt);
    const response = result.response;
    const candidate = response.candidates?.[0];

    if (!candidate || !candidate.content?.parts) {
      return {
        zones: [],
        rawResponse: 'No response from Gemini',
        success: false,
        error: 'No response generated',
      };
    }

    const requested = new Set(selectedZones);
    const zones: ZoneShaderResult[] = [];
    let rawResponse = '';

    for (const part of candidate.content.parts) {
      if ('text' in part && part.text) {
        rawResponse += part.text;
      }

      if ('functionCall' in part && part.functionCall) {
        const fc = part.functionCall;
        if (fc.name === 'set_zone_shader' && fc.args) {
          const args = fc.args as { zone?: string; glsl_code?: string; description?: string };
          if (args.zone && args.glsl_code && requested.has(args.zone)) {
            zones.push({
              zone: args.zone,
              glsl_code: args.glsl_code,
              description: args.description || 'No description',
              status: 'pending',
            });
          } else if (args.zone && !requested.has(args.zone)) {
            console.warn(`[TestShader ${ts()}] Gemini returned unrequested zone: ${args.zone} (dropping)`);
          }
        }
      }
    }

    // Push each zone through the full validation pipeline.
    for (const zoneResult of zones) {
      const pushResult = await pushZoneUpdateWithValidation(zoneResult.zone, zoneResult.glsl_code);
      zoneResult.status = pushResult.success ? 'active' : 'error';
      zoneResult.error = pushResult.error;
      zoneResult.warnings = pushResult.warnings;
      console.log(
        `[TestShader ${ts()}] Zone ${zoneResult.zone}: ${pushResult.success ? 'OK' : 'FAILED'}` +
        (pushResult.error ? ` - ${pushResult.error}` : '')
      );
    }

    console.log(`[TestShader ${ts()}] Generated ${zones.length} of ${selectedZones.length} zone shaders`);

    const success = zones.length >= selectedZones.length;
    return {
      zones,
      rawResponse,
      success,
      error: success ? undefined : `Only got ${zones.length} of ${selectedZones.length} zones`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[TestShader ${ts()}] Error:`, errorMsg);
    return {
      zones: [],
      rawResponse: '',
      success: false,
      error: errorMsg,
    };
  }
}
