# Merlin Mirror

Interactive AR experience combining Electron, MediaPipe tracking, and TouchDesigner visuals.

## Architecture

- **Electron App** (`src/main/`, `src/renderer/`): Camera capture, AI chat, spell recognition
- **TouchDesigner** (`td/demo.toe`): Real-time particle systems, shaders, compositing
- **Bridge**: WebSocket on port 8001 for Electron↔TD communication

Gemini SDK: **`@google/genai` v1+** (the new SDK; supports Gemini 3 multimodal function responses). Default model is `gemini-3-flash-preview`. The legacy `@google/generative-ai` SDK is still in `package.json` but only used by `gemini.ts` (one-shot generateContent paths for expression/body analysis and voice commands). `tts.ts` and `sprite-generator.ts` both use the new `@google/genai` SDK.

## Key Modules

### src/main/merlin/
- `session.ts` - Live Merlin session orchestration (chat, tool calls, spell flow)
- `spell-state.ts` - Spell detection state machine
- `prompts.ts` - Two system prompts + two tool registries:
  - `MERLIN_SYSTEM_PROMPT` + `MERLIN_TOOLS` for live experience (full character, all 7 tools)
  - `MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT` + `MERLIN_VISUAL_AUTHOR_TOOLS` for the Live Spell test (stripped — no Merlin character, only `set_zone_shader` / `generate_sprite` / `request_visual_feedback`)
- `gemini-chat.ts` - Chat wrapper. `MerlinChat.initChat({mode})` selects `'merlin' | 'visual-author'`; defaults to visual-author since the only caller is Live Spell.
- `turn-runner.ts` - Shared dispatch loop for tool calls. `runMerlinTurn` + `dispatchToolCalls` are the single path used by both live session and Live Spell test. Mirrors Gemini's free-text and tool-call summary to stdout (`[Gemini <source> <id>] …`) for dev-console visibility.
- `asset-manager.ts` - Sprite/flipbook asset storage
- `sprite-generator.ts` - Gemini Imagen sprite generation
- `glsl-validator.ts` - GLSL zone code validation
- `zone-registry.ts` - Zone contracts (`ZONE_CONTRACTS`, `ZONE_NAMES`)
- `zone-state.ts` - Zone compilation state + rollback. Tracks `lastCompileSuccess` per zone (survives rollback-to-default) so the screenshot guard can refuse `request_visual_feedback` even after a failed compile has reverted to template defaults.
- `shader-templates.ts` - Loads `shaders/*.glsl` from disk for prompt context
- `td-state-mirror.ts` - Last-pushed flipbook config (Flipbook tab readout) and last-pushed sprite (used by request_visual_feedback to attach the active sprite alongside screenshots)
- `reset-td.ts` - Sidebar "Reset to Baseline" + exports `BASELINE_FLIPBOOK` (1×1 single-frame) for the single-sprite path that resets atlas state on every push

#### Test Mode (Shift+T)
4 tabs:
- `test-shader.ts` - Shaders tab: Gemini fills 1–8 zones with retry on compile failure
- `test-sprite.ts` - Sprites tab: Direct spec or Gemini interpretation → Imagen → push (waits for `sprite_loaded` ACK before returning)
- `test-flipbook.ts` - Flipbook tab: re-configure flipbook playback on the loaded texture
- `test-live-spell.ts` - Live Spell tab: highest-scope test. Free-text spell → `runMerlinTurn` with visual-author mode → Gemini drives sprite gen + zone shaders + screenshot evaluation end-to-end
- `test-live-spell-presets.ts` (in `src/shared/`) - 8 named scenarios for the Live Spell preset dropdown
- `gemini-events.ts` - Publishes `GeminiTurn` events to renderer over `gemini-conversation` IPC (truncates long string fields). Sidebar renders text + tool calls + push results + screenshots inline.
- `gemini-chat-helper.ts` - Shared `startSingleToolChat(toolDef, opts)` for forced-single-tool test paths

### src/main/td-bridge/
- `connection.ts` - WebSocket server on port 8001 (Merlin is server, TD is client). Soft-fails on EADDRINUSE so dev process keeps running if a stale instance is holding the port.
- `push.ts` - Outbound; `pushZoneUpdateWithValidation` runs the validate → push → wait-for-compile → rollback flow
- `protocol.ts` - Inbound message dispatch
- `metrics.ts` - FPS / particle / coverage / visibility metrics. Exposes:
  - `requestScreenshot(send, timeoutMs)` — promise; resolves when `screenshot_result` arrives
  - `waitForSpriteLoad(assetId, timeoutMs)` — promise; resolves when matching `sprite_loaded` ACK arrives. **Critical**: `pushSpriteTexture` is fire-and-forget; without awaiting this the next `request_visual_feedback` can race and screenshot the previous spell's texture still on the GPU.
  - `getLatestMetrics()` / `getLatestVisibility()` — most recent values; visibility includes `renderVsWebcamDiff` from the TD-side numpy diff

### shaders/
- `pop_force.glsl`, `pop_color.glsl`, `pop_size.glsl`, `pop_spawn.glsl`, `pop_velmod.glsl` - POP zone templates
- `top_postfx.glsl` - Post-FX TOP template
- `mat_billboard_pixel.glsl`, `mat_billboard_vertex.glsl` - Billboard material templates. Pixel shader computes per-particle flipbook frame from `(driveSource, frameDuration, playbackMode)` uniforms set on flipbook_config.
- All templates have a `// {zone_code}` injection point where Gemini's snippet is merged

> Particle rendering is **billboard/flipbook only** for now. Mesh-mode rendering was scoped out and pruned; see `docs/mesh-mode-pipeline.md` for the future-work notes.

### Body-tracked particle uniforms

`pointgenerator1.t[xyz]` is bound to a `body_positions` scriptCHOP (callback at `/project1/body_positions_callbacks1`) that reads MediaPipe pose landmarks from `landmark_table` and outputs world-space positions for chest / eyes / hands. Visibility-aware holding: when MediaPipe loses a body part (vis < 0.5), the position is held at last-good for 3 s, then lerps back to chest. Gemini sees these as uniforms in `glsl_spawn` / `glsl_force` / `glsl_velmod`:

- `uChestPos`, `uEyeLPos`, `uEyeRPos`, `uHandLPos`, `uHandRPos` (vec3 world)
- `uChestVis`, `uEyeLVis`, `uEyeRVis`, `uHandLVis`, `uHandRVis` (float [0,1])

**Caveat**: MediaPipe Pose's `vis` field is essentially binary for face/torso landmarks (1.0 whenever any face is detected). Only hand landmarks genuinely fluctuate. The prompt documents this so Gemini doesn't try to use eye visibility as a meaningful signal.

## Live Spell test — visual-author mode

`testLiveSpell(prompt)` is the highest-scope dev surface for evaluating Gemini's spell-creation quality. Uses `MerlinChat.initChat({mode: 'visual-author'})` so the model is *not* loaded with the Merlin character / participant-addressing language — it behaves as a visual-effects authoring assistant.

End-to-end flow:

1. Gemini reads the spell description.
2. Calls `generate_sprite` (Imagen 24-30s round-trip) → `pushSpriteTexture` + `pushFlipbookConfig` to TD → **awaits `sprite_loaded` ACK** so the texture is verified on the GPU before continuing. Sprite PNG is attached as a multimodal part on the function response so Gemini *sees* what Imagen made.
3. Calls `set_zone_shader` for each zone (parallel-batchable). Each push runs `pushZoneUpdateWithValidation` (validate → send → wait-for-compile → rollback on fail).
4. Calls `request_visual_feedback`. Handler **refuses** if any zone has `lastCompileSuccess === false` (catches both 'error' status and rolled-back-to-default cases). On success, response carries:
   - The screenshot (multimodal part #1)
   - The most-recent-pushed sprite from `td-state-mirror.getLastSpritePush()` (multimodal part #2) — Gemini A/B compares texture identity
   - `metrics: { fps, particle_count, coverage, visible_particles, avg_brightness, render_vs_webcam_diff }` — sampled at screenshot time
5. Prompt rules require Gemini to cross-reference metrics against thresholds (`visible_particles >= 50`, `avg_brightness >= 0.02`, `render_vs_webcam_diff >= 0.01`) before declaring the spell complete and to cite actual values in the final summary, not intent.

When Gemini's compile fails, the test panel and live session both feed the error back via the same chat session and ask for a corrected version. Up to 2 retries (3 attempts total). Compile-detection reads TD's `_info` DAT.

## TouchDesigner side

### `td/scripts/ws_callbacks.py` syncs from disk

The `/project1/ws_parlor_callbacks` textDAT has `syncfile=True`. **Edits to the .py file reflect in TD without TD restart or .toe save** — TD evaluates the callback fresh on each WS message. Verify a sync took by reading the textDAT's `.text` via MCP and greping for the new symbol.

### MCP-created nodes don't survive restart unless .toe is saved

When using the TouchDesigner MCP to create nodes (`body_positions`, `render_diff_*`, vec uniforms on glsl_spawn/force/velmod, etc.), they exist only in the running TD process. Always remind the user to save `td/demo.toe` after MCP-driven node work. Re-creation is automatable via MCP scripts but tedious.

### Outbound message types (Merlin → TD)

- `zone_update` - GLSL zone code injection (POP / TOP / MAT)
- `sprite_texture` - Load sprite PNG (TD ACKs with `sprite_loaded`)
- `flipbook_config` - Atlas grid + playback settings
- `tracking_frame` - MediaPipe pose/face data
- `request_screenshot` - Capture render as base64
- `request_metrics` - FPS / particle / coverage stats
- `reset_sprite` - Revert to default sprite

### Inbound (TD → Merlin)

- `td_ready` - Capabilities announcement
- `compile_result` - Per-zone compile success/failure
- `metrics` - FPS / particle_count / coverage
- `visibility` - visible_particles / culled_particles / avg_brightness / render_vs_webcam_diff (TD computes the diff via numpy: `mean(abs(out_final - syphonspoutin1)[rgb])`. Earlier compositeTOP "difference" attempt failed because that operand is a photoshop midgray-encoded blend, not abs-diff)
- `screenshot_result` - Captured render frame (PNG base64). Handler also emits a `visibility` message immediately before the screenshot so metrics arrive fresh.
- `sprite_loaded` - ACK after texture is on the GPU; resolves any pending `waitForSpriteLoad`

## Commands

```bash
npm run dev          # Start Electron dev server (predev kills any process on port 8001)
npm test             # Run Vitest tests
npm run dist         # Build distribution
```

`npm run dev` runs `predev` which executes `scripts/kill-stale-merlin.cjs` — reaps any process holding port 8001 (typically a previous TaskStop'd Electron instance with orphaned children) so the next launch starts clean.

## Testing Patterns

- Use `vi.hoisted()` for mock factories
- Use `vi.resetModules()` + dynamic imports for module-level state
- Mock `fs`, `electron.app`, `crypto` for asset tests
- Mock `../td-bridge` for push tests; mock `../td-bridge/metrics` separately when `waitForSpriteLoad` would otherwise hang
- For Gemini chat tests: mock `@google/genai` with a class exposing `chats: { create: () => ({ sendMessage }) }`. Mock `Type` enum (STRING/OBJECT/NUMBER/...) and `FunctionCallingConfigMode`.
