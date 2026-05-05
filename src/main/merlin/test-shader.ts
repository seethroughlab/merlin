/**
 * Test Shader Generation
 *
 * Standalone function to test Gemini's shader generation
 * without a full Merlin conversation session.
 */

import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  FunctionDeclaration,
  SchemaType,
} from '@google/generative-ai';
import { pushZoneUpdateWithValidation } from '../td-bridge';

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

/**
 * Configuration for test shader generation
 */
export interface TestShaderConfig {
  intent: string;
  element: string;
  energy: number;
}

/**
 * Individual zone shader result
 */
export interface ZoneShaderResult {
  zone: string;
  glsl_code: string;
  description: string;
  status?: 'pending' | 'active' | 'error';
  error?: string;
  warnings?: string[];
}

/**
 * Result from test shader generation
 */
export interface TestShaderResult {
  zones: ZoneShaderResult[];
  rawResponse: string;
  success: boolean;
  error?: string;
}

/**
 * Actual shader templates from td/shaders/ - Gemini writes code snippets that get injected at {zone_code}
 *
 * Templates have default behavior, then {zone_code} insertion point, then output.
 * Gemini should MODIFY the existing variables (force, color, size) rather than replacing them.
 */
const SHADER_TEMPLATES = {
  force_field: `void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));
    vec3 force = TDIn_PartForce();

    // Default behavior: gentle orbit with center attraction
    vec2 toCenter = vec2(0.5, 0.5) - pos.xy;
    float dist = length(toCenter);
    force.x += -toCenter.y * 0.03;
    force.y += toCenter.x * 0.03;
    float pullStrength = smoothstep(0.15, 0.4, dist) * 0.05;
    force.xy += normalize(toCenter) * pullStrength;
    force.y += 0.005;
    force *= (0.5 + uSpellEnergy);

    // {zone_code}  <-- YOUR SNIPPET GOES HERE

    PartForce[idx] = force;
}`,

  color_over_life: `void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default purple with life fade
    vec4 color = vec4(0.6, 0.4, 0.9, life * 0.7);
    color.rgb *= (0.6 + uSpellEnergy * 0.6);

    // {zone_code}  <-- YOUR SNIPPET GOES HERE

    xcolor[idx] = color;
}`,

  size_over_life: `void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default size with life fade
    float size = 0.015 * life;
    size *= (0.8 + uSpellEnergy * 0.4);

    // {zone_code}  <-- YOUR SNIPPET GOES HERE

    xscale[idx] = vec3(size);
}`,
};

/**
 * System prompt focused only on shader generation
 */
const TEST_SHADER_SYSTEM_PROMPT = `You are a GLSL shader author for a particle system in TouchDesigner.
Given a spell intent, element, and energy level, generate expressive visual effects.

## How It Works

You write CODE SNIPPETS that get injected into shader templates at the {zone_code} placeholder.
The templates already have default behavior - your snippet can:
- REPLACE the defaults (assign new values to force/color/size)
- MODIFY the defaults (add to or multiply existing values)

## Available Variables

Each template provides these variables for you to use:

### force_field:
- pos (vec3): particle position
- vel (vec3): particle velocity
- age, lifeSpan (float): particle age and total life
- life (float): 1.0 at birth, 0.0 at death
- force (vec3): accumulated force (modify this!)
- idx (uint): particle index

### color_over_life:
- age, lifeSpan, life (float)
- color (vec4): RGBA color (modify this!)
- idx (uint)

### size_over_life:
- age, lifeSpan, life (float)
- size (float): particle scale (modify this!)
- idx (uint)

### Uniforms (all zones):
- uTime (float): current time in seconds
- uSpellEnergy (float): spell intensity 0-1
- uSpellMode (float): -1=idle, 0=buildup, 1=release

## Example Zone Codes

### force_field - Fire spiral:
\`\`\`glsl
// Replace default with fire behavior
float angle = atan(pos.z, pos.x) + uTime * 2.0;
float lift = uSpellEnergy * 0.2;
force = vec3(cos(angle) * 0.05, lift + sin(uTime * 3.0) * 0.02, sin(angle) * 0.05);
\`\`\`

### color_over_life - Fire gradient:
\`\`\`glsl
// Fire colors: orange core, red edges
vec3 fireCore = vec3(1.0, 0.6, 0.1);
vec3 fireEdge = vec3(1.0, 0.2, 0.0);
color = vec4(mix(fireEdge, fireCore, life), life * 0.85 * uSpellEnergy);
\`\`\`

### size_over_life - Flickering:
\`\`\`glsl
// Flickering flame size
float flicker = 0.8 + 0.2 * sin(uTime * 10.0 + float(idx) * 2.0);
size = life * 0.04 * flicker * (0.6 + uSpellEnergy * 0.4);
\`\`\`

## Element Visual Patterns

- **fire**: upward spirals, orange→red gradients, flickering size
- **water**: wave motion, blue-green→teal, smooth sine waves
- **air**: circular swirling, light pastels, wispy/fading
- **earth**: downward pull, browns/greens, stable/grounded
- **light**: radiant expansion, golden-white, pulsing brightness
- **shadow**: contracting inward, deep purples, fading edges
- **cosmic**: orbital patterns, star blues/purples, scattered dust
- **storm**: chaotic forces, electric blue/white, varied sizes
- **crystal**: geometric angles, prismatic rainbow, sharp edges
- **flora**: organic curves, greens/pinks, budding/growing

## Rules

1. Call set_zone_shader for ALL THREE zones: force_field, color_over_life, size_over_life
2. Write ONLY the snippet code - no void main() or output statements
3. REPLACE or MODIFY the template's force/color/size variables
4. Match the visual style to BOTH the intent AND element
5. Use uSpellEnergy to modulate overall intensity
6. CRITICAL: Keep comments SHORT (under 60 chars) or use /* block */ style. Long // comments that wrap will break compilation!

## Common Pitfalls - AVOID THESE

### 1. Random seeds must include time for spawn shaders
Particle IDs are REUSED when particles die and respawn. If you use only the particle ID for randomization, each ID always spawns at the same position, creating static patterns instead of dynamic motion.

\`\`\`glsl
// BAD - particle ID 0 always spawns at same position
float seed = fract(sin(float(idx) * 12.9898) * 43758.5453);

// GOOD - position varies each time particle is born
float seed = fract(sin((uTime + float(idx) * 0.001) * 12.9898) * 43758.5453);
\`\`\`

### 2. Use uTime for animation, not static patterns
When creating animated effects (swirls, waves, pulses), always incorporate uTime:

\`\`\`glsl
// BAD - static pattern
float wave = sin(pos.x * 10.0);

// GOOD - animated pattern
float wave = sin(pos.x * 10.0 + uTime * 2.0);
\`\`\`

### 3. Visible motion requires appropriate force magnitudes
- Too small (< 0.01): particles appear static
- Good range: 0.03 - 0.15 for gentle motion, 0.15 - 0.3 for energetic
- Too large (> 0.5): motion too fast to perceive

### 4. Balance damping with forces
If using velocity damping elsewhere, ensure forces are strong enough to overcome it.`;

/**
 * Tool definition for shader generation
 */
const SET_ZONE_SHADER_TOOL: FunctionDeclaration = {
  name: 'set_zone_shader',
  description: 'Set custom GLSL code for a particle zone',
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      zone: {
        type: 'string' as SchemaType,
        enum: ['force_field', 'color_over_life', 'size_over_life'],
        description: 'Which shader zone to customize',
      },
      glsl_code: {
        type: 'string' as SchemaType,
        description: 'GLSL code snippet. Must use indexed output: PartForce[idx], xcolor[idx], xscale[idx]',
      },
      description: {
        type: 'string' as SchemaType,
        description: 'Brief description of the visual effect',
      },
    },
    required: ['zone', 'glsl_code', 'description'],
  },
};

/**
 * Generate test shaders using Gemini
 */
export async function testShaderGeneration(config: TestShaderConfig): Promise<TestShaderResult> {
  const ts = () => new Date().toISOString().slice(11, 23);
  console.log(`[TestShader ${ts()}] Starting: intent=${config.intent} element=${config.element} energy=${config.energy}`);

  try {
    const ai = ensureGenAI();

    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: TEST_SHADER_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: [SET_ZONE_SHADER_TOOL] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY, // Force tool use
          allowedFunctionNames: ['set_zone_shader'],
        },
      },
    });

    const prompt = `Generate shaders for a "${config.intent}" spell with "${config.element}" element at ${config.energy.toFixed(1)} energy.

Create expressive, creative GLSL that embodies this combination. Call set_zone_shader for ALL THREE zones: force_field, color_over_life, size_over_life.`;

    console.log(`[TestShader ${ts()}] Sending prompt to Gemini...`);
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

    const zones: ZoneShaderResult[] = [];
    let rawResponse = '';

    // Process all parts
    for (const part of candidate.content.parts) {
      if ('text' in part) {
        rawResponse += part.text;
      }

      if ('functionCall' in part && part.functionCall) {
        const fc = part.functionCall;
        if (fc.name === 'set_zone_shader' && fc.args) {
          const args = fc.args as { zone?: string; glsl_code?: string; description?: string };

          if (args.zone && args.glsl_code) {
            // Create zone result with pending status
            const zoneResult: ZoneShaderResult = {
              zone: args.zone,
              glsl_code: args.glsl_code,
              description: args.description || 'No description',
              status: 'pending',
            };
            zones.push(zoneResult);
          }
        }
      }
    }

    // Process all zones through validation pipeline
    for (const zoneResult of zones) {
      const result = await pushZoneUpdateWithValidation(zoneResult.zone, zoneResult.glsl_code);
      zoneResult.status = result.success ? 'active' : 'error';
      zoneResult.error = result.error;
      zoneResult.warnings = result.warnings;
      console.log(
        `[TestShader ${ts()}] Zone ${zoneResult.zone}: ${result.success ? 'OK' : 'FAILED'}` +
        (result.error ? ` - ${result.error}` : '')
      );
    }

    console.log(`[TestShader ${ts()}] Generated ${zones.length} zone shaders`);

    return {
      zones,
      rawResponse,
      success: zones.length >= 3,
      error: zones.length < 3 ? `Only got ${zones.length} zones, expected 3` : undefined,
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
