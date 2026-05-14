import { describe, it, expect, beforeEach, vi } from 'vitest';

// The exported zone-state instance is a module-singleton. resetAll()
// reverts every zone, so we call it in beforeEach to get clean state.
import { zoneStateManager } from './zone-state';
import { ZONE_NAMES } from './zone-registry';

const PRIMARY = ZONE_NAMES[0]; // any real zone name; deterministic ordering not required

describe('zoneStateManager', () => {
  beforeEach(() => {
    zoneStateManager.resetAll();
    vi.useRealTimers();
  });

  describe('updateZone + handleCompileResult', () => {
    it('marks zone pending then active on success', async () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet v1');
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('pending');
      zoneStateManager.handleCompileResult(PRIMARY, true);
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('active');
      expect(zoneStateManager.getZoneError(PRIMARY)).toBeNull();
      expect(zoneStateManager.getLastCompileSuccess(PRIMARY)).toBe(true);
    });

    it('marks zone error on compile failure and stores the message', () => {
      zoneStateManager.updateZone(PRIMARY, '// bad code');
      zoneStateManager.handleCompileResult(PRIMARY, false, 'syntax error at line 3');
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('error');
      expect(zoneStateManager.getZoneError(PRIMARY)).toBe('syntax error at line 3');
      expect(zoneStateManager.getLastCompileSuccess(PRIMARY)).toBe(false);
    });
  });

  describe('rollbackZone', () => {
    it('reverts to previous code when one exists', () => {
      zoneStateManager.updateZone(PRIMARY, '// good v1');
      zoneStateManager.handleCompileResult(PRIMARY, true);
      zoneStateManager.updateZone(PRIMARY, '// broken v2');
      const rolled = zoneStateManager.rollbackZone(PRIMARY);
      expect(rolled).toBe('// good v1');
      expect(zoneStateManager.getZoneCode(PRIMARY)).toBe('// good v1');
    });

    it('resets to default when no previous code exists', () => {
      zoneStateManager.updateZone(PRIMARY, '// first attempt');
      const rolled = zoneStateManager.rollbackZone(PRIMARY);
      expect(rolled).toBeNull();
      expect(zoneStateManager.getZoneCode(PRIMARY)).toBeNull();
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('default');
    });

    it('keeps lastCompileSuccess=false through rollback so screenshot guard still trips', () => {
      // First, an OK compile so the zone has prior good code.
      zoneStateManager.updateZone(PRIMARY, '// good v1');
      zoneStateManager.handleCompileResult(PRIMARY, true);
      // Then a bad push + failed compile.
      zoneStateManager.updateZone(PRIMARY, '// broken v2');
      zoneStateManager.handleCompileResult(PRIMARY, false, 'compile failed');
      // Rollback reverts the code, but the failure flag must stick so
      // request_visual_feedback can still refuse the screenshot.
      zoneStateManager.rollbackZone(PRIMARY);
      expect(zoneStateManager.getLastCompileSuccess(PRIMARY)).toBe(false);
    });
  });

  describe('waitForCompileResult', () => {
    it('resolves true when handleCompileResult fires success', async () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet');
      const pending = zoneStateManager.waitForCompileResult(PRIMARY, 5000);
      // Fire the result on the next tick so the resolver is in place.
      await Promise.resolve();
      zoneStateManager.handleCompileResult(PRIMARY, true);
      await expect(pending).resolves.toBe(true);
    });

    it('resolves false on compile failure', async () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet');
      const pending = zoneStateManager.waitForCompileResult(PRIMARY, 5000);
      await Promise.resolve();
      zoneStateManager.handleCompileResult(PRIMARY, false, 'error');
      await expect(pending).resolves.toBe(false);
    });

    it('resolves false on timeout and marks the zone as error', async () => {
      vi.useFakeTimers();
      zoneStateManager.updateZone(PRIMARY, '// will-not-compile');
      const pending = zoneStateManager.waitForCompileResult(PRIMARY, 1000);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toBe(false);
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('error');
      expect(zoneStateManager.getZoneError(PRIMARY)).toMatch(/timeout/i);
    });

    it('short-circuits when zone is not pending', async () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet');
      zoneStateManager.handleCompileResult(PRIMARY, true);
      // Already active — should resolve immediately without a pending entry.
      await expect(zoneStateManager.waitForCompileResult(PRIMARY)).resolves.toBe(true);
    });
  });

  describe('resetAll', () => {
    it('cancels pending compiles by resolving false', async () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet');
      const pending = zoneStateManager.waitForCompileResult(PRIMARY, 5000);
      await Promise.resolve();
      zoneStateManager.resetAll();
      await expect(pending).resolves.toBe(false);
      expect(zoneStateManager.getZoneStatus(PRIMARY)).toBe('default');
    });

    it('returns lastCompileSuccess to null', () => {
      zoneStateManager.updateZone(PRIMARY, '// snippet');
      zoneStateManager.handleCompileResult(PRIMARY, true);
      zoneStateManager.resetAll();
      expect(zoneStateManager.getLastCompileSuccess(PRIMARY)).toBeNull();
    });
  });

  describe('unknown zone handling', () => {
    it('updateZone logs a warning and is a no-op', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      zoneStateManager.updateZone('not_a_real_zone', '// x');
      expect(warn).toHaveBeenCalled();
      expect(zoneStateManager.getZoneStatus('not_a_real_zone')).toBe('default');
    });

    it('rollbackZone of unknown zone returns null', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(zoneStateManager.rollbackZone('not_a_real_zone')).toBeNull();
      expect(warn).toHaveBeenCalled();
    });
  });
});
