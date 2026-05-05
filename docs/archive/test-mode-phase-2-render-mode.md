# Test Mode — Phase 2: Render Mode & Flipbook Re-config

## Context

After Phase 1 we can generate sprites and push them to TD on demand, but we still can't:
- Toggle the renderer between `mesh` (3D instanced geometry) and `billboard` (camera-facing sprites) without a full Merlin session.
- Re-configure flipbook playback (frame duration, drive source, playback mode) on an already-loaded asset without regenerating it.

`pushRenderMode` and `pushFlipbookConfig` exist in `src/main/td-bridge/push.ts:365` and `:350` respectively, and TD already handles both message types in `td/scripts/ws_callbacks.py:handle_render_mode` and `handle_flipbook_config`. The plumbing is there; nothing in the renderer triggers it outside the live session.

Goal: a Render Mode tab that lets us flip the renderer and tweak flipbook params instantly. No Gemini path — these aren't Gemini-interpreted decisions today.

## Scope

In:
- "Render Mode" sub-panel in the test panel.
- Two-state toggle: `mesh` ↔ `billboard` → `pushRenderMode(mode)`.
- A "Flipbook re-config" form that pushes a `pushFlipbookConfig` without regenerating the texture (uses whatever asset is currently loaded in TD).
- Live readout: query `/project1/sprite_state` table over the WS bridge or expose via a status push so we can see what TD currently has set.

Out:
- Picking a per-spell render mode via Gemini (deferred — would belong in a future "Gemini decides render mode" enhancement).
- Asset library or re-loading old assets (separate concern).

## Implementation outline

| File | Change |
|---|---|
| `src/main/index.ts` | IPC handlers: `merlin-test-render-mode` (calls `pushRenderMode`), `merlin-test-flipbook-config` (calls `pushFlipbookConfig`), `merlin-test-get-sprite-state` (queries the `sprite_state` table — see below). |
| `src/preload/index.ts` | Expose handlers. |
| `src/renderer/main.ts` | Render Mode sub-panel: mesh/billboard toggle, flipbook config form, status readout. |
| `td/scripts/ws_callbacks.py` | Optional: add a `request_sprite_state` message type that returns the current `sprite_state` table contents to the requester — gives the renderer a readout to display. (Alternative: read the table over MCP for now and skip this.) |

## Form fields for flipbook re-config

Maps to `FlipbookConfigMessage` (`src/main/td-bridge/types.ts`):

| Field | Type | Source of truth |
|---|---|---|
| atlasCols | number | should match the loaded atlas — read-only display from sprite_state |
| atlasRows | number | same |
| frameCount | number | same |
| playbackMode | select | `loop / once / pingpong / random` |
| frameDuration | number | seconds |
| driveSource | select | `age / life / velocity / id / time` |

Atlas cols/rows/frameCount are read-only because changing them without a matching texture produces nonsense sampling — those have to come from a regeneration (Phase 1) or an asset swap.

## Verification

1. Phase 1 complete and used to generate a 16-frame fire flipbook in billboard mode.
2. Open Render Mode tab, toggle mesh → confirm `/project1/sprite_state` row `render_mode` becomes `mesh`, particles render as 3D instances, billboards are hidden.
3. Toggle billboard → confirm sprites face camera again.
4. Change `frameDuration` from 0.1 to 0.5 → expect `/project1/glsl_billboard` `vec2valuex` to change to `0.5` and animation visibly slows.
5. Change `driveSource` from `age` to `time` → expect `vec2valuey` change and all particles animating in lockstep instead of by individual age.
6. Change `playbackMode` to `pingpong` → expect frame index to ping-pong instead of looping.
7. Disconnect TD, click toggle — UI shows "not connected" without crashing.

## Open questions

- Should the live `sprite_state` readout poll on an interval, or only update when we send a change? Polling is simpler; an event push from TD on state change is cleaner.
- Should toggling render mode mid-experience be safe (e.g., particles in flight)? Verify whether `handle_render_mode` swaps cleanly or needs a "release" step first. (Likely fine — render_mode is just a state flag — but worth confirming in TD.)
