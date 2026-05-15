/**
 * Merlin test-mode IPC (Shift+T). Forced-tool Gemini runs for shaders,
 * sprites (direct + Gemini-interpreted), flipbook re-config, mirrored
 * state readout, TD reset to baseline, and the live-spell end-to-end
 * scenario.
 */

import { ipcMain } from 'electron';
import type { MainContext } from './types';
import type {
  TestShaderConfig,
  SpriteTestSpec,
  SpriteFlipbookConfig,
  LiveSpellTestInput,
} from '../../shared/types';
import { isGeminiAvailable } from '../merlin/gemini-analysis';
import { testShaderGeneration } from '../merlin/test-shader';
import { generateSpriteDirect, generateSpriteWithGemini } from '../merlin/test-sprite';
import { applyFlipbookConfig, getCurrentMirroredState } from '../merlin/test-flipbook';
import { testLiveSpell } from '../merlin/test-live-spell';
import { resetTDBaseline } from '../merlin/reset-td';

export function registerMerlinTestIPC(ctx: MainContext): void {
  ipcMain.handle('merlin-test-shader', async (_event, config: TestShaderConfig) => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }
    console.log(`[Merlin ${ctx.ts()}] Test shader: prompt="${config.prompt.slice(0, 60)}${config.prompt.length > 60 ? '…' : ''}" zones=${config.zones?.join(',') ?? 'all'}`);
    const startTime = Date.now();
    try {
      const result = await testShaderGeneration(config);
      console.log(`[Merlin ${ctx.ts()}] Test shader complete in ${Date.now() - startTime}ms, ${result.zones.length} zones`);
      return result;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Test shader failed:`, error);
      throw error;
    }
  });

  ipcMain.handle('merlin-test-sprite-direct', async (_event, spec: SpriteTestSpec) => {
    console.log(`[Merlin ${ctx.ts()}] Test sprite (direct): "${spec.description}"`);
    const startTime = Date.now();
    try {
      const result = await generateSpriteDirect(spec);
      console.log(`[Merlin ${ctx.ts()}] Test sprite (direct) complete in ${Date.now() - startTime}ms, success=${result.success}`);
      return result;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Test sprite (direct) failed:`, error);
      throw error;
    }
  });

  ipcMain.handle('merlin-test-sprite-gemini', async (_event, prompt: string) => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }
    console.log(`[Merlin ${ctx.ts()}] Test sprite (gemini): "${prompt}"`);
    const startTime = Date.now();
    try {
      const result = await generateSpriteWithGemini(prompt);
      console.log(`[Merlin ${ctx.ts()}] Test sprite (gemini) complete in ${Date.now() - startTime}ms, success=${result.success}`);
      return result;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Test sprite (gemini) failed:`, error);
      throw error;
    }
  });

  ipcMain.handle('merlin-test-flipbook-config', async (_event, config: SpriteFlipbookConfig) => {
    console.log(`[Merlin ${ctx.ts()}] Test flipbook config: ${JSON.stringify(config)}`);
    return applyFlipbookConfig(config);
  });

  ipcMain.handle('merlin-test-get-mirrored-state', async () => getCurrentMirroredState());

  // Reset TD shaders / sprite / flipbook to baseline (sidebar button).
  ipcMain.handle('merlin-reset-td-baseline', async () => {
    console.log(`[Merlin ${ctx.ts()}] Reset TD baseline`);
    const startTime = Date.now();
    try {
      const result = await resetTDBaseline();
      const failed = result.steps.filter(s => s.status === 'error').length;
      const skipped = result.steps.filter(s => s.status === 'skipped').length;
      console.log(`[Merlin ${ctx.ts()}] Reset complete in ${Date.now() - startTime}ms (${failed} failed, ${skipped} skipped)`);
      return result;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Reset failed:`, error);
      throw error;
    }
  });

  // Live Spell end-to-end test (Shift+T → Live Spell tab). Highest-scope
  // dev surface: Gemini reads the spell description, generates a sprite,
  // pushes zone shaders, screenshots the result, evaluates, and iterates.
  ipcMain.handle('merlin-test-live-spell', async (_event, input: LiveSpellTestInput) => {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini not available - check GEMINI_API_KEY');
    }
    console.log(`[Merlin ${ctx.ts()}] Test live spell: prompt="${input.prompt}"`);
    const startTime = Date.now();
    try {
      const result = await testLiveSpell(input);
      console.log(`[Merlin ${ctx.ts()}] Test live spell complete in ${Date.now() - startTime}ms, success=${result.success} toolCalls=${result.toolCallCount}`);
      return result;
    } catch (error) {
      console.error(`[Merlin ${ctx.ts()}] Test live spell failed:`, error);
      throw error;
    }
  });
}
