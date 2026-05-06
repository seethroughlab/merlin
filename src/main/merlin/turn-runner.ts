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
}

export interface TurnResult {
  /** Free-text response Gemini produced (concatenated across all sub-turns). */
  finalText: string;
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

  let accumulatedText = result.text === 'No response generated' ? '' : result.text;
  let toolCallCount = 0;

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

  return { finalText: accumulatedText, toolCallCount };
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

  for (const call of toolCalls) {
    let response: unknown;

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

        response = {
          success: true,
          magicWord: params.magicWord,
          gestureHint: params.gestureHint,
          spell: ctx.state.spell,
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

        // Block screenshots while any zone is in 'error' state — that
        // zone's code reset to default, so the screenshot would be
        // misleading. Force Gemini to fix the broken shader first.
        const { zoneStateManager } = await import('./zone-state');
        const allStatuses = zoneStateManager.getAllZoneStatuses();
        const errorZones = Object.entries(allStatuses)
          .filter(([, status]) => status === 'error')
          .map(([name]) => name);
        if (errorZones.length > 0) {
          response = {
            success: false,
            error:
              `Cannot capture screenshot — these zones are in an error state and reverted to defaults: ` +
              `${errorZones.join(', ')}. ` +
              `Fix them with set_zone_shader before requesting visual feedback. ` +
              `A screenshot taken now would not reflect your intended visuals.`,
          };
          break;
        }

        const { send } = await import('../td-bridge/connection');
        const { requestScreenshot } = await import('../td-bridge/metrics');
        const screenshot = await requestScreenshot(send, 5000);
        if (screenshot) {
          // Gemini 3: attach the screenshot as a multimodal part on
          // this function response. callId pairs it with the matching
          // tool result so Gemini knows the image is the answer to
          // *this specific* request_visual_feedback call.
          extraImages.push({
            mimeType: 'image/png',
            base64: screenshot.base64,
            callId: call.id,
          });
          // Surface the screenshot in the sidebar transcript so the
          // operator can see what Gemini saw.
          emitGeminiTurn({
            id: turnId,
            source,
            screenshot: {
              base64: screenshot.base64,
              width: screenshot.width,
              height: screenshot.height,
              caption: intent,
            },
          });
          response = {
            success: true,
            intent,
            width: screenshot.width,
            height: screenshot.height,
            instruction:
              'The screenshot is attached as a multimodal part on this function response. ' +
              'Analyze it and refine via set_zone_shader if it does not match the intent.',
          };
        } else {
          response = {
            success: false,
            error: 'Failed to capture screenshot from TouchDesigner',
          };
        }
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
          const generator = getSpriteGenerator();
          const isFlipbook = animation || (frameCount && frameCount > 1);

          if (isFlipbook) {
            const validFrameCount = (frameCount ?? 16) as 4 | 8 | 9 | 12 | 16 | 25;
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
              response = {
                success: true,
                assetId: r.asset.assetId,
                assetType: 'flipbook',
                frameCount: r.asset.frameCount,
                message: `Generated ${r.asset.frameCount}-frame flipbook sprite: "${description}"`,
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
              response = {
                success: true,
                assetId: r.asset.assetId,
                assetType: 'single',
                message: `Generated sprite: "${description}"`,
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

      default:
        response = { error: `Unknown tool: ${call.name}` };
    }

    results.push({ name: call.name, response, ...(call.id ? { callId: call.id } : {}) });
  }

  return { toolResults: results, extraImages };
}
