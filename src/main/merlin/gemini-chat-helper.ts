/**
 * Gemini Chat Helper
 *
 * Shared boilerplate for the test-mode Gemini callers. Each test
 * module previously open-coded the same forced-tool config; this
 * module collapses that into one call so the test modules stay
 * focused on their domain logic (parsing, coercion, push, retry).
 *
 * Built on `@google/genai` so it shares the same SDK as the live
 * `MerlinChat`.
 */

import {
  GoogleGenAI,
  Chat,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  Part,
} from '@google/genai';
import type { GeminiToolCall } from '../../shared/types';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

let genAI: GoogleGenAI | null = null;

function ensureGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

export interface ParsedGeminiResponse {
  /** Free-text portion of Gemini's response (concatenated across text parts). */
  text: string;
  /** Tool calls extracted from the response, in the order Gemini emitted them. */
  toolCalls: GeminiToolCall[];
  /** Raw parts for callers that need richer parsing (e.g. per-zone routing). */
  rawParts: Part[];
}

export interface GeminiChatHandle {
  /** The underlying chat session. Use directly only when send() isn't sufficient. */
  chat: Chat;
  /** Send a message and return the parsed response. Errors propagate. */
  send(message: string): Promise<ParsedGeminiResponse>;
}

export interface StartSingleToolChatOptions {
  systemInstruction?: string;
  model?: string;
}

/**
 * Start a Gemini chat configured to call exactly one tool, with
 * `FunctionCallingConfigMode.ANY` forcing the tool to fire every response.
 */
export function startSingleToolChat(
  toolDef: FunctionDeclaration,
  opts: StartSingleToolChatOptions = {}
): GeminiChatHandle {
  const ai = ensureGenAI();
  const chat = ai.chats.create({
    model: opts.model ?? DEFAULT_MODEL,
    config: {
      ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
      tools: [{ functionDeclarations: [toolDef] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: [toolDef.name ?? ''],
        },
      },
    },
  });

  return {
    chat,
    async send(message: string): Promise<ParsedGeminiResponse> {
      const result = await chat.sendMessage({ message });
      const parts = result.candidates?.[0]?.content?.parts ?? [];
      let text = '';
      const toolCalls: GeminiToolCall[] = [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) text += part.text;
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name ?? '',
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
      return { text, toolCalls, rawParts: parts };
    },
  };
}
