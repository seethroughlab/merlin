# Handoff — Where to start

You're inheriting Merlin Mirror. This document is the single entrypoint: read it, then the rest of the docs make sense in context.

## Recommended reading order

1. **[`README.md`](../README.md)** — 30-second pitch + quick start. Skim.
2. **[`SETUP.md`](../SETUP.md)** — get a local dev environment running. Follow it end-to-end on a clean checkout; don't skip the troubleshooting section.
3. **This file** — your map of the project.
4. **[`docs/architecture.md`](./architecture.md)** — system block diagram, request/response cycle, error paths.
5. **[`docs/conversation-flow.md`](./conversation-flow.md)** — per-turn execution, phase machine, IPC/WS event glossary. **Critical reference**: come back to it whenever you touch session, runtime, or the mic.
6. **[`docs/PRD.md`](./PRD.md)** — design intent. Tells you why the experience is shaped the way it is.
7. **[`CLAUDE.md`](../CLAUDE.md)** — module-by-module architecture reference. Written for Claude Code originally, but accurate and useful for humans.
8. **[`td/ARCHITECTURE.md`](../td/ARCHITECTURE.md)** — TouchDesigner-side: COMP layout, GLSL zones, body tracking, MCP-and-save trap.

## "Where do I look?" file map

| Task | Start here |
|------|------------|
| Add or change a Gemini tool | `src/main/merlin/prompts.ts` (registry + system prompt), then `src/main/merlin/turn-runner.ts` (dispatch + tool handlers) |
| Session lifecycle, phase machine | `src/main/merlin/session.ts`, then `docs/conversation-flow.md` |
| Touch the conversation flow (mic, TTS, IPC) | `src/renderer/main.ts` (`handleMerlinTranscript`, chunk handler), then `docs/conversation-flow.md` |
| Push something new to TD | `src/main/td-bridge/push.ts`, register the message type in `td/scripts/ws_callbacks.py`, document in `CLAUDE.md` |
| Receive something from TD | `src/main/td-bridge/protocol.ts` (route) + `src/main/td-bridge/metrics.ts` (state) |
| Sprite generation | `src/main/merlin/sprite-generator.ts` |
| GLSL zone behavior | `shaders/*.glsl` (templates), `src/main/merlin/zone-registry.ts` (contracts), `src/main/merlin/glsl-validator.ts` (server-side compile check) |
| TouchDesigner-side any work | `td/ARCHITECTURE.md`, `td/scripts/ws_callbacks.py`. Save `td/demo.toe` after MCP work. |
| Test panel (Shift+T) | `src/main/merlin/test-{shader,sprite,flipbook,live-spell}.ts` |

## Workflow notes

- **Tests**: `npm test` runs Vitest (414+ tests, ~1s). All highest-risk modules have coverage; `src/main/merlin/test-shader.test.ts` is the most representative example of the project's mocking style (`@google/genai` chat-class mock, hoisted vi.fn refs, td-bridge stubs).
- **Lint**: `npm run lint`. Zero errors at handoff; 46 warnings (mostly unused vars in older renderer code and `any` in native bindings) — fix as you touch.
- **Type check**: `npx tsc --noEmit`. Strict mode is on; the codebase is clean.
- **Logger**: new code should import from `src/main/logger.ts` (`log.info('Module', ...)`). Older modules still use `console.*` — migrate incrementally when you touch a file.
- **Config**: ports / timeouts / retry counts live in `src/main/config.ts`. Add new magic numbers there before sprinkling them.
- **Retry**: external API calls (Gemini, Imagen) go through `withRetry()` from `src/main/retry.ts` (3 attempts, 1s/2s/4s, retries 429/5xx/network only).

## Known gaps and open work

The short table below is a snapshot. The canonical priorities list — what to actually work on next, ranked — lives at [`roadmap.md`](./roadmap.md), and the full specs live under [`specs/`](./specs/).

| Item | Status | Where |
|------|--------|-------|
| Listening-stuck-closed bug | **Fixed.** Documented for context in `docs/conversation-flow.md`. |
| Logger migration | **Done.** All console.* sites in `src/main/td-bridge/` and `src/main/merlin/` (~136 sites, 18 files) use `log.info/warn/error` from `src/main/logger.ts`. Two intentional exceptions in `turn-runner.ts` for the per-turn `[Gemini source turnId]` observability stream. |
| ESLint warnings | 46 warnings, 0 errors. Unused-var cleanup in `src/renderer/main.ts` and `any` casts in `src/main/spout.ts` are the main ones. |
| `background_environment` zone | **P1 / ready to ship.** Spec in [`docs/specs/background-environment.md`](./specs/background-environment.md). Estimated 4–6 hours TD setup + Electron integration. |
| Session replay / persistence UI | **P2.** Persistence API exists (`src/main/merlin/state-persistence.ts`); renderer UI not built. |
| Mesh-mode rendering | **P3 / blocked.** Merlin-side infrastructure ready; TD-side geometry/MAT nodes deferred. See [`docs/specs/mesh-mode.md`](./specs/mesh-mode.md). |
| Body-occlusion masking | **Shipped.** See `td/ARCHITECTURE.md` § "Render chain" and the `sMaskInput` sampler. |

## Things that will bite you

1. **MCP-created TD nodes vanish after restart unless you save `td/demo.toe`.** TD doesn't auto-save. `ws_callbacks.py` self-heals expression bindings, but it can't recreate nodes themselves. Save the .toe within the minute any time you use the MCP server to add a node.

2. **Port 8001 holdover.** If a previous Electron instance crashed without releasing the port, `npm run dev`'s `predev` script reaps it. If `predev` is bypassed, you'll see `EADDRINUSE` and the bridge soft-fails (app keeps running without TD).

3. **Sprite-load race.** `pushSpriteTexture` is fire-and-forget. Always pair it with `waitForSpriteLoad(assetId, 8000)` before taking a screenshot or reading the texture, or you'll capture the previous spell's sprite. The `request_visual_feedback` handler enforces this.

4. **The chunk-TTS path stops the mic.** When Gemini's first reply carries text + tool calls, the renderer's `onMerlinSpeakChunk` listener calls `stopContinuousListening()` immediately to avoid TTS feedback. The post-turn handler at `src/renderer/main.ts:3335–3373` is responsible for restarting the mic; all three branches do, but if you refactor the handler, **don't drop the resume call** or the session "stops after one reaction." See `docs/conversation-flow.md` § "Listening stuck closed after turn 1".

5. **`vis` on MediaPipe Pose is effectively binary for face/torso landmarks.** Don't try to use eye visibility as a meaningful signal. Hand visibility genuinely fluctuates and is OK. The prompt warns Gemini about this; don't pull it out.

6. **Per-call tool gating is enforced at two layers**: the Gemini per-call config (`buildPerCallConfig` in `gemini-chat.ts`) and a runtime gate in `turn-runner.ts`. The API layer is more efficient (no wasted round-trip on disallowed calls); the runtime layer is the safety net. Keep both.

## Testing manually

Open the **test panel** with **Shift+T**:
- **Shaders tab**: ask Gemini to fill 1–8 zones with given themes. Each push goes through the full validate → compile → rollback flow.
- **Sprites tab**: direct prompt or Gemini interpretation → Imagen → flipbook composition.
- **Flipbook tab**: reconfigure playback (frames, drive source) on a loaded sprite.
- **Live Spell tab**: highest-scope test. Type a spell description → Gemini drives sprite gen + zone shaders + screenshot evaluation end-to-end. This is the closest thing to a real session without TTS / mic.
- **Conversation tab**: scripted multi-turn participant for testing the full session flow without speaking. Optionally Claude-driven (needs `ANTHROPIC_API_KEY`).

Live session: **Shift+M** starts the real flow with mic, TTS, and phase machine. Speak naturally; speak the magic word to cast; speak the end-word (default "farewell") to end.

## When you're stuck

Follow the data:
- A spell doesn't render → `session.ts` (state) → `turn-runner.ts` (dispatch) → `prompts.ts` (Gemini context) → `td-bridge/push.ts` (wire) → `td/scripts/ws_callbacks.py` (TD side).
- A shader doesn't compile → check TD's textport, then `glsl-validator.ts` (server-side check), then `_check_glsl_compile` in `ws_callbacks.py`.
- A screenshot is wrong → look at `td-bridge/metrics.ts:requestScreenshot` and the `screenshot_result` handler in `protocol.ts`.
- The mic stops working → `docs/conversation-flow.md` § "Listening lifecycle" + the three branches in `handleMerlinTranscript`.

If it's truly weird, `MERLIN_LOG_LEVEL=debug npm run dev` turns on the extra verbosity.
