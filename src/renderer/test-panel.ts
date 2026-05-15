import type {
  MicroExpressionAnalysis,
  BodyLanguageAnalysis,
  SpriteTestSpec,
  SpriteTestResult,
  SpriteFrameCount,
  SpritePlaybackMode,
  SpriteDriveSource,
  SpriteFlipbookConfig,
  FlipbookTestResult,
  MirroredTDState,
  SpellState,
  LiveSpellTestInput,
  LiveSpellTestResult,
  GeminiTurn,
  ConversationTurnSnapshot,
} from '../shared/types';
import { SHADER_TEST_PRESETS } from '../shared/test-shader-presets';
import { LIVE_SPELL_PRESETS } from '../shared/live-spell-presets';
import { CONVERSATION_TEST_PRESETS } from '../shared/conversation-test-presets';
import { escapeHtml } from './gemini-sidebar';
import { clearMerlinUI, addMerlinMessage } from './merlin-ui';

// Injected via initTestPanel — avoids circular dependency with main.ts.
let getMerlinActive: () => boolean = () => false;
let doStopMerlinMode: () => Promise<void> = async () => {};

export function initTestPanel(opts: {
  getMerlinActive: () => boolean;
  stopMerlinMode: () => Promise<void>;
}): void {
  getMerlinActive = opts.getMerlinActive;
  doStopMerlinMode = opts.stopMerlinMode;
}

// ============ TEST SHADER PANEL ============

let testShaderPanelVisible = false;
let lastFlipbookMirror: MirroredTDState | null = null;

// ============ CONVERSATION TESTER ============

let conversationRunActive = false;
let conversationRunStopRequested = false;

// Mutes TTS during scripted conversation runs so the full conversation
// walks through in seconds. The chunk handler and post-turn spokenText
// handler in main.ts both early-return when this is true.
let testModeMuteTts = false;

export function isTestModeMuted(): boolean { return testModeMuteTts; }
export function isTestPanelVisible(): boolean { return testShaderPanelVisible; }

export function toggleTestShaderPanel(): void {
  if (testShaderPanelVisible) {
    hideTestShaderPanel();
  } else {
    showTestShaderPanel();
  }
}

export function showTestShaderPanel(): void {
  let panel = document.getElementById('test-shader-panel');

  if (!panel) {
    panel = createTestShaderPanel();
    document.body.appendChild(panel);
  }

  panel.classList.add('visible');
  testShaderPanelVisible = true;

  // Auto-open the Merlin sidebar so test-mode Gemini activity is visible.
  const sidebar = document.getElementById('sidebar');
  const merlinPanel = document.getElementById('merlin-panel');
  sidebar?.classList.add('merlin-active');
  merlinPanel?.classList.add('active');
}

export function hideTestShaderPanel(): void {
  const panel = document.getElementById('test-shader-panel');
  if (panel) {
    panel.classList.remove('visible');
  }
  testShaderPanelVisible = false;

  // Restore the regular sidebar UNLESS a live Merlin session is active —
  // in that case the sidebar should stay in Merlin mode for the live
  // conversation.
  if (!getMerlinActive()) {
    const sidebar = document.getElementById('sidebar');
    const merlinPanel = document.getElementById('merlin-panel');
    sidebar?.classList.remove('merlin-active');
    merlinPanel?.classList.remove('active');
  }
}

export function handleZoneCompileResult(result: { zone: string; success: boolean; error?: string }): void {
  const zoneResult = document.querySelector(`.shader-zone-result[data-zone="${result.zone}"]`);
  if (!zoneResult) return;

  const statusIndicator = zoneResult.querySelector('.zone-status');
  if (statusIndicator) {
    statusIndicator.className = `zone-status ${result.success ? 'active' : 'error'}`;
  }

  const existingError = zoneResult.querySelector('.zone-error');
  if (result.success) {
    existingError?.remove();
  } else if (result.error && !existingError) {
    const header = zoneResult.querySelector('.zone-header');
    if (header) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'zone-error';
      errorDiv.textContent = result.error;
      header.insertAdjacentElement('afterend', errorDiv);
    }
  }
}

function createTestShaderPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'test-shader-panel';
  panel.className = 'test-shader-panel';

  // Shader preset dropdown options
  const presetOptions = [
    `<option value="">Custom (type your own)</option>`,
    ...SHADER_TEST_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`),
  ].join('');

  // Marker-bearing zones for the Shaders tab.
  const shaderZones = [
    'force_field',
    'color_over_life',
    'size_over_life',
    'spawn_behavior',
    'velocity_modifier',
    'post_fx',
    'billboard_pixel',
    'billboard_vertex',
  ];
  const zoneCheckboxes = shaderZones
    .map(z => `<label class="zone-checkbox-label"><input type="checkbox" data-zone="${z}" checked> ${z}</label>`)
    .join('');

  // Casting origin options for the Spell Program tab.
  const castingOrigins = ['hands', 'heart', 'eyes', 'whole_body', 'wand'];
  const castingOriginOptions = castingOrigins
    .map(o => `<option value="${o}">${o}</option>`)
    .join('');
  void castingOriginOptions; // declared but only used for future extension

  // Sprite dropdowns
  const frameCountOptions = [4, 8, 9, 12, 16]
    .map(n => `<option value="${n}"${n === 16 ? ' selected' : ''}>${n}</option>`)
    .join('');
  const playbackOptions = ['loop', 'once', 'pingpong', 'random']
    .map(m => `<option value="${m}">${m}</option>`)
    .join('');
  const driveOptions = ['age', 'life', 'velocity', 'id', 'time']
    .map(d => `<option value="${d}">${d}</option>`)
    .join('');

  panel.innerHTML = `
    <div class="test-shader-header">
      <h3>Test Mode</h3>
      <div class="test-shader-tabs">
        <button class="test-shader-tab active" data-tab="shaders">Shaders</button>
        <button class="test-shader-tab" data-tab="sprites">Sprites</button>
        <button class="test-shader-tab" data-tab="flipbook">Flipbook</button>
        <button class="test-shader-tab" data-tab="live-spell">Live Spell</button>
        <button class="test-shader-tab" data-tab="conversation">Conversation</button>
        <button class="test-shader-tab" data-tab="sessions">Sessions</button>
      </div>
      <button class="close-btn">×</button>
    </div>

    <div class="test-shader-tab-content" data-tab="shaders">
      <div class="test-shader-config">
        <div class="config-row preset-row">
          <label>Preset:</label>
          <select id="test-preset">${presetOptions}</select>
        </div>
        <div class="config-row">
          <label>Spell:</label>
          <textarea id="test-prompt" rows="3" placeholder="A fire eruption spell — intense confidence, scorching orange plasma blasting upward from the chest"></textarea>
        </div>
        <div class="config-row zones-row">
          <label>Zones:</label>
          <div class="zone-checkboxes">${zoneCheckboxes}</div>
        </div>
        <button id="generate-shaders-btn" class="generate-btn">Generate Shaders</button>
      </div>
      <div id="test-shader-status" class="test-shader-status"></div>
      <div id="test-shader-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="sprites" style="display: none;">
      <div class="sprite-mode-toggle">
        <label><input type="radio" name="sprite-mode" value="direct" checked> Direct Spec</label>
        <label><input type="radio" name="sprite-mode" value="gemini"> Gemini Interpretation</label>
      </div>

      <div class="test-shader-config sprite-direct-form">
        <div class="config-row">
          <label>Description:</label>
          <input type="text" id="sprite-description" placeholder="glowing blue orb">
        </div>
        <div class="config-row">
          <label>Style:</label>
          <input type="text" id="sprite-style" placeholder="soft glow">
        </div>
        <div class="config-row">
          <label>Animation:</label>
          <input type="text" id="sprite-animation" placeholder="(blank = single sprite)">
        </div>
        <div class="config-row">
          <label>Frames:</label>
          <select id="sprite-frame-count">${frameCountOptions}</select>
        </div>
        <div class="config-row">
          <label>Playback:</label>
          <select id="sprite-playback">${playbackOptions}</select>
        </div>
        <div class="config-row">
          <label>Drive:</label>
          <select id="sprite-drive">${driveOptions}</select>
        </div>
        <div class="config-row">
          <label>Frame dur:</label>
          <input type="number" id="sprite-frame-duration" value="0.1" step="0.01" min="0.001">
        </div>
        <button id="generate-sprite-btn" class="generate-btn">Generate Sprite</button>
      </div>

      <div class="test-shader-config sprite-gemini-form" style="display: none;">
        <div class="config-row">
          <label>Prompt:</label>
          <textarea id="sprite-gemini-prompt" rows="3" placeholder="a slow-pulsing protective shield, 9 frames, plays once"></textarea>
        </div>
        <button id="generate-sprite-gemini-btn" class="generate-btn">Interpret &amp; Generate</button>
      </div>

      <div id="sprite-status" class="test-shader-status"></div>
      <div id="sprite-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="flipbook" style="display: none;">
      <div class="test-shader-config flipbook-reconfig-form">
        <div class="config-row">
          <label>Playback:</label>
          <select id="rm-playback">${playbackOptions}</select>
        </div>
        <div class="config-row">
          <label>Drive:</label>
          <select id="rm-drive">${driveOptions}</select>
        </div>
        <div class="config-row">
          <label>Frame dur:</label>
          <input type="number" id="rm-frame-duration" value="0.1" step="0.01" min="0.001">
        </div>
        <button id="rm-apply-flipbook-btn" class="generate-btn">Apply Flipbook Config</button>
      </div>

      <div id="rm-status" class="test-shader-status"></div>

      <div class="sprite-state-readout" id="rm-readout">
        <div class="readout-title">Last pushed to TD</div>
        <div class="readout-grid" id="rm-readout-grid"></div>
      </div>
    </div>

    <div class="test-shader-tab-content" data-tab="live-spell" style="display: none;">
      <div class="test-shader-config spell-program-form">
        <div class="config-row">
          <label>Preset:</label>
          <select id="ls-preset">
            <option value="">Custom (type your own)</option>
            ${LIVE_SPELL_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="config-row">
          <label>Describe a spell:</label>
          <textarea id="ls-prompt" rows="3" placeholder="a slow-pulsing protective shield that explodes outward at release"></textarea>
        </div>
        <button id="ls-run-btn" class="generate-btn">Run Full Creative Process</button>
      </div>

      <div id="ls-status" class="test-shader-status"></div>
      <div id="ls-results" class="test-shader-results"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="conversation" style="display: none;">
      <div class="test-shader-config conversation-form">
        <div class="config-row">
          <label>Character:</label>
          <select id="cv-preset">
            ${CONVERSATION_TEST_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="config-row conversation-opts">
          <label class="conversation-opt"><input type="checkbox" id="cv-mute-tts" checked> Mute TTS</label>
          <label class="conversation-opt"><input type="checkbox" id="cv-claude-driven" checked> Claude-driven (in-character)</label>
          <label class="conversation-opt">Pause (s): <input type="number" id="cv-pause" value="1.0" step="0.1" min="0" style="width: 60px"></label>
        </div>
        <div class="conversation-buttons">
          <button id="cv-run-btn" class="generate-btn">Run Script</button>
          <button id="cv-stop-btn" class="generate-btn" disabled>Stop</button>
          <button id="cv-copy-btn" class="generate-btn" disabled>Copy Transcript</button>
        </div>
      </div>
      <div id="cv-preview" class="conversation-preview"></div>
      <div id="cv-status" class="test-shader-status"></div>
      <div id="cv-transcript" class="conversation-transcript"></div>
    </div>

    <div class="test-shader-tab-content" data-tab="sessions" style="display: none;">
      <div class="test-shader-config">
        <div class="config-row">
          <label>Name (optional):</label>
          <input type="text" id="session-name-input" placeholder="e.g. blue fire shield">
        </div>
        <button id="session-save-btn" class="generate-btn">Save Current Session</button>
        <p class="session-note">Note: sprite texture is not saved — particle texture will default to placeholder after loading.</p>
      </div>
      <div id="session-status" class="test-shader-status"></div>
      <div id="session-list" class="test-shader-results"></div>
    </div>
  `;

  // === Shader tab event listeners ===
  const presetSelect = panel.querySelector('#test-preset') as HTMLSelectElement;
  const promptTextarea = panel.querySelector('#test-prompt') as HTMLTextAreaElement;
  presetSelect.addEventListener('change', () => {
    const preset = SHADER_TEST_PRESETS.find(p => p.id === presetSelect.value);
    if (preset) promptTextarea.value = preset.prompt;
  });

  const generateBtn = panel.querySelector('#generate-shaders-btn') as HTMLButtonElement;
  generateBtn.addEventListener('click', runTestShaderGeneration);

  // === Sprites tab event listeners ===
  const directBtn = panel.querySelector('#generate-sprite-btn') as HTMLButtonElement;
  directBtn.addEventListener('click', runSpriteDirect);

  const geminiBtn = panel.querySelector('#generate-sprite-gemini-btn') as HTMLButtonElement;
  geminiBtn.addEventListener('click', runSpriteGemini);

  panel.querySelectorAll('input[name="sprite-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = (radio as HTMLInputElement).value;
      const directForm = panel.querySelector('.sprite-direct-form') as HTMLElement;
      const geminiForm = panel.querySelector('.sprite-gemini-form') as HTMLElement;
      directForm.style.display = mode === 'direct' ? '' : 'none';
      geminiForm.style.display = mode === 'gemini' ? '' : 'none';
    });
  });

  // === Flipbook tab event listeners ===
  const applyFlipbookBtn = panel.querySelector('#rm-apply-flipbook-btn') as HTMLButtonElement;
  applyFlipbookBtn.addEventListener('click', runApplyFlipbookConfig);

  // === Live Spell tab event listeners ===
  const lsRunBtn = panel.querySelector('#ls-run-btn') as HTMLButtonElement;
  lsRunBtn.addEventListener('click', runLiveSpell);

  const lsPresetSelect = panel.querySelector('#ls-preset') as HTMLSelectElement;
  const lsPromptEl = panel.querySelector('#ls-prompt') as HTMLTextAreaElement;
  lsPresetSelect.addEventListener('change', () => {
    const preset = LIVE_SPELL_PRESETS.find(p => p.id === lsPresetSelect.value);
    if (preset) lsPromptEl.value = preset.prompt;
  });

  // === Conversation tab event listeners ===
  const cvPresetSelect = panel.querySelector('#cv-preset') as HTMLSelectElement;
  const cvPreviewEl = panel.querySelector('#cv-preview') as HTMLDivElement;
  const renderPreview = () => {
    const preset = CONVERSATION_TEST_PRESETS.find(p => p.id === cvPresetSelect.value);
    if (!preset) {
      cvPreviewEl.innerHTML = '';
      return;
    }
    const spellLine = preset.expectedSpell
      ? `<div class="cv-preview-meta">expected: ${escapeHtml(preset.expectedSpell.intent)} / ${escapeHtml(preset.expectedSpell.element)}</div>`
      : '';
    const faceLine = preset.expectedFace?.primaryEmotion
      ? `<div class="cv-preview-meta">face: ${escapeHtml(preset.expectedFace.primaryEmotion)}${preset.expectedFace.secondaryEmotion ? ' + ' + escapeHtml(preset.expectedFace.secondaryEmotion) : ''}</div>`
      : '';
    const bodyLine = preset.expectedBody?.primaryPosture
      ? `<div class="cv-preview-meta">body: ${escapeHtml(preset.expectedBody.primaryPosture)}</div>`
      : '';
    cvPreviewEl.innerHTML = `
      <div class="cv-preview-desc">${escapeHtml(preset.description)}</div>
      ${spellLine}
      ${faceLine}
      ${bodyLine}
      <ol class="cv-preview-script">
        ${preset.script.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
      </ol>
    `;
  };
  cvPresetSelect.addEventListener('change', renderPreview);
  // Initial fill — the first option is selected by default.
  renderPreview();

  const cvRunBtn = panel.querySelector('#cv-run-btn') as HTMLButtonElement;
  const cvStopBtn = panel.querySelector('#cv-stop-btn') as HTMLButtonElement;
  const cvCopyBtn = panel.querySelector('#cv-copy-btn') as HTMLButtonElement;
  cvRunBtn.addEventListener('click', () => runConversationFromPanel(panel));
  cvStopBtn.addEventListener('click', () => requestConversationStop());
  void cvCopyBtn; // wired up after a run completes inside runConversationFromPanel

  // === Sessions tab event listeners ===
  const sessionSaveBtn = panel.querySelector('#session-save-btn') as HTMLButtonElement;
  sessionSaveBtn.addEventListener('click', async () => {
    const nameInput = panel.querySelector('#session-name-input') as HTMLInputElement;
    const statusDiv = panel.querySelector('#session-status') as HTMLDivElement;
    const name = nameInput.value.trim() || undefined;
    statusDiv.textContent = 'Saving…';
    const result = await window.electronAPI.merlinSaveSession(name);
    if (result.success) {
      statusDiv.textContent = `Saved (${result.sessionId})`;
      nameInput.value = '';
      await refreshSessionList(panel);
    } else {
      statusDiv.textContent = `Error: ${result.error}`;
    }
  });

  // === Tab switching ===
  panel.querySelectorAll('.test-shader-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const tabName = (tabBtn as HTMLButtonElement).dataset.tab;
      panel.querySelectorAll('.test-shader-tab').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      panel.querySelectorAll('.test-shader-tab-content').forEach(content => {
        const el = content as HTMLElement;
        el.style.display = el.dataset.tab === tabName ? '' : 'none';
      });
      if (tabName === 'flipbook') {
        refreshFlipbookTabFromMirror();
      }
      if (tabName === 'sessions') {
        refreshSessionList(panel);
      }
    });
  });

  // Close handler — route through hideTestShaderPanel so the sidebar
  // is restored cleanly when no live session is active.
  const closeBtn = panel.querySelector('.close-btn') as HTMLButtonElement;
  closeBtn.addEventListener('click', () => {
    hideTestShaderPanel();
  });

  return panel;
}

async function runTestShaderGeneration(): Promise<void> {
  const promptTextarea = document.getElementById('test-prompt') as HTMLTextAreaElement;
  const statusDiv = document.getElementById('test-shader-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('test-shader-results') as HTMLDivElement;
  const generateBtn = document.getElementById('generate-shaders-btn') as HTMLButtonElement;

  const prompt = promptTextarea.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Enter a spell description';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  // Gather selected zones from the checkbox grid
  const zoneCheckboxes = document.querySelectorAll<HTMLInputElement>(
    '.zone-checkboxes input[type="checkbox"]'
  );
  const zones = Array.from(zoneCheckboxes)
    .filter(c => c.checked)
    .map(c => c.dataset.zone || '');

  if (zones.length === 0) {
    statusDiv.textContent = 'Pick at least one zone';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  const config = { prompt, zones };

  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  statusDiv.textContent = `Generating ${zones.length} zone(s)...`;
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestShader(config);

    if (result.success) {
      statusDiv.textContent = `Generated ${result.zones.length} zone shaders`;
      statusDiv.className = 'test-shader-status success';
    } else {
      statusDiv.textContent = result.error || 'Failed to generate shaders';
      statusDiv.className = 'test-shader-status error';
    }

    resultsDiv.innerHTML = result.zones.map(zone => `
      <div class="shader-zone-result" data-zone="${zone.zone}">
        <div class="zone-header">
          <span class="zone-status ${zone.status || 'pending'}"></span>
          <span class="zone-name">${zone.zone}</span>
          <span class="zone-desc">${zone.description}</span>
        </div>
        ${zone.error ? `<div class="zone-error">${escapeHtml(zone.error)}</div>` : ''}
        ${zone.warnings?.length ? `<div class="zone-warnings">${zone.warnings.map(w => escapeHtml(w)).join('<br>')}</div>` : ''}
        <pre class="zone-glsl">${escapeHtml(zone.glsl_code)}</pre>
      </div>
    `).join('');

  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  generateBtn.disabled = false;
  generateBtn.textContent = 'Generate Shaders';
}

function readSpriteSpecFromForm(): SpriteTestSpec | null {
  const description = (document.getElementById('sprite-description') as HTMLInputElement).value.trim();
  if (!description) return null;

  const style = (document.getElementById('sprite-style') as HTMLInputElement).value.trim();
  const animation = (document.getElementById('sprite-animation') as HTMLInputElement).value.trim();
  const frameCount = parseInt((document.getElementById('sprite-frame-count') as HTMLSelectElement).value, 10) as SpriteFrameCount;
  const playbackMode = (document.getElementById('sprite-playback') as HTMLSelectElement).value as SpritePlaybackMode;
  const driveSource = (document.getElementById('sprite-drive') as HTMLSelectElement).value as SpriteDriveSource;
  const frameDuration = parseFloat((document.getElementById('sprite-frame-duration') as HTMLInputElement).value);

  const spec: SpriteTestSpec = { description };
  if (style) spec.style = style;
  if (animation) spec.animation = animation;
  // Only include flipbook params when there's an animation; single-sprite path ignores them.
  if (animation) {
    spec.frameCount = frameCount;
    spec.playbackMode = playbackMode;
    spec.driveSource = driveSource;
    if (!isNaN(frameDuration)) spec.frameDuration = frameDuration;
  }
  return spec;
}

async function runSpriteDirect(): Promise<void> {
  const btn = document.getElementById('generate-sprite-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('sprite-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('sprite-results') as HTMLDivElement;

  const spec = readSpriteSpecFromForm();
  if (!spec) {
    statusDiv.textContent = 'Description is required';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';
  statusDiv.textContent = `Generating ${spec.animation ? 'flipbook' : 'sprite'}: "${spec.description}"...`;
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestSpriteDirect(spec);
    renderSpriteResult(result, statusDiv, resultsDiv);
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Generate Sprite';
}

async function runSpriteGemini(): Promise<void> {
  const btn = document.getElementById('generate-sprite-gemini-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('sprite-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('sprite-results') as HTMLDivElement;
  const promptEl = document.getElementById('sprite-gemini-prompt') as HTMLTextAreaElement;

  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Prompt is required';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Interpreting...';
  statusDiv.textContent = 'Asking Gemini to choose sprite parameters...';
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result = await window.electronAPI.merlinTestSpriteGemini(prompt);
    renderSpriteResult(result, statusDiv, resultsDiv);
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Interpret & Generate';
}

function renderSpriteResult(
  result: SpriteTestResult,
  statusDiv: HTMLDivElement,
  resultsDiv: HTMLDivElement
): void {
  if (!result.success) {
    statusDiv.textContent = result.error || 'Generation failed';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  if (result.pushed.texture === false) {
    statusDiv.textContent = 'Generated, but TD not connected — texture not pushed';
    statusDiv.className = 'test-shader-status error';
  } else {
    statusDiv.textContent = `Generated ${result.assetType} sprite (${result.assetId})`;
    statusDiv.className = 'test-shader-status success';
  }

  const parts: string[] = [];

  if (result.geminiArgs) {
    parts.push(`
      <div class="gemini-args">
        <div class="gemini-args-title">Gemini chose:</div>
        <pre>${escapeHtml(JSON.stringify(result.geminiArgs, null, 2))}</pre>
      </div>
    `);
  }

  if (result.previewPng) {
    parts.push(`
      <div class="sprite-preview">
        <img src="data:image/png;base64,${result.previewPng}" alt="generated sprite" />
      </div>
    `);
  }

  const meta: Array<[string, string]> = [
    ['assetId', result.assetId ?? '-'],
    ['assetType', result.assetType ?? '-'],
    ['texturePath', result.texturePath ?? '-'],
    ['texturePushed', String(result.pushed.texture)],
  ];
  if (result.assetType === 'flipbook' && result.flipbookConfig) {
    meta.push(['atlas', `${result.flipbookConfig.atlasCols}x${result.flipbookConfig.atlasRows}`]);
    meta.push(['frameCount', String(result.flipbookConfig.frameCount)]);
    meta.push(['playbackMode', result.flipbookConfig.playbackMode]);
    meta.push(['frameDuration', String(result.flipbookConfig.frameDuration)]);
    meta.push(['driveSource', result.flipbookConfig.driveSource]);
    meta.push(['flipbookPushed', String(result.pushed.flipbook)]);
  }

  parts.push(`
    <div class="sprite-meta">
      ${meta.map(([k, v]) => `<div><span class="meta-key">${k}:</span> <span class="meta-value">${escapeHtml(v)}</span></div>`).join('')}
    </div>
  `);

  resultsDiv.innerHTML = parts.join('');
}

// ============ FLIPBOOK TAB ============

async function refreshSessionList(panel: HTMLElement): Promise<void> {
  const listDiv = panel.querySelector('#session-list') as HTMLDivElement;
  if (!listDiv) return;
  try {
    const sessions = await window.electronAPI.merlinListSessions();
    if (sessions.length === 0) {
      listDiv.innerHTML = '<p class="session-empty">No saved sessions.</p>';
      return;
    }
    listDiv.innerHTML = sessions.map(s => {
      const label = s.name || new Date(s.timestamp).toLocaleString();
      const meta = [s.spellIntent, s.spellElement, `${s.zoneCount} zone${s.zoneCount !== 1 ? 's' : ''}`]
        .filter(Boolean).join(' · ');
      return `
        <div class="session-row" data-id="${escapeHtml(s.sessionId)}">
          <div class="session-row-label">
            <strong>${escapeHtml(label)}</strong>
            <span class="session-meta">${escapeHtml(meta)}</span>
          </div>
          <div class="session-row-actions">
            <button class="session-load-btn" data-id="${escapeHtml(s.sessionId)}">Load</button>
            <button class="session-delete-btn" data-id="${escapeHtml(s.sessionId)}">Delete</button>
          </div>
        </div>`;
    }).join('');

    listDiv.querySelectorAll('.session-load-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLButtonElement).dataset.id!;
        const statusDiv = panel.querySelector('#session-status') as HTMLDivElement;
        statusDiv.textContent = 'Loading…';
        const result = await window.electronAPI.merlinLoadSession(id);
        if (result.success) {
          const zonesSummary = Object.entries(result.zoneResults ?? {})
            .map(([z, ok]) => `${z}:${ok ? '✓' : '✗'}`).join(' ');
          statusDiv.textContent = `Loaded. Zones: ${zonesSummary || 'none'}`;
        } else {
          statusDiv.textContent = `Error: ${result.error}`;
        }
      });
    });

    listDiv.querySelectorAll('.session-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLButtonElement).dataset.id!;
        await window.electronAPI.merlinDeleteSession(id);
        await refreshSessionList(panel);
      });
    });
  } catch (error) {
    listDiv.innerHTML = `<p class="session-empty">Error loading sessions.</p>`;
    console.error('[Sessions] Failed to list sessions:', error);
  }
}

async function refreshFlipbookTabFromMirror(): Promise<void> {
  try {
    const state = await window.electronAPI.merlinTestGetMirroredState();
    paintMirroredState(state);
  } catch (error) {
    console.error('[Flipbook] Failed to fetch mirrored state:', error);
  }
}

function paintMirroredState(state: MirroredTDState): void {
  lastFlipbookMirror = state;

  const setVal = (id: string, value: string | number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(value);
  };

  // Pre-fill the editable fields with current values so Apply doesn't
  // surprise the user by reverting to defaults.
  setVal('rm-frame-duration', state.flipbook.frameDuration);
  const playbackEl = document.getElementById('rm-playback') as HTMLSelectElement | null;
  if (playbackEl) playbackEl.value = state.flipbook.playbackMode;
  const driveEl = document.getElementById('rm-drive') as HTMLSelectElement | null;
  if (driveEl) driveEl.value = state.flipbook.driveSource;

  // Readout grid
  const grid = document.getElementById('rm-readout-grid');
  if (!grid) return;
  const ago = state.lastUpdatedAt ? `${Math.round((Date.now() - state.lastUpdatedAt) / 1000)}s ago` : 'never';
  const rows: Array<[string, string]> = [
    ['atlas', `${state.flipbook.atlasCols} × ${state.flipbook.atlasRows}`],
    ['frame_count', String(state.flipbook.frameCount)],
    ['playback_mode', state.flipbook.playbackMode],
    ['frame_duration', String(state.flipbook.frameDuration)],
    ['drive_source', state.flipbook.driveSource],
    ['last_source', state.lastSource ? `${state.lastSource} (${ago})` : 'never pushed'],
  ];
  grid.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="readout-key">${k}:</div><div class="readout-value">${escapeHtml(v)}</div>`
    )
    .join('');
}

function setFlipbookStatus(text: string, kind: 'loading' | 'success' | 'error'): void {
  const statusDiv = document.getElementById('rm-status') as HTMLDivElement | null;
  if (!statusDiv) return;
  statusDiv.textContent = text;
  statusDiv.className = `test-shader-status ${kind}`;
}

async function runApplyFlipbookConfig(): Promise<void> {
  const atlasCols = lastFlipbookMirror?.flipbook.atlasCols ?? 1;
  const atlasRows = lastFlipbookMirror?.flipbook.atlasRows ?? 1;
  const frameCount = lastFlipbookMirror?.flipbook.frameCount ?? 1;
  const playbackMode = (document.getElementById('rm-playback') as HTMLSelectElement).value as SpritePlaybackMode;
  const driveSource = (document.getElementById('rm-drive') as HTMLSelectElement).value as SpriteDriveSource;
  const frameDuration = parseFloat((document.getElementById('rm-frame-duration') as HTMLInputElement).value);

  const config: SpriteFlipbookConfig = {
    atlasCols,
    atlasRows,
    frameCount,
    playbackMode,
    frameDuration,
    driveSource,
  };

  const btn = document.getElementById('rm-apply-flipbook-btn') as HTMLButtonElement;
  btn.disabled = true;
  setFlipbookStatus('Pushing flipbook_config...', 'loading');

  try {
    const result: FlipbookTestResult = await window.electronAPI.merlinTestFlipbookConfig(config);
    paintMirroredState(result.state);
    if (result.pushed) {
      setFlipbookStatus('flipbook_config applied', 'success');
    } else {
      setFlipbookStatus('TD not connected — flipbook_config not pushed', 'error');
    }
  } catch (error) {
    setFlipbookStatus(`Error: ${error}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ LIVE SPELL TAB ============

async function runLiveSpell(): Promise<void> {
  const btn = document.getElementById('ls-run-btn') as HTMLButtonElement;
  const statusDiv = document.getElementById('ls-status') as HTMLDivElement;
  const resultsDiv = document.getElementById('ls-results') as HTMLDivElement;
  const promptEl = document.getElementById('ls-prompt') as HTMLTextAreaElement;

  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusDiv.textContent = 'Describe a spell first';
    statusDiv.className = 'test-shader-status error';
    return;
  }

  const input: LiveSpellTestInput = { prompt };

  btn.disabled = true;
  btn.textContent = 'Running…';
  statusDiv.textContent = 'Gemini is creating the spell — watch the sidebar for tool calls';
  statusDiv.className = 'test-shader-status loading';
  resultsDiv.innerHTML = '';

  try {
    const result: LiveSpellTestResult = await window.electronAPI.merlinTestLiveSpell(input);
    if (result.success) {
      statusDiv.textContent = `Done — ${result.toolCallCount} tool call(s) executed`;
      statusDiv.className = 'test-shader-status success';
      const parts: string[] = [];
      if (result.finalText) {
        parts.push(`<div class="gemini-args"><div class="gemini-args-title">Gemini said:</div><pre>${escapeHtml(result.finalText)}</pre></div>`);
      }
      if (result.finalSpell) {
        parts.push(`<div class="gemini-args"><div class="gemini-args-title">Final spell state:</div><pre>${escapeHtml(JSON.stringify(result.finalSpell, null, 2))}</pre></div>`);
      }
      resultsDiv.innerHTML = parts.join('');
    } else {
      statusDiv.textContent = result.error || 'Run failed';
      statusDiv.className = 'test-shader-status error';
    }
  } catch (error) {
    statusDiv.textContent = `Error: ${error}`;
    statusDiv.className = 'test-shader-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Run Full Creative Process';
}

// ============ CONVERSATION TESTER ============

export interface ConversationRunOpts {
  /** Slug for the saved transcript filename (e.g. preset id or "custom"). */
  id: string;
  character: string;
  script: string[];
  muteTts: boolean;
  pauseMs: number;
  /** Synthetic face analysis pushed before each turn. Replaces MediaPipe. */
  face?: Partial<MicroExpressionAnalysis>;
  /** Synthetic body analysis pushed before each turn. Replaces MediaPipe. */
  body?: Partial<BodyLanguageAnalysis>;
  /**
   * When true, the runner uses the first script line as an opener and
   * then asks Claude (via main IPC) to generate each subsequent
   * participant utterance in-character. Falls back to the canned
   * script silently if the IPC reports no Anthropic key is configured.
   */
  claudeDriven?: boolean;
  /** Used to ask Claude to lean toward this spell shape. */
  expectedSpell?: { intent: string; element: string };
  onTurnComplete: (turn: ConversationTurnSnapshot) => void;
  onStatus: (msg: string) => void;
}

export interface ConversationRunResult {
  snapshots: ConversationTurnSnapshot[];
  transcriptPath?: string;
}

export async function runConversationTest(opts: ConversationRunOpts): Promise<ConversationRunResult> {
  if (conversationRunActive) throw new Error('A conversation test is already running');
  if (getMerlinActive()) {
    opts.onStatus('Stopping live Merlin session before test…');
    await doStopMerlinMode();
    // stopMerlinMode triggers a 3s UI fade — wait a beat so the next
    // start gets a clean slate.
    await new Promise(r => setTimeout(r, 200));
  }

  conversationRunActive = true;
  conversationRunStopRequested = false;
  testModeMuteTts = opts.muteTts;

  // Collect gemini-conversation events emitted between merlinProcessSpeech
  // start and resolution. We tag the start of each turn with a sentinel
  // and pull events that arrived after it.
  const liveEvents: Partial<GeminiTurn>[] = [];
  const removeListener = window.electronAPI.onGeminiConversation((turn) => {
    if (turn.source === 'live') liveEvents.push(turn);
  });

  const snapshots: ConversationTurnSnapshot[] = [];

  // Conversation history for the Claude-as-participant path.
  const history: Array<{ speaker: 'merlin' | 'participant'; text: string }> = [];

  // Indexes of script lines that drive a real conversational turn (i.e.
  // not [CAST] markers). Used to figure out which line is the first
  // conversational turn (use canned opener) and which is the last
  // (tell Claude to wind down).
  const conversationalIdxs = opts.script
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter(({ line }) => line && line !== '[CAST]')
    .map(({ idx }) => idx);
  const firstConversationalIdx = conversationalIdxs[0];
  const lastConversationalIdx = conversationalIdxs[conversationalIdxs.length - 1];

  // Phase + spell flow through the per-call response objects.
  let currentPhase: string;
  let currentSpell: SpellState;
  let claudeAvailable = opts.claudeDriven === true;

  // Make the merlin-conversation sidebar visible so the chat-history
  // bubbles we add per turn are actually seen.
  const sidebarEl = document.getElementById('sidebar');
  const merlinPanelEl = document.getElementById('merlin-panel');
  sidebarEl?.classList.add('merlin-active');
  merlinPanelEl?.classList.add('active');
  clearMerlinUI();

  try {
    opts.onStatus('Starting Merlin session…');
    const intro = await window.electronAPI.merlinStart();
    currentPhase = intro.phase;
    currentSpell = intro.spell;
    if (intro.text) {
      addMerlinMessage('assistant', intro.text);
      history.push({ speaker: 'merlin', text: intro.text });
    }
    // Drain intro-time gemini events so they don't get attributed to turn 1.
    await new Promise(r => setTimeout(r, 50));
    liveEvents.length = 0;

    for (let i = 0; i < opts.script.length; i++) {
      if (conversationRunStopRequested) {
        opts.onStatus('Stopped by user');
        break;
      }
      let line = opts.script[i].trim();
      if (!line) continue;

      const phaseBefore = currentPhase;
      const t0 = performance.now();

      // Marker handling: [CAST] bypasses Gemini and fires IPC directly.
      if (line === '[CAST]') {
        opts.onStatus(`Turn ${i + 1}: triggering cast`);
        const result = await window.electronAPI.merlinTriggerCast();
        if (result.phase) currentPhase = result.phase;
        await new Promise(r => setTimeout(r, 150));
        const snap: ConversationTurnSnapshot = {
          index: i + 1,
          participantLine: '[CAST]',
          geminiText: result.ok ? '(cast triggered)' : `(cast skipped: ${result.reason || 'unknown'})`,
          phaseBefore,
          phaseAfter: currentPhase,
          toolCalls: [],
          spell: currentSpell,
          faceActivity: null,
          durationMs: Math.round(performance.now() - t0),
          marker: 'cast',
        };
        snapshots.push(snap);
        opts.onTurnComplete(snap);
        if (opts.pauseMs > 0) await new Promise(r => setTimeout(r, opts.pauseMs));
        continue;
      }

      // Claude-as-participant: replace canned mid-conversation lines
      // with an in-character utterance generated from history.
      const isFirstTurn = i === firstConversationalIdx;
      const isClosingTurn = i === lastConversationalIdx;
      if (claudeAvailable && !isFirstTurn) {
        opts.onStatus(`Turn ${i + 1}: asking Claude for participant line…`);
        const result = await window.electronAPI.generateParticipantLine({
          characterDescription: opts.character,
          faceDescription: opts.face?.description,
          bodyDescription: opts.body?.description,
          expectedSpell: opts.expectedSpell,
          history,
          closing: isClosingTurn,
        });
        if (!result.available) {
          console.warn('[ConversationTest] ANTHROPIC_API_KEY not set; falling back to canned script.');
          claudeAvailable = false;
        } else if (result.ok && result.line) {
          line = result.line;
        } else {
          console.warn('[ConversationTest] Claude returned no line; falling back to canned script:', result.error);
        }
      }

      opts.onStatus(`Turn ${i + 1}/${opts.script.length}: ${line.slice(0, 60)}${line.length > 60 ? '…' : ''}`);
      addMerlinMessage('user', line);
      history.push({ speaker: 'participant', text: line });
      if (opts.face || opts.body) {
        window.electronAPI.merlinUpdateAnalysis({
          face: opts.face,
          body: opts.body,
        });
      }
      const turnStartIdx = liveEvents.length;
      const response = await window.electronAPI.merlinProcessSpeech(line);
      // Brief grace period so any trailing post-tool events flush.
      await new Promise(r => setTimeout(r, 50));
      if (response.text) {
        addMerlinMessage('assistant', response.text);
        history.push({ speaker: 'merlin', text: response.text });
      }

      const turnEvents = liveEvents.slice(turnStartIdx);
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let faceActivity: string | null = null;
      for (const ev of turnEvents) {
        if (ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            toolCalls.push({ name: tc.name, args: tc.args });
          }
        }
        if (ev.faceActivity) faceActivity = ev.faceActivity;
      }

      currentPhase = response.phase;
      currentSpell = response.spell;
      const snap: ConversationTurnSnapshot = {
        index: i + 1,
        participantLine: line,
        geminiText: response.text,
        phaseBefore,
        phaseAfter: response.phase,
        toolCalls,
        spell: response.spell,
        faceActivity,
        durationMs: Math.round(performance.now() - t0),
      };
      snapshots.push(snap);
      opts.onTurnComplete(snap);

      if (opts.pauseMs > 0 && i < opts.script.length - 1) {
        await new Promise(r => setTimeout(r, opts.pauseMs));
      }
    }

    opts.onStatus('Ending Merlin session…');
    try {
      await window.electronAPI.merlinEnd();
    } catch (err) {
      console.warn('[ConversationTest] merlinEnd error:', err);
    }
  } finally {
    removeListener();
    testModeMuteTts = false;
    conversationRunActive = false;
    conversationRunStopRequested = false;
  }

  const transcriptJson = JSON.stringify({
    id: opts.id,
    character: opts.character,
    runAt: new Date().toISOString(),
    muteTts: opts.muteTts,
    pauseMs: opts.pauseMs,
    claudeDriven: opts.claudeDriven === true,
    snapshots,
  }, null, 2);
  console.log('[ConversationTest] Full transcript:', transcriptJson);
  let transcriptPath: string | undefined;
  try {
    const saveResult = await window.electronAPI.saveConversationTranscript({
      id: opts.id,
      json: transcriptJson,
    });
    if (saveResult.ok) {
      transcriptPath = saveResult.path;
      opts.onStatus(`Saved transcript: ${saveResult.path}`);
      console.log(`[ConversationTest] Transcript saved to ${saveResult.path}`);
    } else {
      console.warn('[ConversationTest] Failed to save transcript:', saveResult.error);
    }
  } catch (err) {
    console.warn('[ConversationTest] Save IPC failed:', err);
  }
  return { snapshots, transcriptPath };
}

export function requestConversationStop(): void {
  conversationRunStopRequested = true;
}

async function runConversationFromPanel(panel: HTMLElement): Promise<void> {
  const runBtn = panel.querySelector('#cv-run-btn') as HTMLButtonElement;
  const stopBtn = panel.querySelector('#cv-stop-btn') as HTMLButtonElement;
  const copyBtn = panel.querySelector('#cv-copy-btn') as HTMLButtonElement;
  const statusDiv = panel.querySelector('#cv-status') as HTMLDivElement;
  const transcriptDiv = panel.querySelector('#cv-transcript') as HTMLDivElement;
  const presetSelect = panel.querySelector('#cv-preset') as HTMLSelectElement;
  const muteEl = panel.querySelector('#cv-mute-tts') as HTMLInputElement;
  const pauseEl = panel.querySelector('#cv-pause') as HTMLInputElement;

  const preset = CONVERSATION_TEST_PRESETS.find(p => p.id === presetSelect.value);
  if (!preset) {
    statusDiv.textContent = 'No character selected';
    statusDiv.className = 'test-shader-status error';
    return;
  }
  const script = preset.script;
  const pauseMs = Math.max(0, parseFloat(pauseEl.value || '1') * 1000);
  const muteTts = muteEl.checked;
  const claudeEl = panel.querySelector('#cv-claude-driven') as HTMLInputElement;
  const claudeDriven = claudeEl.checked;

  runBtn.disabled = true;
  stopBtn.disabled = false;
  copyBtn.disabled = true;
  transcriptDiv.innerHTML = '';
  statusDiv.className = 'test-shader-status loading';

  const renderTurn = (turn: ConversationTurnSnapshot) => {
    const row = document.createElement('div');
    row.className = 'conversation-turn';
    const toolsHtml = turn.toolCalls.length
      ? `<div class="cv-tools">${turn.toolCalls.map(tc => `<span class="cv-tool-chip">${escapeHtml(tc.name)}</span>`).join('')}</div>`
      : '';
    const faceHtml = turn.faceActivity
      ? `<div class="cv-face">face: ${escapeHtml(turn.faceActivity)}</div>`
      : '';
    const spellHtml = (turn.spell && (turn.spell.intent || turn.spell.element))
      ? `<div class="cv-spell">spell: ${escapeHtml(turn.spell.intent || '–')} / ${escapeHtml(turn.spell.element || '–')}${turn.spell.castingOrigin ? ' / ' + escapeHtml(turn.spell.castingOrigin) : ''}</div>`
      : '';
    row.innerHTML = `
      <div class="cv-line cv-you">YOU: ${escapeHtml(turn.participantLine)}</div>
      <div class="cv-line cv-merlin">MERLIN: ${escapeHtml(turn.geminiText)}</div>
      <div class="cv-meta">phase: ${escapeHtml(turn.phaseBefore)} → ${escapeHtml(turn.phaseAfter)} · ${turn.durationMs}ms</div>
      ${spellHtml}
      ${toolsHtml}
      ${faceHtml}
    `;
    transcriptDiv.appendChild(row);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
  };

  let snapshots: ConversationTurnSnapshot[] = [];
  try {
    const result = await runConversationTest({
      id: preset.id,
      character: preset.description,
      script,
      muteTts,
      pauseMs,
      face: preset.expectedFace,
      body: preset.expectedBody,
      claudeDriven,
      expectedSpell: preset.expectedSpell,
      onTurnComplete: renderTurn,
      onStatus: (msg) => {
        statusDiv.textContent = msg;
      },
    });
    snapshots = result.snapshots;
    statusDiv.textContent = `Done — ${snapshots.length} turn(s)`;
    statusDiv.className = 'test-shader-status success';
  } catch (err) {
    statusDiv.textContent = `Error: ${err}`;
    statusDiv.className = 'test-shader-status error';
  } finally {
    runBtn.disabled = false;
    stopBtn.disabled = true;
    copyBtn.disabled = snapshots.length === 0;
    copyBtn.onclick = () => {
      const json = JSON.stringify(snapshots, null, 2);
      void navigator.clipboard.writeText(json);
      statusDiv.textContent = 'Transcript copied to clipboard';
    };
  }
}
