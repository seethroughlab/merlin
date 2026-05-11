/**
 * Face-event ring buffer.
 *
 * The renderer's FaceLandmarker emits edge-triggered events (mouth_open
 * start/end, smile start/end, etc.) over the `face-gesture` IPC. Main
 * pushes them into this buffer so Gemini can query recent facial activity
 * via the `get_face_events` tool, and so the per-turn session context
 * can include a one-line summary ("Recent face: smiled 3s ago, brows
 * raised 5s ago") without an explicit tool call.
 *
 * Buffer is bounded (most recent N events; older ones drop off) and
 * time-windowed on read (queries take a "since" cutoff in ms).
 */

export type FaceGestureKind =
  | 'mouth_open'
  | 'smile'
  | 'brow_raise'
  | 'eye_closed';

export type FaceGestureEdge = 'start' | 'end';

export interface FaceGestureEventRecord {
  kind: FaceGestureKind;
  edge: FaceGestureEdge;
  /** Score at the moment of firing (0-1 normalized). */
  score: number;
  /** Wall-clock ms (Date.now() at push time). */
  at: number;
}

const MAX_EVENTS = 64;
const events: FaceGestureEventRecord[] = [];

/**
 * Push a new face gesture event into the buffer. Called from main's
 * `face-gesture` IPC handler.
 */
export function pushFaceEvent(
  kind: string,
  edge: 'start' | 'end',
  score: number,
): void {
  // Defensive: ignore unknown kinds (renderer is the canonical source,
  // but type-tightens here so downstream consumers can trust the union).
  if (kind !== 'mouth_open' && kind !== 'smile' && kind !== 'brow_raise' && kind !== 'eye_closed') {
    return;
  }
  events.push({ kind, edge, score, at: Date.now() });
  // Bound the buffer; drop oldest when over cap.
  while (events.length > MAX_EVENTS) events.shift();
}

/**
 * Return events that fired within the last `sinceMs` milliseconds.
 * Default 5s. Returns newest-first; each event includes an `ageMs`
 * field so Gemini can reason about "just now" vs. "a moment ago".
 */
export function getRecentFaceEvents(sinceMs = 5000): Array<FaceGestureEventRecord & { ageMs: number }> {
  const now = Date.now();
  const cutoff = now - sinceMs;
  const out: Array<FaceGestureEventRecord & { ageMs: number }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.at < cutoff) break;
    out.push({ ...e, ageMs: now - e.at });
  }
  return out;
}

/**
 * Compute which gestures are currently "active" — i.e., a 'start' has
 * been seen more recently than its matching 'end'. Useful for the
 * per-turn context: "currently smiling" vs. "smiled 4s ago".
 *
 * Only considers events within the last 10s to avoid stale activity
 * from earlier in the session leaking forward.
 */
export function getActiveGestures(): FaceGestureKind[] {
  const recent = getRecentFaceEvents(10000);
  // Latest-first; walk forward (oldest first) and toggle a per-kind flag.
  const ordered = [...recent].reverse();
  const active = new Set<FaceGestureKind>();
  for (const e of ordered) {
    if (e.edge === 'start') active.add(e.kind);
    else active.delete(e.kind);
  }
  return Array.from(active);
}

/**
 * Build a brief human-readable summary of recent face activity for
 * injection into the per-turn session context. Returns null if nothing
 * recent (last 8s) so the caller can omit the line entirely.
 *
 * Example output:
 *   "Currently smiling. Mouth opened 2s ago."
 *   "Brows raised."
 */
export function summarizeRecentFaceActivity(): string | null {
  const recent = getRecentFaceEvents(8000);
  if (recent.length === 0) return null;

  const active = new Set(getActiveGestures());
  const labels: Record<FaceGestureKind, string> = {
    mouth_open: 'mouth open',
    smile: 'smiling',
    brow_raise: 'brows raised',
    eye_closed: 'eyes closed',
  };

  const parts: string[] = [];

  // First: currently active (no time qualifier — it's happening now).
  for (const kind of active) {
    parts.push(`Currently ${labels[kind]}.`);
  }

  // Then: the most recent 'end' for each kind that's NOT active, so we
  // report "smiled 3s ago" without double-counting an ongoing smile.
  const reportedKinds = new Set<FaceGestureKind>(active);
  for (const e of recent) {
    // recent is newest-first
    if (reportedKinds.has(e.kind)) continue;
    if (e.edge !== 'end') continue; // skip starts that haven't ended
    const seconds = Math.round(e.ageMs / 1000);
    parts.push(`${labels[e.kind].charAt(0).toUpperCase() + labels[e.kind].slice(1)} ${seconds}s ago.`);
    reportedKinds.add(e.kind);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Clear the buffer. Called when a session ends so face events from a
 * previous participant don't leak into the next session's context.
 */
export function clearFaceEventBuffer(): void {
  events.length = 0;
}
