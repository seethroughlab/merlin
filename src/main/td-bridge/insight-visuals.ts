/**
 * Insight-Driven Visual Augmentation
 *
 * Maps phases and insights to TouchDesigner visual configurations.
 * Each insight type and phase has distinct visual treatments that stack/blend
 * to create an evolving visual portrait of the participant.
 */

import type { SceneParams, SkeletonOverlay } from './types';

// Local type definitions (formerly in mentalist/types)
export type InsightType = 'emotion' | 'trait' | 'prediction' | 'observation' | 'secret';
export type MentalistMood = 'mysterious' | 'tension' | 'revelation' | 'warm' | 'contemplative';
export type MentalistPhase = 'idle' | 'intro' | 'reading' | 'reveal' | 'finale';

// ===== Color Palettes =====

/**
 * Colors associated with each insight type
 */
export const INSIGHT_COLORS: Record<InsightType, string> = {
  emotion: '#FF6B6B',    // Warm coral - feelings
  trait: '#4ECDC4',      // Teal - personality
  prediction: '#9B59B6', // Purple - future/intuition
  observation: '#3498DB', // Blue - perception
  secret: '#E74C3C',     // Deep red - hidden depths
};

/**
 * Colors associated with each mood
 */
export const MOOD_COLORS: Record<MentalistMood, string> = {
  mysterious: '#8B5CF6',   // Purple
  tension: '#F59E0B',      // Amber
  revelation: '#FFD700',   // Gold
  warm: '#F97316',         // Orange
  contemplative: '#6366F1', // Indigo
};

/**
 * Colors for each phase
 */
export const PHASE_COLORS: Record<MentalistPhase, string> = {
  idle: '#64748B',      // Slate
  intro: '#8B5CF6',     // Purple - mysterious
  reading: '#6366F1',   // Indigo - deep focus
  reveal: '#FFD700',    // Gold - illumination
  finale: '#F97316',    // Orange - warm closing
};

// ===== Phase Visual Configurations =====

/**
 * Visual configuration for each mentalist phase
 */
export interface PhaseVisualConfig {
  sceneParams: Partial<SceneParams>;
  auraSize: number;
  transitionEffect?: {
    effect_type: 'burst' | 'converge' | 'ripple' | 'ascend' | 'transform';
    intensity: number;
    duration: number;
  };
}

/**
 * Get visual configuration for a mentalist phase
 */
export function getPhaseVisualConfig(phase: MentalistPhase): PhaseVisualConfig {
  switch (phase) {
    case 'intro':
      return {
        sceneParams: {
          particle_intensity: 'subtle',
          particle_behavior: 'calm',
          particle_color: PHASE_COLORS.intro,
          aura_color: PHASE_COLORS.intro,
          aura_size: 0.3,
          background_mood: 'mysterious',
        },
        auraSize: 0.3,
        transitionEffect: {
          effect_type: 'ripple',
          intensity: 0.3,
          duration: 2,
        },
      };

    case 'reading':
      return {
        sceneParams: {
          particle_intensity: 'moderate',
          particle_behavior: 'orbiting',
          particle_color: PHASE_COLORS.reading,
          aura_color: PHASE_COLORS.reading,
          aura_size: 0.4,
          background_mood: 'mysterious',
        },
        auraSize: 0.4,
        transitionEffect: {
          effect_type: 'converge',
          intensity: 0.5,
          duration: 1.5,
        },
      };

    case 'reveal':
      return {
        sceneParams: {
          particle_intensity: 'intense',
          particle_behavior: 'attracted',
          particle_color: PHASE_COLORS.reveal,
          aura_color: PHASE_COLORS.reveal,
          aura_size: 0.6,
          background_mood: 'electric',
        },
        auraSize: 0.6,
        transitionEffect: {
          effect_type: 'burst',
          intensity: 0.8,
          duration: 2,
        },
      };

    case 'finale':
      return {
        sceneParams: {
          particle_intensity: 'moderate',
          particle_behavior: 'trailing',
          particle_color: PHASE_COLORS.finale,
          aura_color: PHASE_COLORS.finale,
          aura_size: 0.5,
          background_mood: 'warm',
        },
        auraSize: 0.5,
        transitionEffect: {
          effect_type: 'ascend',
          intensity: 0.6,
          duration: 3,
        },
      };

    case 'idle':
    default:
      return {
        sceneParams: {
          particle_intensity: 'subtle',
          particle_behavior: 'calm',
          particle_color: PHASE_COLORS.idle,
          aura_color: PHASE_COLORS.idle,
          aura_size: 0.2,
          background_mood: 'mysterious',
        },
        auraSize: 0.2,
      };
  }
}

// ===== Insight Visual Effects =====

/**
 * Visual effect configuration for an insight reveal
 */
export interface InsightVisualEffect {
  effect_type: 'burst' | 'converge' | 'ripple' | 'ascend' | 'transform';
  color: string;
  intensity: number;
  duration: number;
  center_landmark?: number;
  skeletonOverlays?: SkeletonOverlay[];
  auraBoost?: {
    color: string;
    sizeIncrease: number;
  };
}

/**
 * Get visual effect for revealing an insight
 */
export function getInsightVisualEffect(
  insightType: InsightType,
  intensity: number = 0.7
): InsightVisualEffect {
  const color = INSIGHT_COLORS[insightType];
  const normalizedIntensity = Math.min(1, Math.max(0, intensity));

  switch (insightType) {
    case 'emotion':
      // Emotion: Pulse effect centered on face/heart, warm colors
      return {
        effect_type: 'ripple',
        color,
        intensity: normalizedIntensity,
        duration: 2,
        center_landmark: 0, // Nose (face center)
        auraBoost: {
          color,
          sizeIncrease: 0.1,
        },
      };

    case 'trait':
      // Trait: Orbiting particles around body, personality emerging
      return {
        effect_type: 'converge',
        color,
        intensity: normalizedIntensity,
        duration: 2.5,
        skeletonOverlays: [
          // Highlight shoulders (posture = personality)
          {
            landmark_start: 11,
            landmark_end: 12,
            effect: 'glow',
            color,
            intensity: normalizedIntensity,
          },
        ],
        auraBoost: {
          color,
          sizeIncrease: 0.05,
        },
      };

    case 'prediction':
      // Prediction: Ascending energy, mystical
      return {
        effect_type: 'ascend',
        color,
        intensity: normalizedIntensity * 0.9,
        duration: 3,
        skeletonOverlays: [
          // Energy lines from hands upward
          {
            landmark_start: 15,
            landmark_end: 11,
            effect: 'energy_line',
            color,
            intensity: normalizedIntensity,
          },
          {
            landmark_start: 16,
            landmark_end: 12,
            effect: 'energy_line',
            color,
            intensity: normalizedIntensity,
          },
        ],
        auraBoost: {
          color,
          sizeIncrease: 0.15,
        },
      };

    case 'observation':
      // Observation: Subtle geometric patterns, analytical
      return {
        effect_type: 'ripple',
        color,
        intensity: normalizedIntensity * 0.6,
        duration: 1.5,
        skeletonOverlays: [
          // Highlight what's being observed (e.g., hands)
          {
            landmark_start: 15,
            landmark_end: 16,
            effect: 'geometric',
            color,
            intensity: normalizedIntensity * 0.5,
          },
        ],
      };

    case 'secret':
      // Secret: Dramatic reveal, deep colors, transformation
      return {
        effect_type: 'transform',
        color,
        intensity: Math.min(1, normalizedIntensity * 1.2),
        duration: 3,
        center_landmark: 0,
        skeletonOverlays: [
          // Full body glow for deep revelation
          {
            landmark_start: 11,
            landmark_end: 23,
            effect: 'glow',
            color,
            intensity: normalizedIntensity,
          },
          {
            landmark_start: 12,
            landmark_end: 24,
            effect: 'glow',
            color,
            intensity: normalizedIntensity,
          },
        ],
        auraBoost: {
          color,
          sizeIncrease: 0.2,
        },
      };

    default:
      return {
        effect_type: 'burst',
        color: '#FFFFFF',
        intensity: normalizedIntensity,
        duration: 2,
      };
  }
}

// ===== Accumulated Visual State =====

/**
 * Tracks visual complexity as insights accumulate
 */
export interface AccumulatedVisualState {
  totalInsights: number;
  insightsByType: Partial<Record<InsightType, number>>;
  auraIntensity: number;
  particleComplexity: number;
  dominantColor: string;
}

/**
 * Calculate accumulated visual state from revealed insights
 */
export function calculateAccumulatedState(
  revealedInsights: Array<{ type: InsightType; confidence: number }>
): AccumulatedVisualState {
  const insightsByType: Partial<Record<InsightType, number>> = {};
  let totalConfidence = 0;

  for (const insight of revealedInsights) {
    insightsByType[insight.type] = (insightsByType[insight.type] || 0) + 1;
    totalConfidence += insight.confidence;
  }

  const totalInsights = revealedInsights.length;

  // Find dominant insight type
  let dominantType: InsightType = 'observation';
  let maxCount = 0;
  for (const [type, count] of Object.entries(insightsByType)) {
    if (count !== undefined && count > maxCount) {
      maxCount = count;
      dominantType = type as InsightType;
    }
  }

  return {
    totalInsights,
    insightsByType,
    auraIntensity: Math.min(1, 0.3 + totalInsights * 0.1),
    particleComplexity: Math.min(1, totalInsights * 0.15),
    dominantColor: INSIGHT_COLORS[dominantType],
  };
}

/**
 * Get scene params that reflect accumulated insights
 */
export function getAccumulatedSceneParams(
  state: AccumulatedVisualState,
  currentPhase: MentalistPhase
): Partial<SceneParams> {
  const phaseConfig = getPhaseVisualConfig(currentPhase);
  const baseParams = phaseConfig.sceneParams;

  // Blend accumulated state with phase defaults
  const particleIntensityLevels: SceneParams['particle_intensity'][] = [
    'subtle',
    'moderate',
    'intense',
    'overwhelming',
  ];
  const intensityIndex = Math.min(
    3,
    Math.floor(state.particleComplexity * 4)
  );

  return {
    ...baseParams,
    particle_intensity: particleIntensityLevels[intensityIndex],
    aura_color: state.dominantColor,
    aura_size: Math.min(0.8, (baseParams.aura_size ?? 0.3) + state.auraIntensity * 0.3),
  };
}
