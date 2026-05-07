# Improvement: Sprite-to-Color Palette Sync

## Problem

Gemini picks `color_over_life` zone colors independently from the sprite it generates. A fire spell might get an orange ember texture from Imagen, but Gemini writes `color = vec4(0.2, 0.4, 1.0, life)` in the color zone — blue particles on an orange texture. The two halves of the visual look like they belong to different spells.

## Approach

After Imagen returns a sprite, extract 2 dominant colors (primary + accent) on the Node.js side using luminance-weighted pixel analysis. Push them to TD as vec uniforms (`uSpriteColor1`, `uSpriteColor2`) that auto-update whenever a new sprite is loaded. Also include the extracted palette in the `generate_sprite` function response so Gemini can reference the actual hex values when writing zone GLSL.

Two delivery paths working together:
1. **Uniforms** (`uSpriteColor1`, `uSpriteColor2`): available in all zone shaders at runtime. Zone code can use them without hard-coding values — `color.rgb = mix(uSpriteColor1, uSpriteColor2, 1.0 - life)` gives a gradient from accent at birth to primary at death.
2. **Response data**: `generate_sprite` returns `palette: [{r,g,b}, {r,g,b}]` so Gemini can also hard-code the exact values into zone code if it wants precise control (`color = vec4(0.95, 0.4, 0.1, life)` is clearer GLSL than `color = vec4(uSpriteColor1, life)`).

## Extraction Algorithm

Simple luminance-weighted centroid approach (no heavy dependencies):

1. Decode the PNG pixel data (already done in `sprite-generator.ts` during validation).
2. Filter to pixels above a brightness threshold (e.g. luminance > 0.15) to skip the black background.
3. Separate bright pixels into two rough groups by hue angle to get primary vs. accent: sort by hue, split at the median, take the luminance-weighted centroid of each group.
4. Normalize to [0,1] float RGB.

This avoids k-means overhead while producing stable, representative colors. Edge case: monochromatic sprites (all pixels near the same hue, e.g. a white glow) produce two similar colors — acceptable, the shader will just use a single hue with slight brightness variation.

For flipbooks, extract from the first frame only (or from all frames combined, averaged). First-frame is simpler and usually representative.

## Changes Required

### `src/main/merlin/sprite-generator.ts`

Add `extractPalette(pixels: Uint8Array, width: number, height: number): [{r,g,b}, {r,g,b}]` function using the algorithm above. Call it after the existing validation step in `_generateSprite` / `_generateFlipbook`. Return palette data alongside the asset in the result object.

### `src/main/merlin/turn-runner.ts`

In the `generate_sprite` dispatch (`case 'generate_sprite'`), after the sprite is pushed and `sprite_loaded` is ACK'd:
1. Push the palette to TD via a new `pushSpriteColors(color1, color2)` function.
2. Include palette data in the Gemini function response alongside the sprite preview image.

### `src/main/td-bridge/push.ts`

Add `pushSpriteColors(color1: {r,g,b}, color2: {r,g,b})`: sends a `sprite_colors` WS message.

### `td/scripts/ws_callbacks.py`

Add handler `handle_sprite_colors(data)` that sets `uSpriteColor1` and `uSpriteColor2` as vec uniforms on the relevant shader nodes. Same pattern as `_wire_spell_state_uniforms` — set on the Vectors page of each GLSL node that declares the uniforms.

Which nodes need the uniforms:
- `glsl_color` (color_over_life zone) — primary use case
- Optionally `glsl_billboard_pixel` (billboard_pixel zone) — if zone code wants to tint the sprite with its own extracted color

### `src/main/merlin/zone-registry.ts`

Add `uSpriteColor1` and `uSpriteColor2` to the `uniforms` list in `color_over_life`, `size_over_life`, and `billboard_pixel` zone contracts.

### `src/main/merlin/prompts.ts`

In `SHADER_AUTHORSHIP` (or the `generate_sprite` tool description), document:
- `uSpriteColor1` (vec3): dominant color extracted from the active sprite
- `uSpriteColor2` (vec3): accent color extracted from the active sprite
- Example: `color.rgb = mix(uSpriteColor2, uSpriteColor1, life);` — fades from accent at birth to dominant at death
- Note: palette uniforms are valid only after `generate_sprite` is called; before that they hold zeros. Always call `generate_sprite` before writing zone code that references these uniforms.

Also update the `generate_sprite` response format in the tool description to mention that the response includes `palette`.

### `src/main/merlin/td-state-mirror.ts`

Track the last-pushed palette alongside the last-pushed sprite, so `request_visual_feedback` can include palette data in its response when Gemini needs to diagnose a color mismatch.

## Open Questions

- **Reset on new spell**: Should `BASELINE_PARTICLE_PARAMS` reset (or zeroing) `uSpriteColor1/2` when `resetToBaseline()` is called? Zeroing them would cause zone code referencing them to go black until the next `generate_sprite` call. Safer to either reset to a neutral purple (matching the current `color_over_life` template default `vec4(0.6, 0.4, 0.9, ...)`) or simply not reset them — old palette values until overwritten are harmless.
- **Palette quality for complex sprites**: The hue-split centroid approach works well for sprites with two clearly distinct color regions. For sprites with many colors (a full aurora, rainbow glow), it will produce averaged values that might not be meaningfully distinct. K-means with k=2 would be more robust but adds complexity. Worth testing the centroid approach first.
- **Flipbook palette**: Should the palette be extracted from all frames combined (time-averaged look) or just frame 0 (initial state)? For animations where color changes over frames (e.g. a flame going from white-hot to orange-red), frame 0 and the average will differ meaningfully. Expose a `paletteFrame` option or default to the midpoint frame?
