# System architecture

A bird's-eye view of where things live and how they talk. For per-turn detail, see [`conversation-flow.md`](./conversation-flow.md). For TD internals, see [`../td/ARCHITECTURE.md`](../td/ARCHITECTURE.md).

## Process layout

```mermaid
flowchart LR
    subgraph Electron["Electron app"]
        direction LR
        Renderer["<b>Renderer</b> (BrowserWindow)<br/>MediaPipe · Whisper STT<br/>LiveTTS · UI · Test panel"]
        Main["<b>Main</b><br/>Gemini chat + Imagen<br/>Merlin session orchestration<br/>TD bridge (WS server)<br/>Asset manager · Settings<br/>Conversation-test HTTP"]
        Renderer <-- IPC --> Main
    end
    Renderer -- Spout 'Merlin Mask'<br/>(body segmentation) --> TD
    Main -- WS localhost:8001 --> TD["<b>TouchDesigner</b> (client)<br/>td/demo.toe<br/>ws_merlin + ws_callbacks.py<br/>5 POPs + TOP + billboard MAT<br/>render1 → glsl_postfx → out_final"]
    TD --> Display["Display / projector"]
```

External services: **Gemini API** (chat, function calls, Imagen, TTS), **Anthropic API** (optional, Conversation Tester only).

## A user spell turn — full data flow

The most useful trace to internalize. This is what happens between "user speaks" and "particles change". Two paths fork at the magic-word check; the Gemini path is the common one.

```mermaid
sequenceDiagram
    actor U as User
    participant R as Renderer
    participant M as Main / Session
    participant G as Gemini
    participant T as TouchDesigner

    U->>R: speaks
    R->>R: Whisper STT → handleMerlinTranscript

    alt magic word matched (LOCAL, no Gemini)
        R->>M: merlin-trigger-cast IPC
        M->>T: pushSpellCast (WS)
        T-->>T: cast envelope tween
    else no match — full Gemini turn
        R->>M: merlinProcessSpeech IPC
        M->>G: chat.sendMessage(transcript + context)
        G-->>M: initial text + pending tool calls
        M-->>R: onSpeakChunk (parallel TTS starts)
        R->>R: stopContinuousListening
        loop tool dispatch (up to 5 rounds)
            Note over M: dispatchToolCalls<br/>generate_sprite · set_zone_shader<br/>request_visual_feedback · get_posture · ...
            M->>T: WS pushes (sprite_texture, zone_update, request_screenshot, ...)
            T-->>M: ACKs (sprite_loaded, compile_result, screenshot_result)
            M->>G: chat.sendToolResults (multimodal: image parts + metrics)
            G-->>M: more text or more tool calls
        end
        M-->>R: final response (text remainder)
        R->>U: TTS remainder, resume mic
    end
```

## Asset pipeline (sprite generation)

```mermaid
flowchart TD
    A["<b>generate_sprite</b> tool call"] --> B[sprite-generator.buildSpritePrompt]
    B --> C["Imagen via @google/genai<br/>(withRetry: 3× exp backoff on 429/5xx)"]
    C --> D["validateSpriteImage<br/>light-bg rejection · transparency check"]
    D --> E["asset-manager.saveSprite<br/>/tmp/merlin-assets/sprite_id.png + manifest"]
    E --> F["palette.extractPaletteFromFile<br/>→ uSpriteColor1, uSpriteColor2 (vec3)"]
    F --> G["pushSpriteTexture + pushFlipbookConfig<br/>fire-and-forget over WS"]
    G -. WS sprite_loaded ACK .-> H["TD: load PNG into movieFileIn<br/>cook glsl_billboard sampler"]
    H --> I["metrics.waitForSpriteLoad(8s)<br/>resolves"]
    I --> J["turn-runner attaches sprite PNG as part #2<br/>in function response (part #1 is screenshot)<br/>so Gemini A/Bs Imagen output vs. render"]
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
| `src/main/merlin/system-prompts.ts` | Static prompt text (persona, tone rules, GLSL guidance, the two cached system prompts) |
| `src/main/merlin/session-context.ts` | Per-turn runtime context, phase framing, `ALLOWED_TOOLS_PER_PHASE` |
| `src/main/merlin/tool-definitions.ts` | Gemini tool `FunctionDeclaration` schemas + tool arrays (`MERLIN_TOOLS`, `MERLIN_VISUAL_AUTHOR_TOOLS`) |
| `td/scripts/ws_callbacks.py` | TD-side zone/uniform/sampler wiring and message dispatch |

## Where the magic actually happens

If you only have time to read four files, read these in this order:

1. `src/main/merlin/session.ts` — phase machine + lifecycle
2. `src/main/merlin/turn-runner.ts` — tool dispatch + screenshot eval
3. `src/main/merlin/system-prompts.ts` (long, the persona/tone/GLSL contract) + `src/main/merlin/tool-definitions.ts` (the tool contract surface). `session-context.ts` is the per-turn glue if you need it.
4. `td/scripts/ws_callbacks.py` — TD-side everything

Then `docs/conversation-flow.md` ties them together turn-by-turn.
