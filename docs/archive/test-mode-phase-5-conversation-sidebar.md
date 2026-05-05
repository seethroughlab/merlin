# Test Mode — Phase 5: Unified Gemini Conversation Sidebar + Retry on Invalid Shaders

## Context

Phases 1–4 added four Test Mode tabs (Shaders / Sprites / Render Mode / Spell Program), but the Merlin sidebar saw none of that activity. The live Merlin session pushed only minimal updates to the sidebar (`MerlinUIUpdate.lastMessage` was even *defined but never populated*); test mode was completely decoupled. Tool calls were invisible everywhere.

Separately, when Gemini produced GLSL that failed to compile in TouchDesigner, the only recourse was to wait for the next live conversation turn — the test panel's Shaders tab marked the zone errored and moved on without trying to fix it.

Phase 5 ties both threads together:

1. **Unified conversation log in the sidebar.** All four test surfaces and the live session emit progressive `GeminiTurn` events through one publisher. The Merlin sidebar (`#merlin-conversation`) renders rich cards: source badge, expandable system prompt, user prompt, response text, tool calls (name + args summary), per-zone push results (✓/✗), retry markers (`↻ retry N/2`).

2. **Retry on invalid GLSL.** When a shader fails to compile, the test path and live session both feed the error back to Gemini via the same chat session and ask for a corrected version. **2 retries (3 attempts total)**.

3. **TD-side compile-detection bug fix (prerequisite).** `glsl_op.errors()` returns empty on TOPs/MATs when only the pixel shader fails to compile. The authoritative error lives in a sibling `_info` DAT. Without this fix, the retry path would never know a shader had failed.

## What shipped

**Files added:**
- `src/main/merlin/gemini-events.ts` — publisher: `setMainWindow`, `nextTurnId`, `emitGeminiTurn`. Sends a `gemini-conversation` IPC channel event for each progressive emission. Recursively truncates string fields >500 chars in tool-call args so multi-KB GLSL doesn't bloat the IPC payload.
- `src/main/merlin/gemini-chat-helper.ts` — `startSingleToolChat(toolDef, opts)` returns a `{chat, send}` handle. Centralizes the `model.startChat({systemInstruction, tools, toolConfig})` boilerplate that all three test-mode Gemini callers had open-coded.
- `src/main/merlin/gemini-events.test.ts` — covers payload shape, destroyed-window guard, recursive truncation, error swallowing, multi-emit per turn.

**Files modified:**
- `src/shared/types.ts` — `GeminiTurnSource`, `GeminiToolCall`, `GeminiPushResult`, `GeminiRetryMarker`, `GeminiTurn`. Progressive event shape: same `id` across emissions; renderer merges them into one card.
- `src/main/merlin/test-shader.ts` — chat-based with per-zone retry loop (up to `MAX_RETRIES = 2`). Retry prompt phrasing borrowed from `vibe-agent/server/gemini_session.py:338-357` (with line-cap guidance added because our validator enforces `ZONE_CONTRACTS[zone].maxLines`).
- `src/main/merlin/test-sprite.ts`, `test-spell-program.ts` — migrated to `startSingleToolChat`; emit progressive events. No retry path (Imagen and program-push errors aren't iterative compile-error surfaces).
- `src/main/merlin/session.ts` — emits a `live` turn per `processUserSpeech`. Tracks per-zone attempt count within a turn so retries are visible in the sidebar; rewrites the failed `set_zone_shader` tool response with the same vibe-agent retry phrasing so live Gemini gets equally good guidance.
- `src/renderer/main.ts` — `appendGeminiTurn(turn)` builds rich cards. `showTestShaderPanel()` auto-activates the Merlin sidebar so test-mode activity is visible. Cleanup on close: sidebar reverts to regular sections unless a live session is running.
- `index.html` — CSS for `.gemini-turn` cards (per-source colored badges), collapsible `<details>` system prompts, tool-call rows, push-result rows (✓/✗), retry markers.
- `td/scripts/ws_callbacks.py` — `_check_glsl_compile` reads the `_info` DAT first for "ERROR:" lines (most specific), falls back to `.errors()`, then `warnings()`. Used by `handle_zone_update`, `handle_top_zone_update`, `handle_mat_zone_update`.

## How it works

**Sidebar trigger.** Pressing `Shift+T` opens the test panel and auto-activates the Merlin sidebar (`sidebar.classList.add('merlin-active')`). Closing the test panel restores the sidebar unless a live Merlin session is running.

**Conversation card.** A turn card looks like:

```
┌─[ Shaders ]──────────────────────────┐
│ ▶ system prompt (8,231 chars)        │  (click to expand)
│                                       │
│ You: Generate shaders for             │
│      "confidence" "fire" at 0.7…      │
│                                       │
│ Gemini:                               │
│   ⊳ set_zone_shader(force_field, …)   │
│   ⊳ set_zone_shader(color_over_life)  │
│   ⊳ … 9 calls                         │
│                                       │
│ TD: ✓ velocity_modifier               │
│ TD: ✗ force_field — undeclared 'foo'  │
│ TD: ✓ post_fx                         │
│                                       │
│ ↻ retry 1/2 — force_field             │
│ Gemini (retry):                       │
│   ⊳ set_zone_shader(force_field)      │
│ TD: ✓ force_field                     │
└───────────────────────────────────────┘
```

**Retry flow (per zone).** Inside `testShaderGeneration`:

```
1. handle = startSingleToolChat(SET_ZONE_SHADER_TOOL, { systemInstruction })
2. emitGeminiTurn({ id, source: 'test_shader', systemPrompt, userPrompt })
3. result = await handle.send(userPrompt)
4. emitGeminiTurn({ id, responseText, toolCalls })
5. for each zone:
     push = await pushZoneUpdateWithValidation(zone, code)
     emit pushResults
     while !push.success and attempts < 2:
       emit retry marker
       retryResp = await handle.send(<vibe-agent retry phrasing with iteration N/2>)
       emit response + toolCalls
       push = await pushZoneUpdateWithValidation(zone, retryCode)
       emit pushResults
6. emitGeminiTurn({ id, final: true })
```

Each per-zone block is wrapped in `try/catch` so a thrown `chat.sendMessage` (transient Gemini failure) leaves the zone marked errored without skipping the final emit.

**Compile detection (TD side).** `_check_glsl_compile(glsl_op)`:

```python
# 1. Most specific: read _info DAT for "ERROR:" lines
info_dat = op(glsl_op.path + '_info')
if info_dat and info_dat.text:
    error_lines = [l for l in info_dat.text.splitlines() if 'ERROR' in l]
    if error_lines:
        return False, '\n'.join(error_lines)
# 2. Fallback: .errors() generic summary
errors = glsl_op.errors()
if errors: return False, errors
# 3. Final fallback: warnings()
...
```

This makes Gemini's retries informative — it sees actual `ERROR: line 45: 'vignette' : redefinition` instead of `Compile failed (/project1/glsl_force)`.

## Decisions made (for posterity)

- **Sidebar trigger**: auto-open on Shift+T. No separate toggle.
- **System prompt**: collapsed `<details>` block per turn, expandable on click.
- **Retry count**: 2 retries (3 attempts total), matching vibe-agent's iteration budget.
- **Tool calls inline in cards** (vibe-agent uses a separate Activity Feed; we chose inline because the user wanted "an accurate representation of the Gemini conversation").
- **Sprite / spell-program: no retry**. Imagen failures aren't iterative; program-push failures don't have a per-piece compile-error feedback loop.

## Patterns cribbed from vibe-agent

- Retry prompt phrasing: `vibe-agent/server/gemini_session.py:338-357` ("COMPILE ERROR (iteration N/2)... reverted to defaults... Common fixes... Explain what you think went wrong"). Adopted near-verbatim, dropping the metrics block (Phase 5 doesn't include the visual feedback loop).
- TD compile detection: `vibe-agent/td/ws_client_callbacks.py:338-366` (`.errors()` first, then `warnings()` containing "compile error", then `_info` DAT). Slight extension here — we always scan `_info` for ERROR lines first because it has the most actionable detail.

## Out of scope (deferred)

- Streaming Gemini responses token-by-token.
- Visual feedback loop (sending TD screenshots back to Gemini for review).
- Sprite / spell-program retries.
- Persisting the conversation log across reloads.
- Editing past Gemini turns from the sidebar.
- Listener-leak cleanup on the Merlin event subscriptions (low impact; deferred as a separate audit).

## Verification

1. **TD compile bug fix.** Push deliberately broken post_fx GLSL (e.g. `float vignette = 0.5;` redeclaration). Without fix: log says "compiled", TOP outputs the red/blue checker. With fix: log says "failed: ERROR: ... 'vignette' : redefinition", rollback fires.

2. **Sidebar appears in test mode.** Shift+T → Shaders tab → Generate. Merlin sidebar auto-opens with a "Shaders" card. Click "system prompt" → expands. Tool calls visible. Push results visible.

3. **Retry path (test mode).** Force a bad zone (e.g. wait for Gemini to hit a real compile error) → see `↻ retry 1/2` markers, see Gemini's correction attempt, eventual success or final-failure card after 2 retries.

4. **Live session retry.** Run a live Merlin session that invokes `set_zone_shader` and triggers a compile failure → the live conversation shows the retry, Gemini self-corrects.

5. **Cross-tab consistency.** Sprites tab generation → "Sprites" card with system prompt + `generate_sprite` tool call args + push result. Spell Program tab → "Spell Program" card with `set_spell_program` args + push result.

6. **Tests.** `npm test src/main/merlin/gemini-events.test.ts` — payload shape, destroyed-window, truncation, multi-emit. `npm test src/main/merlin/test-shader.test.ts` — retry-throw path. All 299+ tests pass.
