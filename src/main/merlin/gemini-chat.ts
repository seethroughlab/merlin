/**
 * Gemini Multi-Turn Chat Wrapper for Merlin
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
import { MERLIN_SYSTEM_PROMPT, MERLIN_TOOLS, INTRO_WITH_IMAGE_PROMPT, MERLIN_CLOSING_PROMPT } from './prompts';
import type { MerlinToolCall } from './types';

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
  toolCalls: MerlinToolCall[];
  finishReason: string;
}

/**
 * MerlinChat - manages multi-turn conversation with Gemini
 */
export class MerlinChat {
  private chat: ChatSession | null = null;
  private history: Content[] = [];

  /**
   * Start a new chat session with an image of the person
   * The image is used to personalize the intro observation
   */
  async startChatWithImage(imageBase64: string): Promise<ChatTurnResult> {
    const ai = ensureGenAI();

    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: MERLIN_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: MERLIN_TOOLS }],
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

    // Send image + intro prompt together
    const messageParts: Part[] = [
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      },
      { text: INTRO_WITH_IMAGE_PROMPT },
    ];

    const result = await this.chat.sendMessage(messageParts);
    const response = this.parseResult(result);

    // Update history (store text representation for history)
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
    const ai = ensureGenAI();

    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: MERLIN_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: MERLIN_TOOLS }],
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

    // Send opening prompt without image
    const result = await this.chat.sendMessage(INTRO_WITH_IMAGE_PROMPT);

    const response = this.parseResult(result);

    // Update history with this exchange
    this.history.push(
      { role: 'user', parts: [{ text: INTRO_WITH_IMAGE_PROMPT }] },
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
   * End the session with a closing message
   */
  async endSession(): Promise<string> {
    if (!this.chat) {
      return 'Session was not active.';
    }

    const result = await this.chat.sendMessage(MERLIN_CLOSING_PROMPT);

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
    const toolCalls: MerlinToolCall[] = parts
      .filter((p) => 'functionCall' in p)
      .map((p) => {
        const fc = (p as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
        return {
          name: fc.name as MerlinToolCall['name'],
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
