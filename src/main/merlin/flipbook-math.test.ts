import { describe, it, expect } from 'vitest';

/**
 * TypeScript replica of `computeFrameFloat` from
 * `shaders/mat_billboard_pixel.glsl`. The shader has no runtime test
 * harness, so this file exists to lock the math down — especially the
 * pingpong tent formula, which is the trickiest piece. If the shader
 * implementation changes, mirror the change here.
 *
 * Modes: 0=loop, 1=once, 2=pingpong. Random (3) is handled by the caller
 * in the shader and never invokes this function.
 */
function computeFrameFloat(
  driveValue: number,
  frameCount: number,
  playbackMode: 0 | 1 | 2,
  frameDuration: number,
): number {
  if (frameCount <= 1) return 0;
  const fc = frameCount;

  if (playbackMode === 0) {
    // loop — wraps continuously
    return mod(driveValue / frameDuration, fc);
  } else if (playbackMode === 1) {
    // once — clamps at last frame; fract collapses to 0 there
    return clamp(driveValue / frameDuration, 0, fc - 1);
  } else {
    // pingpong — tent wave 0 -> N-1 -> 0
    const period = 2 * (fc - 1);
    if (period <= 0) return 0;
    const t = mod(driveValue / frameDuration, period);
    return fc - 1 - Math.abs(t - (fc - 1));
  }
}

// GLSL `mod` matches Math.mod for positive inputs (drive values are always >= 0).
function mod(x: number, y: number): number {
  return x - Math.floor(x / y) * y;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

const FD = 0.1; // frameDuration used throughout

describe('computeFrameFloat — loop mode', () => {
  it('returns 0 at t=0', () => {
    expect(computeFrameFloat(0, 8, 0, FD)).toBe(0);
  });

  it('returns expected fractional position mid-cycle', () => {
    // t = 2.5 frames in, frameCount=8 → frameFloat = 2.5
    expect(computeFrameFloat(0.25, 8, 0, FD)).toBeCloseTo(2.5, 6);
  });

  it('wraps to ~0 after one full cycle', () => {
    // t = 8 * frameDuration → wraps back to 0 (frameCount * frameDuration)
    expect(computeFrameFloat(8 * FD, 8, 0, FD)).toBeCloseTo(0, 6);
  });

  it('wraps to fractional position partway into second cycle', () => {
    // (8 + 1.25) frames in → wraps to 1.25
    expect(computeFrameFloat((8 + 1.25) * FD, 8, 0, FD)).toBeCloseTo(1.25, 6);
  });

  it('frame0 wraps to 0 when frameFloat is between N-1 and N', () => {
    // frameFloat = 7.7 with N=8 → frame0 = 7, frame1 = 0 in the shader.
    // The math here only checks the float value; wrap-around is the caller's job.
    const f = computeFrameFloat(7.7 * FD, 8, 0, FD);
    expect(f).toBeCloseTo(7.7, 6);
    expect(Math.floor(f) % 8).toBe(7);
    expect((Math.floor(f) + 1) % 8).toBe(0);
  });
});

describe('computeFrameFloat — once mode', () => {
  it('returns 0 at t=0', () => {
    expect(computeFrameFloat(0, 8, 1, FD)).toBe(0);
  });

  it('returns expected fractional position mid-animation', () => {
    expect(computeFrameFloat(3.5 * FD, 8, 1, FD)).toBeCloseTo(3.5, 6);
  });

  it('clamps at frameCount - 1 once driveValue exceeds the animation length', () => {
    // After the animation completes, frameFloat pins to N-1 and fract = 0
    // so the shader collapses to a single frame (the last one) with no blend.
    const f = computeFrameFloat(20 * FD, 8, 1, FD);
    expect(f).toBe(7);
    expect(f - Math.floor(f)).toBe(0);
  });

  it('clamps even when driveValue is negative (defensive)', () => {
    expect(computeFrameFloat(-5, 8, 1, FD)).toBe(0);
  });
});

describe('computeFrameFloat — pingpong mode', () => {
  // For N=4, period = 2*(4-1) = 6. Tent wave peaks at 3, returns to 0 at 6.
  it('returns 0 at t=0', () => {
    expect(computeFrameFloat(0, 4, 2, FD)).toBe(0);
  });

  it('reaches peak (N-1) exactly halfway through the period', () => {
    // 3 frame-durations in → peak of tent
    expect(computeFrameFloat(3 * FD, 4, 2, FD)).toBeCloseTo(3, 6);
  });

  it('returns to 0 at the end of the full period', () => {
    // period = 6 frame-durations → back to start
    expect(computeFrameFloat(6 * FD, 4, 2, FD)).toBeCloseTo(0, 6);
  });

  it('produces 2.5 mid-backward-sweep', () => {
    // t = 4.5 frame-durations: forward 0..3 (3 fd), backward 3..0 (next 3 fd).
    // 1.5 fd into the backward sweep → frameFloat = 3 - 1.5 = 1.5
    expect(computeFrameFloat(4.5 * FD, 4, 2, FD)).toBeCloseTo(1.5, 6);
  });

  it('forward sweep increases monotonically', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 30; i++) {
      const t = (i / 30) * (3 * FD); // 0 to peak
      const f = computeFrameFloat(t, 4, 2, FD);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
  });

  it('backward sweep decreases monotonically', () => {
    let prev = Infinity;
    for (let i = 0; i <= 30; i++) {
      const t = 3 * FD + (i / 30) * (3 * FD); // peak to end
      const f = computeFrameFloat(t, 4, 2, FD);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
  });

  it('produces no NaN or Infinity at the turnaround', () => {
    // Sample densely around the peak to make sure the formula stays finite.
    for (let i = -5; i <= 5; i++) {
      const t = 3 * FD + i * 1e-6;
      const f = computeFrameFloat(t, 4, 2, FD);
      expect(Number.isFinite(f)).toBe(true);
    }
  });

  it('blend collapses to a single frame at the turnaround', () => {
    // At the peak, frameFloat == N-1 exactly. Using a clean
    // frameDuration=1.0 avoids the FP wobble that 3*0.1/0.1 introduces
    // (2.9999... instead of 3.0). The shader sees a similar wobble at
    // f32 precision but it's harmless: either fract≈0 (frame N-1 alone)
    // or fract≈1 (frame N-1 with vanishing weight from the wrap-target
    // frame 0) — both render a single frame visually.
    const f = computeFrameFloat(3, 4, 2, 1);
    expect(f).toBe(3);
    expect(f - Math.floor(f)).toBe(0);
  });

  it('turnaround with non-integer-friendly frameDuration still collapses visually', () => {
    // Even when driveValue/frameDuration drifts by FP rounding, the
    // blend at the turnaround is dominated by one of the two adjacent
    // integer frames (fract is near 0 or near 1).
    const f = computeFrameFloat(3 * FD, 4, 2, FD);
    expect(f).toBeCloseTo(3, 5);
    const fr = f - Math.floor(f);
    expect(Math.min(fr, 1 - fr)).toBeLessThan(0.001);
  });
});

describe('computeFrameFloat — N=1 edge case', () => {
  it.each([0, 1, 2] as const)('returns 0 regardless of mode (mode=%i)', (mode) => {
    expect(computeFrameFloat(0, 1, mode, FD)).toBe(0);
    expect(computeFrameFloat(5, 1, mode, FD)).toBe(0);
    expect(computeFrameFloat(100, 1, mode, FD)).toBe(0);
  });
});

describe('computeFrameFloat — N=2 pingpong (degenerate period)', () => {
  // period = 2*(2-1) = 2. Tent peaks at 1, returns to 0 at 2.
  it('peaks at 1 halfway through', () => {
    expect(computeFrameFloat(1 * FD, 2, 2, FD)).toBeCloseTo(1, 6);
  });

  it('returns to 0 at end of period', () => {
    expect(computeFrameFloat(2 * FD, 2, 2, FD)).toBeCloseTo(0, 6);
  });
});
