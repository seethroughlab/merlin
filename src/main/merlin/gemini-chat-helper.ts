/**
 * Gemini Chat Helper
 *
 * Shared boilerplate for the test-mode Gemini callers. Each test
 * module previously open-coded `model.startChat({...})` with the same
 * FunctionCallingMode.ANY + single-tool config; this module collapses
 * that into one call so the three test modules stay focused on their
 * domain logic (parsing, coercion, push, retry).
 */

import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  FunctionDeclaration,
  ChatSession,
  Part,
} from '@google/generative-ai';
import type { GeminiToolCall } from '../../shared/types';

let genAI: GoogleGenerativeAI | null = null;

function ensureGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenerativeAI(apiKey);
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
  chat: ChatSession;
  /** Send a message and return the parsed response. Errors propagate. */
  send(message: string): Promise<ParsedGeminiResponse>;
}

export interface StartSingleToolChatOptions {
  systemInstruction?: string;
  model?: string;
}

/**
 * Start a Gemini chat configured to call exactly one tool, with
 * FunctionCallingMode.ANY forcing the tool to fire every response.
 */
export function startSingleToolChat(
  toolDef: FunctionDeclaration,
  opts: StartSingleToolChatOptions = {}
): GeminiChatHandle {
  const ai = ensureGenAI();
  const model = ai.getGenerativeModel({
    model: opts.model ?? 'gemini-2.5-flash',
    ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
    tools: [{ functionDeclarations: [toolDef] }],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingMode.ANY,
        allowedFunctionNames: [toolDef.name],
      },
    },
  });
  const chat = model.startChat();

  return {
    chat,
    async send(message: string): Promise<ParsedGeminiResponse> {
      const result = await chat.sendMessage(message);
      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      let text = '';
      const toolCalls: GeminiToolCall[] = [];
      for (const part of parts) {
        if ('text' in part && part.text) text += part.text;
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
      return { text, toolCalls, rawParts: parts };
    },
  };
}
