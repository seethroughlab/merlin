# Improvement: TD-Owned Energy Tweens

## Problem

`uSpellEnergy` is currently set by writing directly to the `spell_state` tableDAT from Node.js (`handle_spell_cast` does `update_table_kv(table, 'energy', '1.0')`). This means energy snaps instantly to its target value — there's no smooth interpolation. Spell-cast events produce an abrupt visual jump rather than a rise and fall. The timing logic lives on the Node.js side and downstream code (e.g. the temporal evaluation in the test suite) has to reason about millisecond delays manually, which is fragile.

## Approach

TD owns the energy tween. Merlin sends mode signals (`idle`, `buildup`, `release`) and optionally sets tween parameters (speed, curve). A CHOP network in TD interpolates toward the target energy — the value `uSpellEnergy` reads is always the smoothly-animated CHOP output, never a raw value pushed from Merlin.

This is a prerequisite for `improvement-06-temporal-evaluation.md` (which simplifies to "signal release, wait one tween cycle, capture") and an improvement to the live session in its own right.

## TD-Side Architecture

Replace the direct 'energy' row write in `spell_state` with a CHOP-based interpolation. Options, simplest first:

- **LagCHOP on `mode_float → energy`**: reads the -1/0/1 mode signal and smooths it. Simple, automatic, but symmetric lag (same speed rising and falling). Good starting point.
- **SpeedCHOP + LimitCHOP with separate attack/decay targets**: more expressive — different speeds for `idle→buildup`, `buildup→release`, `release→decay`. Requires more nodes but matches the performance feel better.
- **ScriptCHOP**: full Python control, arbitrary curves per transition. Most flexible, most work.

Recommendation: start with LagCHOP for the initial implementation. Add asymmetric attack/decay if the live session feel demands it.

`uSpellEnergy` expression changes from reading `spell_state['energy', 1]` to reading the CHOP output channel.

## Changes Required

### TD side (`td/demo.toe`)

1. Add a CHOP (LagCHOP or equivalent) that reads `mode_float` from `spell_state` and outputs a smoothed `energy` value.
2. Map the CHOP output range: mode -1 → energy 0.2 (idle baseline), mode 0 → energy 0.6 (buildup), mode 1 → energy 1.0 (release). A Math CHOP after the lag handles the range remap.
3. Change `uSpellEnergy` expression on all shader nodes to read from the CHOP output instead of `spell_state['energy', 1]`.
4. Remove or stop writing the `energy` row in `spell_state` from `handle_spell_cast` / `handle_spell_charge`. The mode signal is now sufficient.
5. Add a `tween_rise_ms` and `tween_fall_ms` row to `spell_state` so the lag time is configurable from WS.
6. Save `td/demo.toe`.

### New WS message: `set_cast_params`

```ts
{
  type: 'set_cast_params',
  riseMs?: number,    // idle → peak tween duration (default ~600ms test, ~2000ms live)
  fallMs?: number,    // peak → idle tween duration
  peakEnergy?: number,  // max energy at release (0–1, default 1.0)
  curve?: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out',
}
```

Handler in `ws_callbacks.py` writes `tween_rise_ms` / `tween_fall_ms` to `spell_state`, which the TD CHOP reads as its lag time parameters.

### `src/main/td-bridge/push.ts`

Add `pushCastParams(params)` — sends the `set_cast_params` message.

### Gemini tool (`set_cast_params`)

Add to both `MERLIN_VISUAL_AUTHOR_TOOLS` and `MERLIN_TOOLS`. Gemini uses it to match the energy envelope to the spell's character:
- Gentle drift spell: `{ riseMs: 2000, curve: 'ease_out' }` — slow meditative rise
- Explosive lightning: `{ riseMs: 150, curve: 'ease_in', peakEnergy: 1.0 }` — snap to peak
- Breathing/pulsing spell: low `peakEnergy` + moderate rise/fall for a subtle oscillation effect

### `src/main/merlin/reset-td.ts`

Add `BASELINE_CAST_PARAMS` constant (fast tween for test mode) and reset it alongside `BASELINE_FLIPBOOK` at the start of each Live Spell test run:

```ts
export const BASELINE_CAST_PARAMS = {
  riseMs: 600,
  fallMs: 800,
  peakEnergy: 1.0,
  curve: 'ease_in_out' as const,
};
```

## Open Questions

- **CHOP choice**: LagCHOP applies the same lag rising and falling. If the live-session feel requires fast attack (snap to release) but slow decay (linger in afterglow), a LagCHOP won't do it cleanly. Worth testing LagCHOP first and assessing.
- **Existing `ignitionMs` / `projectionMs` / `afterglowMs` envelope**: `handle_spell_cast` in `ws_callbacks.py` sets these timing values in `cast_state`. Are they used anywhere in the TD project beyond the direct 'energy' write? If they drive other TD animations, those paths need to remain functional after this change.
- **Idle energy floor**: Currently the template has `force *= (0.5 + uSpellEnergy)`. At idle (energy=0.2) that's 0.7×. If the tween smoothly interpolates down to 0.2 after release, particles will visibly slow — which may actually look good (spell dissipating). Worth observing in practice.
