/**
 * GLSL Snippet Validator
 *
 * Port of vibe-agent's glsl_validator.py
 * Performs syntax checking on GLSL code snippets before sending to TouchDesigner.
 */

/**
 * Result of GLSL validation
 */
export interface ValidationResult {
  isValid: boolean;
  error: string | null;
  warnings: string[];
}

/**
 * GLSL built-in functions (subset of common ones)
 */
const GLSL_BUILTINS = new Set([
  // Trigonometric
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'asinh', 'acosh', 'atanh', 'radians', 'degrees',
  // Exponential
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  // Common
  'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp',
  'mix', 'step', 'smoothstep',
  // Geometric
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward',
  'reflect', 'refract',
  // Matrix
  'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
  // Vector relational
  'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
  'equal', 'notEqual', 'any', 'all', 'not',
  // Texture
  'texture', 'textureOffset', 'textureLod', 'textureGrad', 'textureSize',
  'texelFetch',
  // Noise (deprecated but still used)
  'noise1', 'noise2', 'noise3', 'noise4',
  // Type constructors
  'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'bvec2', 'bvec3', 'bvec4', 'float', 'int', 'uint', 'bool',
  // Other
  'dFdx', 'dFdy', 'fwidth', 'isnan', 'isinf', 'floatBitsToInt',
  'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat',
  'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16', 'unpackUnorm2x16',
  'packHalf2x16', 'unpackHalf2x16', 'round', 'roundEven', 'trunc',
  'modf', 'frexp', 'ldexp', 'fma',
]);

/**
 * TouchDesigner-specific functions and helpers
 */
const TD_HELPERS = new Set([
  // POP functions
  'TDIndex', 'TDNumElements', 'TDIn_P', 'TDIn_PartVel', 'TDIn_PartAge',
  'TDIn_PartLifeSpan', 'TDIn_PartForce', 'TDIn_PartColor', 'TDIn_PartScale',
  'TDIn_PartMass', 'TDIn_PartId',
  // Noise functions
  'TDPerlinNoise', 'TDSimplexNoise', 'TDRandom', 'TDRandomVec3', 'TDRandomVec4',
  // Math helpers
  'TDRotate', 'TDRotateOnAxis',
  // Texture sampling
  'TDTexture', 'TDTextureLod',
]);

/**
 * GLSL keywords (control flow and types)
 */
const GLSL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'discard',
  'void', 'const', 'uniform', 'in', 'out', 'inout',
  'struct', 'true', 'false',
]);

/**
 * Check if braces are balanced
 */
export function checkBalancedBraces(code: string): { valid: boolean; error: string | null } {
  let depth = 0;
  let line = 1;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === '\n') {
      line++;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth < 0) {
        return { valid: false, error: `Unexpected '}' at line ${line}` };
      }
    }
  }

  if (depth > 0) {
    return { valid: false, error: `Missing ${depth} closing brace(s)` };
  }

  return { valid: true, error: null };
}

/**
 * Check if parentheses are balanced
 */
export function checkBalancedParens(code: string): { valid: boolean; error: string | null } {
  let depth = 0;
  let line = 1;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === '\n') {
      line++;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth < 0) {
        return { valid: false, error: `Unexpected ')' at line ${line}` };
      }
    }
  }

  if (depth > 0) {
    return { valid: false, error: `Missing ${depth} closing parenthesis(es)` };
  }

  return { valid: true, error: null };
}

/**
 * Check for potential missing semicolons
 * Returns warnings for lines that might be missing semicolons
 */
export function checkSemicolons(code: string): string[] {
  const warnings: string[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Skip empty lines, comments, preprocessor directives
    if (!line || line.startsWith('//') || line.startsWith('#')) {
      continue;
    }

    // Skip lines that end with control flow or block markers
    if (line.endsWith('{') || line.endsWith('}') || line.endsWith(':')) {
      continue;
    }

    // Skip if/else/for/while lines (they may not need semicolons)
    if (/^(if|else|for|while|switch)\b/.test(line)) {
      continue;
    }

    // Check for lines that look like statements but don't end with semicolon
    // This is a heuristic - may have false positives
    if (
      line.includes('=') ||
      line.includes('(') ||
      /^(float|int|vec|mat|bool|uint|return)\b/.test(line)
    ) {
      if (!line.endsWith(';') && !line.endsWith('{')) {
        // Check if next line exists and is a continuation
        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
        if (!nextLine.startsWith('.') && !nextLine.startsWith('?') && !nextLine.startsWith(':')) {
          warnings.push(`Line ${lineNum} may be missing a semicolon: "${line.substring(0, 40)}..."`);
        }
      }
    }
  }

  return warnings;
}

/**
 * Find function calls that aren't recognized
 */
export function findUndefinedFunctions(code: string): string[] {
  const undefined: string[] = [];

  // Match function calls: identifier followed by (
  const functionCallRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let match;

  while ((match = functionCallRegex.exec(code)) !== null) {
    const funcName = match[1];

    // Skip if it's a known function
    if (GLSL_BUILTINS.has(funcName) || TD_HELPERS.has(funcName) || GLSL_KEYWORDS.has(funcName)) {
      continue;
    }

    // Skip common patterns that aren't function calls
    if (funcName === 'main' || funcName.startsWith('TDIn_') || funcName.startsWith('TDOut_')) {
      continue;
    }

    // Check if it's a type constructor (starts with uppercase, common pattern)
    if (/^[A-Z]/.test(funcName)) {
      continue;
    }

    // This might be an undefined function
    if (!undefined.includes(funcName)) {
      undefined.push(funcName);
    }
  }

  return undefined;
}

/**
 * Check for common GLSL syntax errors
 */
function checkCommonErrors(code: string): string | null {
  // Check for = instead of == in conditions
  const conditionMatch = code.match(/\bif\s*\(\s*[^=!<>]*[^=!<>]=(?!=)[^=]/);
  if (conditionMatch) {
    // This is a heuristic and may have false positives
    // Only warn if it looks suspicious
  }

  // Check for empty statements
  if (/;\s*;/.test(code)) {
    return 'Empty statement (;;) detected';
  }

  return null;
}

/**
 * Main validation function
 * Validates a GLSL code snippet for common errors
 */
export function validateGlslSnippet(code: string): ValidationResult {
  const warnings: string[] = [];

  // Check for empty code
  const trimmed = code.trim();
  if (!trimmed) {
    return {
      isValid: false,
      error: 'Empty code snippet',
      warnings: [],
    };
  }

  // Check balanced braces
  const braceResult = checkBalancedBraces(code);
  if (!braceResult.valid) {
    return {
      isValid: false,
      error: braceResult.error,
      warnings: [],
    };
  }

  // Check balanced parentheses
  const parenResult = checkBalancedParens(code);
  if (!parenResult.valid) {
    return {
      isValid: false,
      error: parenResult.error,
      warnings: [],
    };
  }

  // Check for common errors
  const commonError = checkCommonErrors(code);
  if (commonError) {
    return {
      isValid: false,
      error: commonError,
      warnings: [],
    };
  }

  // Collect warnings (non-fatal)
  const semicolonWarnings = checkSemicolons(code);
  warnings.push(...semicolonWarnings);

  const undefinedFuncs = findUndefinedFunctions(code);
  if (undefinedFuncs.length > 0) {
    warnings.push(`Unknown functions: ${undefinedFuncs.join(', ')}`);
  }

  return {
    isValid: true,
    error: null,
    warnings,
  };
}
