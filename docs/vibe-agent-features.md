# vibe-agent Feature Checklist

Features from vibe-agent that could be ported to Merlin. Mark the ones you want to implement.

---

## Shader Zones

Merlin has 5 zones. vibe-agent has 9.

- [3] **shape_deform** - Vertex displacement for mesh particles (wobble, pulse, twist effects)
- [3] **material_lighting** - Surface properties: roughness, metallic, emission, normal perturbation
- [1] **post_fx** - Post-processing: bloom, chromatic aberration, vignette, color grading
- [2] **background_environment** - Environment backdrop: gradient, noise texture, animated patterns

---

## Render Modes

- [3] **Render mode switching** - Toggle between mesh instancing and billboard sprites at runtime
- [3] **Per-spell render mode** - Let Gemini choose mesh vs billboard based on spell intent

---

## MAT Shaders

- [3] **Vertex shader support** - Custom vertex displacement in material shader
- [1] **Pixel shader support** - Custom fragment/pixel shading in material shader
- [2] **MAT parameter control** - Expose roughness, metallic, emission as uniforms

---

## Sprite System

- [2] **Sprite generation** - Generate sprite textures from 3D geometry or procedurally
- [2] **Flipbook animation** - Animated sprite sequences with configurable frame rate
- [2] **Sprite atlas support** - Pack multiple sprites into atlas texture

---

## Visual Metrics

- [1] **Screenshot capture** - Capture current render for feedback/debugging
- [1] **Visibility metrics** - Track particle visibility, culling stats
- [1] **FPS monitoring** - Real-time performance metrics from TD

---

## Connection & State

- [1] **Auto-reconnect** - Threaded WebSocket with automatic reconnection on disconnect
- [1] **State persistence** - Save/load zone shaders and spell state to JSON
- [2] **Session replay** - Replay a saved session's shader progression

---

## Prompt Enhancements

- [1] **Zone examples library** - Curated GLSL snippets for each zone/element combo
- [1] **Iterative refinement** - Let Gemini see compile errors and retry with fixes
- [1] **Visual feedback loop** - Show Gemini screenshots of current effect for iteration

---

## Notes

_Add any notes about priorities or dependencies here:_

