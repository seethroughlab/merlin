/**
 * Phase Transition Visual Effects
 *
 * Handles visual transitions between mentalist reading phases.
 * Each transition has a distinct visual treatment that signals
 * the shift in the reading's energy and focus.
 */

import type { MentalistPhase } from '../mentalist/types';
import {
  getPhaseVisualConfig,
  getAccumulatedSceneParams,
  calculateAccumulatedState,
  type AccumulatedVisualState,
} from './insight-visuals';
import {
  pushSceneParams,
  pushRevealEffect,
  pushAuraUpdate,
  isConnected as isTDConnected,
} from './index';
import type { InsightType } from '../mentalist/types';

/**
 * Track the current visual state across the session
 */
let currentVisualState: AccumulatedVisualState = {
  totalInsights: 0,
  insightsByType: {},
  auraIntensity: 0.3,
  particleComplexity: 0,
  dominantColor: '#8B5CF6',
};

/**
 * Reset visual state (call at session start)
 */
export function resetVisualState(): void {
  currentVisualState = {
    totalInsights: 0,
    insightsByType: {},
    auraIntensity: 0.3,
    particleComplexity: 0,
    dominantColor: '#8B5CF6',
  };

  if (isTDConnected()) {
    const idleConfig = getPhaseVisualConfig('idle');
    pushSceneParams(idleConfig.sceneParams);
  }
}

/**
 * Handle a phase transition with appropriate visual effects
 */
export function triggerPhaseTransition(
  fromPhase: MentalistPhase,
  toPhase: MentalistPhase,
  revealedInsights: Array<{ type: InsightType; confidence: number }> = []
): void {
  if (!isTDConnected()) {
    return;
  }

  // Update accumulated state
  currentVisualState = calculateAccumulatedState(revealedInsights);

  // Get visual config for new phase
  const phaseConfig = getPhaseVisualConfig(toPhase);

  // Blend with accumulated state
  const sceneParams = getAccumulatedSceneParams(currentVisualState, toPhase);

  // Push scene update
  pushSceneParams(sceneParams);

  // Push aura update
  if (sceneParams.aura_color && sceneParams.aura_size !== undefined) {
    pushAuraUpdate(
      sceneParams.aura_color,
      sceneParams.aura_size,
      sceneParams.particle_behavior || 'calm'
    );
  }

  // Trigger transition effect if defined
  if (phaseConfig.transitionEffect) {
    pushRevealEffect(
      phaseConfig.transitionEffect.effect_type,
      phaseConfig.transitionEffect.intensity,
      phaseConfig.transitionEffect.duration
    );
  }

  console.log(`[PhaseTransition] ${fromPhase} → ${toPhase}`, {
    totalInsights: currentVisualState.totalInsights,
    dominantColor: currentVisualState.dominantColor,
  });
}

/**
 * Apply initial visuals when session starts
 */
export function applySessionStartVisuals(): void {
  if (!isTDConnected()) {
    return;
  }

  resetVisualState();

  const introConfig = getPhaseVisualConfig('intro');
  pushSceneParams(introConfig.sceneParams);

  if (introConfig.sceneParams.aura_color && introConfig.sceneParams.aura_size !== undefined) {
    pushAuraUpdate(
      introConfig.sceneParams.aura_color,
      introConfig.sceneParams.aura_size,
      'calm'
    );
  }

  // Gentle intro effect
  if (introConfig.transitionEffect) {
    // Delay slightly so visuals settle first
    setTimeout(() => {
      if (isTDConnected()) {
        pushRevealEffect(
          introConfig.transitionEffect!.effect_type,
          introConfig.transitionEffect!.intensity * 0.5, // Softer for intro
          introConfig.transitionEffect!.duration
        );
      }
    }, 500);
  }

  console.log('[PhaseTransition] Session started with intro visuals');
}

/**
 * Apply finale visuals when session ends
 */
export function applySessionEndVisuals(
  revealedInsights: Array<{ type: InsightType; confidence: number }>
): void {
  if (!isTDConnected()) {
    return;
  }

  // Calculate final accumulated state
  currentVisualState = calculateAccumulatedState(revealedInsights);

  const finaleConfig = getPhaseVisualConfig('finale');
  const sceneParams = getAccumulatedSceneParams(currentVisualState, 'finale');

  // Push final scene with accumulated colors
  pushSceneParams({
    ...sceneParams,
    particle_behavior: 'trailing', // Peaceful settling
  });

  if (sceneParams.aura_color) {
    pushAuraUpdate(
      sceneParams.aura_color,
      Math.min(0.8, currentVisualState.auraIntensity + 0.2), // Full aura for finale
      'trailing'
    );
  }

  // Final ascending effect
  pushRevealEffect('ascend', 0.7, 4);

  // Gradually fade to warm after finale effect
  setTimeout(() => {
    if (isTDConnected()) {
      pushSceneParams({
        particle_intensity: 'subtle',
        particle_behavior: 'calm',
        aura_size: 0.3,
        background_mood: 'warm',
      });
    }
  }, 4000);

  console.log('[PhaseTransition] Session ended with finale visuals', {
    totalInsights: currentVisualState.totalInsights,
  });
}

/**
 * Update visuals when an insight is revealed (in addition to the reveal effect)
 */
export function updateVisualsForInsight(
  revealedInsights: Array<{ type: InsightType; confidence: number }>,
  currentPhase: MentalistPhase
): void {
  if (!isTDConnected()) {
    return;
  }

  // Update accumulated state
  currentVisualState = calculateAccumulatedState(revealedInsights);

  // Get updated scene params
  const sceneParams = getAccumulatedSceneParams(currentVisualState, currentPhase);

  // Push subtle scene update (don't override ongoing reveal effects)
  pushSceneParams({
    aura_color: sceneParams.aura_color,
    aura_size: sceneParams.aura_size,
  });

  console.log('[InsightVisual] Updated for insight', {
    totalInsights: currentVisualState.totalInsights,
    auraIntensity: currentVisualState.auraIntensity,
  });
}

/**
 * Get current visual state (for debugging/UI)
 */
export function getCurrentVisualState(): AccumulatedVisualState {
  return { ...currentVisualState };
}
