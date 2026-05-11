/**
 * Turn Runner — shared multi-call loop + tool dispatch
 *
 * Extracted from MerlinSession.processInput / handleToolCalls so that
 * any code path that drives Gemini through a Merlin spell turn
 * (live session, Live Spell test tab, future automation) goes through
 * exactly the same dispatch — no parallel routes, no drift.
 *
 * The function takes a chat handle, an initial message, and a
 * dispatch context that exposes the mutable state and side-effect
 * callbacks the handlers need. session.ts wires its context to its
 * instance state; test surfaces wire it to a local accumulator.
 */

import type { MerlinChat, ChatTurnResult } from './gemini-chat';
import { mergeSpellUpdate, defaultOriginForIntent } from './spell-state';
import { pushZoneUpdateWithValidation } from '../td-bridge';
import { emitGeminiTurn } from './gemini-events';
import { ALLOWED_TOOLS_PER_PHASE } from './prompts';
import type {
  SpellState,
  GeminiToolCall,
  GeminiTurnSource,
  BodyLanguageAnalysis,
  MicroExpressionAnalysis,
} from '../../shared/types';
import type {
  MerlinSessionState,
  MerlinToolCall,
  SetSpellProfileParams,
  PrepareCastingParams,
} from './types';

const RETRY_MAX = 2;

/** Callback to fetch fresh body or face analysis. Optional — when absent, handlers fall back to `state.lastPosture` / `state.lastExpression`. */
export type RequestAnalysisCallback = (
  type: 'body' | 'face',
  focus?: string
) => Promise<BodyLanguageAnalysis | MicroExpressionAnalysis | null>;

/**
 * Dependencies that the per-tool handlers need. Live session populates
 * these from its instance; test surfaces populate them from a local
 * accumulator.
 */
export interface TurnDispatchContext {
  /** Mutable session state. Handlers update spell, lastPosture, etc. */
  state: MerlinSessionState;
  /** Notified after spell mutations from set_spell_profile / prepare_casting. */
  onSpellUpdate?: (spell: SpellState) => void;
  /** If absent, get_posture / get_expression return cached state. */
  onRequestAnalysis?: RequestAnalysisCallback;
  /**
   * Notified when Gemini calls register_effect_triggers. The session
   * stores the trigger set and uses it to locally match participant
   * speech against effect-trigger words.
   */
  onRegisterTriggers?: (triggers: ReadonlyArray<EffectTriggerSpec>) => void;
  /**
   * Optional sink for the FIRST text chunk Gemini emits when there
   * are still tool calls pending after the initial response. Lets the
   * renderer start TTS in parallel with the (slow) tool dispatch loop
   * — generate_sprite alone is 24-30s of Imagen latency. The chunk
   * forwarded here will NOT be included in the final returned text,
   * so the renderer doesn't re-speak it.
   */
  onSpeakChunk?: (text: string) => void;
  /**
   * Notified when prepare_casting fires, so the renderer can arm a
   * background magic-word listener independent of the Gemini turn
   * pipeline. Receives the magic word Gemini registered. The cast
   * itself still goes through triggerCast() via IPC when the
   * participant speaks the word.
   */
  onCastArmed?: (payload: { magicWord: string; gestureHint?: string }) => void;
}

/**
 * Spec for a single locally-matched effect trigger word. The session
 * keeps an ordered list of these and tests each user utterance against
 * them before invoking Gemini.
 */
export interface EffectTriggerSpec {
  word: string;
  zone: string;
  glslCode: string;
  description?: string;
}

export interface TurnResult {
  /** Free-text response Gemini produced (concatenated across all sub-turns). */
  finalText: string;
  /** Full accumulated text including any portion that was streamed via onSpeakChunk. */
  fullText: string;
  /** True if any portion of the response was already streamed to TTS via onSpeakChunk. */
  streamedAny: boolean;
  /** Total tool calls Gemini executed across the turn. */
  toolCallCount: number;
}

/**
 * Send `initialMessage` to `chat`, dispatch every tool call Gemini makes,
 * loop until Gemini stops calling tools, and return the accumulated text
 * + tool count. Emits `emitGeminiTurn` events for every sub-result so
 * the sidebar shows progressive activity.
 */
export async function runMerlinTurn(
  chat: MerlinChat,
  initialMessage: string,
  ctx: TurnDispatchContext,
  turnId: string,
  source: GeminiTurnSource
): Promise<TurnResult> {
  const zoneAttempts = new Map<string, number>();

  let result = await chat.sendMessage(initialMessage);
  emitChatResult(turnId, source, result);

  const initialText = result.text === 'No response generated' ? '' : result.text;
  let accumulatedText = initialText;
  let streamedText = '';
  let toolCallCount = 0;

  // Outro turns: accept the text response and stop here. The system
  // prompt forbids tool use on the closing turn, but if Gemini ignores
  // it and emits set_zone_shader/etc., we drop the calls silently —
  // the spell is already cast and the session is closing, no more
  // state changes should fire. Belt-and-suspenders against the model
  // not following the strengthened outro phase rules.
  if (ctx.state.phase === 'outro') {
    return {
      finalText: accumulatedText,
      fullText: accumulatedText,
      streamedAny: false,
      toolCallCount: 0,
    };
  }

  // Parallel TTS: if the initial response carries text AND tool calls
  // are pending, the participant can start hearing Merlin while the
  // tools (often a 25s Imagen call) run in the background. We forward
  // the chunk to the renderer through ctx.onSpeakChunk and mark it as
  // already streamed so the final returned text doesn't double-speak.
  if (initialText && result.toolCalls.length > 0 && ctx.onSpeakChunk) {
    ctx.onSpeakChunk(initialText);
    streamedText = initialText;
  }

  while (result.toolCalls.length > 0) {
    toolCallCount += result.toolCalls.length;
    const dispatch = await dispatchToolCalls(
      result.toolCalls,
      ctx,
      turnId,
      source,
      zoneAttempts
    );
    // In Gemini 3 the screenshot from request_visual_feedback rides
    // inside the function response as a multimodal `parts` entry —
    // single round-trip, no separate user-role follow-up needed.
    result = await chat.sendToolResults(dispatch.toolResults, dispatch.extraImages);
    emitChatResult(turnId, source, result);
    if (result.text && result.text !== 'No response generated') {
      accumulatedText += result.text;
    }
  }

  // finalText is the un-streamed remainder. The renderer uses
  // `alreadyStreamed` on MerlinResponse to decide whether to fire a
  // second speakWithStreaming on response.text — if a chunk was
  // already streamed, calling speakStreaming again would invoke
  // stopStreaming() and cut the chunk off mid-playback.
  const finalText = streamedText
    ? accumulatedText.slice(streamedText.length)
    : accumulatedText;
  return {
    finalText,
    fullText: accumulatedText,
    streamedAny: streamedText.length > 0,
    toolCallCount,
  };
}

function emitChatResult(turnId: string, source: GeminiTurnSource, result: ChatTurnResult): void {
  const toolCalls: GeminiToolCall[] = result.toolCalls.map(tc => ({
    name: tc.name,
    args: tc.args as Record<string, unknown>,
  }));
  const text = result.text === 'No response generated' ? '' : result.text;
  if (text || toolCalls.length > 0) {
    emitGeminiTurn({
      id: turnId,
      source,
      responseText: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    // Mirror Gemini's text + tool calls to stdout so the dev console
    // shows what the model is "thinking" alongside the per-zone push
    // logs. Useful when diagnosing whether Gemini is evaluating
    // screenshots vs. blindly chaining tool calls.
    const tag = `[Gemini ${source} ${turnId.slice(0, 6)}]`;
    if (text) {
      const trimmed = text.length > 600 ? text.slice(0, 600) + '…' : text;
      console.log(`${tag} ${trimmed}`);
    }
    if (toolCalls.length > 0) {
      console.log(`${tag} → ${toolCalls.map(t => t.name).join(', ')}`);
    }
  }
}

/**
 * Image to attach to a function response as a multimodal `parts` entry
 * (Gemini 3). Pair via `callId` to the `MerlinToolCall.id` of the call
 * the image is answering.
 */
export interface DispatchImage {
  mimeType: string;
  base64: string;
  /** Match against the originating MerlinToolCall.id so the inline data lands on the right function response. */
  callId?: string;
}

export interface DispatchResult {
  toolResults: Array<{ name: string; response: unknown; callId?: string }>;
  /** Inline images to attach alongside the function responses (e.g. screenshots). */
  extraImages: DispatchImage[];
}

/**
 * One frame of a multi-frame temporal capture, plus the label that
 * tells Gemini which envelope phase produced it.
 */
export interface TemporalFrame {
  base64: string;
  width: number;
  height: number;
  /** 'idle' | 'peak' | 'afterglow' — see captureTemporalFrames. */
  label: 'idle' | 'peak' | 'afterglow';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Capture three screenshots across an energy envelope so Gemini can
 * evaluate the spell at idle, peak, and during afterglow rather than
 * judging it from a single low-energy frame.
 *
 * Sequence:
 *   1. Frame A (idle) — capture the resting state immediately.
 *   2. pushCastParams(BASELINE_CAST_PARAMS) — force the test envelope
 *      so timing matches our wait values regardless of any prior
 *      set_cast_params Gemini chose for the spell's live performance.
 *   3. pushSpellCast — handle_spell_cast writes mode_float=1.0; the
 *      energy LagCHOP starts ramping uSpellEnergy toward peak.
 *   4. sleep(riseMs + 50ms buffer) — wait for the lag to converge.
 *   5. Frame B (peak) — capture mid-cast with energy near peak_energy.
 *   6. pushMerlinState({phase: 'idle'}) — handle_merlin_state writes
 *      mode_float=-1.0; energy starts falling.
 *   7. sleep(fallMs / 2) — catch the partial decay, not full idle.
 *   8. Frame C (afterglow) — capture mid-fade.
 *
 * Total latency: ~1.5s (riseMs=600 + fallMs/2=400 + 3 screenshot
 * round-trips ≈ 500ms). Caller is responsible for the compile guard
 * (refusing capture when any zone failed compile) — this helper assumes
 * the visuals are valid to capture.
 */
export async function captureTemporalFrames(): Promise<{
  frames: TemporalFrame[];
  partialFailures: string[];
}> {
  const { send } = await import('../td-bridge/connection');
  const { requestScreenshot } = await import('../td-bridge/metrics');
  const { pushCastParams, pushSpellCast, pushMerlinState } = await import('../td-bridge');
  const { BASELINE_CAST_PARAMS } = await import('./reset-td');

  const frames: TemporalFrame[] = [];
  const partialFailures: string[] = [];

  // Frame A: idle baseline.
  const idle = await requestScreenshot(send, 5000);
  if (idle) {
    frames.push({ base64: idle.base64, width: idle.width, height: idle.height, label: 'idle' });
  } else {
    partialFailures.push('idle');
  }

  // Force the snappy test envelope and trigger the cast.
  pushCastParams(BASELINE_CAST_PARAMS);
  pushSpellCast('whole_body', 1.0, 4500, {
    ignitionMs: 400,
    projectionMs: 1200,
    afterglowMs: 2900,
    peakIntensity: 1.0,
  });

  // Frame B: peak. 50ms buffer covers cook-rate jitter at 60fps.
  await sleep((BASELINE_CAST_PARAMS.riseMs ?? 600) + 50);
  const peak = await requestScreenshot(send, 5000);
  if (peak) {
    frames.push({ base64: peak.base64, width: peak.width, height: peak.height, label: 'peak' });
  } else {
    partialFailures.push('peak');
  }

  // Restore idle BEFORE the wait so the lag falls during the sleep.
  pushMerlinState({ active: true, phase: 'idle' });
  await sleep((BASELINE_CAST_PARAMS.fallMs ?? 800) / 2);
  const afterglow = await requestScreenshot(send, 5000);
  if (afterglow) {
    frames.push({ base64: afterglow.base64, width: afterglow.width, height: afterglow.height, label: 'afterglow' });
  } else {
    partialFailures.push('afterglow');
  }

  return { frames, partialFailures };
}

/**
 * Run the dispatch switch for a batch of tool calls. Exported so the
 * session intro flow (which also needs to dispatch tool calls outside
 * a full runMerlinTurn turn) can reuse the same logic.
 */
export async function dispatchToolCalls(
  toolCalls: MerlinToolCall[],
  ctx: TurnDispatchContext,
  turnId: string,
  source: GeminiTurnSource,
  zoneAttempts: Map<string, number>
): Promise<DispatchResult> {
  const results: Array<{ name: string; response: unknown; callId?: string }> = [];
  const extraImages: DispatchImage[] = [];
  const allowed = ALLOWED_TOOLS_PER_PHASE[ctx.state.phase];

  for (const call of toolCalls) {
    let response: unknown;

    // Phase-gate: drop tool calls forbidden by the current phase.
    // Returns a synthetic error response so Gemini sees the constraint
    // as feedback (rather than a silent drop, which would confuse it
    // into retrying the same tool). The system prompt's per-phase
    // rules already tell Gemini which tools are available; this is
    // belt-and-suspenders against the model ignoring those rules.
    if (allowed && !allowed.has(call.name)) {
      const allowedList = Array.from(allowed).join(', ') || 'none';
      console.warn(
        `[TurnRunner] Tool '${call.name}' not allowed in phase '${ctx.state.phase}' — dropping. ` +
        `Allowed: ${allowedList}`
      );
      results.push({
        name: call.name,
        response: {
          success: false,
          error: `Tool '${call.name}' is not available in phase '${ctx.state.phase}'. Available tools this phase: ${allowedList}. Move toward the next phase before using this tool.`,
        },
        ...(call.id ? { callId: call.id } : {}),
      });
      continue;
    }

    switch (call.name) {
      case 'get_posture': {
        if (ctx.onRequestAnalysis) {
          const focus = (call.args as { focus?: string }).focus;
          const analysis = await ctx.onRequestAnalysis('body', focus);
          if (analysis) {
            ctx.state.lastPosture = analysis as Partial<BodyLanguageAnalysis>;
            ctx.state.lastPerceptionTime = Date.now();
          }
          response = analysis ?? { error: 'Analysis not available' };
        } else {
          response = ctx.state.lastPosture ?? { error: 'No posture data available' };
        }
        break;
      }

      case 'get_expression': {
        if (ctx.onRequestAnalysis) {
          const focus = (call.args as { focus?: string }).focus;
          const analysis = await ctx.onRequestAnalysis('face', focus);
          if (analysis) {
            ctx.state.lastExpression = analysis as Partial<MicroExpressionAnalysis>;
            ctx.state.lastPerceptionTime = Date.now();
          }
          response = analysis ?? { error: 'Analysis not available' };
        } else {
          response = ctx.state.lastExpression ?? { error: 'No expression data available' };
        }
        break;
      }

      case 'get_face_events': {
        // Live face-gesture buffer (mouth_open / smile / brow_raise /
        // eye_closed). Edge-triggered, filled by the renderer at ~30fps.
        // Imported here to keep turn-runner free of the face-event-buffer
        // dependency at module-load time (matters for test mocks).
        const { getRecentFaceEvents, getActiveGestures } = await import('./face-event-buffer');
        const sinceMs = (call.args as { sinceMs?: number }).sinceMs ?? 5000;
        const clamped = Math.max(100, Math.min(sinceMs, 60000));
        const events = getRecentFaceEvents(clamped);
        const active = getActiveGestures();
        response = {
          success: true,
          nowMs: Date.now(),
          sinceMs: clamped,
          activeGestures: active,
          events: events.map(e => ({
            kind: e.kind,
            edge: e.edge,
            score: Number(e.score.toFixed(3)),
            ageMs: e.ageMs,
          })),
        };
        break;
      }

      case 'set_spell_profile': {
        // Pure metadata update — no side effects on TD visuals. Visuals
        // come entirely from set_zone_shader / generate_sprite. Tracking
        // intent/element/etc. here gives later turns conversational
        // context via the system prompt builder.
        const params = call.args as unknown as SetSpellProfileParams;
        const update: Partial<SpellState> = {};

        if (params.intent) {
          update.intent = params.intent as SpellState['intent'];
          if (!ctx.state.spell.castingOrigin && update.intent) {
            update.castingOrigin = defaultOriginForIntent(update.intent);
          }
        }
        if (params.element) update.element = params.element as SpellState['element'];
        if (params.tone) update.tone = params.tone as SpellState['tone'];
        if (typeof params.energy === 'number') update.energy = params.energy;
        if (params.castingOrigin) {
          update.castingOrigin = params.castingOrigin as SpellState['castingOrigin'];
        }

        const completenessBoost =
          (update.intent ? 0.15 : 0) +
          (update.element ? 0.15 : 0) +
          (update.castingOrigin ? 0.1 : 0);
        if (completenessBoost > 0) {
          update.confidence = Math.min(1, ctx.state.spell.confidence + completenessBoost);
        }

        ctx.state.spell = mergeSpellUpdate(ctx.state.spell, update);
        ctx.onSpellUpdate?.(ctx.state.spell);

        response = { success: true, spell: ctx.state.spell };
        break;
      }

      case 'prepare_casting': {
        const params = call.args as unknown as PrepareCastingParams;
        ctx.state.spell = mergeSpellUpdate(ctx.state.spell, {
          magicWord: params.magicWord,
          confidence: 1.0,
        });
        ctx.state.castReady = true;
        ctx.onSpellUpdate?.(ctx.state.spell);
        // Arm the renderer's background cast listener with the declared
        // magic word so the cast fires the instant the participant speaks
        // it — no Gemini round-trip required.
        ctx.onCastArmed?.({
          magicWord: params.magicWord,
          gestureHint: params.gestureHint,
        });

        response = {
          success: true,
          magicWord: params.magicWord,
          gestureHint: params.gestureHint,
          spell: ctx.state.spell,
        };
        break;
      }

      case 'register_effect_triggers': {
        const { triggers } = call.args as {
          triggers: Array<{
            word: string;
            zone: string;
            glsl_code: string;
            description?: string;
          }>;
        };

        if (!Array.isArray(triggers) || triggers.length === 0) {
          response = { success: false, error: 'triggers array is required' };
          break;
        }

        const normalized: EffectTriggerSpec[] = triggers
          .filter(t => t?.word && t?.zone && t?.glsl_code)
          .map(t => ({
            word: t.word,
            zone: t.zone,
            glslCode: t.glsl_code,
            description: t.description,
          }));

        if (normalized.length === 0) {
          response = { success: false, error: 'no valid triggers (each needs word, zone, glsl_code)' };
          break;
        }

        ctx.onRegisterTriggers?.(normalized);
        console.log(
          `[TurnRunner] Registered ${normalized.length} effect trigger(s): ` +
          normalized.map(t => `"${t.word}"→${t.zone}`).join(', ')
        );
        response = {
          success: true,
          registered: normalized.map(t => ({ word: t.word, zone: t.zone })),
        };
        break;
      }

      case 'set_zone_shader': {
        const { zone, glsl_code, description } = call.args as {
          zone: string;
          glsl_code: string;
          description?: string;
        };

        const priorAttempts = zoneAttempts.get(zone) ?? 0;
        if (priorAttempts > 0) {
          emitGeminiTurn({
            id: turnId,
            source,
            retry: { attempt: priorAttempts, total: RETRY_MAX, zone },
          });
        }

        const r = await pushZoneUpdateWithValidation(zone, glsl_code);
        zoneAttempts.set(zone, priorAttempts + 1);

        emitGeminiTurn({
          id: turnId,
          source,
          pushResults: [{ zone, success: r.success, error: r.error, warnings: r.warnings }],
        });

        if (r.success) {
          response = {
            success: true,
            zone,
            description: description || 'Custom shader applied',
            warnings: r.warnings,
          };
        } else {
          const attempt = priorAttempts + 1;
          const exhausted = attempt > RETRY_MAX;
          response = {
            success: false,
            zone,
            error: r.error,
            warnings: r.warnings,
            instruction: exhausted
              ? `The zone "${zone}" has now failed ${attempt} times. Stop trying to fix this zone for now and respond to the user.`
              : `COMPILE ERROR (iteration ${attempt}/${RETRY_MAX}):\n\n` +
                `Tool result for "${zone}": ${r.error ?? 'unknown error'}\n\n` +
                `CRITICAL: The GLSL zone "${zone}" failed to compile. The zone code was reverted to defaults.\n` +
                `You MUST call set_zone_shader again with corrected GLSL for zone "${zone}".\n` +
                `Common fixes: check for syntax errors, undefined variables, missing semicolons, ` +
                `redeclaration of template-provided variables, or invalid GLSL.\n` +
                `Explain what you think went wrong and provide fixed code.`,
          };
        }
        break;
      }

      case 'request_visual_feedback': {
        const { intent } = call.args as { intent: string };

        // Block screenshots while any zone's most recent compile
        // attempt failed — even if it has since been rolled back to
        // 'default' status. Otherwise Gemini gets a screenshot of
        // template-default visuals and reads it as evidence of its
        // intended spell, leading to confident hallucinated summaries.
        const { zoneStateManager } = await import('./zone-state');
        const { ZONE_NAMES } = await import('./zone-registry');
        const failedZones = ZONE_NAMES.filter(
          (z) => zoneStateManager.getLastCompileSuccess(z) === false
        );
        if (failedZones.length > 0) {
          response = {
            success: false,
            error:
              `Cannot capture screenshot — these zones recently failed to compile and reverted to defaults: ` +
              `${failedZones.join(', ')}. ` +
              `Fix them with set_zone_shader before requesting visual feedback. ` +
              `A screenshot taken now would show template defaults, not your intended visuals.`,
          };
          break;
        }

        const { getLatestMetrics, getLatestVisibility } = await import('../td-bridge/metrics');

        // Capture 3 frames across the energy envelope (idle / peak /
        // afterglow). The helper drives the cast tween via spell_cast
        // and restores idle via merlin_state — total ~1.5s.
        const { frames, partialFailures } = await captureTemporalFrames();

        if (frames.length === 0) {
          response = {
            success: false,
            error: `Failed to capture any frames from TouchDesigner (all 3 timed out: ${partialFailures.join(', ')})`,
          };
          break;
        }

        // Gemini 3: attach each frame as a separate multimodal part.
        // Order matches the response.frames array iteration (idle, peak,
        // afterglow), so Gemini can correlate by position. callId pairs
        // them all with this specific request_visual_feedback call.
        for (const f of frames) {
          extraImages.push({
            mimeType: 'image/png',
            base64: f.base64,
            callId: call.id,
          });
        }

        // Surface the frames in the sidebar transcript as a labelled
        // strip so the operator can see what Gemini saw at each phase.
        emitGeminiTurn({
          id: turnId,
          source,
          screenshots: frames.map((f) => ({
            base64: f.base64,
            width: f.width,
            height: f.height,
            caption: intent,
            label: f.label,
          })),
        });

        // Also attach the most-recently-pushed sprite (if any) as a
        // FOURTH inline image so Gemini can A/B compare: "is the
        // texture in the screenshots the same as the sprite I just
        // generated?" Without this, Gemini has no visual reference
        // for what the active sprite should look like and can miss
        // sprite-load failures even when the screenshots clearly
        // show the wrong texture.
        let activeSpriteAttached = false;
        let activeSpriteDescription: string | null = null;
        let activeSpriteAssetType: 'flipbook' | 'single' | null = null;
        try {
          const { getLastSpritePush } = await import('./td-state-mirror');
          const lastSprite = getLastSpritePush();
          if (lastSprite) {
            const { readFileSync } = await import('fs');
            const png = readFileSync(lastSprite.texturePath);
            extraImages.push({
              mimeType: 'image/png',
              base64: png.toString('base64'),
              callId: call.id,
            });
            activeSpriteAttached = true;
            activeSpriteDescription = lastSprite.description ?? null;
            activeSpriteAssetType = lastSprite.assetType;
          }
        } catch (e) {
          console.warn(
            `[TurnRunner] Couldn't attach active sprite preview: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        // Metrics sampled after captureTemporalFrames returns — that's
        // post-peak / early-afterglow, close enough to peak for
        // threshold evaluation. visibility values come from TD's most
        // recent visibility message which arrives every screenshot, so
        // these reflect the afterglow frame's state.
        const m = getLatestMetrics();
        const v = getLatestVisibility();

        const partialNote = partialFailures.length > 0
          ? ` Note: ${partialFailures.length} frame(s) failed to capture (${partialFailures.join(', ')}); evaluate from what's available.`
          : '';
        const baseInstruction =
          `Three frames are attached as inline images in order: idle, peak, afterglow. ` +
          `Idle = baseline before cast (particles must be present and positioned correctly). ` +
          `Peak = mid-cast at maximum energy (must meet visible_particles >= 50, avg_brightness >= 0.02, render_vs_webcam_diff >= 0.01, and show meaningful change from idle). ` +
          `Afterglow = decaying energy mid-fade (must show graceful fade — not identical to peak, not collapsed back to idle). ` +
          `Metrics reflect post-peak state. If visible_particles is 0 or render_vs_webcam_diff is near 0, particles aren't rendering regardless of what the frames suggest. ` +
          `Refine via set_zone_shader if the visuals do not match the intent.` +
          partialNote;
        const spriteInstruction = activeSpriteAttached
          ? ` A FOURTH inline image is also attached: the ${activeSpriteAssetType ?? ''} sprite that should currently be on every particle (described as "${activeSpriteDescription ?? '(no description)'}"). Compare its texture to what you see in the frames — if the particles don't show this sprite's texture, the sprite load failed or a shader is masking it; investigate before iterating on visual style.`
          : '';

        response = {
          success: true,
          intent,
          frames: frames.reduce((acc, f) => {
            acc[f.label] = { width: f.width, height: f.height };
            return acc;
          }, {} as Record<string, { width: number; height: number }>),
          metrics: {
            fps: m?.fps ?? null,
            particle_count: m?.particleCount ?? null,
            coverage: m?.coverage ?? null,
            visible_particles: v?.visibleParticles ?? null,
            avg_brightness: v?.avgBrightness ?? null,
            render_vs_webcam_diff: v?.renderVsWebcamDiff ?? null,
          },
          active_sprite: activeSpriteAttached
            ? { description: activeSpriteDescription, assetType: activeSpriteAssetType }
            : null,
          instruction: baseInstruction + spriteInstruction,
        };
        break;
      }

      case 'generate_sprite': {
        const {
          description,
          style,
          animation,
          frameCount,
          playbackMode,
          driveSource,
        } = call.args as {
          description: string;
          style?: string;
          animation?: string;
          frameCount?: number;
          playbackMode?: string;
          driveSource?: string;
        };

        try {
          const { getSpriteGenerator } = await import('./sprite-generator');
          const { pushSpriteTexture, pushFlipbookConfig } = await import('../td-bridge');
          const { waitForSpriteLoad } = await import('../td-bridge/metrics');
          const { readFileSync } = await import('fs');
          const generator = getSpriteGenerator();
          const isFlipbook = animation || (frameCount && frameCount > 1);

          // Helper: read the sprite PNG and attach it to the function
          // response as a multimodal part so Gemini has visual ground
          // truth for what its sprite looks like (vs. a stale leftover
          // from a previous spell). The accompanying caption goes in
          // the response JSON's `message` field — Gemini reads both
          // together, so it knows what the inline image represents.
          const attachSpritePreview = (
            assetId: string,
            texturePath: string
          ): boolean => {
            try {
              const png = readFileSync(texturePath);
              extraImages.push({
                mimeType: 'image/png',
                base64: png.toString('base64'),
                callId: call.id,
              });
              return true;
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.warn(`[TurnRunner] Couldn't attach sprite preview ${assetId}: ${errMsg}`);
              return false;
            }
          };

          if (isFlipbook) {
            const validFrameCount = (frameCount ?? 16) as 4 | 8 | 9 | 12 | 16;
            const r = await generator.generateFlipbookSync(description, {
              frameCount: validFrameCount,
              style,
              animation,
              playbackMode: (playbackMode ?? 'loop') as 'loop' | 'once' | 'pingpong' | 'random',
              driveSource: (driveSource ?? 'age') as 'age' | 'life' | 'velocity' | 'id' | 'time',
            });

            if (r.success && r.asset) {
              pushSpriteTexture(r.asset.assetId, r.asset.texturePath);
              if (r.flipbookConfig) {
                const pushed = pushFlipbookConfig(r.flipbookConfig);
                if (pushed) {
                  const { recordFlipbookConfigPush } = await import('./td-state-mirror');
                  recordFlipbookConfigPush(r.flipbookConfig);
                }
              }
              // Block until TD confirms the new texture is on the GPU.
              // Without this, a follow-up request_visual_feedback can
              // race ahead and screenshot the previous spell's sprite.
              const ack = await waitForSpriteLoad(r.asset.assetId, 5000);
              if (!ack.success) {
                response = {
                  success: false,
                  error: ack.timedOut
                    ? `Sprite generated but TD did not ACK load within 5s for asset ${r.asset.assetId}`
                    : `Sprite generated but TD load failed: ${ack.error ?? 'unknown error'}`,
                };
                break;
              }
              // Push the extracted palette to TD as uSpriteColor1/2 uniforms
              // and record it for request_visual_feedback diagnostics.
              if (r.palette) {
                const { pushSpriteColors } = await import('../td-bridge');
                pushSpriteColors(r.palette[0], r.palette[1]);
              }
              // Record so request_visual_feedback can re-show this sprite
              // alongside future screenshots.
              const { recordSpriteTexturePush } = await import('./td-state-mirror');
              recordSpriteTexturePush({
                assetId: r.asset.assetId,
                texturePath: r.asset.texturePath,
                description,
                assetType: 'flipbook',
                palette: r.palette,
              });
              const previewAttached = attachSpritePreview(r.asset.assetId, r.asset.texturePath);
              response = {
                success: true,
                assetId: r.asset.assetId,
                assetType: 'flipbook',
                frameCount: r.asset.frameCount,
                palette: r.palette,
                message: previewAttached
                  ? `Generated ${r.asset.frameCount}-frame flipbook sprite for "${description}". The atlas (${r.asset.frameCount} frames in a grid) is attached as an inline image — this is the texture now active on every particle. Each particle samples one frame at a time per the flipbook config. Use this image as ground truth when you later view a screenshot: if the screenshot's particles don't show this texture, the load failed or a shader is hiding it.`
                  : `Generated ${r.asset.frameCount}-frame flipbook sprite for "${description}".`,
              };
            } else {
              response = {
                success: false,
                error: r.error ?? 'Failed to generate flipbook sprite',
              };
            }
          } else {
            const r = await generator.generateSpriteSync(description, { style });
            if (r.success && r.asset) {
              pushSpriteTexture(r.asset.assetId, r.asset.texturePath);
              // Clear any prior multi-frame flipbook state so TD doesn't
              // keep slicing this single sprite by the previous spell's
              // atlas grid. 1×1 single-frame makes the billboard
              // shader's flipbook math a no-op.
              const { BASELINE_FLIPBOOK } = await import('./reset-td');
              const fbPushed = pushFlipbookConfig(BASELINE_FLIPBOOK);
              if (fbPushed) {
                const { recordFlipbookConfigPush } = await import('./td-state-mirror');
                recordFlipbookConfigPush(BASELINE_FLIPBOOK);
              }
              // Block until TD confirms the new texture is on the GPU
              // (see flipbook branch comment above).
              const ack = await waitForSpriteLoad(r.asset.assetId, 5000);
              if (!ack.success) {
                response = {
                  success: false,
                  error: ack.timedOut
                    ? `Sprite generated but TD did not ACK load within 5s for asset ${r.asset.assetId}`
                    : `Sprite generated but TD load failed: ${ack.error ?? 'unknown error'}`,
                };
                break;
              }
              // Push the extracted palette to TD as uSpriteColor1/2 uniforms
              // and record it for request_visual_feedback diagnostics.
              if (r.palette) {
                const { pushSpriteColors } = await import('../td-bridge');
                pushSpriteColors(r.palette[0], r.palette[1]);
              }
              const { recordSpriteTexturePush } = await import('./td-state-mirror');
              recordSpriteTexturePush({
                assetId: r.asset.assetId,
                texturePath: r.asset.texturePath,
                description,
                assetType: 'single',
                palette: r.palette,
              });
              const previewAttached = attachSpritePreview(r.asset.assetId, r.asset.texturePath);
              response = {
                success: true,
                assetId: r.asset.assetId,
                assetType: 'single',
                palette: r.palette,
                message: previewAttached
                  ? `Generated single-frame sprite for "${description}". The sprite is attached as an inline image — this is the texture now active on every particle. Use this image as ground truth when you later view a screenshot.`
                  : `Generated single-frame sprite for "${description}".`,
              };
            } else {
              response = {
                success: false,
                error: r.error ?? 'Failed to generate sprite',
              };
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[TurnRunner] generate_sprite error: ${errorMessage}`);
          response = { success: false, error: errorMessage };
        }
        break;
      }

      case 'set_cast_params': {
        const args = call.args as { riseMs?: number; fallMs?: number; peakEnergy?: number };
        const { pushCastParams } = await import('../td-bridge');
        const pushed = pushCastParams(args);
        response = pushed
          ? { success: true, params: args }
          : { success: false, error: 'TD not connected' };
        break;
      }

      case 'set_particle_params': {
        const args = call.args as {
          maxCount?: number;
          lifespan?: number;
          emitRate?: number;
          spawnRadius?: number;
          blendMode?: 'additive' | 'alpha';
        };
        const { pushParticleParams } = await import('../td-bridge');
        const pushed = pushParticleParams(args);
        response = pushed
          ? { success: true, params: args }
          : { success: false, error: 'TD not connected' };
        break;
      }

      default:
        response = { error: `Unknown tool: ${call.name}` };
    }

    results.push({ name: call.name, response, ...(call.id ? { callId: call.id } : {}) });
  }

  return { toolResults: results, extraImages };
}
