# Improvement: Background Environment Zone

> **Status:** Ready to implement. P1 priority per [`../roadmap.md`](../roadmap.md). Estimated 4–6 hours for TD setup + Electron integration + testing. Spec below is fully fleshed out; no design open questions blocking implementation.

## Overview

Add a `background_environment` zone that lets Gemini replace the background of the webcam image using the person segmentation mask. The person stays as-is from the webcam; behind them, Gemini's zone code fills the frame with any procedural pattern — gradients, animated noise, a void, a vortex, elemental environments, etc.

This is listed as P1 in [`../roadmap.md`](../roadmap.md). Vibe-agent has a `background_environment` zone but its template is an equirectangular environment map for 3D rendering — useful as a reference for the zone injection pattern, not the shader content.

## Architecture

### Current composite chain

```
syphonspoutin1 (webcam)
     ↓ additive composite
render1 (particles)
     ↓
glsl_postfx
     ↓
out_final → spout
```

### New composite chain

```
syphonspoutin2 (mask: "Merlin Mask", white=person, black=background)
syphonspoutin1 (webcam)       glsl_background (background_environment zone)
         ↓                                  ↓
         └──── composite_bg ────────────────┘   (over: background fills where mask=0)
                      ↓
                render1 (particles, additive)
                      ↓
               glsl_postfx
                      ↓
                  out_final → spout
```

`composite_bg` computes: `output = mix(background, webcam, mask)` — where the mask is white (person), webcam shows through; where mask is black (background), the zone-generated background shows.

### Mask Syphon sender

The renderer already has a mask mode (`?mask` URL param) that outputs the segmentation mask (white=person, black=background) via Spout/Syphon as `"Merlin Mask"`. This sender needs to be running for the background environment to work. Currently TD only has `syphonspoutin1` (webcam); a second `syphonspoutin2` pointing to `"Merlin Mask"` needs to be added.

## Background Shader Template (`shaders/top_background.glsl`)

This is a new file. The template is a flat 2D screen-space shader — not equirectangular like vibe-agent's version.

```glsl
// Background Environment Shader
// Renders the background visible behind the participant (masked areas)
//
// Inputs:
//   sTD2DInputs[0] = webcam frame
//   sTD2DInputs[1] = segmentation mask (white=person, black=background)
//
// Zone code writes to: color (vec3 RGB, the background color/pattern)
// Template then composites: output = mix(color, webcam, mask)

uniform float uTime;
uniform float uSpellEnergy;
uniform float uSpellMode;

out vec4 fragColor;

void main() {
    vec2 uv = vUV.st;

    vec4 webcam = texture(sTD2DInputs[0], uv);
    float mask = texture(sTD2DInputs[1], uv).r;   // white=person, black=background

    // Default: subtle dark tint (keeps the experience grounded, not jarring)
    vec3 color = webcam.rgb * 0.15;

    // {zone_code}

    // Composite: person from webcam, background from zone code
    vec3 result = mix(color, webcam.rgb, mask);

    fragColor = vec4(result, 1.0);
}
```

Zone code modifies `color` (the background pattern). The template handles the mask compositing — zone code doesn't need to reference the mask at all for simple backgrounds. For advanced zone code that wants to interact with the mask edge (e.g. a glow at the person's silhouette), `mask` is available as a local.

## Zone Contract

```ts
background_environment: {
  description: 'Replace the webcam background behind the participant. Zone code writes to `color` (vec3). The template composites using the segmentation mask: wherever MediaPipe sees background (not person), your color shows. The person silhouette stays as webcam footage. `uv` is 0→1 screen space. Webcam and mask are available as `sTD2DInputs[0]` and `sTD2DInputs[1]` if needed for advanced effects.',
  modifies: 'color',
  availableVars: ['uv', 'color'],
  uniforms: ['uTime', 'uSpellEnergy', 'uSpellMode'],
  maxLines: 30,
}
```

## TD Setup Required (MCP or manual)

1. Add `syphonspoutin2` pointing to `"Merlin Mask"` sender (match resolution to `syphonspoutin1`)
2. Add `glsl_background` (glslTOP):
   - Input 0: `syphonspoutin1` (webcam)
   - Input 1: `syphonspoutin2` (mask)
   - Pixel DAT: `glsl_background_pixel` (textDAT, initial content = `shaders/top_background.glsl`)
   - Uniforms: `uTime` (expression: `absTime.seconds`), `uSpellEnergy` and `uSpellMode` wired via `_wire_spell_state_uniforms` pattern
3. Add `glsl_background_pixel` (textDAT) with `syncfile=True` pointing to `shaders/top_background.glsl` in the project directory
4. Re-wire composite chain:
   - Remove `syphonspoutin1` → `compositeTOP` direct connection
   - Add `glsl_background` as the new webcam layer in `compositeTOP` (replaces raw `syphonspoutin1`)
5. Register `glsl_background_info` in the compile-detection dict in `ws_callbacks.py`
6. Save `td/demo.toe`

## Electron / WS Changes

### `ws_callbacks.py`

Add to the zone-name → TD node mapping:
```python
'background_environment': '/project1/glsl_background',
'background_environment' (pixel DAT): '/project1/glsl_background_pixel',
```

Add `glsl_background_info` to compile-detection (same pattern as `glsl_postfx_info`).

### `src/main/merlin/tool-definitions.ts` + `system-prompts.ts`

Add `background_environment` to `MERLIN_VISUAL_AUTHOR_TOOLS` and `MERLIN_TOOLS` in `tool-definitions.ts`.

In `system-prompts.ts`, update `SHADER_AUTHORSHIP` with zone description and example patterns:
- Dark void: `color = vec3(0.0);` (pure black background)
- Deep space: `color = vec3(0.02, 0.01, 0.05) + hash31(uv.x * 100.0 + uv.y * 200.0) * 0.03;`
- Vortex: animated polar coordinate pattern
- Elemental gradient: sky-to-ground gradient tied to spell element
- Pulsing energy: `color = spell_color * uSpellEnergy * smoothstep(0.8, 0.3, length(uv - 0.5));`

## Open Questions

- **Mask quality**: MediaPipe's person segmentation has soft edges and occasionally glitches on hair/hands. The mask blend will produce some fringing. A `smoothstep` on the mask value (instead of a hard cut) can soften this:
  `float softMask = smoothstep(0.3, 0.7, mask);` — worth building into the template rather than requiring zone code to handle it.
- **Mask running as a separate window**: The "Merlin Mask" Syphon sender only works when a second renderer window is open in mask mode. For the Live Spell test and demo setup, both windows need to be running. Should the main process automatically launch the mask window on startup, or is it always manual?
- **Mask latency**: The mask window runs MediaPipe segmentation and sends via Syphon. There's at least one frame of latency between the webcam image in `syphonspoutin1` and the mask in `syphonspoutin2`. Mild ghosting on fast movement. Probably acceptable for the artistic use case.
- **Fallback when mask is unavailable**: If `syphonspoutin2` has no signal, the mask will be all-black (all background), making the person invisible. The template should detect this and fall back to `mask = 1.0` (show full webcam) when the mask input appears to be empty/solid-black.
