# Improvement: Real Bloom / Post-FX

## Problem

`glsl_postfx` already receives the rendered particle layer and supports a `post_fx` zone where Gemini can write screen-space effects. The zone contract lists `uBloomIntensity`, `uVignetteStrength`, and `uChromaticAberration` as available uniforms, but there is no blur chain in TD — so any zone code that references `uBloomIntensity` composites nothing useful. Without bloom, additive-blended particles look like a flat overlay on the webcam instead of glowing light sources.

## Approach

Wire a `blurTOP` output into `glsl_postfx` as a second input (`sTD2DInputs[1]`). The blur computation stays in TD (hardware-accelerated, multi-pass Gaussian). Gemini's `post_fx` zone code gets full creative control over how to use it — intensity, color tinting, threshold, energy-reactive pulse, etc.

Chain:

```
render1 (renderTOP)
  │
  ├──► glsl_postfx  ◄── sTD2DInputs[0]  (original render)
  │
  └──► blur1 (blurTOP, Gaussian)
         └──► glsl_postfx  ◄── sTD2DInputs[1]  (pre-blurred render)
```

The `glsl_postfx` node already sits upstream of `out_final`; no changes to the end of the chain are needed.

## Changes Required

### TD side (`td/demo.toe` via MCP or manual)

1. Add `blur1` (blurTOP) wired from `render1` output. Suggested starting params: Gaussian filter, radius ~6–10, size matching `render1` resolution.
2. Connect `blur1` as the second input to `glsl_postfx` (drag onto the second input slot). After this, `sTD2DInputs[1]` in the pixel shader resolves to the blurred render.
3. Optionally add a second `blur2` at larger radius (~20–30) for a two-tier glow (soft halo + tight core). Would be `sTD2DInputs[2]` if added.
4. Remember to save `td/demo.toe` after MCP-driven node changes — they don't persist on restart otherwise.

### Shader template (`shaders/top_postfx.glsl`)

Add a default bloom behavior before `{zone_code}` so the effect is present even when Gemini writes no post_fx zone:

```glsl
// Pre-blurred render available for bloom compositing
// sTD2DInputs[1] = blurTOP output (Gaussian blur of render1)
vec4 blurred = texture(sTD2DInputs[1], uv);

// Default: subtle additive bloom
color.rgb += blurred.rgb * uBloomIntensity;

// {zone_code}
```

The default `uBloomIntensity` value should be set to something tasteful (~0.3–0.5) on the TD Vectors page so idle baseline already glows without any zone code.

### Zone contract (`src/main/merlin/zone-registry.ts`)

Update the `post_fx` contract description to document the blur input:

- Add `sTD2DInputs[1]` to the description as "pre-blurred version of the render (Gaussian, for bloom compositing)"
- Add `sTD2DInputs[2]` if the second wider blur is added

### Gemini prompt context (`src/main/merlin/prompts.ts` — `SHADER_AUTHORSHIP`)

Add a note to the post_fx section explaining:
- `sTD2DInputs[0]` = original render, `sTD2DInputs[1]` = blurred render
- Zone code can use the blurred input for glow, light leaks, or energy-reactive pulse
- Example: `color.rgb += texture(sTD2DInputs[1], uv).rgb * (0.2 + uSpellEnergy * 0.8);`

### Zone examples (`src/main/merlin/zone-examples.ts`)

Add a `post_fx` example demonstrating energy-reactive bloom and optionally chromatic aberration using the blur input.

## Open Questions

- **Blur radius**: A single radius is a compromise — tight enough for core glow, wide enough for soft halo. Two blur inputs at different radii (r≈8 and r≈24) would allow zone code to mix them for richer effects. Worth the extra node?
- **`uBloomIntensity` source**: Should this be a static constant on the TD Vectors page, or wired to an expression (e.g. `0.3 + op('/project1/spell_state')['uSpellEnergy', 1] * 0.5`) so it naturally pulses with spell energy? The expression approach costs nothing once set up and would make the default bloom feel alive without any zone code.
- **Performance**: blurTOP at full render resolution is cheap but not free. If render resolution is high (e.g. 1920×1080), a half-res blur + upsample would be faster and visually indistinguishable. Worth noting for when the .toe is set up.
- **blurTOP filter quality**: TD's blurTOP supports Gaussian, Box, and a few others. Gaussian is the standard choice for bloom; Box is cheaper but has a square halo artifact.
