# vibe-agent Feature Checklist

Remaining features from vibe-agent that could still be ported to Merlin. Items already implemented have been removed; see git history for the full original list.

> Note: `shape_deform` and `material_lighting` are mesh-mode-dependent. Mesh mode was scoped out and pruned (see `docs/mesh-mode-pipeline.md`), so these are blocked until/unless mesh rendering returns.

## Priorities for the next team

- **P1 / ready to ship**: `background_environment` — spec is fully written in [`improvement-07-background-environment.md`](./improvement-07-background-environment.md). ~4–6 hours TD setup + Electron integration + testing.
- **P2 / has prereq**: `Session replay` — persistence API exists (`src/main/merlin/state-persistence.ts`), renderer UI needs to be built.
- **P3 / blocked**: `shape_deform`, `material_lighting`, `MAT parameter control` — all gated on mesh mode being unscoped. See `docs/mesh-mode-pipeline.md`.

---

## Shader Zones

- [3] **shape_deform** - Vertex displacement for mesh particles (wobble, pulse, twist effects) _(blocked on mesh mode)_
- [3] **material_lighting** - Surface properties: roughness, metallic, emission, normal perturbation _(blocked on mesh mode)_
- [2] **background_environment** - Environment backdrop: gradient, noise texture, animated patterns

---

## MAT Shaders

- [2] **MAT parameter control** - Expose roughness, metallic, emission as uniforms

---

## Connection & State

- [2] **Session replay** - Replay a saved session's shader progression _(persistence API exists in `src/main/merlin/state-persistence.ts`; no renderer UI yet)_

---

## Notes

_Add any notes about priorities or dependencies here:_
