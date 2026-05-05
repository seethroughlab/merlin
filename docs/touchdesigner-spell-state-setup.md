# TouchDesigner Spell State Setup

Setup guide for integrating the Merlin spell system with TouchDesigner's POP particle system.

---

## Architecture Overview

Merlin uses **Gemini-authored GLSL shaders** for visual effects. Instead of parameter-driven uniforms, Gemini writes custom GLSL code snippets that get inserted into shader templates on each conversation turn.

```
Gemini Response
  ↓
  [Tool: set_zone_shader]
  ↓
session.ts → pushZoneUpdate(zone, glsl_code)
  ↓
ws_callbacks.py → Merges into template at {zone_code}
  ↓
TD glslPOP → Custom behavior active
```

---

## Current Project State

**Already configured:**
- Spout inputs: `syphonspoutin1` → "Merlin", `spout_mask` → "Merlin Mask"
- Existing tables: `scene_state`, `analysis_state`, `resolution_state`, `landmark_table`, `pose_connections`, `spell_state`
- glsladvancedPOPs: `glsl_spawn`, `glsl_force1`, `glsl_color1`, `glsl_size`, `glsl_velmod`

**Uniforms on glslPOPs (minimal set):**

| Slot | Uniform | Type | Source | Description |
|------|---------|------|--------|-------------|
| 0 | uTime | float | absTime.seconds | Animation timing |
| 1 | uAnalysis1 | vec4 | analysis_state | valence, arousal, tension, openness |
| 2 | uAnalysis2 | vec4 | analysis_state | engagement, emotion_index, 0, 0 |
| 3 | uSpellEnergy | float | spell_state | Spell intensity 0-1 |
| 4 | uSpellMode | float | spell_state | -1=idle, 0=buildup, 1=release |

---

## Shader Zones

Each zone has a shader template with a `{zone_code}` placeholder where Gemini's GLSL gets inserted.

| Zone | glslPOP | Output Variables | Purpose |
|------|---------|------------------|---------|
| force_field | glsl_force1 | `PartForce` (vec3) | Particle acceleration |
| spawn_behavior | glsl_spawn | `P` (vec3), `PartVel` (vec3) | Spawn position & velocity |
| color_over_life | glsl_color1 | `Cd` (vec4) | Particle RGBA color |
| size_over_life | glsl_size | `pscale` (float) | Particle scale |
| velocity_modifier | glsl_velmod | `PartVel` (vec3) | Velocity multiplier |

---

## Zone Update Message

When Gemini calls `set_zone_shader`, Parlor sends a WebSocket message:

```json
{
  "type": "zone_update",
  "zone": "force_field",
  "glsl_code": "// Custom GLSL here\nPartForce += vec3(0, uSpellEnergy * 0.5, 0);"
}
```

The `ws_callbacks.py` handler merges this into the shader template.

---

## Example Shader Snippets

### Force Field - Upward Spiral (Fire/Confidence)
```glsl
vec3 toCenter = vec3(0.5, 0.5, 0) - P;
float angle = atan(toCenter.y, toCenter.x) + uTime * 2.0;
float lift = uSpellEnergy * 0.3;
PartForce += vec3(cos(angle) * 0.1, sin(angle) * 0.1, lift);
```

### Color Over Life - Warm Gradient (Fire)
```glsl
float life = 1.0 - (age / life);
vec3 fireColor = mix(vec3(1.0, 0.3, 0.0), vec3(1.0, 0.8, 0.2), life);
Cd = vec4(fireColor * uSpellEnergy, life * 0.8);
```

### Spawn Behavior - Heart Origin
```glsl
// Spawn near body center with outward velocity
P = vec3(0.5, 0.4, 0) + (rand3(id) - 0.5) * 0.1;
PartVel = normalize(P - vec3(0.5, 0.4, 0)) * uSpellEnergy * 0.2;
```

---

## Uniform Reference for Shader Authors

Available in all zones:

```glsl
uniform float uTime;        // Current time in seconds
uniform vec4 uAnalysis1;    // [valence, arousal, tension, openness]
uniform vec4 uAnalysis2;    // [engagement, emotion_index, 0, 0]
uniform float uSpellEnergy; // Spell intensity 0-1
uniform float uSpellMode;   // -1=idle, 0=buildup, 1=release
```

### Usage Patterns

```glsl
// Respond to spell energy
float intensity = uSpellEnergy;

// Check spell mode
bool isBuildup = uSpellMode > -0.5 && uSpellMode < 0.5;
bool isRelease = uSpellMode > 0.5;

// Access analysis values
float valence = uAnalysis1.x;   // -1 to 1, negative to positive affect
float arousal = uAnalysis1.y;   // 0 to 1, calm to energized
float tension = uAnalysis1.z;   // 0 to 1, relaxed to tense
float openness = uAnalysis1.w;  // 0 to 1, closed to open posture
```

---

## Spell State Table

The `spell_state` tableDAT stores spell parameters (key-value pairs):

| Key | Default | Description |
|-----|---------|-------------|
| active | 0 | Session active flag |
| phase | idle | Current phase (idle/intro/discovery/formation/outro) |
| mode | idle | Spell mode (idle/buildup/release) |
| mode_float | -1 | Numeric mode (-1/0/1) |
| energy | 0.2 | Spell energy 0-1 |
| intent | | User's intent (confidence, calm, etc.) |
| element | | Spell element (fire, water, etc.) |
| casting_origin | | Where spell originates (hands, heart, etc.) |

---

## Test the Integration

1. Start Parlor: `npm run dev`
2. Connect TD to WebSocket (auto-connects on port 8001)
3. Start a Merlin session
4. Watch TD textport for zone_update messages:
   ```
   [WS] zone_update: force_field
   [WS] Shader code: PartForce += vec3(0, uSpellEnergy * 0.3, 0);
   ```
5. Particles should respond to Gemini's custom GLSL each turn

---

## Helper Functions in ws_callbacks

```python
# Mode queries
is_merlin_active()      # bool
get_spell_mode()        # 'idle', 'buildup', 'release'
get_spell_mode_float()  # -1, 0, 1

# Spell state
get_spell_energy()      # 0-1
get_spell_intent()      # intent or None
get_spell_element()     # element or None
get_casting_origin()    # 'hands', 'heart', etc.
```
