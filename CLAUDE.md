# Merlin Mirror

Interactive AR experience combining Electron, MediaPipe tracking, and TouchDesigner visuals.

## Architecture

- **Electron App** (`src/main/`, `src/renderer/`): Camera capture, AI chat, spell recognition
- **TouchDesigner** (`td/demo.toe`): Real-time particle systems, shaders, compositing
- **Bridge**: WebSocket on port 9980 for Electron↔TD communication

## Key Modules

### src/main/merlin/
- `session.ts` - Live Merlin session orchestration (chat, tool calls, spell flow)
- `spell-state.ts` - Spell detection state machine
- `particle-program.ts` - Default `ParticleSpellProgram` builders for buildup / release / idle
- `prompts.ts` - Gemini system prompts and tool declarations (incl. `GENERATE_SPRITE_TOOL`, `GENERATE_SPELL_PROGRAM_TOOL`)
- `gemini-chat.ts` - Live session's chat wrapper
- `asset-manager.ts` - Sprite/flipbook asset storage
- `sprite-generator.ts` - Gemini Imagen sprite generation
- `glsl-validator.ts` - GLSL zone code validation
- `zone-registry.ts` - Zone contracts (`ZONE_CONTRACTS`, `ZONE_NAMES`)
- `zone-state.ts` - Zone compilation state + rollback
- `shader-templates.ts` - Loads `shaders/*.glsl` from disk for prompt context

#### Test Mode (Shift+T)
- `test-shader.ts` - Shaders tab: Gemini fills 1–8 zones with retry on compile failure
- `test-sprite.ts` - Sprites tab: Direct spec or Gemini interpretation → Imagen → push
- `test-flipbook.ts` - Flipbook tab: re-configure flipbook playback on the loaded texture
- `test-spell-program.ts` - Spell Program tab: free-text → `set_spell_program` → push
- `test-shader-presets.ts` - Named scenarios for the Shaders preset dropdown (in `src/shared/`)
- `td-state-mirror.ts` - Last-pushed snapshot of flipbook config (read by Flipbook tab)
- `gemini-events.ts` - Publisher: emits `GeminiTurn` events on `gemini-conversation` IPC channel; truncates long string fields to keep IPC payloads small
- `gemini-chat-helper.ts` - Shared `startSingleToolChat(toolDef, opts)` used by all three Gemini-test modules

### src/main/td-bridge/
- `connection.ts` - WebSocket client to TD
- `push.ts` - Outbound messages to TD; `pushZoneUpdateWithValidation` runs the validate → push → wait-for-compile → rollback flow
- `protocol.ts` - Inbound message dispatch
- `metrics.ts` - FPS / particle / coverage metrics

### shaders/
- `pop_force.glsl`, `pop_color.glsl`, `pop_size.glsl`, `pop_spawn.glsl`, `pop_velmod.glsl` - POP zone templates
- `top_postfx.glsl` - Post-FX TOP template
- `mat_billboard_pixel.glsl`, `mat_billboard_vertex.glsl` - Billboard material templates
- All templates have a `// {zone_code}` injection point where Gemini's snippet is merged

> Particle rendering is **billboard/flipbook only** for now. Mesh-mode rendering (a `particle_mat` glslMAT + `material_pixel` zone) was scoped out and pruned; see `docs/mesh-mode-pipeline.md` for the future-work notes if we ever bring it back.

## Test Mode

`Shift+T` opens a four-tab developer panel:

| Tab | Purpose |
|---|---|
| Shaders | Gemini generates GLSL for a chosen subset of zones; auto-retries up to 2× on compile failure |
| Sprites | Direct spec or Gemini-interpretation → Gemini Imagen → `pushSpriteTexture` / `pushFlipbookConfig` |
| Flipbook | Re-configure flipbook playback (frameDuration / playbackMode / driveSource) without regenerating the texture |
| Spell Program | Gemini fills a `ParticleSpellProgram` and pushes via `pushParticleSpellProgram` |

Opening the panel auto-activates the Merlin sidebar so every Gemini turn (live session AND test mode) shows up as a card with: source badge, collapsible system prompt, user prompt, response text, tool calls, push results, retry markers. All flows route through `gemini-events.ts` so the sidebar is a single conversation transcript.

When a shader fails to compile, the test panel and live session both feed the error back to Gemini via the same chat session and ask for a corrected version. Up to 2 retries (3 attempts total). Retry-prompt phrasing is borrowed from the vibe-agent reference. The compile-detection itself reads TD's `_info` DAT (the `.errors()` method on a glslTOP can return empty when only the pixel shader failed — see `td/scripts/ws_callbacks.py:_check_glsl_compile`).

## Commands

```bash
npm run dev          # Start Electron dev server
npm test             # Run Vitest tests
npm run dist         # Build distribution
```

## Testing Patterns

- Use `vi.hoisted()` for mock factories
- Use `vi.resetModules()` + dynamic imports for module-level state
- Mock `fs`, `electron.app`, `crypto` for asset tests
- Mock `../td-bridge` for push tests
- For Gemini chat tests: mock `@google/generative-ai` with a class that exposes `getGenerativeModel` returning `{ startChat: () => ({ sendMessage }) }`

## TouchDesigner Integration

TD connects via WebSocket. Outbound message types (Merlin → TD):

- `zone_update` - GLSL zone code injection (POP / TOP / MAT)
- `sprite_texture` - Load sprite PNG
- `flipbook_config` - Atlas grid + playback settings
- `particle_spell_program` - Full spell-program payload
- `tracking_frame` - MediaPipe pose/face data
- `mood_update`, `scene_params`, `reveal_effect`, etc.

Inbound (TD → Merlin):

- `td_ready` - Capabilities announcement
- `compile_result` - Per-zone compile success/failure
- `metrics` / `visibility` - Render stats
- `screenshot_result` - Captured render frame
