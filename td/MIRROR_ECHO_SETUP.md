# Mirror/Echo Visual System - TouchDesigner Setup Guide

This guide walks you through setting up the expanded POP-based particle system for the mirror/echo AR visuals.

## Overview

The system maps psychological analysis values to particle behavior:

| Analysis | Range | Visual Effect |
|----------|-------|---------------|
| **tension** | 0→1 | Edge energy, inward pressure, vibration |
| **openness** | -1→1 | Aura expansion, spawn radius, particle reach |
| **valence** | -1→1 | Color temperature, vertical drift direction |
| **arousal** | 0→1 | Speed, birth rate, overall energy |
| **engagement** | 0→1 | Skeleton glow, particle density |
| **primary_emotion** | string | Color palette (joy/fear/anger/sadness/surprise/neutral) |

---

## Shader Templates Location

Shader templates are stored at the project root in `/shaders/` (shared between Electron and TD):

| File | Zone | Type |
|------|------|------|
| `pop_force.glsl` | force_field | POP compute |
| `pop_spawn.glsl` | spawn_behavior | POP compute |
| `pop_velmod.glsl` | velocity_modifier | POP compute |
| `pop_color.glsl` | color_over_life | POP compute |
| `pop_size.glsl` | size_over_life | POP compute |
| `top_postfx.glsl` | post_fx | TOP pixel |
| `mat_pixel.glsl` | material_pixel | MAT pixel |

**Note:** TD's `ws_callbacks.py` loads these via `../shaders/` path. Gemini sees these templates in prompts so it understands the context when writing `zone_code` snippets.

---

## What's Already Done (Python)

The `td/scripts/ws_callbacks.py` file has been updated with:

- ✅ Expanded `ZONE_PATHS` and `ZONE_COMPUTE_PATHS` (5 zones)
- ✅ `EMOTION_INDEX` mapping for shaders
- ✅ `analysis_state` dict for storing values
- ✅ `handle_analysis_update()` function
- ✅ Message router for `analysis_update`
- ✅ Helper functions: `get_valence()`, `get_arousal()`, `get_tension()`, etc.
- ✅ `get_analysis_vec4_1()` and `get_analysis_vec4_2()` for shader uniforms

**Important:** After making changes in TD, sync the `ws_parlor_callbacks` textDAT to the external file, or copy the file contents into the textDAT.

---

## Step 1: Create Analysis State Table

Create a new **tableDAT** named `analysis_state` at `/project1/analysis_state`:

| key | value |
|-----|-------|
| valence | 0 |
| arousal | 0 |
| tension | 0 |
| openness | 0 |
| engagement | 0 |
| primary_emotion | neutral |
| emotion_index | 0 |

---

## Step 2: Sync WebSocket Callbacks

Make sure the `ws_parlor_callbacks` textDAT in TD has the updated code:

**Option A:** Set the textDAT to sync from `td/scripts/ws_callbacks.py`
- DAT → File → File Path: `scripts/ws_callbacks.py`
- Enable "Sync to File"

**Option B:** Copy-paste the contents of `td/scripts/ws_callbacks.py` into the textDAT

---

## Step 3: Create Particles Container

Create a **baseCOMP** at `/project1/particles` to hold the POP network.

Inside `/project1/particles`, create:

### POP Chain

```
pointgenerator1 (pointgeneratorPOP)
    ↓
particle1 (particlePOP)
    ↓
glsl_spawn (glslPOP) ← glsl_spawn_compute (textDAT)
    ↓
glsl_force (glslPOP) ← glsl_force_compute (textDAT)
    ↓
glsl_velmod (glslPOP) ← glsl_velmod_compute (textDAT)
    ↓
glsl_size (glslPOP) ← glsl_size_compute (textDAT)
    ↓
glsl_color (glslPOP) ← glsl_color_compute (textDAT)
    ↓
null_out (nullPOP) - for output
```

### pointgenerator1 Settings
- Shape: Sphere
- Radius: 0.2
- Points: 100

### particle1 Settings
- Max Particles: 50000
- Life: 4
- Birth: 500 per second

---

## Step 4: Create Shader TextDATs

For each glslPOP, create a corresponding textDAT with the shader code.

### GLSL POP Attribute Reference

Standard TouchDesigner particle attributes (case-sensitive):
- `P` (vec3) - position
- `PartVel` (vec3) - velocity
- `PartAge` (float) - particle age in seconds
- `PartLifeSpan` (float) - particle lifespan in seconds (**not** `PartLife`)
- `PartMass` (float) - mass
- `PartDrag` (float) - drag coefficient
- `PartForce` (vec3) - force accumulator
- `PartId` (float) - unique particle ID

**For glslPOP (simple):**
- Read: `TDIn_AttributeName()` (e.g., `TDIn_P()`, `TDIn_PartAge()`)
- Write: `AttributeName[idx]` (e.g., `P[idx]`, `PartVel[idx]`)

**For glsladvancedPOP:**
- Read: `TDInPoint_AttributeName()` (e.g., `TDInPoint_P()`, `TDInPoint_PartAge()`)
- Write: `oTDPoint_AttributeName[idx]` (e.g., `oTDPoint_P[idx]`)
- **Important:** Set `ptoutputattrs` parameter to list attributes being written
- Custom attributes (like `pscale`, `Cd`) must be created on the Create Attributes page

### glsl_spawn_compute (glsladvancedPOP)

**Node config:** Set `ptoutputattrs` = `P`

```glsl
void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 pos = TDInPoint_P();
    float radius = 0.3;
    pos *= radius;
    oTDPoint_P[idx] = pos;
}
```

### glsl_force_compute

```glsl
uniform float uTime;
uniform vec4 uAnalysis1;  // valence, arousal, tension, openness
uniform vec4 uAnalysis2;  // engagement, emotion_index, 0, 0
uniform vec3 uBodyCenter;

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z
#define uOpenness uAnalysis1.w

void main() {
    uint id = TDIndex();
    vec3 pos = TDIn_P();

    vec3 force = vec3(0.0);

    // Valence: vertical drift
    force.y += uValence * 0.15;

    // Arousal: turbulence
    float turbulence = uArousal * 0.4;
    vec3 noisePos = pos * (2.0 + uArousal * 5.0) + uTime * (0.5 + uArousal * 2.0);
    force += sin(noisePos) * turbulence * 0.3;

    // Tension: inward pressure + vibration
    vec3 toCenter = normalize(uBodyCenter - pos);
    float distToBody = length(uBodyCenter - pos);
    force += toCenter * uTension * 0.3 * smoothstep(0.5, 0.0, distToBody);
    force += sin(pos * 20.0 + uTime * 5.0) * uTension * 0.2;

    // Openness: expansion/contraction
    force += -toCenter * uOpenness * 0.2;

    pos += force * 0.016;
    P[id] = pos;
}
```

### glsl_velmod_compute (glsladvancedPOP)

**Node config:** Set `ptoutputattrs` = `PartVel`

```glsl
uniform vec4 uAnalysis1;

#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 vel = TDInPoint_PartVel();

    float speedMult = 0.5 + uArousal * 1.5;
    vel *= speedMult;

    float damping = 1.0 - uTension * 0.3;
    vel *= damping;

    oTDPoint_PartVel[idx] = vel;
}
```

### glsl_size_compute (glsladvancedPOP)

**Node config:**
- Create custom attribute: `pscale` (float, 1 component)
- Set `ptoutputattrs` = `pscale`

```glsl
uniform vec4 uAnalysis1;

#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    float baseSize = 0.05 * life;
    baseSize *= 1.0 + uArousal * 0.5;
    baseSize *= 1.0 - uTension * 0.3;
    baseSize = max(baseSize, 0.01);

    oTDPoint_pscale[idx] = baseSize;
}
```

### glsl_color_compute (glsladvancedPOP)

**Node config:**
- Create custom attribute: `Cd` (float, 4 components)
- Set `ptoutputattrs` = `Cd`

```glsl
uniform float uTime;
uniform vec4 uAnalysis1;
uniform vec4 uAnalysis2;

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uEmotionIndex int(uAnalysis2.y)

// Emotion palettes
const vec3 PAL_NEUTRAL[3] = vec3[](vec3(0.55, 0.36, 0.96), vec3(0.4, 0.4, 0.9), vec3(0.6, 0.5, 0.8));
const vec3 PAL_JOY[3] = vec3[](vec3(1.0, 0.9, 0.4), vec3(1.0, 0.7, 0.3), vec3(1.0, 1.0, 0.9));
const vec3 PAL_FEAR[3] = vec3[](vec3(0.3, 0.5, 0.9), vec3(0.5, 0.6, 0.8), vec3(0.9, 0.95, 1.0));
const vec3 PAL_ANGER[3] = vec3[](vec3(0.9, 0.2, 0.1), vec3(1.0, 0.4, 0.1), vec3(1.0, 0.8, 0.3));
const vec3 PAL_SAD[3] = vec3[](vec3(0.2, 0.3, 0.6), vec3(0.3, 0.4, 0.7), vec3(0.4, 0.4, 0.5));
const vec3 PAL_SURPRISE[3] = vec3[](vec3(1.0, 1.0, 0.8), vec3(0.9, 0.8, 0.5), vec3(0.7, 0.6, 0.8));

vec3 getColor(int emo, float t) {
    vec3 c0, c1, c2;
    if (emo == 1) { c0 = PAL_JOY[0]; c1 = PAL_JOY[1]; c2 = PAL_JOY[2]; }
    else if (emo == 2) { c0 = PAL_FEAR[0]; c1 = PAL_FEAR[1]; c2 = PAL_FEAR[2]; }
    else if (emo == 3) { c0 = PAL_ANGER[0]; c1 = PAL_ANGER[1]; c2 = PAL_ANGER[2]; }
    else if (emo == 4) { c0 = PAL_SAD[0]; c1 = PAL_SAD[1]; c2 = PAL_SAD[2]; }
    else if (emo == 5) { c0 = PAL_SURPRISE[0]; c1 = PAL_SURPRISE[1]; c2 = PAL_SURPRISE[2]; }
    else { c0 = PAL_NEUTRAL[0]; c1 = PAL_NEUTRAL[1]; c2 = PAL_NEUTRAL[2]; }

    if (t < 0.5) return mix(c0, c1, t * 2.0);
    return mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    vec3 col = getColor(uEmotionIndex, life);

    vec3 warmShift = vec3(0.1, 0.05, -0.1);
    vec3 coolShift = vec3(-0.1, 0.0, 0.15);
    col += mix(coolShift, warmShift, uValence * 0.5 + 0.5) * 0.3;
    col *= 0.8 + uArousal * 0.4;

    oTDPoint_Cd[idx] = vec4(col, life);
}
```

---

## Step 5: Add Uniforms to glslPOPs

For each glslPOP, add these uniforms on the **Vectors 1** page:

### uTime
- Name: `uTime`
- Value: `absTime.seconds`

### uAnalysis1
- Name: `uAnalysis1`
- Values (4 expressions):
  - `float(op('/project1/analysis_state')['valence', 1])`
  - `float(op('/project1/analysis_state')['arousal', 1])`
  - `float(op('/project1/analysis_state')['tension', 1])`
  - `float(op('/project1/analysis_state')['openness', 1])`

### uAnalysis2
- Name: `uAnalysis2`
- Values (4 expressions):
  - `float(op('/project1/analysis_state')['engagement', 1])`
  - `float(op('/project1/analysis_state')['emotion_index', 1])`
  - `0`
  - `0`

### uBodyCenter (for glsl_force only)
- Name: `uBodyCenter`
- Values: Calculate from landmarks (see below)

---

## Step 6: Body Center Calculation

Create a **scriptCHOP** or use expressions to calculate body center from landmarks.

### Expression approach (on glsl_force vec uniform):

```python
# X: average of shoulders and hips
(float(op('/project1/landmark_table')[12, 0]) + float(op('/project1/landmark_table')[13, 0]) + float(op('/project1/landmark_table')[24, 0]) + float(op('/project1/landmark_table')[25, 0])) / 4

# Y: same for Y
(float(op('/project1/landmark_table')[12, 1]) + float(op('/project1/landmark_table')[13, 1]) + float(op('/project1/landmark_table')[24, 1]) + float(op('/project1/landmark_table')[25, 1])) / 4

# Z: same for Z
0  # or calculate if needed
```

Note: Landmark indices are 1-indexed in the table (row 0 is header), so shoulders are rows 12,13 and hips are rows 24,25.

---

## Step 7: Particle-Skeleton Interaction

Particles react to skeleton landmarks based on mood. Add force modes to `glsl_force_compute`.

### Force Mode Uniforms

Add to glsl_force:
- `uForceMode` (int): 0=orbit, 1=attract, 2=repel, 3=emit
- `uLandmarkTex` (sampler2D): The landmark_tex texture (33x1 RGBA32F)

### Force Mode Selection by Mood

| Mood | Force Mode | Behavior |
|------|-----------|----------|
| mysterious | 0 (orbit) | Slow orbit around body center |
| tension | 2 (repel) | Push away from body, defensive shell |
| revelation | 1 (attract) | Pull toward reveal landmark, then burst |
| warm | 3 (emit) | Spawn from heart, gentle outward |
| contemplative | 0 (orbit) | Slow orbit near head/crown |

### Updated glsl_force_compute with Landmarks

```glsl
uniform float uTime;
uniform vec4 uAnalysis1;  // valence, arousal, tension, openness
uniform vec4 uAnalysis2;  // engagement, emotion_index, 0, 0
uniform int uForceMode;   // 0=orbit, 1=attract, 2=repel, 3=emit
uniform sampler2D uLandmarkTex;  // 33x1 RGBA32F texture

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z
#define uOpenness uAnalysis1.w
#define uEngagement uAnalysis2.x

vec3 getLandmark(int idx) {
    return texelFetch(uLandmarkTex, ivec2(idx, 0), 0).xyz;
}

vec3 getBodyCenter() {
    // Average of shoulders (11, 12) and hips (23, 24)
    return (getLandmark(11) + getLandmark(12) + getLandmark(23) + getLandmark(24)) * 0.25;
}

vec3 getHeartPos() {
    return (getLandmark(11) + getLandmark(12)) * 0.5;
}

float distToNearestLandmark(vec3 p, out int nearest) {
    float minDist = 1000.0;
    nearest = 0;
    for (int i = 0; i < 33; i++) {
        vec3 lm = getLandmark(i);
        float d = length(p - lm);
        if (d < minDist) {
            minDist = d;
            nearest = i;
        }
    }
    return minDist;
}

void main() {
    uint id = TDIndex();
    vec3 pos = TDIn_P();

    vec3 bodyCenter = getBodyCenter();
    vec3 force = vec3(0.0);

    // Base analysis forces (always active)
    force.y += uValence * 0.1;  // Valence: vertical drift

    // Mode-specific forces
    if (uForceMode == 0) {
        // ORBIT: tangential force around body center
        vec3 toCenter = bodyCenter - pos;
        vec3 tangent = normalize(cross(toCenter, vec3(0, 1, 0)));
        float orbitSpeed = 0.3 + uArousal * 0.5;
        force += tangent * orbitSpeed * 0.1;
        // Gentle attraction to maintain orbit
        force += normalize(toCenter) * 0.02;
    }
    else if (uForceMode == 1) {
        // ATTRACT: pull toward nearest landmark
        int nearest;
        float dist = distToNearestLandmark(pos, nearest);
        vec3 lm = getLandmark(nearest);
        vec3 toL = normalize(lm - pos);
        float attractStrength = 0.3 + uEngagement * 0.4;
        force += toL * attractStrength * smoothstep(0.5, 0.0, dist);
    }
    else if (uForceMode == 2) {
        // REPEL: push away from body
        int nearest;
        float dist = distToNearestLandmark(pos, nearest);
        vec3 lm = getLandmark(nearest);
        vec3 away = normalize(pos - lm);
        float repelStrength = 0.2 + uTension * 0.5;
        force += away * repelStrength * smoothstep(0.3, 0.0, dist);
        // Jitter when tense
        force += sin(pos * 20.0 + uTime * 5.0) * uTension * 0.15;
    }
    else if (uForceMode == 3) {
        // EMIT: radial outward from heart
        vec3 heart = getHeartPos();
        vec3 fromHeart = normalize(pos - heart);
        float emitStrength = 0.2 + uOpenness * 0.3;
        force += fromHeart * emitStrength;
    }

    // Arousal turbulence (always active)
    vec3 noisePos = pos * 3.0 + uTime;
    force += sin(noisePos) * uArousal * 0.1;

    pos += force * 0.016;
    P[id] = pos;
}
```

---

## Step 8: Body Occlusion (AR Compositing)

The body should appear solid with particles wrapping around/behind.

### Composite Chain

```
[particles_render] (renderTOP - particles to texture)
        ↓
[invert_mask] (levelTOP - invert spout_mask)
        ↓
[particles_masked] (multiplyTOP - particles × inverted_mask)
        ↓
[comp_behind] (compositeTOP: Under mode)
    + [spout_video]
        ↓
[comp_front] (compositeTOP: Over mode)
    + [edge_energy]
    + [skeleton_overlay]
        ↓
[out_final]
```

### Create These Nodes

1. **invert_mask** (levelTOP)
   - Input: `spout_mask` (the Spout "Parlor Mask" input)
   - Invert: On
   - This creates a mask where body = black, background = white

2. **particles_masked** (multiplyTOP)
   - Input 1: `particles_render` (your rendered particles)
   - Input 2: `invert_mask`
   - Result: Particles only visible where body is NOT

3. **comp_behind** (compositeTOP)
   - Operation: Under
   - Input 1: `particles_masked`
   - Input 2: `spout_video` (the main camera feed)
   - Result: Video on top of masked particles

4. **comp_front** (compositeTOP)
   - Operation: Over
   - Input 1: `comp_behind`
   - Input 2: `edge_energy` (if you have it)
   - Input 3: `skeleton_overlay`
   - Result: Edge effects and skeleton on top of everything

---

## Step 9: Render the Particles

Before the composite chain, you need to render particles to a texture:

1. Create **renderTOP** named `particles_render`
2. Set geometry to your particle geo (instanced spheres or sprites)
3. Set camera appropriately
4. Resolution should match your output

---

## Step 10: Test

1. Start Parlor: `npm run dev`
2. Start a mentalist session (M key)
3. Watch TD console for `[WS] Analysis:` messages
4. Verify `analysis_state` table updates
5. Check particle behavior changes with emotions
6. Verify body occlusion (particles behind person)
7. Test different moods to see force mode changes

---

## Helper Functions (in ws_callbacks.py)

You can use these in TD expressions:

```python
# Individual values
op.ws_parlor_callbacks.module.get_valence()
op.ws_parlor_callbacks.module.get_arousal()
op.ws_parlor_callbacks.module.get_tension()
op.ws_parlor_callbacks.module.get_openness()
op.ws_parlor_callbacks.module.get_engagement()
op.ws_parlor_callbacks.module.get_emotion()
op.ws_parlor_callbacks.module.get_emotion_index()

# Force mode based on mood (0=orbit, 1=attract, 2=repel, 3=emit)
op.ws_parlor_callbacks.module.get_force_mode()

# For shader uniforms
op.ws_parlor_callbacks.module.get_analysis_vec4_1()  # (valence, arousal, tension, openness)
op.ws_parlor_callbacks.module.get_analysis_vec4_2()  # (engagement, emotion_index, 0, 0)
```

### Force Mode Uniform

For `uForceMode` on glsl_force, use:
```python
int(op('/project1/scene_state')['force_mode', 1])
```
Or:
```python
op.ws_parlor_callbacks.module.get_force_mode()
```

---

## Step 11: Post-Processing Effects

The post-FX system applies screen-space effects after compositing.

### Node Chain

```
comp2 → glsl_postfx (glslTOP) → out_final
```

### glsl_postfx Configuration

The `glsl_postfx` node is a glslTOP with these settings:

**Shader DATs:**
- Pixel: `glsl_postfx_pixel`
- Compute: `glsl_postfx_compute` (not used in vertex/pixel mode)

**Uniforms (Vec page):**

| Name | Expression/Value | Description |
|------|-----------------|-------------|
| uTime | `absTime.seconds` | Animation time |
| uSpellEnergy | `float(op('/project1/spell_state')['energy', 1])` | 0-1 spell energy |
| uSpellMode | `float(op('/project1/spell_state')['mode_float', 1])` | Mode as float |
| uBloomIntensity | `0.5` | Bloom strength (0-1) |
| uVignetteStrength | `0.3` | Edge darkening (0-1) |
| uChromaticAberration | `0.5` | Color fringing (0-1) |

### Default Effects

The built-in shader provides:
- **Chromatic aberration**: RGB channel separation at edges, scaled by spell energy
- **Bloom**: Brightens already-bright areas for a glow effect
- **Vignette**: Darkens edges for focus effect

### Custom Effects via Gemini

Gemini can inject custom GLSL code at the `// {zone_code}` marker in the shader. The zone system handles this via the `set_zone_shader` tool with `zone: "post_fx"`.

Example custom effects:
- Color grading (warm/cool shifts)
- Film grain
- Scan lines
- Custom blur patterns

### Adjusting Effect Strength

For real-time control, you can:
1. Link uniforms to CHOPs for animation
2. Use `uSpellEnergy` to scale effects with spell intensity
3. Add a lagCHOP for smooth transitions

---

## Troubleshooting

### No analysis messages
- Check WebSocket connection status
- Verify mentalist session is active
- Check Parlor console for errors

### Particles not responding
- Check uniform expressions are correct
- Verify `analysis_state` table has values
- Check glslPOP Info DAT for compile errors

### Jerky visuals
- Add lagCHOP smoothing between analysis_state and uniforms
- Typical lag: 0.3s for most, 0.1s for arousal

### Zone not found errors
- Make sure particle operators are at `/project1/particles/glsl_*`
- Or update ZONE_PATHS in ws_callbacks.py to match your layout
