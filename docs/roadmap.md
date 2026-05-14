# Roadmap

What's still on the table after the handoff, ranked by readiness. Each P1 / P2 item has a fully-written spec in [`specs/`](./specs/); P3 items are blocked behind earlier scope decisions and stay as ideas, not specs.

## P1 — Ready to ship

- **Background environment zone** — environment backdrop driven by Gemini-authored zone code (gradients, noise textures, animated patterns), composited behind the person via the existing segmentation mask. ~4–6 hours TD setup + Electron integration + testing. Full spec: [`specs/background-environment.md`](./specs/background-environment.md).

## P2 — Has prerequisites

- **Lit billboards (normal maps + view-dependent fading)** — adds directional shading and edge-on fading to billboard particles so material spells (earth, crystal, water droplets) read as solid rather than emissive. Works with the existing flipbook pipeline. Spec: [`specs/lit-billboards.md`](./specs/lit-billboards.md).
- **Session replay** — replay a saved session's shader progression. Persistence API already exists at `src/main/merlin/state-persistence.ts`; what's missing is a renderer UI to browse saved sessions and scrub through their state history.

## P3 — Blocked / nice-to-have

- **`shape_deform`** — vertex displacement for mesh particles (wobble, pulse, twist). Blocked on mesh mode.
- **`material_lighting`** — surface properties (roughness, metallic, emission, normal perturbation). Blocked on mesh mode.
- **MAT parameter control** — expose roughness/metallic/emission as Gemini-tunable uniforms. Blocked on mesh mode.

The mesh-mode rendering path was deliberately scoped out — see [`specs/mesh-mode.md`](./specs/mesh-mode.md) for the deferred-feature spec, including the verification checklist and the Merlin-side infrastructure that's already in place if someone picks it up.
