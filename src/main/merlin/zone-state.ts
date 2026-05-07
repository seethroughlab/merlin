/**
 * Zone State Manager
 *
 * Tracks the state of each shader zone through compile lifecycle:
 * default → pending → active/error
 *
 * Handles async compile results from TouchDesigner and supports rollback.
 */

import { ZONE_NAMES, type ZoneName } from './zone-registry';

/**
 * Possible zone states
 */
export type ZoneStatus = 'default' | 'pending' | 'active' | 'error';

/**
 * State for a single zone
 */
interface ZoneState {
  code: string | null;
  status: ZoneStatus;
  error: string | null;
  previousCode: string | null;
  /**
   * Outcome of the most recent compile attempt:
   *  - null  : never attempted
   *  - true  : last compile succeeded
   *  - false : last compile failed (stays false through rollback —
   *            does NOT reset to null when status drops back to
   *            'default'). Lets the screenshot guard distinguish
   *            "untouched zone" from "recently failed zone".
   */
  lastCompileSuccess: boolean | null;
}

/**
 * Pending compile promise handlers
 */
interface PendingCompile {
  resolve: (success: boolean) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Zone State Manager class
 * Singleton that tracks all zone states
 */
class ZoneStateManager {
  private zones: Map<string, ZoneState> = new Map();
  private pendingCompiles: Map<string, PendingCompile> = new Map();

  constructor() {
    // Initialize all zones with default state
    for (const zoneName of ZONE_NAMES) {
      this.zones.set(zoneName, {
        code: null,
        status: 'default',
        error: null,
        previousCode: null,
        lastCompileSuccess: null,
      });
    }
  }

  /**
   * Update zone code and mark as pending
   * Saves previous code for potential rollback
   */
  updateZone(zoneName: string, code: string): void {
    const state = this.zones.get(zoneName);
    if (!state) {
      console.warn(`[ZoneState] Unknown zone: ${zoneName}`);
      return;
    }

    // Save previous code for rollback
    state.previousCode = state.code;
    state.code = code;
    state.status = 'pending';
    state.error = null;

    console.log(`[ZoneState] Zone '${zoneName}' marked pending`);
  }

  /**
   * Wait for compile result from TouchDesigner
   * Returns true if compilation succeeded, false otherwise
   */
  async waitForCompileResult(zoneName: string, timeoutMs: number = 3000): Promise<boolean> {
    const state = this.zones.get(zoneName);
    if (!state) {
      console.warn(`[ZoneState] waitForCompileResult: Unknown zone: ${zoneName}`);
      return false;
    }

    // If not pending, check current status
    if (state.status !== 'pending') {
      return state.status === 'active';
    }

    // Cancel any existing pending compile for this zone
    const existing = this.pendingCompiles.get(zoneName);
    if (existing) {
      clearTimeout(existing.timeoutId);
      existing.resolve(false);
    }

    // Create promise for compile result
    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        // Timeout - treat as error
        this.handleCompileResult(zoneName, false, 'Compile timeout');
        resolve(false);
      }, timeoutMs);

      this.pendingCompiles.set(zoneName, { resolve, timeoutId });
    });
  }

  /**
   * Handle compile result from TouchDesigner
   * Called when TD sends back a compile_result message
   */
  handleCompileResult(zoneName: string, success: boolean, error?: string): void {
    const state = this.zones.get(zoneName);
    if (!state) {
      console.warn(`[ZoneState] handleCompileResult: Unknown zone: ${zoneName}`);
      return;
    }

    if (success) {
      state.status = 'active';
      state.error = null;
      state.lastCompileSuccess = true;
      console.log(`[ZoneState] Zone '${zoneName}' compiled successfully`);
    } else {
      state.status = 'error';
      state.error = error || 'Compilation failed';
      state.lastCompileSuccess = false;
      console.log(`[ZoneState] Zone '${zoneName}' compile failed: ${state.error}`);
    }

    // Resolve pending compile promise
    const pending = this.pendingCompiles.get(zoneName);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve(success);
      this.pendingCompiles.delete(zoneName);
    }
  }

  /**
   * Rollback zone to previous working code
   */
  rollbackZone(zoneName: string): string | null {
    const state = this.zones.get(zoneName);
    if (!state) {
      console.warn(`[ZoneState] rollbackZone: Unknown zone: ${zoneName}`);
      return null;
    }

    if (state.previousCode !== null) {
      console.log(`[ZoneState] Rolling back zone '${zoneName}'`);
      state.code = state.previousCode;
      state.previousCode = null;
      // Don't change status - caller should re-push the rollback code
      return state.code;
    }

    // No previous code - reset to default
    console.log(`[ZoneState] No previous code for '${zoneName}', resetting to default`);
    state.code = null;
    state.status = 'default';
    state.error = null;
    return null;
  }

  /**
   * Get current zone status
   */
  getZoneStatus(zoneName: string): ZoneStatus {
    const state = this.zones.get(zoneName);
    return state?.status || 'default';
  }

  /**
   * Outcome of the most recent compile attempt for this zone.
   *  - null  : never attempted
   *  - true  : last attempt succeeded (regardless of any later
   *            updateZone() that put it back into 'pending')
   *  - false : last attempt failed (stays false through rollback;
   *            only flips back to true after a successful compile)
   *
   * Used by the screenshot guard so a screenshot can be refused
   * even after a failed zone has been silently rolled back to its
   * default code (status='default' but lastCompileSuccess=false).
   */
  getLastCompileSuccess(zoneName: string): boolean | null {
    const state = this.zones.get(zoneName);
    return state?.lastCompileSuccess ?? null;
  }

  /**
   * Get zone error message
   */
  getZoneError(zoneName: string): string | null {
    const state = this.zones.get(zoneName);
    return state?.error || null;
  }

  /**
   * Get zone code
   */
  getZoneCode(zoneName: string): string | null {
    const state = this.zones.get(zoneName);
    return state?.code || null;
  }

  /**
   * Get all zone statuses for UI
   */
  getAllZoneStatuses(): Record<string, ZoneStatus> {
    const result: Record<string, ZoneStatus> = {};
    for (const [name, state] of this.zones) {
      result[name] = state.status;
    }
    return result;
  }

  /**
   * Get full state for a zone (for debugging)
   */
  getZoneState(zoneName: string): ZoneState | undefined {
    return this.zones.get(zoneName);
  }

  /**
   * Reset all zones to default state
   */
  resetAll(): void {
    for (const [zoneName] of this.zones) {
      this.zones.set(zoneName, {
        code: null,
        status: 'default',
        error: null,
        previousCode: null,
        lastCompileSuccess: null,
      });
    }

    // Clear all pending compiles
    for (const [, pending] of this.pendingCompiles) {
      clearTimeout(pending.timeoutId);
      pending.resolve(false);
    }
    this.pendingCompiles.clear();

    console.log('[ZoneState] All zones reset to default');
  }
}

/**
 * Singleton instance
 */
export const zoneStateManager = new ZoneStateManager();
