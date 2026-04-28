/**
 * Gemini TTS Module
 *
 * High-quality text-to-speech using Google's Gemini 3.1 Flash TTS.
 * Returns PCM audio data (24kHz, 16-bit mono) as base64.
 */

import { GoogleGenAI } from '@google/genai';

let ai: GoogleGenAI | null = null;

/**
 * Available voices for TTS
 * Each has distinct characteristics suited for different personas
 */
export const VOICES = {
  // Dramatic/mysterious voices (good for mentalist)
  charon: 'Charon',     // Deep, mysterious
  kore: 'Kore',         // Expressive, warm
  fenrir: 'Fenrir',     // Dark, intense

  // Neutral/professional
  puck: 'Puck',         // Playful, clear
  zephyr: 'Zephyr',     // Light, airy
  leda: 'Leda',         // Calm, composed

  // Other options
  enceladus: 'Enceladus',
  umbriel: 'Umbriel',
  algieba: 'Algieba',
  despina: 'Despina',
  achernar: 'Achernar',
  sulafat: 'Sulafat',
} as const;

export type VoiceName = typeof VOICES[keyof typeof VOICES];

// Default voice for mentalist - mysterious and theatrical
const DEFAULT_VOICE: VoiceName = 'Charon';

/**
 * Initialize the Gemini TTS client
 */
export function initTTS(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set - TTS disabled');
    return false;
  }

  try {
    ai = new GoogleGenAI({ apiKey });
    console.log('Gemini TTS initialized');
    return true;
  } catch (error) {
    console.error('Failed to initialize Gemini TTS:', error);
    return false;
  }
}

/**
 * Check if TTS is available
 */
export function isTTSAvailable(): boolean {
  return ai !== null;
}

export interface TTSOptions {
  voice?: VoiceName;
  // Audio tags can be embedded in text like [mysteriously] or [whispers]
}

export interface TTSResult {
  audioBase64: string;  // Base64-encoded PCM audio (24kHz, 16-bit mono)
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/**
 * Generate speech from text using Gemini TTS
 *
 * @param text - Text to speak. Can include audio tags like [mysteriously], [whispers], [excitedly]
 * @param options - Voice selection and other options
 * @returns Base64-encoded PCM audio data
 */
export async function generateSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<TTSResult> {
  if (!ai) {
    throw new Error('Gemini TTS not initialized');
  }

  const voice = options.voice || DEFAULT_VOICE;

  const startTime = Date.now();
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[TTS ${timestamp}] Generating speech with voice "${voice}": "${text.slice(0, 50)}..."`);

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',  // 'gemini-3.1-flash-tts-preview' for faster but check availability
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    // Extract audio data from response
    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!audioData) {
      throw new Error('No audio data in response');
    }

    const endTimestamp = new Date().toISOString().slice(11, 23);
    console.log(`[TTS ${endTimestamp}] Generated ${Math.round(audioData.length / 1024)}KB in ${Date.now() - startTime}ms`);

    return {
      audioBase64: audioData,
      sampleRate: 24000,
      channels: 1,
      bitDepth: 16,
    };
  } catch (error) {
    console.error('[TTS] Generation error:', error);
    throw error;
  }
}

/**
 * Generate theatrical mentalist speech
 * Selects voice based on mood (no audio tags for faster generation)
 */
export async function generateMentalistSpeech(
  text: string,
  mood: string = 'mysterious'
): Promise<TTSResult> {
  // Select voice based on mentalist mood
  let voice: VoiceName;

  switch (mood) {
    case 'mysterious':
    case 'revelation':
      voice = 'Charon';  // Deep, mysterious
      break;
    case 'warm':
    case 'contemplative':
      voice = 'Kore';    // Expressive, warm
      break;
    case 'tension':
    case 'intense':
      voice = 'Fenrir';  // Dark, intense
      break;
    case 'playful':
      voice = 'Puck';    // Playful
      break;
    default:
      voice = 'Charon';
  }

  return generateSpeech(text, { voice });
}
