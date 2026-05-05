/**
 * State Persistence
 *
 * Save and load Merlin session state including zone shaders and spell state.
 * Sessions are stored as JSON files in ~/.merlin/sessions/
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { SpellState } from '../../shared/types';
import { zoneStateManager } from './zone-state';
import { ZONE_NAMES } from './zone-registry';

/**
 * Persisted session state
 */
export interface PersistedState {
  version: '1.0';
  sessionId: string;
  zones: Record<string, string | null>; // zone name → GLSL code
  spell: SpellState;
  timestamp: number;
  metadata?: {
    name?: string;
    description?: string;
  };
}

/**
 * Session summary for listing
 */
export interface SessionSummary {
  sessionId: string;
  timestamp: number;
  spellIntent: string | null;
  spellElement: string | null;
  zoneCount: number;
  name?: string;
}

const SESSIONS_DIR = 'sessions';
const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Get the sessions directory path
 */
function getSessionsDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, SESSIONS_DIR);
}

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[StatePersistence ${ts()}] Created sessions directory: ${dir}`);
  }
}

/**
 * Get path for a session file
 */
function getSessionPath(sessionId: string): string {
  // Sanitize session ID for filename
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSessionsDir(), `${sanitized}.json`);
}

/**
 * Save current session state
 */
export function saveSessionState(
  sessionId: string,
  spell: SpellState,
  metadata?: { name?: string; description?: string }
): boolean {
  try {
    ensureSessionsDir();

    // Collect zone codes from zone state manager
    const zones: Record<string, string | null> = {};
    for (const zoneName of ZONE_NAMES) {
      zones[zoneName] = zoneStateManager.getZoneCode(zoneName);
    }

    const state: PersistedState = {
      version: '1.0',
      sessionId,
      zones,
      spell,
      timestamp: Date.now(),
      metadata,
    };

    const filePath = getSessionPath(sessionId);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    console.log(`[StatePersistence ${ts()}] Saved session: ${sessionId}`);
    return true;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to save session:`, error);
    return false;
  }
}

/**
 * Load a saved session state
 */
export function loadSessionState(sessionId: string): PersistedState | null {
  try {
    const filePath = getSessionPath(sessionId);

    if (!fs.existsSync(filePath)) {
      console.warn(`[StatePersistence ${ts()}] Session not found: ${sessionId}`);
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(data) as PersistedState;

    // Validate version
    if (state.version !== '1.0') {
      console.warn(`[StatePersistence ${ts()}] Unknown version: ${state.version}`);
    }

    console.log(`[StatePersistence ${ts()}] Loaded session: ${sessionId}`);
    return state;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to load session:`, error);
    return null;
  }
}

/**
 * Apply a loaded session state to zone manager
 */
export function applySessionState(state: PersistedState): void {
  // Reset all zones first
  zoneStateManager.resetAll();

  // Apply saved zone codes
  for (const [zoneName, code] of Object.entries(state.zones)) {
    if (code !== null) {
      zoneStateManager.updateZone(zoneName, code);
    }
  }

  console.log(`[StatePersistence ${ts()}] Applied session state: ${state.sessionId}`);
}

/**
 * List all saved sessions
 */
export function listSavedSessions(): SessionSummary[] {
  try {
    ensureSessionsDir();
    const dir = getSessionsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

    const sessions: SessionSummary[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(dir, file), 'utf-8');
        const state = JSON.parse(data) as PersistedState;

        // Count non-null zones
        const zoneCount = Object.values(state.zones).filter((z) => z !== null).length;

        sessions.push({
          sessionId: state.sessionId,
          timestamp: state.timestamp,
          spellIntent: state.spell?.intent || null,
          spellElement: state.spell?.element || null,
          zoneCount,
          name: state.metadata?.name,
        });
      } catch {
        // Skip invalid files
        console.warn(`[StatePersistence ${ts()}] Skipping invalid file: ${file}`);
      }
    }

    // Sort by timestamp descending (newest first)
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to list sessions:`, error);
    return [];
  }
}

/**
 * Delete a saved session
 */
export function deleteSession(sessionId: string): boolean {
  try {
    const filePath = getSessionPath(sessionId);

    if (!fs.existsSync(filePath)) {
      console.warn(`[StatePersistence ${ts()}] Session not found for deletion: ${sessionId}`);
      return false;
    }

    fs.unlinkSync(filePath);
    console.log(`[StatePersistence ${ts()}] Deleted session: ${sessionId}`);
    return true;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to delete session:`, error);
    return false;
  }
}

/**
 * Export session to a specific path (for user-chosen location)
 */
export function exportSession(sessionId: string, exportPath: string): boolean {
  try {
    const state = loadSessionState(sessionId);
    if (!state) {
      return false;
    }

    fs.writeFileSync(exportPath, JSON.stringify(state, null, 2));
    console.log(`[StatePersistence ${ts()}] Exported session to: ${exportPath}`);
    return true;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to export session:`, error);
    return false;
  }
}

/**
 * Import session from a file
 */
export function importSession(importPath: string): PersistedState | null {
  try {
    if (!fs.existsSync(importPath)) {
      console.warn(`[StatePersistence ${ts()}] Import file not found: ${importPath}`);
      return null;
    }

    const data = fs.readFileSync(importPath, 'utf-8');
    const state = JSON.parse(data) as PersistedState;

    // Validate basic structure
    if (!state.sessionId || !state.zones || !state.spell) {
      console.error(`[StatePersistence ${ts()}] Invalid session file structure`);
      return null;
    }

    // Save to sessions directory with new ID to avoid conflicts
    const newId = `imported_${Date.now()}`;
    state.sessionId = newId;
    state.timestamp = Date.now();

    ensureSessionsDir();
    const filePath = getSessionPath(newId);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));

    console.log(`[StatePersistence ${ts()}] Imported session as: ${newId}`);
    return state;
  } catch (error) {
    console.error(`[StatePersistence ${ts()}] Failed to import session:`, error);
    return null;
  }
}
