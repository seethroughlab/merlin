/**
 * Gemini Multi-Turn Chat Wrapper for Merlin
 *
 * Manages a stateful conversation with Gemini including tool calling.
 * Built on `@google/genai` (the v1+ SDK) so that `request_visual_feedback`
 * can deliver its screenshot via nested multimodal parts inside the
 * function response — a Gemini 3 capability the older SDK doesn't expose.
 */

import {
  GoogleGenAI,
  Chat,
  Content,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import {
  MERLIN_SYSTEM_PROMPT,
  MERLIN_TOOLS,
  MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT,
  MERLIN_VISUAL_AUTHOR_TOOLS,
  INTRO_WITH_IMAGE_PROMPT,
  MERLIN_CLOSING_PROMPT,
} from './prompts';
import type { MerlinToolCall } from './types';
import { withRetry } from '../retry';

const MERLIN_MODEL = 'gemini-3-flash-preview';

let genAI: GoogleGenAI | null = null;

function ensureGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

/**
 * Chat mode selects which system prompt + tool registry the chat
 * is created with.
 *  - 'merlin'         : full Merlin character + all tools (live experience)
 *  - 'visual-author'  : stripped prompt focused on visual authoring,
 *                        only the 3 visual tools — no perception, no
 *                        casting, no metadata. Used by Live Spell test.
 */
export type ChatMode = 'merlin' | 'visual-author';

function buildChat(history: Content[], mode: ChatMode = 'merlin'): Chat {
  const ai = ensureGenAI();
  const systemInstruction =
    mode === 'visual-author' ? MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT : MERLIN_SYSTEM_PROMPT;
  const tools =
    mode === 'visual-author' ? MERLIN_VISUAL_AUTHOR_TOOLS : MERLIN_TOOLS;
  return ai.chats.create({
    model: MERLIN_MODEL,
    history,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: tools }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.AUTO,
        },
      },
    },
  });
}

/**
 * Parsed response from Gemini chat turn
 */
export interface ChatTurnResult {
  text: string;
  toolCalls: MerlinToolCall[];
  finishReason: string;
}

/**
 * One screenshot to deliver alongside a tool result via the Gemini 3
 * multimodal-function-response feature: the inline image rides inside
 * the `parts` field of the matching `functionResponse`, so the model
 * sees it as part of a single tool result.
 */
interface ToolResultImage {
  /** Match against `MerlinToolCall.id` so the inline data is attached to the right function response. */
  callId?: string;
  mimeType: string;
  base64: string;
}

/**
 * MerlinChat - manages multi-turn conversation with Gemini
 */
export class MerlinChat {
  private chat: Chat | null = null;
  private history: Content[] = [];
  private mode: ChatMode = 'merlin';

  /**
   * Build a per-call config that overrides the chat-level tool registry
   * with a filtered subset. Used to enforce per-phase tool gating at
   * the API level — Gemini physically can't call a tool that isn't in
   * the per-call `tools` list, so we don't waste a round-trip on
   * disallowed calls and the runtime gate becomes a safety net.
   *
   * Per-call config in @google/genai does NOT inherit from chat-level
   * config — we have to re-supply systemInstruction + toolConfig.
   */
  private buildPerCallConfig(allowedToolNames: string[]): Record<string, unknown> {
    const baseTools = this.mode === 'visual-author' ? MERLIN_VISUAL_AUTHOR_TOOLS : MERLIN_TOOLS;
    const filtered = baseTools.filter(t => allowedToolNames.includes(t.name as string));
    const systemInstruction =
      this.mode === 'visual-author' ? MERLIN_VISUAL_AUTHOR_SYSTEM_PROMPT : MERLIN_SYSTEM_PROMPT;
    console.log(`[MerlinChat] Per-call tools filter: ${filtered.length}/${baseTools.length} tools allowed → [${filtered.map(t => t.name).join(', ')}]`);
    return {
      systemInstruction,
      ...(filtered.length > 0
        ? { tools: [{ functionDeclarations: filtered }] }
        : {}),
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.AUTO,
        },
      },
    };
  }

  /**
   * Start a new chat session with an image of the person
   * The image is used to personalize the intro observation
   */
  async startChatWithImage(imageBase64: string): Promise<ChatTurnResult> {
    this.history = [];
    this.mode = 'merlin';
    this.chat = buildChat(this.history);

    const messageParts: Part[] = [
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      },
      { text: INTRO_WITH_IMAGE_PROMPT },
    ];

    const result = await withRetry(
      () => this.chat!.sendMessage({ message: messageParts }),
      { label: 'gemini:startChatWithImage' },
    );
    const response = parseResult(result);

    this.history.push(
      { role: 'user', parts: [{ text: '[Image of person] ' + INTRO_WITH_IMAGE_PROMPT }] },
      { role: 'model', parts: [{ text: response.text || '[processing tools]' }] }
    );

    return response;
  }

  /**
   * Start a new chat session without an image (fallback)
   */
  async startChat(): Promise<ChatTurnResult> {
    this.history = [];
    this.mode = 'merlin';
    this.chat = buildChat(this.history);

    const result = await withRetry(
      () => this.chat!.sendMessage({ message: INTRO_WITH_IMAGE_PROMPT }),
      { label: 'gemini:startChat' },
    );
    const response = parseResult(result);

    this.history.push(
      { role: 'user', parts: [{ text: INTRO_WITH_IMAGE_PROMPT }] },
      { role: 'model', parts: [{ text: response.text || '[processing tools]' }] }
    );

    return response;
  }

  /**
   * Initialize a chat session WITHOUT sending an opening message.
   * Used by Test Mode's Live Spell tab so the caller can send the
   * user's spell description through the same `sendMessage` path live
   * Merlin uses, instead of the live `INTRO_WITH_IMAGE_PROMPT`.
   *
   * `mode` defaults to 'visual-author' — Live Spell test should not
   * inherit the conversational Merlin character (it produces
   * hallucinated participant interaction in a context where there is
   * no participant). Pass 'merlin' explicitly if you really want the
   * full character + all tools.
   */
  initChat(opts: { mode?: ChatMode } = {}): void {
    const mode = opts.mode ?? 'visual-author';
    this.mode = mode;
    this.history = [];
    this.chat = buildChat(this.history, mode);
  }

  /**
   * Send a plain user-text message and get a response.
   *
   * Optional `allowedTools` filters the tool registry to a subset for
   * this single call. Used by the live session to enforce per-phase
   * tool gating at the API level — Gemini physically can't call tools
   * outside the allowed list, so we don't burn a round-trip on
   * disallowed calls (e.g. prepare_casting in discovery).
   */
  async sendMessage(
    message: string,
    opts: { allowedTools?: string[] } = {},
  ): Promise<ChatTurnResult> {
    if (!this.chat) {
      throw new Error('Chat not started - call startChat() first');
    }

    const config = opts.allowedTools
      ? this.buildPerCallConfig(opts.allowedTools)
      : undefined;
    const result = await withRetry(
      () => this.chat!.sendMessage(
        config ? { message, config: config as never } : { message },
      ),
      { label: 'gemini:sendMessage' },
    );
    const response = parseResult(result);

    this.history.push(
      { role: 'user', parts: [{ text: message }] },
      { role: 'model', parts: [{ text: response.text }] }
    );

    return response;
  }

  /**
   * Provide tool results back to the model, optionally with inline
   * images attached to specific function responses.
   *
   * In Gemini 3, a function response can carry multimodal parts
   * (`parts: FunctionResponsePart[]`) alongside its structured
   * response. This is the canonical way to deliver something like a
   * screenshot back to the model — it avoids both the old text-only
   * `response: { base64: '...' }` (opaque) and the workaround of
   * sending a separate user-role message (an extra round-trip).
   *
   * Inline images are matched to function responses by `callId`. If a
   * `ToolResultImage` has no matching call, it's attached to the first
   * response in the batch as a safety fallback.
   */
  async sendToolResults(
    results: Array<{ name: string; response: unknown; callId?: string }>,
    images: ToolResultImage[] = [],
    opts: { allowedTools?: string[] } = {},
  ): Promise<ChatTurnResult> {
    if (!this.chat) {
      throw new Error('Chat not started');
    }

    const imagesByCallId = new Map<string, ToolResultImage[]>();
    const orphans: ToolResultImage[] = [];
    for (const img of images) {
      if (img.callId) {
        const arr = imagesByCallId.get(img.callId) ?? [];
        arr.push(img);
        imagesByCallId.set(img.callId, arr);
      } else {
        orphans.push(img);
      }
    }

    const parts: Part[] = results.map((r, i) => {
      const matched = r.callId ? imagesByCallId.get(r.callId) ?? [] : [];
      const fallback = i === 0 ? orphans : [];
      const inlineParts = [...matched, ...fallback].map((img) => ({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64,
        },
      }));
      return {
        functionResponse: {
          ...(r.callId ? { id: r.callId } : {}),
          name: r.name,
          response: r.response as Record<string, unknown>,
          ...(inlineParts.length > 0 ? { parts: inlineParts } : {}),
        },
      };
    });

    const config = opts.allowedTools
      ? this.buildPerCallConfig(opts.allowedTools)
      : undefined;
    const result = await withRetry(
      () => this.chat!.sendMessage(
        config ? { message: parts, config: config as never } : { message: parts },
      ),
      { label: 'gemini:sendToolResults' },
    );
    return parseResult(result);
  }

  /**
   * End the session with a closing message
   */
  async endSession(): Promise<string> {
    if (!this.chat) {
      return 'Session was not active.';
    }

    const result = await withRetry(
      () => this.chat!.sendMessage({ message: MERLIN_CLOSING_PROMPT }),
      { label: 'gemini:endSession' },
    );
    const response = parseResult(result);
    this.chat = null;

    return response.text;
  }

  isActive(): boolean {
    return this.chat !== null;
  }

  getTurnCount(): number {
    return Math.floor(this.history.length / 2);
  }
}

function parseResult(result: GenerateContentResponse): ChatTurnResult {
  const candidate = result.candidates?.[0];

  if (!candidate || !candidate.content || !candidate.content.parts) {
    return {
      text: 'No response generated',
      toolCalls: [],
      finishReason: 'ERROR',
    };
  }

  const parts = candidate.content.parts;

  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');

  const toolCalls: MerlinToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => {
      const fc = p.functionCall!;
      return {
        name: (fc.name ?? '') as MerlinToolCall['name'],
        args: (fc.args ?? {}) as Record<string, unknown>,
        ...(fc.id ? { id: fc.id } : {}),
      };
    });

  return {
    text,
    toolCalls,
    finishReason: candidate.finishReason ?? 'STOP',
  };
}
