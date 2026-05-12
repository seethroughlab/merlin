/**
 * Shader Template Loader
 *
 * Loads GLSL shader templates from the /shaders directory.
 * Templates are used by both Electron (for Gemini prompts) and TD (for compilation).
 *
 * Each template contains a `{zone_code}` placeholder where Gemini's
 * generated GLSL snippets get injected.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Get the shaders directory path.
 * In development: project root /shaders
 * In production: packaged app resources /shaders
 */
function getShadersDir(): string {
  // app.getAppPath() returns the app root directory
  // In dev: the project folder
  // In prod: the app.asar or unpacked folder
  const appPath = app.getAppPath();

  // If running from asar, the shaders should be in extraResources
  if (appPath.includes('app.asar')) {
    // In production, shaders are copied to resources/shaders
    return path.join(path.dirname(appPath), 'shaders');
  }

  // Development: shaders are at project root
  return path.join(appPath, 'shaders');
}

/**
 * Zone name to template filename mapping
 */
export const ZONE_TEMPLATE_FILES: Record<string, string> = {
  force_field: 'pop_force.glsl',
  spawn_behavior: 'pop_spawn.glsl',
  velocity_modifier: 'pop_velmod.glsl',
  color_over_life: 'pop_color.glsl',
  size_over_life: 'pop_size.glsl',
  post_fx: 'top_postfx.glsl',
  billboard_vertex: 'mat_billboard_vertex.glsl',
  billboard_pixel: 'mat_billboard_pixel.glsl',
};

/**
 * Template cache to avoid repeated file reads
 */
const templateCache: Map<string, string> = new Map();

/**
 * Load a shader template by zone name.
 * Returns the template content or null if not found.
 */
export function loadTemplate(zoneName: string): string | null {
  // Check cache first
  if (templateCache.has(zoneName)) {
    return templateCache.get(zoneName)!;
  }

  const filename = ZONE_TEMPLATE_FILES[zoneName];
  if (!filename) {
    console.warn(`[ShaderTemplates ${ts()}] Unknown zone: ${zoneName}`);
    return null;
  }

  const filepath = path.join(getShadersDir(), filename);
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    templateCache.set(zoneName, content);
    console.log(`[ShaderTemplates ${ts()}] Loaded template: ${filename}`);
    return content;
  } catch (e) {
    console.error(`[ShaderTemplates ${ts()}] Failed to load template ${filename}:`, e);
    return null;
  }
}

/**
 * Load all templates at once.
 * Returns a map of zone name → template content.
 */
export function getAllTemplates(): Record<string, string> {
  const templates: Record<string, string> = {};
  for (const zone of Object.keys(ZONE_TEMPLATE_FILES)) {
    const content = loadTemplate(zone);
    if (content) {
      templates[zone] = content;
    }
  }
  return templates;
}

/**
 * Format a single template for inclusion in a prompt.
 */
export function formatTemplateForPrompt(zoneName: string): string {
  const template = loadTemplate(zoneName);
  if (!template) return '';

  return `### ${zoneName} template:\n\`\`\`glsl\n${template}\n\`\`\`\n`;
}

/**
 * Format all templates for the main system prompt.
 * Includes only the most commonly used zones to avoid prompt bloat.
 */
export function formatTemplatesForSystemPrompt(): string {
  // Include spawn_behavior and velocity_modifier in the system-prompt
  // templates so Gemini sees the hash31() helper, the local-variable
  // scope, and the default drag — all critical for the EYE-BURST,
  // FOUNTAIN, and force-magnitude-vs-drag recipes to make sense.
  const primaryZones = [
    'force_field',
    'spawn_behavior',
    'velocity_modifier',
    'color_over_life',
    'size_over_life',
    'post_fx',
  ];

  const sections: string[] = [];
  for (const zone of primaryZones) {
    const formatted = formatTemplateForPrompt(zone);
    if (formatted) {
      sections.push(formatted);
    }
  }

  if (sections.length === 0) {
    return '';
  }

  return `## Shader Templates

Your zone_code gets injected at the \`{zone_code}\` marker in each template.
Here are the templates for reference:

${sections.join('\n')}`;
}

/**
 * Get the template for a specific zone for detailed tool descriptions.
 */
export function getTemplateSnippetForTool(zoneName: string, maxLines: number = 30): string {
  const template = loadTemplate(zoneName);
  if (!template) return '';

  // For tool descriptions, we may want a truncated version
  const lines = template.split('\n');
  if (lines.length <= maxLines) {
    return template;
  }

  // Find the {zone_code} marker and show context around it
  const markerIndex = lines.findIndex((line) => line.includes('{zone_code}'));
  if (markerIndex === -1) {
    return lines.slice(0, maxLines).join('\n') + '\n// ... truncated';
  }

  // Show lines around the marker
  const contextBefore = 10;
  const contextAfter = 15;
  const start = Math.max(0, markerIndex - contextBefore);
  const end = Math.min(lines.length, markerIndex + contextAfter);

  const result: string[] = [];
  if (start > 0) {
    result.push('// ... (header trimmed)');
  }
  result.push(...lines.slice(start, end));
  if (end < lines.length) {
    result.push('// ... (footer trimmed)');
  }

  return result.join('\n');
}

/**
 * Clear the template cache (useful for hot-reloading in development)
 */
export function clearTemplateCache(): void {
  templateCache.clear();
  console.log(`[ShaderTemplates ${ts()}] Cache cleared`);
}
