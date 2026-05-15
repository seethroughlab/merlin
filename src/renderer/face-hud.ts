const FACE_KIND_LABEL: Record<string, { label: string; emoji: string }> = {
  mouth_open: { label: 'mouth open', emoji: '😮' },
  smile:      { label: 'smile',      emoji: '😄' },
  brow_raise: { label: 'brows up',   emoji: '🤨' },
  eye_closed: { label: 'eyes closed', emoji: '😑' },
};

const faceHudActive = new Set<string>();

interface RecentFaceEvent {
  kind: string;
  edge: 'start' | 'end';
  at: number; // performance.now()
}

const faceHudRecent: RecentFaceEvent[] = [];
const FACE_HUD_RECENT_MAX = 8;
let faceHudRefreshInterval: ReturnType<typeof setInterval> | null = null;

export function updateFaceHud(evt: { kind: string; edge: 'start' | 'end'; timestamp: number }): void {
  if (evt.edge === 'start') faceHudActive.add(evt.kind);
  else faceHudActive.delete(evt.kind);

  faceHudRecent.unshift({ kind: evt.kind, edge: evt.edge, at: evt.timestamp });
  while (faceHudRecent.length > FACE_HUD_RECENT_MAX) faceHudRecent.pop();

  renderFaceHud();
  // Kick a slow refresh so the "Xs ago" labels stay accurate while
  // nothing new fires.
  if (!faceHudRefreshInterval) {
    faceHudRefreshInterval = setInterval(renderFaceHud, 1000);
  }
}

export function renderFaceHud(): void {
  const activeEl = document.getElementById('face-hud-active');
  const recentEl = document.getElementById('face-hud-recent');
  if (!activeEl || !recentEl) return;

  if (faceHudActive.size === 0) {
    activeEl.innerHTML = '<span class="face-hud-empty">neutral</span>';
  } else {
    activeEl.innerHTML = '';
    for (const kind of faceHudActive) {
      const meta = FACE_KIND_LABEL[kind] ?? { label: kind, emoji: '·' };
      const pill = document.createElement('span');
      pill.className = 'face-pill';
      pill.textContent = `${meta.emoji} ${meta.label}`;
      activeEl.appendChild(pill);
    }
  }

  const now = performance.now();
  // Drop entries older than 10s from the recent display (buffer keeps
  // them for slightly longer but the HUD only shows recent).
  while (faceHudRecent.length > 0 && now - faceHudRecent[faceHudRecent.length - 1].at > 10000) {
    faceHudRecent.pop();
  }

  if (faceHudRecent.length === 0) {
    recentEl.innerHTML = '';
    // No recent activity — pause the refresh timer.
    if (faceHudRefreshInterval) {
      clearInterval(faceHudRefreshInterval);
      faceHudRefreshInterval = null;
    }
    return;
  }

  recentEl.innerHTML = '';
  for (const e of faceHudRecent) {
    const meta = FACE_KIND_LABEL[e.kind] ?? { label: e.kind, emoji: '·' };
    const secs = Math.max(0, Math.round((now - e.at) / 1000));
    const line = document.createElement('div');
    line.className = 'face-recent-line';
    line.textContent = `${meta.emoji} ${meta.label} ${e.edge === 'start' ? 'started' : 'ended'} ${secs}s ago`;
    recentEl.appendChild(line);
  }
}

export function resetFaceHud(): void {
  faceHudActive.clear();
  faceHudRecent.length = 0;
  if (faceHudRefreshInterval) {
    clearInterval(faceHudRefreshInterval);
    faceHudRefreshInterval = null;
  }
  renderFaceHud();
}
