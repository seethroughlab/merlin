/**
 * Gemini Multi-Turn Chat Wrapper
 *
 * Manages a stateful conversation with Gemini including tool calling.
 */

import {
  GoogleGenerativeAI,
  ChatSession,
  Content,
  FunctionCallingMode,
  GenerateContentResult,
  Part,
} from '@google/generative-ai';
import { MENTALIST_SYSTEM_PROMPT, MENTALIST_TOOLS } from './prompts';
import type { MentalistToolCall } from './types';

let genAI: GoogleGenerativeAI | null = null;

/**
 * Initialize the Gemini client for chat
 */
function ensureGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

/**
 * Parsed response from Gemini chat turn
 */
export interface ChatTurnResult {
  text: string;
  toolCalls: MentalistToolCall[];
  finishReason: string;
}

/**
 * MentalistChat - manages multi-turn conversation with Gemini
 */
export class MentalistChat {
  private chat: ChatSession | null = null;
  private history: Content[] = [];

  /**
   * Start a new chat session
   * Returns full ChatTurnResult so caller can handle tool calls
   */
  async startChat(): Promise<ChatTurnResult> {
    const ai = ensureGenAI();

    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: MENTALIST_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: MENTALIST_TOOLS }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.AUTO,
        },
      },
    });

    this.history = [];
    this.chat = model.startChat({
      history: this.history,
    });

    // Send initial message to get intro - must end with an engaging question
    const initPrompt = `Begin the reading. The participant has just sat down and is ready.

IMPORTANT: Your response MUST end with an engaging question or prompt for them to respond to. Don't just observe - draw them into conversation.`;

    const result = await this.chat.sendMessage(initPrompt);

    const response = this.parseResult(result);

    // Update history with this exchange (text may be filled in after tool processing)
    this.history.push(
      { role: 'user', parts: [{ text: initPrompt }] },
      { role: 'model', parts: [{ text: response.text || '[processing tools]' }] }
    );

    return response;
  }

  /**
   * Send a message and get a response
   */
  async sendMessage(message: string): Promise<ChatTurnResult> {
    if (!this.chat) {
      throw new Error('Chat not started - call startChat() first');
    }

    const result = await this.chat.sendMessage(message);
    const response = this.parseResult(result);

    // Update history
    this.history.push(
      { role: 'user', parts: [{ text: message }] },
      { role: 'model', parts: [{ text: response.text }] }
    );

    return response;
  }

  /**
   * Provide tool results back to the model
   */
  async sendToolResults(results: Array<{ name: string; response: unknown }>): Promise<ChatTurnResult> {
    if (!this.chat) {
      throw new Error('Chat not started');
    }

    const functionResponses: Part[] = results.map((r) => ({
      functionResponse: {
        name: r.name,
        response: r.response as object,
      },
    }));

    const result = await this.chat.sendMessage(functionResponses);
    return this.parseResult(result);
  }

  /**
   * End the session with a finale message
   */
  async endSession(): Promise<string> {
    if (!this.chat) {
      return 'Session was not active.';
    }

    const result = await this.chat.sendMessage(
      '[The participant is ready to conclude. Provide a warm, memorable finale that summarizes key insights.]'
    );

    const response = this.parseResult(result);
    this.chat = null;

    return response.text;
  }

  /**
   * Check if chat is active
   */
  isActive(): boolean {
    return this.chat !== null;
  }

  /**
   * Get conversation history length
   */
  getTurnCount(): number {
    return Math.floor(this.history.length / 2);
  }

  /**
   * Parse Gemini result into our format
   */
  private parseResult(result: GenerateContentResult): ChatTurnResult {
    const response = result.response;
    const candidate = response.candidates?.[0];

    if (!candidate || !candidate.content || !candidate.content.parts) {
      return {
        text: 'No response generated',
        toolCalls: [],
        finishReason: 'ERROR',
      };
    }

    const parts = candidate.content.parts;

    // Extract text parts
    const textParts = parts
      .filter((p) => 'text' in p)
      .map((p) => (p as { text: string }).text);
    const text = textParts.join('');

    // Extract function calls
    const toolCalls: MentalistToolCall[] = parts
      .filter((p) => 'functionCall' in p)
      .map((p) => {
        const fc = (p as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
        return {
          name: fc.name as MentalistToolCall['name'],
          args: fc.args,
        };
      });

    return {
      text,
      toolCalls,
      finishReason: candidate.finishReason || 'STOP',
    };
  }
}
