# Archived TD setup docs

These documents describe older TouchDesigner-side setups for visual systems that have since been superseded. They're preserved for historical context — and because some sections (zone-to-shader mappings, parameter expressions) are still accurate at a tactical level even if the surrounding architecture moved on.

For the current TD-side overview — COMP hierarchy, GLSL zones, uniforms, body tracking, render chain, MCP-and-save trap — see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

| File | What it covered |
|------|------|
| `MIRROR_ECHO_SETUP.md` | Setup guide for the original mirror/echo POP particle system mapping psychological-analysis values (tension/openness/valence/arousal/engagement/emotion) to particle behavior. Predates the current spell-cast envelope + multi-zone GLSL architecture. |
| `SPRITE_BILLBOARD_SETUP.md` | Setup for the sprite/billboard rendering system. Describes the deprecated mesh-vs-billboard render-mode toggle as if both paths are current — mesh mode has been pruned (see [`../../docs/specs/mesh-mode.md`](../../docs/specs/mesh-mode.md) for the deferred-feature spec). The billboard-side content is still accurate. |
