/**
 * Standardized logging for the Merlin main process.
 *
 * All main-process modules SHOULD route through `log.info/warn/error/
 * debug(module, ...)` so:
 *   - every line has a consistent `[Module HH:MM:SS]` prefix
 *   - debug logs can be silenced in production via MERLIN_LOG_LEVEL
 *   - there's one place to add file output or redaction later.
 *
 * Existing call sites that still use console.* are not buggy — they
 * just predate this module. New code should prefer `log.*`, and you
 * can mass-migrate a file when you're already touching it.
 *
 * Usage:
 *   import { log } from '../logger';
 *   log.info('TDBridge', 'Server started on port', port);
 *   log.warn('SpriteGen', 'description truncated', input.length);
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function pickLevel(): Level {
  const raw = (process.env.MERLIN_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

const currentLevel = pickLevel();

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function prefix(module: string): string {
  return `[${module} ${ts()}]`;
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

export const log = {
  debug(module: string, ...args: unknown[]): void {
    if (shouldLog('debug')) console.log(prefix(module), ...args);
  },
  info(module: string, ...args: unknown[]): void {
    if (shouldLog('info')) console.log(prefix(module), ...args);
  },
  warn(module: string, ...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(prefix(module), ...args);
  },
  error(module: string, ...args: unknown[]): void {
    // Errors always print regardless of level.
    console.error(prefix(module), ...args);
  },
};
