import type { MerlinUIUpdate, SpellState } from '../shared/types';

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Map internal MerlinPhase to participant-facing label for the sidebar.
 * Internal names stay unchanged to keep tests + persistence stable; only
 * the display label collapses the multi-turn arc into the
 * Attract / Interaction / Cast / Play / Outro vocabulary the client
 * uses.
 */
export function displayPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
    case 'wake':
      return 'Attract';
    case 'intro':
    case 'discovery':
    case 'formation':
    case 'ready_to_cast':
      return 'Interaction';
    case 'casting':
      return 'Cast';
    case 'play':
      return 'Play';
    case 'outro':
      return 'Outro';
    default:
      return capitalize(phase);
  }
}

export function updateMerlinUI(update: MerlinUIUpdate): void {
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('merlin-panel');
  const header = document.getElementById('merlin-header');
  const phaseSpan = document.getElementById('merlin-phase');
  const turnSpan = document.getElementById('merlin-turn');
  const voiceStatus = document.getElementById('merlin-voice-status');

  if (!sidebar || !panel) return;

  if (phaseSpan) phaseSpan.textContent = displayPhaseLabel(update.phase);
  if (turnSpan) turnSpan.textContent = update.turnCount.toString();

  updateMerlinSpellUI(update.spell);

  if (header && update.spell.element) {
    header.className = `merlin-header element-${update.spell.element}`;
  }

  if (voiceStatus) {
    if (update.isProcessing) {
      voiceStatus.textContent = 'Processing...';
      voiceStatus.className = 'merlin-voice-status processing';
    } else if (update.isListening) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'merlin-voice-status listening';
    } else if (update.phase === 'idle') {
      voiceStatus.textContent = 'Shift+M to begin';
      voiceStatus.className = 'merlin-voice-status';
    } else {
      voiceStatus.textContent = 'Ready';
      voiceStatus.className = 'merlin-voice-status';
    }
  }

  if (update.lastMessage) {
    addMerlinMessage(update.lastMessage.role, update.lastMessage.content);
  }
}

export function updateMerlinSpellUI(spell: SpellState): void {
  const intentEl = document.getElementById('spell-intent');
  const elementEl = document.getElementById('spell-element');
  const originEl = document.getElementById('spell-origin');
  const magicWordEl = document.getElementById('spell-magic-word');
  const confidenceFill = document.getElementById('spell-confidence-fill');

  if (intentEl) {
    intentEl.textContent = spell.intent ? capitalize(spell.intent) : '-';
    intentEl.classList.toggle('empty', !spell.intent);
  }
  if (elementEl) {
    elementEl.textContent = spell.element ? capitalize(spell.element) : '-';
    elementEl.classList.toggle('empty', !spell.element);
  }
  if (originEl) {
    const origin = spell.castingOrigin?.replace(/_/g, ' ');
    originEl.textContent = origin ? capitalize(origin) : '-';
    originEl.classList.toggle('empty', !spell.castingOrigin);
  }
  if (magicWordEl) {
    magicWordEl.textContent = spell.magicWord ?? '-';
    magicWordEl.classList.toggle('empty', !spell.magicWord);
  }
  if (confidenceFill) {
    confidenceFill.style.width = `${Math.round(spell.confidence * 100)}%`;
  }
}

export function addMerlinMessage(role: 'user' | 'assistant', content: string): void {
  const conversation = document.getElementById('merlin-conversation');
  if (!conversation) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `merlin-message ${role}`;

  // Build with textContent so Gemini/user-supplied content can't inject HTML.
  const roleDiv = document.createElement('div');
  roleDiv.className = 'merlin-message-role';
  roleDiv.textContent = role === 'user' ? 'You' : 'Merlin';
  msgDiv.appendChild(roleDiv);

  const contentDiv = document.createElement('div');
  contentDiv.textContent = content;
  msgDiv.appendChild(contentDiv);

  conversation.appendChild(msgDiv);
  conversation.scrollTop = conversation.scrollHeight;
}

export function clearMerlinUI(): void {
  const conversation = document.getElementById('merlin-conversation');
  if (conversation) conversation.innerHTML = '';

  const emptySpell: SpellState = {
    intent: null,
    element: null,
    tone: null,
    energy: 0.3,
    complexity: 0.2,
    castingOrigin: null,
    visualArchetype: null,
    palette: null,
    magicWord: null,
    confidence: 0,
  };
  updateMerlinSpellUI(emptySpell);
}

export function updateMerlinSpeakingIndicator(
  speaking: boolean,
  merlinModeActive: boolean,
  merlinIsListening: boolean,
): void {
  const voiceStatus = document.getElementById('merlin-voice-status');
  if (voiceStatus && merlinModeActive) {
    if (speaking) {
      voiceStatus.textContent = 'Speaking...';
      voiceStatus.className = 'merlin-voice-status speaking';
    } else if (merlinIsListening) {
      voiceStatus.textContent = 'Listening...';
      voiceStatus.className = 'merlin-voice-status listening';
    }
  }
}
