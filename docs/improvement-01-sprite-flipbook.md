# Improvement: Smoother Flipbook Animation

## Problem

Flipbook animation snaps discretely between atlas frames, producing visible jerk when there isn't enough frames or when frame content changes significantly between adjacent cells. Increasing frame count helps but hits a resolution ceiling (Imagen generates up to ~1024px; at 4×4 = 512px total, each 128px frame is already small). The real fix is frame interpolation in the shader: blending between the current and next frame using the fractional position within the current frame interval.

## Approach

### 1. Frame interpolation in `mat_billboard_pixel.glsl` (high impact, no content re-generation needed)

Change `computeFrameIndex` from returning an `int` to returning a `float`, and blend between adjacent frames in the main shader body. This makes any existing flipbook look smooth, regardless of how many frames Imagen generated.

Current behavior:
```glsl
int frameIndex = computeFrameIndex(driveValue, frameCount, playbackMode, frameDuration, vId);
atlasUV = /* sample frameIndex */
vec4 sprite = texture(sSpriteMap, atlasUV);
```

Proposed behavior:
```glsl
// Fractional frame position (not clamped to int)
float frameFloat = computeFrameFloat(driveValue, frameCount, playbackMode, frameDuration, vId);
float frameBlend = fract(frameFloat);
int frame0 = int(frameFloat) % frameCount;
int frame1 = (frame0 + 1) % frameCount;

vec2 uv0 = atlasUVForFrame(frame0, atlasCols, atlasRows, vUV);
vec2 uv1 = atlasUVForFrame(frame1, atlasCols, atlasRows, vUV);

vec4 sprite = mix(texture(sSpriteMap, uv0), texture(sSpriteMap, uv1), frameBlend);
```

This is a standard technique (used in game engines for sprite animation). The blend is per-pixel within the particle quad — at 60fps it's smooth to within 1/60th of a frame duration, which is imperceptible.

**Note on `random` playback mode**: Frame interpolation doesn't apply cleanly to random mode (interpolating between two randomly selected frames produces a nonsensical blend). For `playbackMode == 3` (random), keep the existing discrete frame selection.

### 2. Larger atlas resolution

The current max is 25 frames at 128px each (5×5 = 640px atlas). Imagen supports up to 1024px output. Options:

| Config | Frames | Frame size | Atlas total |
|--------|--------|------------|-------------|
| Current 4×4 | 16 | 128px | 512×512 |
| 4×4 large | 16 | 256px | 1024×1024 |
| 3×3 large | 9 | 256px | 768×768 |
| 5×5 medium | 25 | ~192px | 960×960 |

Increasing `FLIPBOOK_FRAME_SIZE` from 128 to 256 would double frame resolution at the cost of 4× the pixel count — fewer useful for fixed-size flipbooks where quality per frame matters more than count. With interpolation already handling smoothness, the argument for more frames weakens; better frames become the priority.

The supported `frameCount` values (`4 | 8 | 9 | 12 | 16 | 25`) in `turn-runner.ts` would need to expand if larger atlases are added, and `FLIPBOOK_FRAME_SIZE` in `sprite-generator.ts` is the single constant to change.

### 3. Smoother Imagen animation prompts

The current prompt says "Frames should progress smoothly and continuously between states." This is the right instruction but might be underspecified. A stronger framing:

> "Each consecutive frame should differ from the previous by a small, incremental amount — like a slow morph or gentle pulse. Avoid large jumps between frames. The animation should look fluid when played at 8-15 frames per second."

Adding this to `buildFlipbookPrompt` in `sprite-generator.ts` would help, especially for non-cyclic animations like "expand" or "morph."

## Changes Required

### `shaders/mat_billboard_pixel.glsl`

- Refactor `computeFrameIndex` into `computeFrameFloat` returning a `float` (preserving the fractional part for blend weighting)
- Extract `atlasUVForFrame(int frame, int cols, int rows, vec2 baseUV) → vec2` helper
- Replace single-frame texture sample with `mix(frame0, frame1, fract(frameFloat))`
- Keep discrete-index path for `playbackMode == 3` (random)

### `src/main/merlin/sprite-generator.ts`

- Change `FLIPBOOK_FRAME_SIZE` from 128 to 256 (or make it configurable per call)
- Update `buildFlipbookPrompt` with stronger temporal-smoothness language
- If frame size becomes configurable, update `generate_sprite` tool schema with a `frameSize` parameter

### `src/main/merlin/prompts.ts`

- Update `generate_sprite` tool description to mention that frame count vs. frame size is a trade-off: fewer large frames give more detail; more small frames give finer timing. Current advice defaults to 16 frames which may not be optimal.

## Open Questions

- **Does Imagen actually respect frame-progression prompts?** The interpolation fix makes this less critical, but better prompt language is still worth testing. Has anyone compared "slow morph" vs "smooth animation" in the prompt? Results from the Live Spell test would show in the screenshot.
- **Frame size constant vs. per-call**: Should `frameSize` be a constant in `sprite-generator.ts` or exposed as a `generate_sprite` parameter? The case for per-call: an 8-frame "fast flicker" spell can use small frames; a 4-frame "slow morph" spell benefits from large ones. Against: more complexity for Gemini to reason about.
- **Memory / upload size**: A 1024×1024 atlas is ~3MB uncompressed. TD's `moviefileinTOP` accepts JPEG/PNG — a 1024px PNG should be fine, but worth confirming the file size doesn't affect load time noticeably on the target hardware.
- **Should single sprites use 512px instead of 256px?** Currently `SPRITE_SIZE = 256`. At the same bandwidth as a 1024px flipbook, a single 512px static sprite would have more detail. Likely fine to bump this alongside the flipbook size change.
- **Hard-edge sprites**: The current shader computes `alpha = luminance(sprite.rgb)`, which gives a smooth proportional fade from bright to transparent. For sprites with intentional hard shapes (lightning bolt, geometric sigil), this means the edges always look soft regardless of how Imagen drew them. A thresholded pre-processing pass (alpha = 1 if luminance > N, else 0) could produce crisper outlines. Worth exploring when non-radial sprite styles are requested.
- **Dead code**: `applyLuminanceAlpha()` in `sprite-generator.ts` (line 177) is defined but never called. The shader handles it instead. Should be removed to avoid confusion.

## Sprite Art Guidance for Non-Emissive Spells

For earth, crystal, shadow, and flora spells, strong silhouette design matters more than for emissive spells. Because these particles should read as physical objects rather than light sources:

- Imagen prompts should specify "hard-edged", "sharp silhouette", "no glow", "matte surface"
- Avoid feathered/soft-edged sprites for these elements — the billboard outline IS the perceived shape
- A shard with a clear angular profile reads as a shard at billboard scale; a soft blob reads as a glowing orb regardless of intent
- For crystal/gem shapes, request "faceted" and "distinct highlights on flat planes"

When `blendMode: 'alpha'` is in use (from improvement-03), the alpha channel is respected as-is — hard-edged sprites produce crisp particle boundaries, which is desirable for physical fragments. Combined, these two changes (silhouette-focused Imagen prompts + alpha blend mode) bring non-emissive spells much closer to looking like physical matter rather than glowing clouds.
