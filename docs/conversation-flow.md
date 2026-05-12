# Merlin Conversation Flow

End-to-end map of how a Merlin session works: state held, where turns
begin and end, when tool calls happen, when the microphone is open or
closed, and which IPC events thread the whole thing together.

This document covers the *live participant-facing* flow (Shift+M to
start). The Live Spell test panel and other dev surfaces use the same
`runMerlinTurn` core but with simpler wrappers.

---

## Players

Three processes / contexts cooperate:

| Player | Role | Lives in |
|---|---|---|
| **Renderer** | Whisper STT, MediaPipe trackers, FaceLandmarker, LiveTTS playback, UI | `src/renderer/main.ts`, browser/Electron renderer process |
| **Main** | Gemini chat session, tool dispatcher, TD WebSocket bridge | `src/main/`, Electron main process |
| **TouchDesigner** | Particle rendering, shader compile, sprite display | external (WS port 8001) |

IPC goes Main ⇄ Renderer; WS goes Main ⇄ TD.

---

## State

### Session-level (lives in `MerlinSession`, `src/main/merlin/session.ts`)

| Field | Meaning |
|---|---|
| `state.phase` | One of: `idle`, `wake`, `intro`, `discovery`, `formation`, `ready_to_cast`, `casting`, `play`, `outro`. Phase machine determines tool allow-lists and Gemini's per-turn instructions. |
| `state.turnCount` | Increments each time `processUserSpeech` is called. **Drives phase transitions** via `updatePhase()`. |
| `state.spell` | Accumulating spell profile: `intent`, `element`, `castingOrigin`, `tone`, `magicWord`, `confidence`. Mutated by Gemini's `set_spell_profile` tool calls. |
| `state.castReady` | Set true when Gemini calls `prepare_casting` with a magic word. Allows phase to move to `ready_to_cast`. |
| `state.castCompleted` | Set true when `triggerCast()` fires (magic word matched). Once true, the participant can keep re-casting visually but the conversational layer is done. |
| `state.lastPosture`, `state.lastExpression` | Cached body-language + face-expression analysis from `get_posture` / `get_expression` tools. |
| `conversationHistory` | Local copy of all turns (role + content) — informs Gemini context display, not the model's memory (Gemini chat keeps its own history). |
| `endWord` (private) | Word the participant says to end the play phase. Defaults to `'farewell'`. |
| `playSafetyTimer` (private) | 60-second timer that auto-advances `play` → `outro` if the participant never speaks the end-word. |
| `effectTriggers` (private) | Words Gemini registered via `register_effect_triggers` — matched locally to fire instant zone updates with no Gemini round-trip. |

The Gemini SDK chat object (`this.chat`) keeps its own conversation
history server-side — the same multi-turn `Chat` instance is reused
across every user-speech turn so Gemini can reference what was said
earlier.

### Per-turn (lives in `runMerlinTurn`, `src/main/merlin/turn-runner.ts`)

| Var | Meaning |
|---|---|
| `accumulatedText` | Gemini's response text so far this turn. Starts with the initial response; **only appended to from subsequent sub-turns when no chunk fired**. |
| `streamedText` | Text already sent to TTS via the chunk path. Used to compute the un-streamed remainder. |
| `chunkAlreadyResponded` | Bool. If true (chunk path fired text + tools), post-tool text emissions are DROPPED from accumulation — see "One response per user-speech turn" below. |
| `rounds` | Counts dispatch loop iterations. Capped at `MAX_DISPATCH_ROUNDS = 5` so a Gemini retry storm can't run indefinitely. |

### Renderer-level (lives in `src/renderer/main.ts`)

| Var | Meaning |
|---|---|
| `merlinModeActive` | `true` while a session is running. Listening + IPC handlers gate on this. |
| `isProcessingMerlinTranscript` | Lock to prevent concurrent processing if the user speaks again while a turn is in flight. |
| `inFlightSpeechPromise` | Promise for the in-flight chunk-path TTS. The post-turn spokenText path awaits this before its own `speakWithStreaming` to avoid two parallel TTS requests interleaving at the LiveTTS server. |
| `armedMagicWord`, `armedEndWord` | Set when main pushes `merlin-cast-armed` (after `prepare_casting`). The transcript callback matches these locally and fires the cast / end via direct IPC, bypassing Gemini. |
| Face HUD state (`faceHudActive`, `faceHudRecent`) | UI for the live face-gesture pills + recent-events feed. |

---

## Phase machine

Default phase config (`DEFAULT_PHASE_CONFIG`, `session.ts`):

```ts
introTurns: 0,         // intro is the session-start narration, not a user-speech turn
discoveryTurns: 3,     // user-speech turns 1–3
formationTurns: 1,     // user-speech turn 4
castingTurns: 1,       // moment of cast (not a turn count in the same sense)
outroTurns: 1,         // closing
```

`updatePhase()` runs at the top of `processUserSpeech` after `turnCount++`. It computes the new phase from `turnCount` + `castReady` + `castCompleted`:

| Conditions | Phase |
|---|---|
| `turnCount ≤ 0` (never true after the increment) | `intro` (legacy fallthrough — `introTurns=0` means we never hit this) |
| `1 ≤ turnCount ≤ 3` | `discovery` |
| `turnCount == 4` | `formation` |
| `castReady && !castCompleted` | `ready_to_cast` |
| `castCompleted` | `outro` (via `markCastCompleted` → `'play'`, then `closePlay` → `'outro'`) |
| else | stays in `formation` until cast |

Once `markCastCompleted()` fires:
- `state.phase` jumps to `'play'` (not `outro` directly)
- `playSafetyTimer` starts (60s)
- `closePlay('end-word' | 'timeout')` advances to `outro` and runs the closing Gemini turn

The intro narration (Merlin's opening line) is fired by `startSession` *before* any user-speech turn — it does NOT increment `turnCount`. The first user reply lands in `discovery`.

---

## When tools run

Tools are allowed per phase via `ALLOWED_TOOLS_PER_PHASE` in `prompts.ts`. The dispatcher in `turn-runner.ts` (`dispatchToolCalls`) silently drops any call whose name isn't in the current phase's set, replying with a synthetic error so Gemini learns the constraint:

| Phase | Allowed tools |
|---|---|
| `idle` | none |
| `wake` | `get_posture`, `get_expression`, `get_face_events` |
| `intro` | `get_posture`, `get_expression`, `get_face_events`, `set_spell_profile` |
| `discovery` | all visual + perception tools (no `prepare_casting`) |
| `formation` | adds `prepare_casting` |
| `ready_to_cast` | perception only |
| `casting` / `play` / `outro` | none |

Within a single user-speech turn, tools fire inside `runMerlinTurn`'s dispatch loop:

```
chat.sendMessage(initialMessage)        — Gemini's first response (text + maybe tool calls)
  ↓
[chunk path]                            — if text + pending tools, fire onSpeakChunk
  ↓
while (toolCalls.length && rounds < 5)  — capped retry
  dispatchToolCalls()                   — phase-gated; runs each tool side-effect
  chat.sendToolResults()                — server may return more text + more tools
  emit each sub-turn to LIVE card
  rounds++
```

A "tool call" is one of:
- **Pure-info** (`get_posture`, `get_expression`, `get_face_events`) — returns cached data or fires a renderer-side analysis IPC.
- **State mutator** (`set_spell_profile`, `prepare_casting`, `set_cast_params`, `set_particle_params`) — updates session state and/or pushes to TD via WS.
- **Heavy** (`generate_sprite`, `request_visual_feedback`) — 5-30 s of Imagen / multi-frame screenshot capture.
- **Background-trigger registration** (`register_effect_triggers`) — stores words in `session.effectTriggers` for renderer-side local matching.
- **Shader** (`set_zone_shader`) — pushes GLSL to TD with validate + compile + rollback.

---

## One response per user-speech turn

The cardinal rule. Implemented by the `chunkAlreadyResponded` flag in `runMerlinTurn`:

- If the **initial** response had text + tool calls → the chunk path streams the initial text to TTS, and any text Gemini emits AFTER the tool dispatch loop is **dropped from `accumulatedText`** (logged + visible in the LIVE card under `gemini-response-post-tool-dropped` but not spoken).
- If the initial response had **tools only**, a pre-canned filler (`pickAckFiller`, e.g. *"Hold a moment — I'm reading what you've given me."*) is sent via the chunk path so the participant hears something within ~200 ms, AND post-tool text IS accumulated (the filler isn't a real response, so the post-tool text becomes the spoken response).

This prevents "ack + next question + meta-commentary" from being mashed into one 30-second TTS playback. Net result: **1 user utterance = 1 Merlin spoken response**.

---

## Listening lifecycle

The microphone (Whisper continuous-listening with VAD) is governed by `startContinuousListening` / `stopContinuousListening` in `src/renderer/whisper/index.ts`. State transitions:

| When | What happens |
|---|---|
| `startMerlinMode()` | Intro fires (`merlinStart` IPC → session.startSession). Intro is spoken via TTS. After TTS finishes, `startContinuousListening(handleMerlinTranscript)` opens the mic. |
| User speaks → Whisper detects silence → onTranscript fires → `handleMerlinTranscript(text)` runs | First it checks `armedMagicWord` / `armedEndWord` for instant local matches (cast / play-end). Otherwise calls `merlinProcessSpeech` IPC. |
| Chunk path fires (initial Gemini text + tools) | Renderer's `onMerlinSpeakChunk` handler calls `stopContinuousListening()` then `speakWithStreaming(text)`. Mic closed. |
| `merlinProcessSpeech` returns | Renderer awaits any in-flight chunk TTS. If `response.spokenText` is non-empty (rare with one-response-per-turn), speak it too. |
| Speech finishes | `startContinuousListening(handleMerlinTranscript)` re-opens the mic. |
| Magic word match | Renderer fires `merlin-trigger-cast` IPC → main's `session.triggerCast()` runs directly. Cast envelope sent to TD. **No Gemini round-trip.** |
| End-word match (during `play`) | Renderer fires `merlin-trigger-end` IPC → `session.closePlay('end-word')`. Outro Gemini turn runs. |
| `stopMerlinMode()` | `stopContinuousListening()`, clears callbacks, fires `merlin-end` IPC, resets face HUD + armed words. |

### Bug we've seen: listening stuck closed after turn 1

The chunk path closes the mic with `stopContinuousListening()`. After the chunk's TTS finishes and `merlinProcessSpeech` returns, `handleMerlinTranscript`'s post-turn block has THREE branches:

```ts
if (ttsReady && response.spokenText) {
  // (A) spokenText non-empty: speak it, then resume listening
  await speakWithStreaming(response.spokenText, 'wizard');
  if (merlinModeActive) await startContinuousListening(handleMerlinTranscript);
} else if (inFlightSpeechPromise) {
  // (B) chunk in flight, no remainder: await the chunk
  await inFlightSpeechPromise;
  inFlightSpeechPromise = null;
  // ❌ Does NOT resume listening — but the chunk path stopped it!
} else {
  // (C) nothing happening: log only
  // ✓ Listening was never stopped
}
```

Branch (B) is the **common path** under the one-response-per-turn rule (chunk fires, spokenText is empty since everything streamed). The mic was stopped by the chunk handler but never restarted. The participant can speak but nothing reaches Whisper. This is the "stopped after 1 reaction" symptom.

**Fix**: branch (B) must call `startContinuousListening(handleMerlinTranscript)` after the await.

---

## IPC + WS event glossary

### Renderer → Main (via preload)

| IPC | Purpose |
|---|---|
| `merlin-start` | Begin a session. Returns the intro response. |
| `merlin-process-speech` | Send a transcript for processing. Returns `{ text, phase, spell, spokenText }`. |
| `merlin-end` | Tear down the session. |
| `merlin-trigger-cast` | Fired by renderer's background magic-word matcher. Calls `session.triggerCast()` directly. |
| `merlin-trigger-end` | Fired by renderer's end-word matcher during play phase. Calls `session.closePlay('end-word')`. |
| `tracking-frame` | Pose + face landmark data, ~30 fps. |
| `face-gesture` | Single edge-triggered face event (smile start, mouth open end, etc.) — pushed into the face-event ring buffer. |

### Main → Renderer

| IPC | Purpose |
|---|---|
| `merlin-update` | Broadcast session state changes (phase, spell, etc.) for UI sync. |
| `merlin-auto-end` | Session naturally completed (turnCount ≥ totalTurns); renderer tears down. |
| `merlin-speak-chunk` | Parallel-TTS: forward Gemini's initial text to the renderer's TTS while tools run. |
| `merlin-cast-armed` | When `prepare_casting` dispatches, push magic word + end word so the renderer arms its local matcher. |
| `gemini-conversation` | Per-turn LIVE-card events: system prompt, user prompt, response text, tool calls, push results, face activity, kind label. |

### Main ↔ TD WebSocket (port 8001)

Outbound (main → TD): `zone_update`, `sprite_texture`, `flipbook_config`, `sprite_colors`, `spell_cast`, `cast_params`, `particle_params`, `merlin_state`, `tracking_frame`, `request_screenshot`, `reset_sprite`.

Inbound (TD → main): `td_ready`, `compile_result`, `metrics`, `visibility`, `screenshot_result`, `sprite_loaded`.

---

## Turn-by-turn walkthrough (typical session)

| # | Trigger | Phase before | Phase after | What happens |
|---|---|---|---|---|
| — | Click Start | — | `intro` | `merlinStart` IPC. Intro Gemini turn runs (captures webcam frame, fires `chat.startChatWithImage`). Intro is spoken via TTS. Continuous listening starts AFTER TTS. |
| 1 | User: *"I just finished my PhD"* | `intro` | `discovery` | `processUserSpeech` increments turnCount → 1, updatePhase → discovery. Gemini emits initial response + tool calls. Chunk path streams text. Tools dispatch (set_spell_profile, set_zone_shader, generate_sprite if visual change). Post-tool text dropped. |
| 2 | User: *"It was 6 years of stress"* | `discovery` | `discovery` | Same shape — chunk + tools + drop. |
| 3 | User: *"…"* | `discovery` | `discovery` | Same shape. |
| 4 | User: *"…"* | `discovery` | `formation` | turnCount = 4 → formation. Gemini calls `prepare_casting` with a magic word. State: `castReady = true`. `onCastArmed` fires → renderer arms its background matcher. |
| 5 | User stays silent (or speaks softly) | `formation` | `ready_to_cast` | Phase advances because `castReady && !castCompleted`. Tools restricted to perception only. |
| — | User speaks the magic word | `ready_to_cast` | `play` | Renderer's local matcher fires `merlin-trigger-cast` BEFORE merlinProcessSpeech. `triggerCast()` → cast envelope pushed to TD, `markCastCompleted()` runs, phase=`play`, 60s safety timer starts. |
| — | User speaks the end word (or 60s elapse) | `play` | `outro` | `closePlay('end-word')` runs. Gemini outro turn produces farewell. TTS plays it. Session ends. |

---

## Critical files

| File | Role |
|---|---|
| `src/main/merlin/session.ts` | `MerlinSession`, phase machine, processUserSpeech orchestrator. |
| `src/main/merlin/turn-runner.ts` | `runMerlinTurn`, `dispatchToolCalls`, chunk path, post-tool drop, retry cap. |
| `src/main/merlin/prompts.ts` | Persona, tone constraints, phase rules, tool definitions, ALLOWED_TOOLS_PER_PHASE. |
| `src/renderer/main.ts` | `handleMerlinTranscript`, listening lifecycle, chunk listener, IPC wiring, face HUD. |
| `src/renderer/whisper/index.ts` | Continuous listening + VAD. |
| `src/renderer/tts/index.ts` | LiveTTS playback (chunk + remainder, WebAudio scheduling). |
| `src/main/index.ts` | Main-side IPC handlers, MerlinSessionConfig wiring, WS bridge. |
| `src/preload/index.ts` | Renderer ↔ Main bridge. |
| `src/main/td-bridge/push.ts` | WS messages to TD (zone_update, spell_cast, etc.) with rollback. |
