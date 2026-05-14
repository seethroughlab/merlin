# System architecture

A bird's-eye view of where things live and how they talk. For per-turn detail, see [`conversation-flow.md`](./conversation-flow.md). For TD internals, see [`../td/ARCHITECTURE.md`](../td/ARCHITECTURE.md).

## Process layout

```
┌────────────────────────────────────────────────────────────────────┐
│ Electron app                                                       │
│                                                                    │
│  ┌──────────────────┐         ┌────────────────────────────────┐   │
│  │  Renderer        │         │  Main                          │   │
│  │  (BrowserWindow) │         │                                │   │
│  │                  │         │  • Gemini chat + Imagen        │   │
│  │  • MediaPipe     │   IPC   │  • Merlin session orchestr.    │   │
│  │  • Whisper STT   │ ◀─────▶ │  • TD bridge (WS server)       │   │
│  │  • LiveTTS WS    │         │  • Asset manager (sprites)     │   │
│  │  • UI / sidebar  │         │  • Settings persistence        │   │
│  │  • Test panel    │         │  • Conversation-test HTTP      │   │
│  └────────┬─────────┘         └────────────────┬───────────────┘   │
│           │                                     │                  │
└───────────┼─────────────────────────────────────┼──────────────────┘
            │                                     │
       Spout "Merlin Mask"            WebSocket localhost:8001
       (body segmentation)                        │
            │                                     ▼
            ▼                            ┌─────────────────────┐
┌──────────────────────────────────────▶│  TouchDesigner      │
│  td/demo.toe                          │  (client)           │
│                                       │                     │
│  • ws_parlor → ws_callbacks.py        │                     │
│  • body_positions ← landmark_table    │                     │
│  • 5 POP zones + 1 TOP + billboard MAT│                     │
│  • render1 → glsl_postfx → out_final  │                     │
│  • Spout/Syphon out                   │                     │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       Display / projector
```

External services: **Gemini API** (chat, function calls, Imagen, TTS), **Anthropic API** (optional, Conversation Tester only).

## A user spell turn — full data flow

The most useful trace to internalize. This is what happens between "user speaks" and "particles change".

```
1. User speaks
   └─ renderer: Whisper STT → onTranscript → handleMerlinTranscript(text)
                                                 │
2. Magic-word check (LOCAL, no Gemini)           │
   ├─ MATCH → fire merlin-trigger-cast IPC ──┐   │
   │                                          ▼  │
   │                              main: session.triggerCast()
   │                                          │
   │                                          ▼
   │                              td-bridge: pushSpellCast(...)
   │                                          │
   │                                          ▼   (WS)
   │                              TD: cast envelope tween
   │                                          
   └─ NO MATCH → fall through to Gemini turn ─┐
                                              ▼
3. merlinProcessSpeech IPC → main
   └─ session.processUserSpeech(transcript, body, face)
        │
        ▼
4. Chat turn through Gemini (runMerlinTurn)
   ├─ initial response may carry text + tool calls
   │  └─ onSpeakChunk fires → renderer: stopContinuousListening + speakWithStreaming
   │
   ├─ Tool dispatch loop (dispatchToolCalls)
   │  ├─ generate_sprite       → Imagen ~25s → pushSpriteTexture → pushFlipbookConfig
   │  │                          → wait for sprite_loaded ACK
   │  ├─ set_zone_shader (×N)  → pushZoneUpdateWithValidation (validate → push → wait compile → rollback on fail)
   │  ├─ request_visual_feedback → requestScreenshot + getLatestVisibility
   │  │                            → return image + metrics to Gemini as a multimodal function response
   │  ├─ register_effect_triggers, prepare_casting, get_posture/expression
   │  │
   │  └─ Loop: send results back → Gemini may emit more tool calls or final text
   │
   └─ Final text accumulated
        │
        ▼
5. Response returned via IPC
   └─ renderer: speak the remainder (if any) → resume mic on completion
```

## Asset pipeline (sprite generation)

```
generate_sprite tool call
    │
    ▼
sprite-generator: buildSpritePrompt → Imagen via @google/genai
    │ (with withRetry: 3 attempts, exp backoff on 429/5xx)
    ▼
PNG bytes → validateSpriteImage (light-bg rejection, transparency check)
    │
    ▼
asset-manager.saveSprite → /tmp/merlin-assets/sprite_<id>.png + manifest
    │
    ▼
palette.extractPaletteFromFile → uSpriteColor1, uSpriteColor2 (vec3)
    │
    ▼
td-bridge.pushSpriteTexture (WS sprite_texture message, fire-and-forget)
td-bridge.pushFlipbookConfig (WS flipbook_config)
    │
    ▼ (back-channel)
TD: load PNG into movieFileIn → cook glsl_billboard sampler → send sprite_loaded ACK
    │
    ▼
metrics.waitForSpriteLoad(assetId, 8s) resolves
    │
    ▼
turn-runner attaches the sprite PNG as part #2 in the function response
(part #1 is a screenshot from request_visual_feedback) so Gemini can
A/B compare what Imagen made vs. what's rendering.
```

## Error paths

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Gemini 429 / 5xx / network | `withRetry` in `gemini-chat.ts` / `sprite-generator.ts` | Exponential backoff, 3 attempts. Final throw bubbles to session → user-visible error |
| GLSL compile failure | `_check_glsl_compile` in TD sends `compile_result {success: false}` | `pushZoneUpdateWithValidation` rolls back to previous good code or template default. `lastCompileSuccess=false` blocks subsequent `request_visual_feedback`. |
| Screenshot timeout | `requestScreenshot(send, 5000)` resolves null | Caller treats as "no data" — request_visual_feedback handler returns metrics-only response |
| Sprite-load timeout | `waitForSpriteLoad(id, 8000)` resolves `{success: false, timedOut: true}` | `generate_sprite` returns error → Gemini sees it and can retry with a different prompt |
| TD disconnect mid-turn | WS `close` event | `clearMetrics()` resolves all pending waits with disconnect failure. Tool handlers see the failures and continue or surface them. |
| Imagen safety block | Throws / returns no image | `_generateSpriteInternal` catches, returns `{success: false, error}` to caller |

## State ownership

- **Session phase, spell state, conversation history** → `MerlinSession` (`src/main/merlin/session.ts`) — single source of truth.
- **Per-zone compile state** → `ZoneStateManager` (`src/main/merlin/zone-state.ts`) — singleton.
- **Last-pushed sprite + flipbook config** → `td-state-mirror.ts` — read by `request_visual_feedback` to attach context.
- **TD metrics / visibility / latest screenshot** → `td-bridge/metrics.ts` — singleton, cleared on disconnect.
- **Persistent session history** → `state-persistence.ts` (disk, electron-store). Read by the Sessions tab.

## IPC, WS, and HTTP surfaces (where strings cross processes)

- **IPC**: `src/main/index.ts` registers every `ipcMain.handle('foo', ...)`. The renderer-side facade is `src/preload.ts`. The full event glossary lives in [`conversation-flow.md`](./conversation-flow.md#ipc--ws-event-glossary).
- **WS**: `src/main/td-bridge/protocol.ts` (inbound) + `src/main/td-bridge/push.ts` (outbound). Message types listed in `CLAUDE.md`.
- **HTTP**: `src/main/conversation-test-trigger.ts` listens on `localhost:8765` (configurable via `MERLIN_TEST_TRIGGER_PORT`). One endpoint: `POST /run-conversation`. External callers (curl, Claude) kick off Conversation Tester presets without the UI.

## Configuration map

| Lives in | What it controls |
|----------|------------------|
| `.env` | API keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`), `MERLIN_LOG_LEVEL`, `MERLIN_TEST_TRIGGER_PORT` |
| `src/main/config.ts` | Ports (8001 TD bridge, 8765 trigger), timeouts (screenshot 5s, sprite-load 8s, compile 5s), retry counts (3, 1s base, 10s cap) |
| `src/main/merlin/zone-registry.ts` | Per-zone validation contracts (modifies, vars, uniforms, banned keywords, max lines) |
| `src/main/merlin/prompts.ts` | All system prompts + Gemini tool function declarations |
| `td/scripts/ws_callbacks.py` | TD-side zone/uniform/sampler wiring and message dispatch |

## Where the magic actually happens

If you only have time to read four files, read these in this order:

1. `src/main/merlin/session.ts` — phase machine + lifecycle
2. `src/main/merlin/turn-runner.ts` — tool dispatch + screenshot eval
3. `src/main/merlin/prompts.ts` — the system prompt is **long**; the tool list is the contract surface
4. `td/scripts/ws_callbacks.py` — TD-side everything

Then `docs/conversation-flow.md` ties them together turn-by-turn.
