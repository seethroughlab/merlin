# Improvement: Gemini-Controllable Particle Parameters

## Problem

The core particle simulation parameters — max particle count, lifespan, emit rate, and spawn radius — are hardcoded in the TD project. Gemini currently has no way to say "this spell needs 2000 dense firefly sparks" vs "this spell needs 200 slow-drifting embers." The zone shaders can shape behavior but can't override how many particles exist or how long they live. A blizzard and a single candle flame look equally dense by default.

## Approach

Add a `set_particle_params` WS message type and a corresponding Gemini tool. When called, the message updates the TD POP network parameters directly (birth rate, max count, lifespan, spawn sphere radius). Defaults are reset at the start of each new spell so parameters don't bleed across spells.

## Parameters

| Parameter | Description | Suggested range | Default |
|-----------|-------------|-----------------|---------|
| `maxCount` | Max live particles at once | 100 – 3000 | ~500 (to be verified) |
| `lifespan` | Particle lifetime in seconds | 1.0 – 8.0 | ~4.0 |
| `emitRate` | New particles born per second | 30 – 600 | ~120 |
| `spawnRadius` | Radius of the initial spawn sphere around the body point (TD world units) | 0.03 – 0.4 | ~0.2 |
| `blendMode` | Particle blend equation | `'additive'` \| `'alpha'` | `'additive'` |

`blendMode` is the most impactful parameter for non-emissive spell archetypes. Additive blending (the default) sums brightness — particles always add light to the scene, which is correct for fire/plasma/light but wrong for earth/crystal/shadow, where particles should occlude each other and read as solid objects. Alpha blend with depth sort produces that opacity. Internally this changes `geo_billboard`'s blend mode and enables depth-sorted draw order. Gemini should use `'alpha'` for any spell where the particles are meant to look like physical fragments rather than emitted light.

`spawnRadius` controls the `pointgenerator1` sphere radius — the initial scatter around the body-tracked position. This is distinct from what `spawn_behavior` zone code can do (which redirects `pos` to a different body part but doesn't change spread independently).

## Changes Required

### WS protocol (`src/main/td-bridge/push.ts` + `protocol.ts`)

New outbound message type:

```ts
{
  type: 'particle_params',
  maxCount?: number,
  lifespan?: number,
  emitRate?: number,
  spawnRadius?: number,
}
```

All fields optional — send only the ones changing. TD handler applies each present field and ignores missing ones.

### TD side (`td/scripts/ws_callbacks.py`)

Add handler `handle_particle_params(data)`:

```python
def handle_particle_params(data):
    max_count  = data.get('maxCount')
    lifespan   = data.get('lifespan')
    emit_rate  = data.get('emitRate')
    spawn_r    = data.get('spawnRadius')

    if max_count is not None:
        # set max particles on the relevant POP node (see open questions)
        pass
    if lifespan is not None:
        # set lifespan on the POP source/birth node
        pass
    if emit_rate is not None:
        # set birthrate on the POP source/birth node
        pass
    if spawn_r is not None:
        op('/project1/pointgenerator1').par.radscale = spawn_r  # verify param name
    blend = data.get('blendMode')
    if blend is not None:
        mat = op('/project1/geo_billboard').par  # verify node path
        if blend == 'alpha':
            mat.blendmode = 'combinealpha'  # or equivalent TD blend param
            mat.sortorder = 'bydistance'
        else:  # 'additive'
            mat.blendmode = 'add'
            mat.sortorder = 'none'
```

Wire this into the main `on_text_message` dispatch alongside the existing handlers.

### Reset baseline (`src/main/merlin/reset-td.ts`)

Add `BASELINE_PARTICLE_PARAMS` alongside `BASELINE_FLIPBOOK`, and push it at the start of each Live Spell test (and spell transition in the live session) so parameters reset between spells:

```ts
export const BASELINE_PARTICLE_PARAMS = {
  maxCount: 500,     // verify against current TD defaults
  lifespan: 4.0,
  emitRate: 120,
  spawnRadius: 0.2,
  blendMode: 'additive' as const,
};
```

### Gemini tool (`src/main/merlin/prompts.ts` — `MERLIN_VISUAL_AUTHOR_TOOLS`)

New tool definition `set_particle_params`:

- Description: set the density, lifespan, emit rate, spawn spread, and blend mode of the particle system
- Parameters: `maxCount` (int), `lifespan` (float, seconds), `emitRate` (float, per second), `spawnRadius` (float, world units), `blendMode` (`'additive'` | `'alpha'`)
- All optional; only the supplied fields are changed
- Should be called before or alongside `set_zone_shader`, not after `request_visual_feedback`

Add guidance in `MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT` about when to use it:
- Dense atmospheric effects (fog, snow, smoke): high count + moderate rate + longer life
- Energetic/explosive spells: high rate + short life (fast churn, not density accumulation)
- Sparse/precise effects (single flame, lightning): low count + high rate + very short life
- Ambient drifting (stardust, pollen): low rate + long life

Also add to the live session `MERLIN_TOOLS` so the full Merlin character can adjust particle density during discovery/formation.

### Turn runner (`src/main/merlin/turn-runner.ts`)

Add `set_particle_params` to the tool dispatch in `dispatchToolCalls`, calling the new WS push function. Mirror result back to Gemini in the function response (echo back applied values).

## Open Questions

- **TD node paths for max count and lifespan**: The POP network lives at `/project1/popnet1` and references `particles_out`/`particle1`, but the actual birthing node name and its parameter names need to be verified in the running project. In TD POP networks, `birthrate` and `lifespan` commonly live on a `popSourceDAT`, `popBirth`, or `glsl_spawn`'s parent sopgen. Inspect the network when TD is available.
- **Max count ceiling**: 3000 is a guess. The actual comfortable ceiling depends on GPU and target frame rate — check FPS metrics at different counts with the live hardware.
- **Should `set_particle_params` be in `MERLIN_TOOLS` (live session) too?** If yes, Merlin can ramp density during the buildup phase as the spell intensifies. If the live session already uses the full participant-facing Merlin character and these calls might feel mechanical, it could stay visual-author-only.
- **Emit rate vs. max count interaction**: In a POP network these are somewhat redundant — if `emitRate * lifespan < maxCount` then max count is never hit. The prompt guidance should clarify that `emitRate` controls the feel of churn, `maxCount` is a hard ceiling. Consider whether to expose both or just `emitRate` and `lifespan` and derive max count implicitly.
