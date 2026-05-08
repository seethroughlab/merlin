import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const { mockPushCastParams } = vi.hoisted(() => ({
  mockPushCastParams: vi.fn(() => true),
}));

vi.mock('../td-bridge', () => ({
  pushCastParams: mockPushCastParams,
  // Other push functions are not exercised by the cases under test here.
  pushZoneUpdateWithValidation: vi.fn(),
}));

vi.mock('./gemini-events', () => ({
  emitGeminiTurn: vi.fn(),
}));

import { dispatchToolCalls } from './turn-runner';
import type { TurnDispatchContext } from './turn-runner';
import type { MerlinToolCall } from './types';

// set_cast_params doesn't read from session state, so a minimal cast keeps
// this test focused on dispatch + push wiring.
function makeCtx(): TurnDispatchContext {
  return { state: {} as TurnDispatchContext['state'] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPushCastParams.mockReturnValue(true);
});

describe('dispatchToolCalls — set_cast_params', () => {
  it('forwards args verbatim to pushCastParams and returns success', async () => {
    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 150, fallMs: 2000, peakEnergy: 0.7 },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-1', 'live', new Map());

    expect(mockPushCastParams).toHaveBeenCalledWith({
      riseMs: 150,
      fallMs: 2000,
      peakEnergy: 0.7,
    });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      name: 'set_cast_params',
      response: { success: true, params: { riseMs: 150, fallMs: 2000, peakEnergy: 0.7 } },
    });
  });

  it('passes through partial args (only riseMs)', async () => {
    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 800 },
    };

    await dispatchToolCalls([call], makeCtx(), 'turn-2', 'live', new Map());

    expect(mockPushCastParams).toHaveBeenCalledWith({ riseMs: 800 });
  });

  it('reports failure when push returns false (TD disconnected)', async () => {
    mockPushCastParams.mockReturnValue(false);

    const call: MerlinToolCall = {
      name: 'set_cast_params',
      args: { riseMs: 600 },
    };

    const result = await dispatchToolCalls([call], makeCtx(), 'turn-3', 'live', new Map());

    expect(result.toolResults[0].response).toMatchObject({
      success: false,
      error: expect.stringMatching(/not connected/i),
    });
  });
});
