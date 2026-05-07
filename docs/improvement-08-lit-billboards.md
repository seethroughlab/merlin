# Improvement: Lit Billboard Sprites — Normal Maps and View-Dependent Fading

## Problem

Billboard particles have no directional light response — they're uniformly bright regardless of where a light source is. This is correct for self-illuminating spells (fire, plasma, cosmic) but wrong for physical-material spells (earth, crystal, water droplets, leaves) where the sense of solidity comes from one side being lit and the other shaded. A pile of crystal shards that all have identical brightness reads as emissive, not solid.

Two billboard techniques address this without adding mesh geometry:

1. **Normal-mapped sprites** — bake a surface normal into the sprite texture and apply directional shading in `billboard_pixel`
2. **View-dependent orientation fading** — shrink particles that are edge-on to the camera, reducing the "flat wall of dots" look in dense fields

Both techniques work with the existing billboard/flipbook pipeline and are suitable additions to `VISUAL_TECHNIQUES` in `prompts.ts`.

---

## Technique A: Normal-Mapped Billboard Sprites

### Concept

A standard color sprite encodes RGB appearance and uses alpha for masking. A normal-mapped sprite encodes a tangent-space surface normal in RGB (same convention as DirectX/OpenGL normal maps: R=X, G=Y, B=Z, remapped from [-1,1] to [0,1]). In `billboard_pixel`, decode this normal and apply a fixed key light direction — the particle shades exactly like a mesh surface with the same profile, at no geometry cost.

### GLSL — `billboard_pixel`

```glsl
// Decode tangent-space normal from sprite RGB
vec3 N = normalize(texture(sSpriteMap, vUV).rgb * 2.0 - 1.0);
vec3 keyLight = normalize(vec3(0.4, 1.0, 0.3));   // fixed key: up-right
float NdotL = max(dot(N, keyLight), 0.0);
float ambient = 0.25;
brightness *= NdotL * (1.0 - ambient) + ambient;  // 25% ambient floor
```

A sphere sprite with a baked normal map responds to the key light identically to a mesh sphere. Crystal shards baked from faceted geometry respond with hard terminator lines between lit and shadowed facets — giving the particle its perceived shape, not just its silhouette.

**Add as VISUAL_TECHNIQUES #9 in `prompts.ts`.**

### Sprite generation pipeline changes

Imagen cannot generate tangent-space normal maps directly. Two approaches:

**Option A — Pre-baked library (preferred for common shapes):**
Bake normal maps once from 3D geometry for sphere, shard, teardrop, leaf, and pebble shapes. Store these as `assets/normals/<shape>.png`. The `generate_sprite` tool gains an optional `normalMap: '<shape>'` parameter; when set, the matching pre-baked PNG is pushed alongside the Imagen color texture (or composited into the alpha channel, depending on the TD material setup).

**Option B — Luminance-gradient estimation:**
After Imagen generates a color sprite, compute a rough normal map by treating luminance as a height field and deriving normals via central-difference gradient. This is approximate — it works for rounded shapes (spheres, drops) but fails on flat-shaded objects. Useful as a no-asset fallback.

In either case, `sprite-generator.ts` would need a `normalMap` flag in `SpriteGenerationOptions`, and the TD material would need a second texture input for the normal sampler.

### Prerequisites

- A `sSpriteMap` sampler that either contains the normal in a separate atlas slot or as a dedicated second texture
- A `sNormalMap` sampler input on the `geo_billboard` material, or an atlas convention where color and normal maps tile side by side
- Pre-baked normal assets (or luminance-estimation post-processing in `sprite-generator.ts`)

**Priority: Medium.** Requires both asset pipeline work and TD material changes. The `billboard_pixel` GLSL is trivial; the asset work is the real cost.

---

## Technique B: View-Dependent Orientation Fading

### Concept

In a dense particle field, particles that happen to be edge-on to the camera are nearly invisible anyway — but they still consume fill rate and contribute to overdraw. More visually, a field where edge-on particles vanish (rather than appearing as thin slivers) creates a subtle sense of depth: particles appear to have volumetric presence because their visible density changes with viewing angle.

### GLSL — `billboard_vertex`

```glsl
// Fade particles that are edge-on to camera
// Requires camIdx uniform (available from TD via uTDMats)
vec3 toParticle = normalize(worldOrigin.xyz);
vec3 camFwd = -normalize(uTDMats[camIdx].camInverse[2].xyz);
float facing = abs(dot(toParticle, camFwd));
finalScale *= 0.15 + facing * 0.85;  // edge-on = 15% size, facing = 100%
```

`camIdx` is the TD camera index uniform documented in the `billboard_vertex` zone contract. Particles facing directly toward the camera (`facing ≈ 1.0`) remain full size; particles moving edge-on (`facing ≈ 0.0`) shrink to 15% — still present but imperceptible at normal density.

The effect is subtle in sparse fields, prominent in dense ones. It pairs well with `blendMode: 'alpha'` (from improvement-03): alpha-blended particles that are nearly edge-on contribute almost nothing to coverage, so fading their scale removes them cleanly rather than leaving a ghost contribution.

**Add as VISUAL_TECHNIQUES #10 in `prompts.ts`.**

### Prerequisites

None. The `camIdx` uniform is already available in `billboard_vertex` (documented in the zone contract). This is a pure GLSL pattern — no TD changes, no protocol changes.

**Priority: Low (immediate).** Only requires adding the technique to `VISUAL_TECHNIQUES` in `prompts.ts`. Gemini can start using it on the next deploy.

---

## Summary

| Technique | Zone | TD work | Asset work | Benefit |
|---|---|---|---|---|
| Normal-mapped sprites | `billboard_pixel` | New material input | Normal map library or luminance estimation | Directional shading on physical-material particles |
| View-dependent fading | `billboard_vertex` | None | None | Reduces "flat wall" appearance in dense fields |

Both are most useful for non-emissive spells (earth, crystal, shadow, flora). Fire/plasma/cosmic spells are self-illuminating and don't benefit from directional shading; they're also usually sparse enough that view-dependent fading has little effect.

## Relationship to Other Improvements

- **improvement-01** (sprite flipbook): add silhouette-focused Imagen prompt guidance for non-emissive spells; the billboard outline is the perceived shape
- **improvement-03** (particle params): add `blendMode: 'alpha'` — the depth sort and occlusion that makes particles read as solid objects; pairs directly with the normal-map technique for maximum physical-material effect
