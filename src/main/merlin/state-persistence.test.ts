import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpellState } from '../../shared/types';

// Use vi.hoisted to create mocks that can be referenced in vi.mock factories
const { mockFs, mockZoneStateManager, mockGetPath } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  mockZoneStateManager: {
    getZoneCode: vi.fn(),
    resetAll: vi.fn(),
    updateZone: vi.fn(),
  },
  mockGetPath: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

// Mock fs module
vi.mock('fs', () => mockFs);

// Mock zone-state module
vi.mock('./zone-state', () => ({
  zoneStateManager: mockZoneStateManager,
}));

// Import after mocks are set up
import {
  saveSessionState,
  loadSessionState,
  listSavedSessions,
  deleteSession,
  exportSession,
  importSession,
  applySessionState,
  type PersistedState,
} from './state-persistence';

// Helper to create a complete SpellState for tests
function createTestSpell(overrides: Partial<SpellState> = {}): SpellState {
  return {
    intent: 'calm',
    element: 'water',
    energy: 0.5,
    complexity: 0.3,
    visualArchetype: 'breathing_aura_mist',
    palette: 'soft-blue',
    castingOrigin: null,
    tone: 'gentle',
    magicWord: null,
    confidence: 0.5,
    ...overrides,
  };
}

describe('state-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directories exist
    mockFs.existsSync.mockReturnValue(true);
    mockGetPath.mockReturnValue('/mock/user/data');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('saveSessionState', () => {
    it('should create sessions directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockZoneStateManager.getZoneCode.mockReturnValue(null);

      saveSessionState('test-session', createTestSpell());

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it('should write session to file', () => {
      mockZoneStateManager.getZoneCode.mockImplementation((zone: string) => {
        if (zone === 'force_field') return 'force = vec3(0.0);';
        return null;
      });

      const result = saveSessionState('test-session', createTestSpell());

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalled();

      // Check that correct data was written
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string) as PersistedState;
      expect(writtenData.version).toBe('1.0');
      expect(writtenData.sessionId).toBe('test-session');
      expect(writtenData.spell.intent).toBe('calm');
      expect(writtenData.zones.force_field).toBe('force = vec3(0.0);');
    });

    it('should include metadata when provided', () => {
      mockZoneStateManager.getZoneCode.mockReturnValue(null);

      saveSessionState(
        'test-session',
        createTestSpell({ intent: 'protection', element: 'earth', energy: 0.7, tone: 'heroic' }),
        { name: 'My Spell', description: 'A test spell' }
      );

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string) as PersistedState;
      expect(writtenData.metadata?.name).toBe('My Spell');
      expect(writtenData.metadata?.description).toBe('A test spell');
    });

    it('should return false on error', () => {
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = saveSessionState('test-session', createTestSpell());

      expect(result).toBe(false);
    });

    it('should sanitize session ID for filename', () => {
      mockZoneStateManager.getZoneCode.mockReturnValue(null);

      saveSessionState('test/session:with*chars', createTestSpell());

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const filePath = writeCall[0] as string;
      expect(filePath).not.toContain('/session');  // sanitized
      expect(filePath).not.toContain('*');
    });
  });

  describe('loadSessionState', () => {
    it('should return null if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = loadSessionState('nonexistent');
      expect(result).toBeNull();
    });

    it('should load and parse session file', () => {
      const mockState: PersistedState = {
        version: '1.0',
        sessionId: 'test-session',
        zones: { force_field: 'force = vec3(1.0);' },
        spell: createTestSpell(),
        timestamp: Date.now(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockState));

      const result = loadSessionState('test-session');
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe('test-session');
      expect(result?.spell.intent).toBe('calm');
    });

    it('should return null on parse error', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const result = loadSessionState('test-session');
      expect(result).toBeNull();
    });
  });

  describe('applySessionState', () => {
    it('should reset zones and apply saved codes', () => {
      const state: PersistedState = {
        version: '1.0',
        sessionId: 'test-session',
        zones: {
          force_field: 'force = vec3(1.0);',
          color_over_life: 'color = vec4(1.0);',
        },
        spell: createTestSpell(),
        timestamp: Date.now(),
      };

      applySessionState(state);

      expect(mockZoneStateManager.resetAll).toHaveBeenCalled();
      expect(mockZoneStateManager.updateZone).toHaveBeenCalledWith('force_field', 'force = vec3(1.0);');
      expect(mockZoneStateManager.updateZone).toHaveBeenCalledWith('color_over_life', 'color = vec4(1.0);');
    });

    it('should skip null zone codes', () => {
      const state: PersistedState = {
        version: '1.0',
        sessionId: 'test-session',
        zones: {
          force_field: 'force = vec3(1.0);',
          color_over_life: null,
        },
        spell: createTestSpell(),
        timestamp: Date.now(),
      };

      applySessionState(state);

      expect(mockZoneStateManager.updateZone).toHaveBeenCalledWith('force_field', 'force = vec3(1.0);');
      expect(mockZoneStateManager.updateZone).not.toHaveBeenCalledWith('color_over_life', expect.anything());
    });
  });

  describe('listSavedSessions', () => {
    it('should return empty array when no sessions', () => {
      mockFs.readdirSync.mockReturnValue([]);

      const sessions = listSavedSessions();
      expect(sessions).toHaveLength(0);
    });

    it('should parse and return session summaries', () => {
      const state1: PersistedState = {
        version: '1.0',
        sessionId: 'session1',
        zones: { force_field: 'code1' },
        spell: createTestSpell(),
        timestamp: 1000,
        metadata: { name: 'First Spell' },
      };

      const state2: PersistedState = {
        version: '1.0',
        sessionId: 'session2',
        zones: { force_field: 'code2', color_over_life: 'code3' },
        spell: createTestSpell({ intent: 'protection', element: 'fire', castingOrigin: 'hands', tone: 'heroic' }),
        timestamp: 2000,
      };

      mockFs.readdirSync.mockReturnValue(['session1.json', 'session2.json'] as any);
      mockFs.readFileSync
        .mockReturnValueOnce(JSON.stringify(state1))
        .mockReturnValueOnce(JSON.stringify(state2));

      const sessions = listSavedSessions();
      expect(sessions).toHaveLength(2);
      // Should be sorted by timestamp descending
      expect(sessions[0].sessionId).toBe('session2');
      expect(sessions[1].sessionId).toBe('session1');
      expect(sessions[0].zoneCount).toBe(2);
      expect(sessions[1].name).toBe('First Spell');
    });

    it('should skip invalid files', () => {
      mockFs.readdirSync.mockReturnValue(['valid.json', 'invalid.json'] as any);
      mockFs.readFileSync
        .mockReturnValueOnce(JSON.stringify({
          version: '1.0',
          sessionId: 'valid',
          zones: {},
          spell: createTestSpell(),
          timestamp: 1000,
        }))
        .mockReturnValueOnce('not json');

      const sessions = listSavedSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('valid');
    });
  });

  describe('deleteSession', () => {
    it('should return false if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = deleteSession('nonexistent');
      expect(result).toBe(false);
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should delete file and return true', () => {
      mockFs.existsSync.mockReturnValue(true);

      const result = deleteSession('test-session');
      expect(result).toBe(true);
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });

    it('should return false on error', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockImplementation(() => {
        throw new Error('Delete failed');
      });

      const result = deleteSession('test-session');
      expect(result).toBe(false);
    });
  });

  describe('exportSession', () => {
    it('should return false if session does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = exportSession('nonexistent', '/export/path.json');
      expect(result).toBe(false);
    });

    it('should write to export path', () => {
      const state: PersistedState = {
        version: '1.0',
        sessionId: 'test-session',
        zones: {},
        spell: createTestSpell(),
        timestamp: 1000,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(state));

      const result = exportSession('test-session', '/export/my-spell.json');
      expect(result).toBe(true);

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      expect(writeCall[0]).toBe('/export/my-spell.json');
    });
  });

  describe('importSession', () => {
    it('should return null if import file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = importSession('/import/nonexistent.json');
      expect(result).toBeNull();
    });

    it('should return null for invalid file structure', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ invalid: 'structure' }));

      const result = importSession('/import/invalid.json');
      expect(result).toBeNull();
    });

    it('should import and save with new ID', () => {
      const state: PersistedState = {
        version: '1.0',
        sessionId: 'original-id',
        zones: { force_field: 'code' },
        spell: createTestSpell(),
        timestamp: 1000,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(state));

      const result = importSession('/import/spell.json');
      expect(result).not.toBeNull();
      expect(result?.sessionId).toMatch(/^imported_\d+$/);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });
});
