# Mesh Mode Pipeline (deferred)

## Status

**Not built.** Merlin currently renders particles as billboards only. This document captures the research for a mesh-rendering path so a future maintainer can re-add it without rediscovering everything from scratch.

The orphaned UI surfaces (Render Mode toggle, `material_pixel` zone, `shaders/mat_pixel.glsl`) have been pruned from main. If mesh mode is later re-added, that prune commit is the place to revert from — search git log for "Prune mesh-mode" or look for the commit before the cleanup pass.

> **Important when re-adding**: MCP-created TouchDesigner nodes (geometry COMPs, MAT ops, attribute SOPs, etc.) do **not** survive a TD restart unless `td/demo.toe` is saved. The `ws_callbacks.py` self-heal pattern wires expression bindings on connect, but it can't recreate nodes. Save the .toe within the minute of any MCP node-creation work. See [`../../CLAUDE.md`](../../CLAUDE.md#mcp-created-nodes-dont-survive-restart-unless-toe-is-saved).

## Why a mesh mode at all

Billboards (camera-facing quads) work well for sprite-like particles — softly glowing dots, small flames, dust motes. They lose:

- **Depth cues.** Every billboard sits in a plane facing the camera, so they don't read as volumetric.
- **Surface lighting.** No normals → no Phong / PBR-style response to scene lights.
- **Per-particle silhouette.** Every particle has the same quad shape; you can suggest variety via the sprite texture but not the geometry.

Mesh mode renders each particle as actual 3D geometry (sphere, icosa, custom mesh). Trade-offs:

- More expensive (sphere has ~100x the triangles of a quad).
- Visible normals and lighting → particles can read as solid spheres / shards / crystals.
- Per-pixel material shading via a glslMAT (this is where `material_pixel` zone code would land).

The original Phase 2 design also envisioned a **per-spell render mode picker** — Gemini deciding whether a particular spell looks better as 2D atomized energy (billboard) or solid 3D objects (mesh). The infrastructure for the toggle and the zone landed in Merlin; the TD-side execution didn't.

## Current state

### Billboard side: fully wired

```
particles_out (null SOP, particle output)
   ↓ instances
geo_billboard (geometryCOMP)
   • SOP: quad1 (gridSOP, 1×1 XY plane, 2×2 verts)
   • Material: glsl_billboard
   • Custom attribs: PartVel (attr0), xpartinfo (attr1)
   ↓ rendered by
render1 (renderTOP, geometry = /project1/geo_billboard)
   ↓
… composite chain → glsl_postfx → out_final → spout
```

### Mesh side: every node missing

- No `geo_mesh` (or equivalent) instanced from `particles_out`.
- No `particle_mat` (glslMAT) — confirmed missing via MCP.
- No `particle_mat_pixel` / `particle_mat_vertex` (textDATs).
- No switching mechanism — `render1.par.geometry` is hardcoded to `/project1/geo_billboard`.
- `handle_render_mode` in `td/scripts/ws_callbacks.py` updates `sprite_state['render_mode']` and the table, but the `# TODO: Toggle render paths in TD based on mode` comment marks the unfinished work.

## TD setup steps (when mesh mode is built)

| Step | Node to create | Notes |
|---|---|---|
| a | `/project1/geo_mesh` (geometryCOMP) | Internal SOP: low-poly sphere or icosa. Instancing ON. `instanceop = /project1/particles_out`. Translate / scale / color from `P` / `xscale` / `xcolor` attribs. Custom attribs `PartVel(0..2)` and `xpartinfo(0..2)` on instance0/instance1 just like `geo_billboard`. Material slot → `particle_mat`. |
| b | `/project1/particle_mat` (glslMAT) | vDAT → `particle_mat_vertex`, pDAT → `particle_mat_pixel`. Uniform slots: `vec0name = uTime` (expression `absTime.seconds`), `const0name = uSpellEnergy` (expression — `_wire_spell_state_uniforms()` will fill it on connect), `const1name = uSpellMode` (same). Add sampler / vec slots if material_pixel zone needs them later. |
| c | `/project1/particle_mat_vertex` (textDAT) | Default vertex shader. Pass position through `TDDeform`. Pass normal, position, uv to fragment. Emit `gl_Position = TDWorldToProj(...)`. |
| c | `/project1/particle_mat_pixel` (textDAT) | Initial content: the `shaders/mat_pixel.glsl` template with the `{zone_code}` marker preserved. The merge-and-write happens via `handle_mat_zone_update` whenever `material_pixel` zone gets a push. |
| d | Switching mechanism — pick **(d1)** or **(d2)** below | Ties it together. |
| e | Wire `handle_render_mode` in `ws_callbacks.py` | Currently has `# TODO: Toggle render paths in TD based on mode` marker. Replace with the switch logic from (d). |

### (d1) Two renderTOPs + switchTOP — recommended

```
geo_billboard ─────► render_billboard (renderTOP)
                                    ↘
                                     render_switch (switchTOP, index = render_mode_float)
                                    ↗                                      │
geo_mesh      ─────► render_mesh (renderTOP)                                │
                                                                            ▼
                                                           (existing composite chain)
```

- Both render TOPs cook independently — no transition state to manage.
- `render_switch.par.index` driven by an expression: `int(op('/project1/sprite_state')['render_mode_float', 1])` (0 = mesh, 1 = billboard).
- `_check_glsl_compile` already works per glsl op; nothing extra needed.
- Replace `/project1/render1` in the downstream composite (or rename `render1` → `render_billboard` and add `render_mesh` as the sibling).

### (d2) Single renderTOP, Python-driven geometry swap

```python
# In handle_render_mode(dat, msg):
target = '/project1/geo_mesh' if mode == 'mesh' else '/project1/geo_billboard'
op('/project1/render1').par.geometry = target
```

- Cheaper to wire up (no new render TOP).
- Only one render path active at a time → fewer GPU resources.
- Trickier transitions: mid-frame swap can flicker; render1's `compilebehavior` may need tweaks.

Recommendation: start with (d1). It's slightly more nodes but more predictable.

## Merlin side: what already supports mesh mode

Everything except the TD-side execution is in place. **No Merlin code change is needed** to enable mesh mode once TD is wired up:

- `pushRenderMode(mode)` — `src/main/td-bridge/push.ts:365`. Emits `{type: 'render_mode', mode}`. ✓
- `RenderMode` type — `src/shared/types.ts`. `'mesh' | 'billboard'`. ✓
- Render Mode tab toggle — `src/renderer/main.ts` (Phase 2 work). ✓
- `material_pixel` zone:
  - Template: `shaders/mat_pixel.glsl` with `{zone_code}` marker. ✓
  - Contract: `ZONE_CONTRACTS.material_pixel` in `src/main/merlin/zone-registry.ts`. ✓
  - Gemini tool enum: `set_zone_shader` accepts `material_pixel` (Phase 3). ✓
  - WS routing: `handle_mat_zone_update` writes to `/project1/particle_mat_pixel` and cooks `/project1/particle_mat` via `ZONE_MAT_CODE_PATHS` and `ZONE_MAT_PATHS`. **Works the moment those nodes exist.** ✓
- Spell uniform binding: `_wire_spell_state_uniforms()` in `ws_callbacks.py` scans every glsl op for `uSpellEnergy` / `uSpellMode` and binds them on connect. Will pick up `particle_mat` automatically. ✓

If you re-add mesh mode after the prune step, you'll need to revert the prune commit first to restore those surfaces; everything else is still wired.

## Verification (for whoever builds it)

1. **Mesh path renders.** Render Mode tab → toggle to "Mesh". Particles change from camera-facing quads to 3D spheres / icosas. `op('/project1/render_switch').par.index` (or equivalent) reflects the toggle.

2. **material_pixel zone works end-to-end.** Shaders tab → check only `material_pixel` → Generate. Gemini's snippet lands in `/project1/particle_mat_pixel`; the MAT cooks clean. Visible: particle surface shading changes per Gemini's code.

3. **Reset to Baseline includes material_pixel cleanly.** Click Reset. Status shows `✓ 13/13 reset` (no skipped step). The `material_pixel` reset uses the no-op `// reset to defaults` snippet just like other zones.

4. **Spell uniforms live.** Push a spell program with `energy: 0.9`. `op('/project1/particle_mat').par.const0value.eval()` returns 0.9 (because `_wire_spell_state_uniforms` bound it to the spell_state expression).

5. **Live session round-trip.** During a live Merlin spell, if Gemini calls `set_zone_shader('material_pixel', ...)` AND `pushRenderMode('mesh')`, the visible result reflects both.

## Cross-references

- `docs/archive/test-mode-phase-2-render-mode.md` — original Phase 2 plan; "Open questions" section flagged this gap.
- `td/scripts/ws_callbacks.py` — search for `# TODO: Toggle render paths in TD based on mode` (the marker in `handle_render_mode`).
- `src/main/merlin/zone-registry.ts` — `material_pixel` zone contract.
- `shaders/mat_pixel.glsl` — the per-pixel material template (will be removed in the prune commit; restore from git history when rebuilding).
- `src/main/merlin/reset-td.ts` — Reset orchestrator currently classifies `material_pixel`'s "MAT zone not found" as skipped; once the TD nodes exist, it'll report `ok`.

## Pruning history (when this gets re-added later)

If you bring mesh mode back, look for the prune commit in git history (`git log --oneline -- shaders/mat_pixel.glsl`) — it's the inverse of what needs to be restored. Roughly: re-add `mat_pixel.glsl`, the `material_pixel` entry in `ZONE_TEMPLATE_FILES` / `ZONE_CONTRACTS` / `ZONE_MAT_CODE_PATHS` / `ZONE_MAT_PATHS`, and the Render Mode tab toggle in the renderer (if it was also removed).
