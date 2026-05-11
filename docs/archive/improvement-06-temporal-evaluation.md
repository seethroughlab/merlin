# Improvement: Multi-Frame Temporal Evaluation in Live Spell Test

## Problem

`request_visual_feedback` captures a single screenshot at whatever energy level the system happens to be at — typically idle (low energy). A spell that swirls dramatically at release or fades gracefully over its lifetime looks identical to a static cloud of dots in the one-frame snapshot. Gemini evaluates visual quality based on a moment that may not represent the spell's most important states, and passes or requests retries based on incomplete information.

## Prerequisite

`improvement-02-energy-tweens.md` — TD must own the energy tween before this feature is built. Once TD interpolates energy smoothly in response to mode signals, the multi-frame capture simplifies to: signal release, wait one tween cycle, capture. Without it, the Node.js side would need to manually time delays against raw energy writes, which is fragile.

## Capture Sequence

With TD-owned tweening in place:

1. **Frame A (idle)**: System at idle baseline. Request screenshot immediately.
2. **Signal release**: Send `spell_cast` to trigger TD's tween to peak energy.
3. **Frame B (peak)**: Wait `riseMs` (from `TEST_CAST_PARAMS`, default ~600ms). Request screenshot.
4. **Frame C (afterglow)**: Wait `fallMs / 2` for partial decay. Request screenshot.
5. **Reset**: Signal idle to restore baseline. (Full `resetTD()` still runs at end of test.)

The test runner uses `TEST_CAST_PARAMS` (a fast envelope constant) so evaluation stays snappy regardless of whatever `set_cast_params` Gemini chose for the spell's live performance feel.

Total added latency: ~1.5s per `request_visual_feedback` call (600ms rise + 400ms partial fall + 3 screenshot round-trips ≈ 500ms).

## Changes Required

### `src/main/merlin/turn-runner.ts` — `request_visual_feedback` handler

Replace the single `requestScreenshot(send, 5000)` call with `captureTemporalFrames(send)`:

```ts
async function captureTemporalFrames(send: SendFn) {
  // Frame A: idle
  const frameA = await requestScreenshot(send, 5000);

  // Trigger cast tween
  await pushCastParams(TEST_CAST_PARAMS);   // ensure fast test envelope
  guardedSend({ type: 'spell_cast', ... });

  // Frame B: peak
  await sleep(TEST_CAST_PARAMS.riseMs);
  const frameB = await requestScreenshot(send, 5000);

  // Frame C: afterglow
  await sleep(TEST_CAST_PARAMS.fallMs / 2);
  const frameC = await requestScreenshot(send, 5000);

  // Restore idle
  guardedSend({ type: 'merlin_state', active: true, phase: 'idle' });

  return { frameA, frameB, frameC };
}
```

Export `TEST_CAST_PARAMS`:
```ts
export const TEST_CAST_PARAMS = { riseMs: 600, fallMs: 800, peakEnergy: 1.0, curve: 'ease_in_out' };
```

All three frames sent to Gemini as multimodal parts in the function response, labelled `frame_idle`, `frame_peak`, `frame_afterglow`.

### `src/main/merlin/prompts.ts`

Update `request_visual_feedback` tool description:
- Response contains three frames: `frame_idle` (low energy baseline), `frame_peak` (maximum energy), `frame_afterglow` (decaying energy)
- Evaluation criteria apply per-frame: idle must show particles present and positioned correctly; peak must meet `visible_particles` and `avg_brightness` thresholds and show meaningful change from idle; afterglow must show graceful fade, not an abrupt cutoff
- Metrics values in the response reflect Frame B (peak) — that's when thresholds are most meaningful

### `src/main/merlin/gemini-events.ts`

Update `GeminiTurn` event publishing to include all three screenshots so the sidebar can display the temporal sequence inline.

### Test panel renderer

Show three frames side-by-side (or stacked with labels) in the Live Spell test panel when a result arrives.

## Open Questions

- **Compile guard**: The existing guard (`lastCompileSuccess === false` blocks screenshots) still applies. If any zone failed to compile, refuse all three captures — not just the first.
- **Metrics frame**: The `metrics` block in the response should report values sampled at Frame B (peak). Frames A and C metrics are secondary context — include them if they add signal (e.g. idle visibility confirming spawn is working), omit if they clutter the response.
- **Frame count**: 3 frames adds ~1.5s. Could reduce to 2 (idle + peak) if the afterglow frame rarely changes Gemini's evaluation. Worth trying both and seeing if the third frame ever triggers a retry that the first two wouldn't have.
- **No state leak between calls**: After `captureTemporalFrames`, restore idle immediately — don't wait for `resetTD()`. A second `request_visual_feedback` in the same turn would otherwise start mid-ramp.
