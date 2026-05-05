# Test Mode — Phase 4: Particle Spell Programs & billboard_vertex Hot-Reload

## Context

Two production paths still have no test-mode entry point after Phases 1–3:

1. **`pushParticleSpellProgram(mode, program)`** — the full "spell archetype" payload sent during buildup and release of a cast. Defined in `src/main/td-bridge/push.ts:286`. Today it's only emitted by the live Merlin session at cast time.
2. **`mat_billboard_vertex.glsl`** — has no `{zone_code}` marker, and `td/scripts/ws_callbacks.py:handle_mat_zone_update` only handles pixel DATs (`ZONE_MAT_CODE_PATHS`). The vertex DAT mapping `ZONE_MAT_VERTEX_PATHS` is **defined but never used** (`ws_callbacks.py:67-70`). The only ways to update this shader today are MCP push or a manual save inside TD — see `memory/workflow_shader_debugging.md`.

Goal:
- Direct-spec and Gemini-interpretation testing for spell programs.
- Wire up `billboard_vertex` so the WS `zone_update` pipeline can push it like any other shader.

## Scope

In:
- Spell-program test sub-panel: pick `mode` (`buildup` / `release`), build a `ParticleSpellProgram` payload, push.
- Direct-spec form for spell program fields.
- Gemini-interpretation: free-text intent → small Gemini call that returns a structured `ParticleSpellProgram`.
- `ws_callbacks.py` change: extend `handle_mat_zone_update` to handle vertex shaders by routing to `ZONE_MAT_VERTEX_PATHS` when the zone is a vertex zone (`billboard_vertex`).
- Make `billboard_vertex` go through the same template merge path. Two options:
  - **(A)** Add a `{zone_code}` marker to `shaders/mat_billboard_vertex.glsl` so it conforms to the existing snippet-injection pipeline. Then it can be tested via Phase 3's Direct GLSL or Gemini-interpretation paths.
  - **(B)** Add a "full shader" zone type that bypasses the `{zone_code}` merge and writes the entire shader. Lets us hot-reload the whole vertex shader file from disk — useful for the kind of bugfix we just did manually.

In: implement both (A) and (B). They serve different needs — (A) for snippet authoring per spell, (B) for shader-file iteration during dev.

Out:
- Re-running a saved spell session (separate "session replay" feature in `vibe-agent-features.md`).
- Building a spell-program library / preset bank.

## Particle spell program — Direct mode

`ParticleSpellProgram` shape lives in `src/main/merlin/types.ts`. Form fields cover at minimum:

- `archetype` (enum)
- `energy` (0–1 slider)
- `mode` for the push call (`buildup` / `release`)
- Any zone-code overrides the program carries (read the type definition for the full set when implementing).

Push button → `pushParticleSpellProgram(mode, program)`.

## Particle spell program — Gemini-interpretation mode

Single textarea: "Slow protective shield, building, then a sudden release."

Backend: Gemini-2.5-flash with a `set_spell_program` tool that returns the structured `ParticleSpellProgram`. The args feed `pushParticleSpellProgram(mode, program)`. Show the chosen archetype/zones in the panel.

(If the live session already has a tool that produces this payload, lift it to a shared module so we don't drift — same pattern as the `generate_sprite` extraction in Phase 1.)

## billboard_vertex hot-reload

### Path A — add `{zone_code}` marker

1. Edit `shaders/mat_billboard_vertex.glsl` to add a `// {zone_code}` line at a sensible insertion point (probably right before `gl_Position` is computed, so a snippet can mutate `worldOffset` / `viewPos`).
2. Update `ZoneContract` for `billboard_vertex` (`zone-registry.ts:93`) to reflect the actually-available variables in the new context (`viewPos`, etc., post-Phase-1 view-space rewrite).
3. Add `'billboard_vertex': '/project1/glsl_billboard_vertex'` to `ZONE_MAT_CODE_PATHS` in `ws_callbacks.py` (or use the existing `ZONE_MAT_VERTEX_PATHS`).
4. Extend `handle_mat_zone_update` to look up `ZONE_MAT_VERTEX_PATHS` for vertex zones and write to that DAT. Cook the MAT either way.

### Path B — full-shader override

Add a new message type, e.g. `shader_file_update`:

```json
{ "type": "shader_file_update", "path": "/project1/glsl_billboard_vertex", "source": "<full shader text>" }
```

Handler writes the source verbatim into the target DAT and cooks the parent MAT. No template merge.

Renderer-side: a "Reload from disk" button per shader file that reads the local `shaders/*.glsl` and sends the full text. Closes the manual-MCP-push gap from `workflow_shader_debugging.md` for whole-shader iteration.

## Implementation outline

| File | Change |
|---|---|
| `src/main/merlin/test-spell-program.ts` (new) | Direct-spec push helper + Gemini interpretation helper. |
| `src/main/index.ts` | IPC handlers for spell-program direct/Gemini paths and a `merlin-shader-file-reload` for Path B. |
| `src/preload/index.ts` | Expose handlers. |
| `src/renderer/main.ts` | Spell Program sub-panel + a "Reload Shader File" utility (probably alongside the Shaders tab). |
| `shaders/mat_billboard_vertex.glsl` | Add `{zone_code}` marker (Path A). |
| `src/main/merlin/zone-registry.ts` | Update `billboard_vertex` contract — `availableVars` should reflect the view-space rewrite (worldOrigin, viewPos, finalScale, etc.). |
| `td/scripts/ws_callbacks.py` | Extend `handle_mat_zone_update` to route to `ZONE_MAT_VERTEX_PATHS`. Add `handle_shader_file_update` for Path B. |
| `src/main/td-bridge/push.ts` | Add `pushShaderFileUpdate(targetPath, source)` for Path B. |

## Verification

### Spell programs
1. Direct: open Spell Program tab, pick archetype "swirl", energy 0.7, mode "buildup" → push → expect particles in TD shift to swirl behavior, console logs `Pushing spell program: mode=buildup ...`.
2. Same with mode "release" — confirm the release-time behavior triggers (matches what the live session does at cast time).
3. Gemini-interpretation: type "calm protective dome that swells then dissipates" → verify the Gemini-chosen `archetype` / energy / per-zone code visibly differs from the Direct test, and behaves accordingly.

### billboard_vertex (Path A)
4. In Phase 3's Direct GLSL tab, select `billboard_vertex`, paste a snippet that nudges `viewPos.y` upward → push → expect billboards to render slightly above particle origin.
5. Bad GLSL → expect rollback to last working code.

### billboard_vertex (Path B)
6. Edit `shaders/mat_billboard_vertex.glsl`, add a comment or trivial change → click "Reload Shader File" → expect the change to land in `/project1/glsl_billboard_vertex` and the MAT to recompile clean. No more manual MCP push for shader iteration.

## Open questions

- Path A vs Path B: do we keep both, or pick one? They serve different audiences. Recommendation: keep both — A for in-experience zone authoring, B for dev iteration on the shader file itself.
- Is a `{zone_code}` insertion point in `mat_billboard_vertex` actually useful? The current shader is small and most of its logic is structural (camera math). Adding a snippet hook there might encourage Gemini to produce code that breaks billboarding. Worth discussing where (if anywhere) the marker should go.
- For the shader-file-reload path (B), should we also add a file-watcher that auto-pushes on save? Out of scope for this phase, but worth noting as a future ergonomics win.
