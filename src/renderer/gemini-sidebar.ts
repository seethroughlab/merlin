import type {
  GeminiTurn,
  GeminiToolCall,
  GeminiPushResult,
  GeminiRetryMarker,
  GeminiTurnSource,
} from '../shared/types';

const SOURCE_LABELS: Record<GeminiTurnSource, string> = {
  live: 'Live',
  test_shader: 'Shaders',
  test_sprite: 'Sprites',
  test_live_spell: 'Live Spell',
};

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function ensureTurnCard(turn: Partial<GeminiTurn> & { id: string; source: GeminiTurnSource }): HTMLElement | null {
  const conversation = document.getElementById('merlin-conversation');
  if (!conversation) return null;

  let card = conversation.querySelector<HTMLElement>(`.gemini-turn[data-turn-id="${turn.id}"]`);
  if (card) return card;

  card = document.createElement('div');
  card.className = 'gemini-turn';
  card.dataset.turnId = turn.id;
  card.dataset.source = turn.source;

  const header = document.createElement('div');
  header.className = 'gemini-turn-header';
  const sourceSpan = document.createElement('span');
  sourceSpan.className = 'gemini-turn-source';
  // textContent escapes the fallback if a future code path emits an unknown source.
  sourceSpan.textContent = SOURCE_LABELS[turn.source] ?? turn.source;
  header.appendChild(sourceSpan);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'gemini-turn-body';
  card.appendChild(body);

  conversation.appendChild(card);
  return card;
}

export function appendGeminiTurn(turn: Partial<GeminiTurn> & { id: string; source: GeminiTurnSource }): void {
  const card = ensureTurnCard(turn);
  if (!card) return;
  const body = card.querySelector<HTMLElement>('.gemini-turn-body')!;

  // System prompt — collapsed details block, only added on first sight.
  if (turn.systemPrompt && !card.querySelector('.gemini-system-prompt')) {
    const det = document.createElement('details');
    det.className = 'gemini-system-prompt';
    const summary = document.createElement('summary');
    summary.textContent = `system prompt (${turn.systemPrompt.length.toLocaleString()} chars)`;
    const pre = document.createElement('pre');
    pre.textContent = turn.systemPrompt;
    det.appendChild(summary);
    det.appendChild(pre);
    body.appendChild(det);
  }

  // User prompt block intentionally not rendered here — the chat-history
  // bubble above the LIVE card already shows the participant's words.
  // GeminiTurn.userPrompt is still emitted in case other surfaces need it.

  // FACE ACTIVITY (live) — surfaces the per-turn snippet that main
  // injected into Gemini's context (e.g. "Currently smiling. Brows
  // raised 3s ago."). Only added on first sight so retry-followup
  // events don't duplicate it.
  if (turn.faceActivity && !card.querySelector('.gemini-face-activity')) {
    const faceDiv = document.createElement('div');
    faceDiv.className = 'gemini-face-activity';
    faceDiv.textContent = `face: ${turn.faceActivity}`;
    body.appendChild(faceDiv);
  }

  // Response text and tool calls — each emission produces a new section
  // so retry-followup responses appear below their pushResults. The
  // `kind` field labels each emission so the user can see at a glance:
  //   - 'initial'              → first response (text streamed to TTS)
  //   - 'post-tool-spoken'     → post-tool text that WAS spoken (filler-cover case)
  //   - 'post-tool-dropped'    → post-tool text dropped from speech (one-response-per-turn rule)
  if (turn.responseText || (turn.toolCalls && turn.toolCalls.length > 0)) {
    const kind = turn.kind ?? 'initial';
    const respDiv = document.createElement('div');
    respDiv.className = `gemini-response gemini-response-${kind}`;

    // Role label with kind annotation so it's obvious what the emission
    // is doing in the turn flow.
    let kindLabel = '';
    if (kind === 'initial') kindLabel = ' · initial → TTS';
    else if (kind === 'post-tool-spoken') kindLabel = ' · post-tool → TTS';
    else if (kind === 'post-tool-dropped') kindLabel = ' · post-tool · not spoken';
    respDiv.innerHTML = `<div class="gemini-role">Gemini${kindLabel}</div>`;

    if (turn.responseText) {
      const textDiv = document.createElement('div');
      textDiv.className = 'gemini-text';
      textDiv.textContent = turn.responseText;
      respDiv.appendChild(textDiv);
    }

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      const callsDiv = document.createElement('div');
      callsDiv.className = 'gemini-tool-calls';
      for (const tc of turn.toolCalls) {
        callsDiv.appendChild(renderToolCall(tc));
      }
      respDiv.appendChild(callsDiv);
    }
    body.appendChild(respDiv);
  }

  // Push results — append each as a row.
  if (turn.pushResults && turn.pushResults.length > 0) {
    const resultsDiv = document.createElement('div');
    resultsDiv.className = 'gemini-push-results';
    for (const pr of turn.pushResults) {
      resultsDiv.appendChild(renderPushResult(pr));
    }
    body.appendChild(resultsDiv);
  }

  // Multi-frame temporal capture — what Gemini saw across the energy
  // envelope (idle / peak / afterglow). Stacked vertically with labels.
  if (turn.screenshots && turn.screenshots.length > 0) {
    const stripDiv = document.createElement('div');
    stripDiv.className = 'gemini-screenshot gemini-screenshot-strip';
    const role = document.createElement('div');
    role.className = 'gemini-role';
    role.textContent = `Visual feedback (${turn.screenshots.length} frames)`;
    stripDiv.appendChild(role);
    if (turn.screenshots[0]?.caption) {
      const cap = document.createElement('div');
      cap.className = 'gemini-screenshot-caption';
      cap.textContent = turn.screenshots[0].caption;
      stripDiv.appendChild(cap);
    }
    for (const shot of turn.screenshots) {
      const frameDiv = document.createElement('div');
      frameDiv.className = 'gemini-screenshot-frame';
      if (shot.label) {
        const lbl = document.createElement('div');
        lbl.className = 'gemini-screenshot-label';
        lbl.textContent = shot.label;
        frameDiv.appendChild(lbl);
      }
      const img = document.createElement('img');
      img.className = 'gemini-screenshot-img';
      img.src = `data:image/png;base64,${shot.base64}`;
      img.width = shot.width;
      img.height = shot.height;
      frameDiv.appendChild(img);
      stripDiv.appendChild(frameDiv);
    }
    body.appendChild(stripDiv);
  }

  // Single screenshot — legacy / non-temporal paths.
  if (turn.screenshot) {
    const shotDiv = document.createElement('div');
    shotDiv.className = 'gemini-screenshot';
    const role = document.createElement('div');
    role.className = 'gemini-role';
    role.textContent = 'Screenshot';
    shotDiv.appendChild(role);
    if (turn.screenshot.caption) {
      const cap = document.createElement('div');
      cap.className = 'gemini-screenshot-caption';
      cap.textContent = turn.screenshot.caption;
      shotDiv.appendChild(cap);
    }
    const img = document.createElement('img');
    img.className = 'gemini-screenshot-img';
    img.src = `data:image/png;base64,${turn.screenshot.base64}`;
    img.width = turn.screenshot.width;
    img.height = turn.screenshot.height;
    shotDiv.appendChild(img);
    body.appendChild(shotDiv);
  }

  // Retry marker — visual divider before the next response.
  if (turn.retry) {
    body.appendChild(renderRetryMarker(turn.retry));
  }

  // Final marker — purely cosmetic; could be used to "lock" the card.
  if (turn.final) {
    card.classList.add('final');
  }

  const conversation = document.getElementById('merlin-conversation');
  if (conversation) conversation.scrollTop = conversation.scrollHeight;
}

function renderToolCall(tc: GeminiToolCall): HTMLElement {
  const row = document.createElement('div');
  row.className = 'gemini-tool-call';
  const argsSummary = summarizeToolArgs(tc.args);
  row.innerHTML = `<span class="gemini-tool-glyph">⊳</span> <span class="gemini-tool-name">${escapeHtml(tc.name)}</span>`;
  if (argsSummary) {
    const argsSpan = document.createElement('span');
    argsSpan.className = 'gemini-tool-call-args';
    argsSpan.textContent = ` ${argsSummary}`;
    row.appendChild(argsSpan);
  }
  return row;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  // Compact one-line summary for the row header. Long fields (glsl_code,
  // descriptions, full programs) are elided here and shown on click via
  // a "details" expansion if we add it later.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const short = v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
      parts.push(`${k}=${short}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else if (v && typeof v === 'object') {
      parts.push(`${k}={…}`);
    }
    if (parts.join(', ').length > 100) break;
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

function renderPushResult(pr: GeminiPushResult): HTMLElement {
  const row = document.createElement('div');
  row.className = `gemini-push-result ${pr.success ? 'success' : 'error'}`;
  const label = pr.zone ?? pr.label ?? 'unknown';
  const glyph = pr.success ? '✓' : '✗';
  row.textContent = `TD: ${glyph} ${label}${pr.error ? ` — ${pr.error}` : ''}`;
  return row;
}

function renderRetryMarker(r: GeminiRetryMarker): HTMLElement {
  const div = document.createElement('div');
  div.className = 'gemini-retry-marker';
  const zone = r.zone ? ` — ${r.zone}` : '';
  div.textContent = `↻ retry ${r.attempt}/${r.total}${zone}`;
  return div;
}
