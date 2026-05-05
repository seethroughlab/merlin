# Test Mode — Phase 1: Sprites

## Context

The sprite system (`src/main/merlin/sprite-generator.ts`, `asset-manager.ts`, billboard shaders, `pushSpriteTexture` / `pushFlipbookConfig`) is the most recently shipped feature in the vibe-agent port and is currently **only reachable through the live Merlin session** when Gemini calls the `generate_sprite` tool (`src/main/merlin/session.ts:474`).

The existing Shift+T panel only exercises three POP shader zones. There is no quick way to generate a sprite or flipbook on demand and watch it land in TouchDesigner.

Goal: a Sprites tab in the test panel that runs the full sprite pipeline standalone and lets us see how Gemini interprets a free-text request vs. an explicit spec.

## Scope

In:
- A "Sprites" sub-panel inside the existing Shift+T test panel.
- Two modes selected by a toggle:
  1. **Direct spec** — form fields drive `generateSpriteSync` / `generateFlipbookSync` literally.
  2. **Gemini-interpretation** — a single free-text box; Gemini-2.5-flash picks the structured params via the existing `generate_sprite` tool, then we feed those into the same generation path.
- Both modes run Imagen end-to-end and call `pushSpriteTexture` (+ `pushFlipbookConfig` for flipbooks).
- Inline preview of the resulting PNG (read from `asset.texturePath`).

Out:
- Render mode toggle (Phase 2).
- Direct flipbook re-config without re-generating (Phase 2).
- Sprite asset library / re-use of past assets.

## Direct spec mode

Form fields, one-to-one with `SpriteOptions` / `FlipbookOptions` (`sprite-generator.ts:38-50`):

| Field | Type | Notes |
|---|---|---|
| description | text | required |
| style | text | optional |
| animation | text | optional; presence triggers flipbook path |
| frameCount | select | `4 / 8 / 9 / 12 / 16 / 25` (gates `FLIPBOOK_LAYOUTS`) |
| playbackMode | select | `loop / once / pingpong / random` |
| driveSource | select | `age / life / velocity / id / time` |
| frameDuration | number | seconds per frame |

A "Generate" button calls a new IPC handler (see below) that mirrors the `case 'generate_sprite'` block in `session.ts:474-565`: choose `generateSpriteSync` vs `generateFlipbookSync` based on whether `animation` is set or `frameCount > 1`, then push results.

## Gemini-interpretation mode

Single textarea: free-form description ("a fiery dragon swirling upward, 16 frames, plays once").

Backend: a new `testGenerateSprite(prompt)` helper that mirrors `test-shader.ts` style — Gemini-2.5-flash with `FunctionCallingMode.ANY` and a single-tool config restricted to `generate_sprite` (the same tool definition the live session uses; should be lifted to a shared module so we don't duplicate). The tool args land in the same generation path as Direct mode.

We display the args Gemini chose (description, style, animation, frameCount, …) above the preview so we can see how it interpreted us.

## Implementation outline

| File | Change |
|---|---|
| `src/main/merlin/test-sprite.ts` (new) | `testGenerateSprite(prompt)` — Gemini call → `generate_sprite` args → reuse shared generator path. Also `runSpriteSpecDirect(spec)` for Direct mode. |
| `src/main/merlin/session.ts` | Extract `generate_sprite` tool definition + execution body into a shared helper that both `session.ts` and `test-sprite.ts` import. Avoids drift. |
| `src/main/index.ts` | New IPC handlers: `merlin-test-sprite-direct`, `merlin-test-sprite-gemini`. |
| `src/preload/index.ts` | Expose both via `electronAPI`. |
| `src/renderer/main.ts` | Add a tab strip to the existing test panel; add Sprites sub-panel with toggle + form + preview. Tabs default to "Shaders" (current behavior). |
| `src/shared/types.ts` | Types for the new IPC payloads/results. |

## Verification

1. Start dev: `npm run dev`. Confirm TD is connected and `glsl_billboard` MAT exists.
2. Shift+T opens panel; click "Sprites" tab.
3. **Direct single sprite**: description="glowing blue orb", no animation → click Generate → expect (a) Imagen call logs in console, (b) `pushSpriteTexture` log, (c) PNG preview, (d) `/project1/sprite_texture` TOP shows the new texture (verify via MCP).
4. **Direct flipbook**: description="fire", animation="flicker", frameCount=16 → expect (a) atlas PNG preview, (b) both `pushSpriteTexture` and `pushFlipbookConfig` logs, (c) `/project1/glsl_billboard` `vec1`/`vec2` params updated to match (verify via MCP `get_td_node_parameters`).
5. **Gemini-interpretation**: type "a slow-pulsing protective shield, 9 frames" → expect (a) Gemini args displayed (description, frameCount=9, …), (b) same downstream effects as Direct.
6. Fail-paths: disconnect TD, click Generate — Imagen still runs but `pushSpriteTexture` should report a `not connected` warning (existing `guardedSend` behavior).

## Open questions

- Should the panel persist the last-used Direct spec across reloads, or always start blank?
- Do we want a "Use default sprite" shortcut that skips Imagen entirely (useful when we just want to test the WS push, not image generation)? (User has said cost isn't a concern, but this still saves time iterating on TD plumbing.)
