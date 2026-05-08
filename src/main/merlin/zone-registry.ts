/**
 * Zone Registry
 *
 * Port of vibe-agent's zone_registry.py
 * Defines zone contracts and validation rules for each shader zone.
 */

/**
 * Zone contract definition
 */
export interface ZoneContract {
  description: string;
  modifies: string | string[];
  availableVars: string[];
  uniforms: string[];
  maxLines: number;
  bannedKeywords?: string[];
  bannedPatterns?: RegExp[];
}

/**
 * All valid zone names
 */
export const ZONE_NAMES = [
  'force_field',
  'color_over_life',
  'size_over_life',
  'spawn_behavior',
  'velocity_modifier',
  'post_fx',
  'billboard_vertex',
  'billboard_pixel',
] as const;

export type ZoneName = (typeof ZONE_NAMES)[number];

/**
 * Zone contracts defining what each zone can access and modify
 */
export const ZONE_CONTRACTS: Record<ZoneName, ZoneContract> = {
  force_field: {
    description:
      'Apply forces to particles. The template applies NO default forces — your snippet is the sole source of motion (other than emission velocity, drag, and a tiny per-id drift). Without a force_field snippet, particles coast on inertia. The template multiplies the final force by (0.5 + uSpellEnergy) so spell intensity scales automatically. Use `uChestPos`, `uEyeLPos`, `uEyeRPos`, `uHandLPos`, `uHandRPos` (vec3 world positions, last-good-held when MediaPipe loses the body part) to pull/push particles — e.g. `force += normalize(uHandRPos - pos) * 5.0` makes particles converge on the right hand. `uChestVis`, `uEyeLVis`, `uEyeRVis`, `uHandLVis`, `uHandRVis` (float [0,1]) report current MediaPipe visibility so you can branch (e.g. fall back to chest when hand isn\'t visible). Note: drag in velocity_modifier compounds per frame — at 60fps `vel *= 0.9` leaves only 0.18% velocity after 1 second, which can swallow your forces. Either keep drag gentle (`vel *= 0.98`) or scale forces 10× to match.',
    modifies: 'force',
    availableVars: ['pos', 'vel', 'age', 'lifeSpan', 'life', 'force', 'id', 'idx'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode', 'uChestPos', 'uEyeLPos', 'uEyeRPos', 'uHandLPos', 'uHandRPos', 'uChestVis', 'uEyeLVis', 'uEyeRVis', 'uHandLVis', 'uHandRVis'],
    maxLines: 25,
  },
  color_over_life: {
    description: 'Set particle color',
    modifies: 'color',
    availableVars: ['pos', 'vel', 'age', 'lifeSpan', 'life', 'color', 'id', 'idx'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode'],
    maxLines: 20,
    bannedKeywords: ['discard'],
  },
  size_over_life: {
    description: 'Set particle size',
    modifies: 'size',
    availableVars: ['age', 'lifeSpan', 'life', 'size', 'id', 'idx'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode'],
    maxLines: 15,
  },
  spawn_behavior: {
    description:
      "Initialize a newborn particle's position and velocity. The template provides these locals already populated — DO NOT redeclare them: `pos` (vec3, **default = a random point in a 0.2-radius sphere centered on the participant's chest — already body-tracked, follows them as they move**), `vel` (vec3, default outward radial + jitter from `pos`), `age` (float), `id` (float, persistent particle id), `idx` (uint, slot index), and **`r` (vec3 of pseudo-random values from hash31(id) — already a variable, do not write `vec3 r = ...` again**, just reference it). " +
      "**Body-target uniforms (vec3 world positions, last-good-held when MediaPipe loses tracking)**: `uChestPos`, `uEyeLPos`, `uEyeRPos`, `uHandLPos`, `uHandRPos`. " +
      "**Body-visibility uniforms (float [0,1])**: `uChestVis`, `uEyeLVis`, `uEyeRVis`, `uHandLVis`, `uHandRVis`. ~1 means tracked, <0.5 means MediaPipe lost the body part (and the position is held / falling back to chest). Use these if you want the spell to *behave differently* when a body part is occluded. " +
      "**Spawning rules**: If the spell emits from the chest, leave `pos` alone — it's already there. If the spell emits from another body part, set `pos = uEyeLPos + r * 0.05;` (or eye_r/hand_l/hand_r) — the small jitter keeps the spawn from being a single point. **NEVER set `pos` to a static vector near world origin** (e.g. `vec3(r.x*0.2, r.y*0.2, 0)`); that throws away body tracking and the spell will appear to come from empty space instead of the participant. To change spawn behavior assign to `pos` and/or `vel`. The template handles `P[idx] = pos; PartVel[idx] = vel;` after your snippet runs — don't write to P[] or PartVel[] yourself, they're write-only output buffers. There's no built-in `PI` constant; use `6.2832` for tau or `3.14159`. Snippet runs only when age < ~1 frame.",
    modifies: ['pos', 'vel'],
    availableVars: ['pos', 'vel', 'age', 'r', 'id', 'idx'],
    uniforms: ['uDeltaTime', 'uTime', 'uChestPos', 'uEyeLPos', 'uEyeRPos', 'uHandLPos', 'uHandRPos', 'uChestVis', 'uEyeLVis', 'uEyeRVis', 'uHandLVis', 'uHandRVis'],
    maxLines: 20,
  },
  velocity_modifier: {
    description:
      'Modify particle velocity. Default drag is `vel *= 0.98` — gentle, leaves room for force_field. **DRAG COMPOUNDS PER FRAME**: at 60fps, `vel *= 0.9` leaves only 0.18% of original velocity after 1 second, swallowing typical force_field magnitudes (0.05–0.3). Either keep drag mild (≥0.95) or scale your force_field 10× to compensate. Body-target uniforms `uChestPos`/`uEyeLPos`/`uEyeRPos`/`uHandLPos`/`uHandRPos` (vec3) and visibility uniforms `uChestVis`/`uEyeLVis`/`uEyeRVis`/`uHandLVis`/`uHandRVis` (float) are also available for mid-flight steering.',
    modifies: 'vel',
    availableVars: ['pos', 'vel', 'age', 'lifeSpan', 'life', 'id', 'idx'],
    uniforms: ['uTime', 'uChestPos', 'uEyeLPos', 'uEyeRPos', 'uHandLPos', 'uHandRPos', 'uChestVis', 'uEyeLVis', 'uEyeRVis', 'uHandLVis', 'uHandRVis'],
    maxLines: 20,
  },
  post_fx: {
    description: 'Post-processing effects (bloom, vignette, color grading, chromatic aberration). Two textures available: sTD2DInputs[0]=composite scene (particles + webcam), sTD2DInputs[1]=Gaussian-blurred particle render (for bloom compositing). Default bloom is already applied before zone code runs.',
    modifies: 'color',
    availableVars: ['uv', 'color', 'vignette', 'blurred'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode', 'uBloomIntensity', 'uVignetteStrength', 'uChromaticAberration'],
    maxLines: 30,
    bannedKeywords: ['discard'],
  },
  billboard_vertex: {
    description: 'Billboard particle vertex shader. Snippet runs in view space after the camera-facing quad has been positioned, before final projection — typically used to perturb viewPos for wobble, jitter, or other position effects. TD globals uTDMats and TDCameraIndex() are accessible; camIdx is already declared by the template so zone code can use it directly (e.g. uTDMats[camIdx].cam for view-space velocity transform in velocity-stretch effects).',
    modifies: 'viewPos',
    availableVars: ['localPos', 'worldOrigin', 'viewPos', 'instanceScale', 'finalScale', 'vel', 'age', 'life', 'id', 'camIdx'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode'],
    maxLines: 20,
  },
  billboard_pixel: {
    description: 'Billboard particle pixel shader with flipbook animation',
    modifies: ['brightness', 'saturation', 'hueShift'],
    availableVars: ['albedo', 'alpha', 'vel', 'age', 'life', 'id', 'energy', 'mode', 'brightness', 'saturation', 'hueShift'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode', 'uFlipbook1', 'uFlipbook2', 'sSpriteMap'],
    maxLines: 25,
  },
};

/**
 * Custom error for zone validation failures
 */
export class ZoneValidationError extends Error {
  constructor(
    public zone: string,
    message: string
  ) {
    super(`Zone '${zone}': ${message}`);
    this.name = 'ZoneValidationError';
  }
}

/**
 * Get zone contract by name
 */
export function getZoneContract(zoneName: string): ZoneContract | null {
  if (isValidZoneName(zoneName)) {
    return ZONE_CONTRACTS[zoneName];
  }
  return null;
}

/**
 * Check if a zone name is valid
 */
export function isValidZoneName(zoneName: string): zoneName is ZoneName {
  return ZONE_NAMES.includes(zoneName as ZoneName);
}

/**
 * Get variables for a zone
 */
export function getZoneVariables(zoneName: string): { modifies: string[]; availableVars: string[] } {
  const contract = getZoneContract(zoneName);
  if (!contract) {
    return { modifies: [], availableVars: [] };
  }

  const modifies = Array.isArray(contract.modifies) ? contract.modifies : [contract.modifies];

  return {
    modifies,
    availableVars: contract.availableVars,
  };
}

/**
 * Extract identifiers from GLSL code
 * Used to check what variables the code references
 */
export function extractIdentifiers(code: string): Set<string> {
  const identifiers = new Set<string>();

  // Remove comments
  const withoutComments = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove string literals (shouldn't have any in GLSL, but just in case)
  const withoutStrings = withoutComments.replace(/"[^"]*"/g, '');

  // Match identifiers
  const identifierRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let match;

  while ((match = identifierRegex.exec(withoutStrings)) !== null) {
    identifiers.add(match[1]);
  }

  return identifiers;
}

/**
 * GLSL built-in types and keywords to ignore during variable checking
 */
const GLSL_TYPES_AND_KEYWORDS = new Set([
  // Types
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube',
  // Keywords
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'discard',
  'const', 'uniform', 'in', 'out', 'inout', 'struct',
  'true', 'false',
  // Common functions
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'pow', 'exp', 'log', 'sqrt', 'abs', 'sign',
  'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp',
  'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross',
  'normalize', 'reflect', 'refract',
  // Vector components
  'x', 'y', 'z', 'w', 'r', 'g', 'b', 'a', 's', 't', 'p', 'q',
  'xy', 'xyz', 'xyzw', 'rgb', 'rgba',
]);

/**
 * Validate zone code against its contract
 * Throws ZoneValidationError if validation fails
 */
export function validateZoneCode(zoneName: string, code: string): void {
  const contract = getZoneContract(zoneName);

  if (!contract) {
    throw new ZoneValidationError(zoneName, `Unknown zone name`);
  }

  // Check for empty code
  const trimmed = code.trim();
  if (!trimmed) {
    throw new ZoneValidationError(zoneName, 'Empty code snippet');
  }

  // Check line count
  const lines = code.split('\n').filter((line) => line.trim() !== '');
  if (lines.length > contract.maxLines) {
    throw new ZoneValidationError(
      zoneName,
      `Code has ${lines.length} lines, max is ${contract.maxLines}`
    );
  }

  // Check for banned keywords
  if (contract.bannedKeywords) {
    for (const keyword of contract.bannedKeywords) {
      // Match whole word only
      const regex = new RegExp(`\\b${keyword}\\b`);
      if (regex.test(code)) {
        throw new ZoneValidationError(zoneName, `Banned keyword '${keyword}' used`);
      }
    }
  }

  // Check for banned patterns
  if (contract.bannedPatterns) {
    for (const pattern of contract.bannedPatterns) {
      if (pattern.test(code)) {
        throw new ZoneValidationError(zoneName, `Banned pattern found: ${pattern.source}`);
      }
    }
  }

  // Note: We don't strictly validate variable references because:
  // 1. Code may define local variables
  // 2. GLSL has many built-in functions we'd need to whitelist
  // 3. False positives are annoying
  // The real validation happens when TD compiles the shader
}

/**
 * Get a summary of all zones for prompt generation
 */
export function getZoneSummary(): string {
  const summaries: string[] = [];

  for (const [name, contract] of Object.entries(ZONE_CONTRACTS)) {
    const modifies = Array.isArray(contract.modifies)
      ? contract.modifies.join(', ')
      : contract.modifies;
    summaries.push(
      `- ${name}: ${contract.description} (modifies: ${modifies}, max ${contract.maxLines} lines)`
    );
  }

  return summaries.join('\n');
}
