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
  FunctionDeclaration,
  SchemaType,
  Part,
} from '@google/generative-ai';
import { pushZoneUpdateWithValidation } from '../td-bridge';
import { loadTemplate, ZONE_TEMPLATE_FILES } from './shader-templates';
import { ZONE_CONTRACTS } from './zone-registry';
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import { startSingleToolChat } from './gemini-chat-helper';
import type {
  TestShaderConfig,
  TestShaderResult,
  ZoneShaderResult,
  GeminiToolCall,
} from '../../shared/types';

const MAX_RETRIES = 2;

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Zones whose templates have no {zone_code} marker — the WS pipeline
 * would fail to merge a snippet into them. Empty after Phase 4 added
 * the billboard_vertex marker; kept as the extension point for any
 * future marker-less templates.
 */
const ZONES_WITHOUT_MARKER = new Set<string>();

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

interface ParsedResponse {
  text: string;
  toolCallsByZone: Map<string, { glsl_code: string; description: string }>;
  rawToolCalls: GeminiToolCall[];
}

function parseShaderResponse(parts: Part[], requested: Set<string>): ParsedResponse {
  const toolCallsByZone = new Map<string, { glsl_code: string; description: string }>();
  const rawToolCalls: GeminiToolCall[] = [];
  let text = '';

  for (const part of parts) {
    if ('text' in part && part.text) text += part.text;
    if ('functionCall' in part && part.functionCall?.name === 'set_zone_shader') {
      const args = (part.functionCall.args ?? {}) as { zone?: string; glsl_code?: string; description?: string };
      rawToolCalls.push({ name: 'set_zone_shader', args: args as Record<string, unknown> });
      if (args.zone && args.glsl_code && requested.has(args.zone)) {
        toolCallsByZone.set(args.zone, {
          glsl_code: args.glsl_code,
          description: args.description ?? 'No description',
        });
      }
    }
  }
  return { text, toolCallsByZone, rawToolCalls };
}

/**
 * Generate test shaders using Gemini.
 *
 * Chat-based: opens a multi-turn `chat = model.startChat(...)` so we can
 * send compile errors back as follow-up messages. Up to MAX_RETRIES per
 * zone before giving up. Emits progressive GeminiTurn events so the
 * sidebar shows the conversation in real time.
 */
export async function testShaderGeneration(config: TestShaderConfig): Promise<TestShaderResult> {
  const selectedZones = resolveZones(config.zones);
  console.log(
    `[TestShader ${ts()}] Starting: intent=${config.intent} element=${config.element} ` +
    `energy=${config.energy} zones=[${selectedZones.join(', ')}]`
  );

  const turnId = nextTurnId();
  const systemPrompt = buildSystemPrompt(selectedZones);
  const userPrompt =
    `Generate shaders for a "${config.intent}" spell with "${config.element}" element ` +
    `at ${config.energy.toFixed(1)} energy.\n\n` +
    `Create expressive, creative GLSL that embodies this combination. ` +
    `Call set_zone_shader once for each of these zones: ${selectedZones.join(', ')}.`;

  emitGeminiTurn({ id: turnId, source: 'test_shader', systemPrompt, userPrompt });

  try {
    const tool = buildToolDefinition(selectedZones);
    const handle = startSingleToolChat(tool, { systemInstruction: systemPrompt });

    console.log(`[TestShader ${ts()}] Sending prompt to Gemini (${selectedZones.length} zones)...`);
    const initial = await handle.send(userPrompt);
    const requested = new Set(selectedZones);
    const initialParsed = parseShaderResponse(initial.rawParts, requested);

    emitGeminiTurn({
      id: turnId,
      source: 'test_shader',
      responseText: initialParsed.text,
      toolCalls: initialParsed.rawToolCalls,
    });

    if (initial.rawParts.length === 0) {
      emitGeminiTurn({ id: turnId, source: 'test_shader', final: true });
      return {
        zones: [],
        rawResponse: 'No response from Gemini',
        success: false,
        error: 'No response generated',
      };
    }

    const zones: ZoneShaderResult[] = [];
    let rawResponse = initialParsed.text;
    const codeByZone = new Map<string, { glsl_code: string; description: string }>(initialParsed.toolCallsByZone);

    // Push each zone, retrying on compile failure within the same chat.
    for (const zone of selectedZones) {
      const initialCall = codeByZone.get(zone);
      if (!initialCall) {
        zones.push({
          zone,
          glsl_code: '',
          description: 'Gemini did not return code for this zone',
          status: 'error',
          error: 'Missing tool call',
        });
        continue;
      }

      const zoneResult: ZoneShaderResult = {
        zone,
        glsl_code: initialCall.glsl_code,
        description: initialCall.description,
        status: 'pending',
      };

      // Per-zone block wrapped in try/catch so a transient Gemini failure
      // or a thrown push doesn't skip the final emit and leave the zone
      // in a half-recorded state.
      try {
        let push = await pushZoneUpdateWithValidation(zoneResult.zone, zoneResult.glsl_code);
        let attempt = 1;
        emitGeminiTurn({
          id: turnId,
          source: 'test_shader',
          pushResults: [{ zone, success: push.success, error: push.error, warnings: push.warnings }],
        });
        console.log(
          `[TestShader ${ts()}] Zone ${zone} attempt 1: ${push.success ? 'OK' : 'FAILED'}` +
          (push.error ? ` - ${push.error}` : '')
        );

        while (!push.success && attempt <= MAX_RETRIES) {
          const contract = ZONE_CONTRACTS[zone as keyof typeof ZONE_CONTRACTS];
          const maxLines = contract?.maxLines;
          // Phrasing borrowed from vibe-agent/server/gemini_session.py:338-357,
          // extended with line-cap guidance because the validator rejects
          // snippets exceeding ZONE_CONTRACTS[zone].maxLines.
          const retryMsg =
            `COMPILE ERROR (iteration ${attempt}/${MAX_RETRIES}):\n\n` +
            `Tool result for "${zone}": ${push.error ?? 'unknown error'}\n\n` +
            `CRITICAL: The GLSL zone "${zone}" failed. The zone code was reverted to defaults.\n` +
            `You MUST call set_zone_shader again with corrected GLSL for zone "${zone}".\n` +
            `Common fixes: check for syntax errors, undefined variables, missing semicolons, ` +
            `redeclaration of template-provided variables, or invalid GLSL.\n` +
            (maxLines
              ? `This zone has a hard cap of ${maxLines} lines — keep the snippet shorter than that.\n`
              : '') +
            `Explain what you think went wrong and provide fixed code.`;
          emitGeminiTurn({
            id: turnId,
            source: 'test_shader',
            retry: { attempt, total: MAX_RETRIES, zone, reason: push.error },
          });

          const retryResp = await handle.send(retryMsg);
          const retryParsed = parseShaderResponse(retryResp.rawParts, requested);
          rawResponse += '\n' + retryParsed.text;
          emitGeminiTurn({
            id: turnId,
            source: 'test_shader',
            responseText: retryParsed.text,
            toolCalls: retryParsed.rawToolCalls,
          });

          const next = retryParsed.toolCallsByZone.get(zone);
          if (!next) {
            console.warn(`[TestShader ${ts()}] Retry response did not include zone "${zone}", giving up`);
            break;
          }
          zoneResult.glsl_code = next.glsl_code;
          zoneResult.description = next.description || zoneResult.description;
          push = await pushZoneUpdateWithValidation(zoneResult.zone, zoneResult.glsl_code);
          attempt += 1;
          emitGeminiTurn({
            id: turnId,
            source: 'test_shader',
            pushResults: [{ zone, success: push.success, error: push.error, warnings: push.warnings }],
          });
          console.log(
            `[TestShader ${ts()}] Zone ${zone} attempt ${attempt}: ${push.success ? 'OK' : 'FAILED'}` +
            (push.error ? ` - ${push.error}` : '')
          );
        }

        zoneResult.status = push.success ? 'active' : 'error';
        zoneResult.error = push.success ? undefined : push.error;
        zoneResult.warnings = push.warnings;
      } catch (zoneErr) {
        const msg = zoneErr instanceof Error ? zoneErr.message : String(zoneErr);
        console.warn(`[TestShader ${ts()}] Zone ${zone} threw mid-loop: ${msg}`);
        zoneResult.status = 'error';
        zoneResult.error = msg;
        emitGeminiTurn({
          id: turnId,
          source: 'test_shader',
          pushResults: [{ zone, success: false, error: msg }],
        });
      }
      zones.push(zoneResult);
    }

    emitGeminiTurn({ id: turnId, source: 'test_shader', final: true });

    const compiled = zones.filter(z => z.status === 'active').length;
    console.log(`[TestShader ${ts()}] Final: ${compiled}/${selectedZones.length} zones compiled`);

    const success = compiled >= selectedZones.length;
    return {
      zones,
      rawResponse,
      success,
      error: success ? undefined : `Only ${compiled} of ${selectedZones.length} zones compiled`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[TestShader ${ts()}] Error:`, errorMsg);
    emitGeminiTurn({ id: turnId, source: 'test_shader', responseText: `Error: ${errorMsg}`, final: true });
    return {
      zones: [],
      rawResponse: '',
      success: false,
      error: errorMsg,
    };
  }
}
