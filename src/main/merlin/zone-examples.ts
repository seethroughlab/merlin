/**
 * Zone Examples Library
 *
 * Curated GLSL snippets for each zone/element combination.
 * Used for few-shot prompting and as fallback examples.
 */

import type { SpellElement } from '../../shared/types';

/**
 * Example snippet with metadata
 */
export interface ZoneExample {
  code: string;
  description: string;
}

/**
 * Force field examples by element
 */
const FORCE_FIELD_EXAMPLES: Record<SpellElement, ZoneExample> = {
  fire: {
    description: 'Rising spiral with flickering turbulence',
    code: `// Rising fire spiral
float angle = atan(pos.z, pos.x) + uTime * 2.0;
float lift = uSpellEnergy * 0.15;
float flicker = sin(uTime * 8.0 + float(idx) * 0.3) * 0.02;
force = vec3(cos(angle) * 0.04, lift + flicker, sin(angle) * 0.04);`,
  },
  water: {
    description: 'Gentle wave motion with horizontal drift',
    code: `// Ocean wave motion
float wave = sin(pos.x * 4.0 + uTime * 1.5) * 0.08;
float drift = cos(uTime * 0.5) * 0.03;
force.y += wave * uSpellEnergy;
force.x += drift;
force.z += sin(pos.z * 3.0 + uTime) * 0.02;`,
  },
  air: {
    description: 'Swirling vortex with upward lift',
    code: `// Air vortex
vec2 toCenter = -pos.xy;
float dist = length(toCenter);
float swirl = 0.08 / max(dist, 0.1);
force.xy += vec2(-toCenter.y, toCenter.x) * swirl;
force.y += 0.05 * uSpellEnergy;
force.z += sin(uTime * 2.0) * 0.02;`,
  },
  earth: {
    description: 'Grounding pull with gentle oscillation',
    code: `// Earth grounding
force.y -= 0.06 * uSpellEnergy;
float groundWave = sin(pos.x * 3.0 + uTime * 0.5) * 0.02;
force.y += groundWave * (1.0 - life);
force.xz *= 0.95;  // Dampen horizontal`,
  },
  light: {
    description: 'Radiant expansion with pulsing',
    code: `// Light expansion
vec3 outward = normalize(pos - vec3(0.5, 0.5, 0.0));
float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
force += outward * 0.08 * uSpellEnergy * pulse;`,
  },
  shadow: {
    description: 'Contracting inward with fading edges',
    code: `// Shadow contraction
vec2 toCenter = vec2(0.5) - pos.xy;
float pull = smoothstep(0.3, 0.6, length(toCenter)) * 0.1;
force.xy += normalize(toCenter) * pull * uSpellEnergy;
force *= life;  // Fade with age`,
  },
  crystal: {
    description: 'Geometric angular motion',
    code: `// Crystal facets
float facet = floor(atan(pos.z, pos.x) * 3.0 / 3.14159) * 3.14159 / 3.0;
vec2 dir = vec2(cos(facet), sin(facet));
force.xz += dir * 0.05 * uSpellEnergy;
force.y += abs(sin(facet + uTime)) * 0.03;`,
  },
  storm: {
    description: 'Chaotic turbulent forces',
    code: `// Storm chaos
float chaos = sin(uTime * 5.0 + pos.x * 10.0) * cos(uTime * 3.0 + pos.z * 8.0);
force.x += chaos * 0.1 * uSpellEnergy;
force.y += sin(uTime * 7.0 + pos.y * 6.0) * 0.08;
force.z += cos(chaos * 3.0) * 0.05;`,
  },
  flora: {
    description: 'Organic growth curves',
    code: `// Flora growth
float growth = smoothstep(0.0, 0.3, life);
force.y += growth * 0.06 * uSpellEnergy;
float sway = sin(uTime + pos.y * 4.0) * 0.03;
force.x += sway * (1.0 - life);`,
  },
  cosmic: {
    description: 'Orbital patterns with gravity wells',
    code: `// Cosmic orbit
vec2 toCenter = -pos.xy;
float dist = length(toCenter);
float orbital = 0.06 / max(dist, 0.15);
force.xy += vec2(-toCenter.y, toCenter.x) * orbital;
force.xy += normalize(toCenter) * 0.02 / (dist + 0.1);
force.z += sin(uTime + dist * 5.0) * 0.02;`,
  },
};

/**
 * Color over life examples by element
 */
const COLOR_OVER_LIFE_EXAMPLES: Record<SpellElement, ZoneExample> = {
  fire: {
    description: 'Orange core to red edges with intensity',
    code: `// Fire gradient
vec3 core = vec3(1.0, 0.7, 0.2);
vec3 edge = vec3(1.0, 0.2, 0.05);
color = vec4(mix(edge, core, life), life * 0.85 * uSpellEnergy);`,
  },
  water: {
    description: 'Deep blue to teal with transparency',
    code: `// Ocean colors
vec3 deep = vec3(0.1, 0.3, 0.6);
vec3 surface = vec3(0.3, 0.7, 0.8);
color = vec4(mix(deep, surface, life), life * 0.7);`,
  },
  air: {
    description: 'Light pastels fading to white',
    code: `// Air wisps
vec3 base = vec3(0.8, 0.9, 1.0);
color = vec4(base, life * 0.5 * uSpellEnergy);`,
  },
  earth: {
    description: 'Rich browns and greens',
    code: `// Earth tones
vec3 soil = vec3(0.4, 0.25, 0.1);
vec3 moss = vec3(0.2, 0.4, 0.15);
color = vec4(mix(soil, moss, sin(life * 3.14159)), life * 0.8);`,
  },
  light: {
    description: 'Golden white with radiant glow',
    code: `// Light radiance
vec3 gold = vec3(1.0, 0.9, 0.6);
float glow = 0.5 + 0.5 * sin(uTime * 4.0);
color = vec4(gold * (0.8 + glow * 0.4), life);`,
  },
  shadow: {
    description: 'Deep purples fading to black',
    code: `// Shadow fade
vec3 purple = vec3(0.3, 0.1, 0.4);
color = vec4(purple * life, life * life * 0.8);`,
  },
  crystal: {
    description: 'Prismatic rainbow shimmer',
    code: `// Crystal prism
float hue = fract(life + uTime * 0.2 + float(idx) * 0.01);
vec3 rgb = 0.5 + 0.5 * cos(6.28318 * (hue + vec3(0.0, 0.33, 0.67)));
color = vec4(rgb, life * 0.9);`,
  },
  storm: {
    description: 'Electric blue with white flashes',
    code: `// Storm lightning
vec3 electric = vec3(0.3, 0.5, 1.0);
float flash = step(0.95, fract(uTime * 3.0 + float(idx) * 0.1));
color = vec4(mix(electric, vec3(1.0), flash), life * 0.85);`,
  },
  flora: {
    description: 'Greens with pink blooms',
    code: `// Flora bloom
vec3 leaf = vec3(0.2, 0.6, 0.3);
vec3 flower = vec3(0.9, 0.4, 0.6);
float bloom = smoothstep(0.7, 1.0, life);
color = vec4(mix(leaf, flower, bloom), life * 0.8);`,
  },
  cosmic: {
    description: 'Star blues and nebula purples',
    code: `// Cosmic nebula
vec3 star = vec3(0.6, 0.7, 1.0);
vec3 nebula = vec3(0.5, 0.2, 0.7);
float phase = sin(uTime + float(idx) * 0.05);
color = vec4(mix(nebula, star, phase * 0.5 + 0.5), life * 0.75);`,
  },
};

/**
 * Size over life examples by element
 */
const SIZE_OVER_LIFE_EXAMPLES: Record<SpellElement, ZoneExample> = {
  fire: {
    description: 'Flickering flame size',
    code: `// Flame flicker
float flicker = 0.8 + 0.2 * sin(uTime * 10.0 + float(idx) * 2.0);
size = life * 0.04 * flicker * uSpellEnergy;`,
  },
  water: {
    description: 'Smooth droplet expansion',
    code: `// Droplet size
size = 0.025 * smoothstep(0.0, 0.2, life) * smoothstep(1.0, 0.3, life);`,
  },
  air: {
    description: 'Wispy fading particles',
    code: `// Air wisp
size = 0.02 * life * life * uSpellEnergy;`,
  },
  earth: {
    description: 'Stable grounded particles',
    code: `// Earth solid
size = 0.03 * (0.5 + 0.5 * life);`,
  },
  light: {
    description: 'Pulsing radiant orbs',
    code: `// Light pulse
float pulse = 0.8 + 0.3 * sin(uTime * 5.0);
size = 0.035 * life * pulse;`,
  },
  shadow: {
    description: 'Shrinking into darkness',
    code: `// Shadow shrink
size = 0.03 * life * life * life;`,
  },
  crystal: {
    description: 'Sharp geometric sizes',
    code: `// Crystal sharp
float facet = step(0.5, fract(float(idx) * 0.618));
size = 0.02 + facet * 0.015 * life;`,
  },
  storm: {
    description: 'Varied chaotic sizes',
    code: `// Storm chaos
float chaos = fract(sin(float(idx) * 127.1) * 43758.5453);
size = (0.015 + chaos * 0.025) * life;`,
  },
  flora: {
    description: 'Budding growth pattern',
    code: `// Flora bud
float bud = smoothstep(0.8, 1.0, life);
size = 0.02 * (1.0 + bud * 0.5);`,
  },
  cosmic: {
    description: 'Scattered stardust sizes',
    code: `// Stardust scatter
float star = fract(float(idx) * 0.618);
size = (0.01 + star * 0.03) * life * uSpellEnergy;`,
  },
};

/**
 * Post-FX examples by element
 */
const POST_FX_EXAMPLES: Partial<Record<SpellElement, ZoneExample>> = {
  fire: {
    description: 'Warm color grading with bloom',
    code: `// Fire warmth
color.rgb = pow(color.rgb, vec3(0.9, 1.0, 1.1));
color.rgb += vec3(0.05, 0.02, 0.0) * uSpellEnergy;`,
  },
  light: {
    description: 'Soft bloom effect',
    code: `// Light bloom
vec3 bloom = color.rgb * smoothstep(0.5, 1.0, dot(color.rgb, vec3(0.299, 0.587, 0.114)));
color.rgb += bloom * uBloomIntensity * 0.3;`,
  },
  shadow: {
    description: 'Dark vignette with desaturation',
    code: `// Shadow mood
float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
color.rgb = mix(vec3(luma), color.rgb, 0.7);
float vig = 1.0 - length(uv - 0.5) * 1.2;
color.rgb *= vig;`,
  },
  cosmic: {
    description: 'Subtle chromatic aberration',
    code: `// Cosmic aberration
float dist = length(uv - 0.5);
float offset = dist * uChromaticAberration * 0.01;
color.r = texture(sTD2DInputs[0], uv + vec2(offset, 0.0)).r;
color.b = texture(sTD2DInputs[0], uv - vec2(offset, 0.0)).b;`,
  },
};

/**
 * Get example for a specific zone and element
 */
export function getZoneExample(zone: string, element: SpellElement): ZoneExample | null {
  switch (zone) {
    case 'force_field':
      return FORCE_FIELD_EXAMPLES[element] || null;
    case 'color_over_life':
      return COLOR_OVER_LIFE_EXAMPLES[element] || null;
    case 'size_over_life':
      return SIZE_OVER_LIFE_EXAMPLES[element] || null;
    case 'post_fx':
      return POST_FX_EXAMPLES[element] || null;
    default:
      return null;
  }
}

/**
 * Get a random example for a zone (for prompt diversity)
 */
export function getRandomExample(zone: string): { element: SpellElement; example: ZoneExample } | null {
  const elements: SpellElement[] = ['fire', 'water', 'air', 'earth', 'light', 'shadow', 'crystal', 'storm', 'flora', 'cosmic'];
  const shuffled = elements.sort(() => Math.random() - 0.5);

  for (const element of shuffled) {
    const example = getZoneExample(zone, element);
    if (example) {
      return { element, example };
    }
  }
  return null;
}

/**
 * Get all examples for a zone (for comprehensive prompting)
 */
export function getAllExamplesForZone(zone: string): Array<{ element: SpellElement; example: ZoneExample }> {
  const elements: SpellElement[] = ['fire', 'water', 'air', 'earth', 'light', 'shadow', 'crystal', 'storm', 'flora', 'cosmic'];
  const results: Array<{ element: SpellElement; example: ZoneExample }> = [];

  for (const element of elements) {
    const example = getZoneExample(zone, element);
    if (example) {
      results.push({ element, example });
    }
  }

  return results;
}

/**
 * Format examples for prompt injection
 */
export function formatExamplesForPrompt(zone: string, maxExamples: number = 3): string {
  const examples = getAllExamplesForZone(zone).slice(0, maxExamples);

  if (examples.length === 0) {
    return '';
  }

  const lines: string[] = [`### ${zone} examples:`];

  for (const { element, example } of examples) {
    lines.push(`**${element}** - ${example.description}:`);
    lines.push('```glsl');
    lines.push(example.code);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
