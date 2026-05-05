# Test Mode — Phase 3: Expand Shader-Zone Testing to All 9 Zones

## Context

The current Shift+T panel only generates shaders for **3 zones** (`force_field`, `color_over_life`, `size_over_life`). The full registry has **9 zones** today (`src/main/merlin/zone-registry.ts:24`):

```
force_field, color_over_life, size_over_life, spawn_behavior,
velocity_modifier, post_fx, material_pixel, billboard_vertex, billboard_pixel
```

There are two separate problems with the existing flow:

1. **Drift risk:** `src/main/merlin/test-shader.ts:66-126` hardcodes a copy of the shader templates inline. The real templates on disk (`shaders/*.glsl`) are loaded by `shader-templates.ts:loadTemplate`. The two have already diverged — for example, the inline `color_over_life` template uses a hardcoded purple default while the disk version may differ as the project evolves.
2. **Coverage gap:** Gemini's `set_zone_shader` tool is restricted to 3 zones in the test path. The newer zones (`velocity_modifier`, `post_fx`, `material_pixel`, `billboard_pixel`, etc.) never get exercised through the test panel even though they're production zones.

`billboard_vertex` is a special case — it has no `{zone_code}` marker, so the WS pipeline can't update it via `zone_update`. That belongs in Phase 4.

Goal: extend the test panel's shader path to cover all 8 zones that have `{zone_code}` markers, kill the duplicated templates, and add a "paste your own GLSL" mode for direct-spec testing.

## Scope

In:
- Replace the inline `SHADER_TEMPLATES` map in `test-shader.ts` with calls to `loadTemplate()` from `shader-templates.ts`.
- Expand the `set_zone_shader` tool's zone enum to include all 8 marker-bearing zones. Let the test panel select which zones Gemini should generate via checkboxes (default: all checked).
- Add a "Direct GLSL" sub-mode: pick a zone → paste a snippet → push through `pushZoneUpdateWithValidation` (full validate → push → wait-for-compile → rollback path). No Gemini.
- Keep the existing intent/element/energy controls for the Gemini-interpretation path.

Out:
- `billboard_vertex` (no `{zone_code}` marker — Phase 4).
- Authoring whole shader files (we only inject snippets at `{zone_code}`).
- Sharing zone code between spells / persisting custom snippets.

## Direct GLSL mode

UI:
- Zone dropdown (8 zones).
- Code editor (textarea is fine to start; Monaco is overkill).
- Variables/uniforms reference panel populated from `ZONE_CONTRACTS[zone].availableVars` + `.uniforms` so we always know what's accessible.
- "Push" button → `pushZoneUpdateWithValidation(zone, code)` → show `success / error / warnings` from the result.

This exercises the full validation pipeline (`validateGlslSnippet` → `validateZoneCode` → push → wait for `compile_result`) without the Gemini step, so we can isolate "Gemini wrote bad GLSL" vs. "the pipeline mis-handles good GLSL."

## Gemini-interpretation mode (extended)

UI:
- Existing intent / element / energy controls remain.
- New: checkbox list of zones to request (default all 8).
- Gemini gets a `set_zone_shader` tool whose `zone` enum matches the checked zones; system prompt is updated to include the correct templates (loaded via `loadTemplate`).
- Per-zone result row: status (pending / active / error), diff/warnings, the generated snippet.

## Implementation outline

| File | Change |
|---|---|
| `src/main/merlin/test-shader.ts` | Drop the inline `SHADER_TEMPLATES` constant. Build the system prompt by iterating selected zones and concatenating `formatTemplateForPrompt(zone)` (already exists). Expand `set_zone_shader` tool's enum dynamically based on selected zones. |
| `src/main/merlin/test-shader.ts` | New `pushDirectZoneCode(zone, code)` that just calls `pushZoneUpdateWithValidation`. |
| `src/main/index.ts` | New IPC handler `merlin-test-zone-direct`. Existing `merlin-test-shader` extended with a `zones?: ZoneName[]` param. |
| `src/preload/index.ts` | Expose new handler; update `merlinTestShader` signature. |
| `src/renderer/main.ts` | Shaders sub-panel: add zone-checkbox list + "Direct GLSL" mode toggle with editor. Render results per zone. |
| `src/shared/types.ts` | Update `TestShaderConfig` to accept optional `zones`. |

## Verification

1. **Templates load from disk:** edit `shaders/pop_force.glsl` (e.g. add a comment) → re-run the Shaders tab in Gemini-interpretation mode → confirm Gemini's prompt context reflects the edit (visible in console log of system prompt or compiled shader text in TD).
2. **All 8 zones generate:** check all boxes, run a generation. Expect 8 zone result rows; each `pushZoneUpdateWithValidation` returns success or a meaningful error.
3. **Selective generation:** uncheck `post_fx` and `material_pixel`; expect Gemini to generate only the 6 remaining zones (or fewer if it skips some) and the panel to show only the requested set.
4. **Direct GLSL pass:** in Direct mode, pick `force_field`, paste a known-good snippet (e.g. `force += vec3(0, 0.05, 0);`), push → expect `success`, particles drift up.
5. **Direct GLSL fail:** paste invalid GLSL (`force = banana;`) → expect `success: false` with the TD compiler error, and rollback to the previous snippet (verify by checking that the prior behavior persists).
6. **Banned-keyword catch:** paste a snippet using `discard` in `color_over_life` (banned per `ZONE_CONTRACTS`) → expect rejection at `validateZoneCode` step before TD ever sees it.

## Open questions

- For the Gemini-interpretation system prompt, do we include all selected templates verbatim (token-heavy) or rely on `getTemplateSnippetForTool` truncation? Probably full templates since cost isn't a concern.
- Direct mode editor: textarea now, upgrade later? Or jump straight to a syntax-highlighted editor (Monaco / CodeMirror) since this is a developer tool?
- Should the Direct mode have a "library" of canned snippets per zone (matches the "Zone examples library" item in `vibe-agent-features.md`)? Could naturally grow into that.
