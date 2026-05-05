# TouchDesigner POP GLSL Reference

Reference guide for writing GLSL shaders in TouchDesigner's POP (Point Operator) particle system.

---

## Operator Types

### glslPOP vs glsladvancedPOP

TouchDesigner has two GLSL-based POP operators:

| Feature | glslPOP | glsladvancedPOP |
|---------|---------|-----------------|
| Input syntax | `TDIn_P()` | `TDInPoint_P()` |
| Output syntax | `P[idx]`, `PartVel[idx]` | `oTDPoint_P[idx]`, `oTDPoint_PartVel[idx]` |
| Output param | `outputattrs` | `ptoutputattrs` |
| Complexity | Simpler | More control |

**Recommendation:** Use `glslPOP` for most cases. It's simpler and matches the vibe-agent reference implementation.

---

## GLSL Input Functions (glslPOP)

```glsl
// Index and bounds
uint idx = TDIndex();              // Current particle index
uint count = TDNumElements();      // Total particle count

// Position and velocity
vec3 pos = TDIn_P();               // Position
vec3 vel = TDIn_PartVel();         // Velocity
vec3 force = TDIn_PartForce();     // Accumulated force

// Particle state
float id = float(TDIn_PartId());   // Persistent particle ID
float age = TDIn_PartAge();        // Age in seconds
float lifeSpan = TDIn_PartLifeSpan(); // Total lifespan

// Derived values
float life = 1.0 - (age / max(lifeSpan, 0.001)); // 1.0 at birth, 0.0 at death
```

---

## GLSL Output Arrays (glslPOP)

Each shader zone outputs to specific arrays:

| Zone | Output Array | Type | Description |
|------|--------------|------|-------------|
| spawn | `P[idx]` | vec3 | Particle position |
| spawn | `PartVel[idx]` | vec3 | Particle velocity |
| spawn | `PartLifeSpan[idx]` | float | Particle lifespan |
| force | `PartForce[idx]` | vec3 | Force accumulator |
| velmod | `PartVel[idx]` | vec3 | Velocity modifier |
| color | `xcolor[idx]` | vec4 | RGBA color |
| size | `xscale[idx]` | vec3 | Scale (use .x for uniform) |

**Important:** Set the `outputattrs` parameter on the glslPOP to match what you're outputting:
- Force shader: `outputattrs = "PartForce"`
- Spawn shader: `outputattrs = "P PartVel PartLifeSpan"`
- Velocity shader: `outputattrs = "PartVel"`

---

## Shader Templates

### Force Field (`glsl_force`)

```glsl
void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));
    vec3 force = TDIn_PartForce();

    // === custom behavior ===
    {zone_code}
    // === end ===

    PartForce[idx] = force;
}
```

### Spawn Behavior (`glsl_spawn`)

```glsl
void main() {
    const uint id = TDIndex();
    if (id >= TDNumElements()) return;

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();

    if (age < uDeltaTime * 1.5) {
        // Particle just born - initialize position and velocity
        float seed = fract(sin(fract(float(id) * 0.00123456) * 6.283) * 43758.5453);

        // === custom behavior ===
        {zone_code}
        // === end ===
    }

    P[id] = pos;
    PartVel[id] = vel;
}
```

### Color Over Life (`glsl_color`)

```glsl
void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // === custom behavior ===
    vec4 color = vec4(1.0, 0.6, 0.3, life * 0.8);
    // === end ===

    xcolor[idx] = color;
}
```

### Size Over Life (`glsl_size`)

```glsl
void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // === custom behavior ===
    float size = life * 0.5;
    // === end ===

    xscale[idx] = vec3(size);
}
```

### Velocity Modifier (`glsl_velmod`)

```glsl
void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 vel = TDIn_PartVel();
    vec3 pos = TDIn_P();
    float age = TDIn_PartAge();

    // === custom behavior ===
    vel *= 0.98; // Drag
    // === end ===

    PartVel[idx] = vel;
}
```

---

## Particle System Configuration

### particle1 (particlePOP) Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `timeintegration` | `true` | **Critical** - Integrates force→velocity→position |
| `targetpop` | `/project1/null_out` | Feedback loop target for recycling |
| `life` | `5.0` | Particle lifespan in seconds |
| `birthrate` | `400` | Particles born per second |

### Geometry Instancing (geometryCOMP)

| Parameter | Value | Description |
|-----------|-------|-------------|
| `instancepop` | `/project1/null_out` | POP to instance from |
| `instancetx/ty/tz` | `P(0)`, `P(1)`, `P(2)` | Position mapping |
| `material` | `/project1/glsl_billboard` | Billboard material |

---

## Common Issues and Fixes

### Particles Not Moving

1. **Check `timeintegration`** - Must be `true` on particle1
2. **Check force magnitude** - Forces may be too small
3. **Check velocity damping** - Drag may be too high (< 0.95 recommended)

### Particles Invisible

1. **Check alpha values** - Color alpha may be 0
2. **Check shader compilation** - Look at `*_info` DAT for errors
3. **Check instancepop** - Must point to the null_out POP

### Shader Not Updating

1. **Duplicate main()** - Check for duplicate function definitions
2. **Clear and rewrite** - Use `dat.clear()` then `dat.appendRow([shader])`
3. **Force cook** - Call `op.cook(force=True)` after changes

### Ages All Near Max

1. **Feedback loop** - Verify `targetpop` points to end of chain
2. **Birthrate** - May be too low to see young particles

---

## Debugging with popToCHOP

Create a temporary `poptoCHOP` to inspect particle data:

```python
# Create popToCHOP
ptc = parent.create(poptoCHOP, 'debug_particles')
ptc.par.pop = '/project1/null_out'
ptc.par.attribscope = '*'  # Get all attributes

# Read channels
px, py, pz = ptc['P_0'], ptc['P_1'], ptc['P_2']
vx, vy, vz = ptc['PartVel_0'], ptc['PartVel_1'], ptc['PartVel_2']
age = ptc['PartAge']
```

Available channels: `P_0/1/2`, `PartVel_0/1/2`, `PartId`, `PartAge`, `PartLifeSpan`, `PartForce_0/1/2`, `xcolor_0/1/2/3`, `xscale_0/1/2`

---

## Uniforms Available

Defined on glslPOP operators:

| Slot | Uniform | Type | Source |
|------|---------|------|--------|
| 0 | `uTime` | float | `absTime.seconds` |
| 1 | `uDeltaTime` | float | `1/me.time.rate` |
| 2 | `uAnalysis1` | vec4 | analysis_state table |
| 3 | `uAnalysis2` | vec4 | analysis_state table |
| 4 | `uSpellEnergy` | float | spell_state table |
| 5 | `uSpellMode` | float | spell_state table |

---

## POP Chain Order

```
pointgenerator1 (source points)
    ↓
particle1 (lifecycle, feedback loop)
    ↓
glsl_spawn (birth position/velocity)
    ↓
glsl_force (force accumulation)
    ↓
glsl_velmod (velocity modification)
    ↓
glsl_color (color assignment)
    ↓
glsl_size (scale assignment)
    ↓
null_out (output, feedback target)
```

The feedback loop (particle1.targetpop → null_out) recycles dead particles as new births.
