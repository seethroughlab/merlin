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
  'material_pixel',
  'billboard_vertex',
  'billboard_pixel',
] as const;

export type ZoneName = (typeof ZONE_NAMES)[number];

/**
 * Zone contracts defining what each zone can access and modify
 */
export const ZONE_CONTRACTS: Record<ZoneName, ZoneContract> = {
  force_field: {
    description: 'Apply forces to particles',
    modifies: 'force',
    availableVars: ['pos', 'vel', 'age', 'lifeSpan', 'life', 'force', 'id', 'idx'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode'],
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
    description: 'Initialize particle position/velocity',
    modifies: ['pos', 'vel'],
    availableVars: ['pos', 'vel', 'age', 'seed', 'seed2', 'seed3', 'id'],
    uniforms: ['uDeltaTime'],
    maxLines: 20,
  },
  velocity_modifier: {
    description: 'Modify particle velocity',
    modifies: 'vel',
    availableVars: ['pos', 'vel', 'age', 'lifeSpan', 'life', 'id', 'idx'],
    uniforms: ['uTime'],
    maxLines: 20,
  },
  post_fx: {
    description: 'Post-processing effects (bloom, vignette, color grading)',
    modifies: 'color',
    availableVars: ['uv', 'color', 'vignette'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode', 'uBloomIntensity', 'uVignetteStrength', 'uChromaticAberration'],
    maxLines: 30,
    bannedKeywords: ['discard'],
  },
  material_pixel: {
    description: 'Custom pixel/fragment shading on particle geometry',
    modifies: ['color', 'emission', 'roughness', 'metallic'],
    availableVars: ['uv', 'normal', 'worldPos', 'baseColor', 'color', 'emission', 'roughness', 'metallic'],
    uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode', 'uRoughness', 'uMetallic', 'uEmission'],
    maxLines: 35,
  },
  billboard_vertex: {
    description: 'Billboard particle vertex shader (camera-facing quads)',
    modifies: ['worldOffset'],
    availableVars: ['localPos', 'instancePos', 'instanceScale', 'camRight', 'camUp', 'worldOffset', 'vel', 'age', 'life', 'id'],
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
