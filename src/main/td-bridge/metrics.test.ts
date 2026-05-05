import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  updateMetrics,
  updateVisibility,
  handleScreenshotResponse,
  requestScreenshot,
  getLatestMetrics,
  getAverageFps,
  getAverageParticleCount,
  getMetricsHistory,
  getLatestScreenshot,
  getLatestVisibility,
  clearMetrics,
  getMetricsSummary,
} from './metrics';

describe('metrics', () => {
  beforeEach(() => {
    // Clear metrics before each test
    clearMetrics();
  });

  describe('updateMetrics', () => {
    it('should store metrics', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      const latest = getLatestMetrics();
      expect(latest?.fps).toBe(60);
      expect(latest?.particleCount).toBe(1000);
      expect(latest?.coverage).toBe(0.5);
    });

    it('should add timestamp', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      const latest = getLatestMetrics();
      expect(latest?.timestamp).toBeDefined();
      expect(latest?.timestamp).toBeGreaterThan(0);
    });

    it('should build history', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      updateMetrics({ fps: 55, particle_count: 950, coverage: 0.45 });
      updateMetrics({ fps: 65, particle_count: 1050, coverage: 0.55 });

      const history = getMetricsHistory();
      expect(history).toHaveLength(3);
    });

    it('should limit history size', () => {
      // Add more than 60 samples
      for (let i = 0; i < 70; i++) {
        updateMetrics({ fps: 60 + i, particle_count: 1000, coverage: 0.5 });
      }

      const history = getMetricsHistory();
      expect(history).toHaveLength(60);
    });
  });

  describe('updateVisibility', () => {
    it('should store visibility metrics', () => {
      updateVisibility({
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.7,
      });

      const visibility = getLatestVisibility();
      expect(visibility?.visibleParticles).toBe(800);
      expect(visibility?.culledParticles).toBe(200);
      expect(visibility?.avgBrightness).toBe(0.7);
    });

    it('should add timestamp', () => {
      updateVisibility({
        visible_particles: 800,
        culled_particles: 200,
        avg_brightness: 0.7,
      });

      const visibility = getLatestVisibility();
      expect(visibility?.timestamp).toBeGreaterThan(0);
    });
  });

  describe('handleScreenshotResponse', () => {
    it('should store screenshot', () => {
      handleScreenshotResponse({
        base64: 'abc123',
        width: 1920,
        height: 1080,
      });

      const screenshot = getLatestScreenshot();
      expect(screenshot?.base64).toBe('abc123');
      expect(screenshot?.width).toBe(1920);
      expect(screenshot?.height).toBe(1080);
    });

    it('should add timestamp', () => {
      handleScreenshotResponse({
        base64: 'abc123',
        width: 1920,
        height: 1080,
      });

      const screenshot = getLatestScreenshot();
      expect(screenshot?.timestamp).toBeGreaterThan(0);
    });
  });

  describe('requestScreenshot', () => {
    it('should send request via sendFn', async () => {
      const sendFn = vi.fn().mockReturnValue(true);

      // Don't await - just initiate
      const promise = requestScreenshot(sendFn, 100);

      expect(sendFn).toHaveBeenCalledWith({ type: 'request_screenshot' });

      // Resolve with a response
      handleScreenshotResponse({ base64: 'test', width: 100, height: 100 });

      const result = await promise;
      expect(result?.base64).toBe('test');
    });

    it('should return null if sendFn fails', async () => {
      const sendFn = vi.fn().mockReturnValue(false);

      const result = await requestScreenshot(sendFn, 100);
      expect(result).toBeNull();
    });

    it('should timeout and return null', async () => {
      const sendFn = vi.fn().mockReturnValue(true);

      const result = await requestScreenshot(sendFn, 50);
      expect(result).toBeNull();
    });

    it('should cancel previous pending request', async () => {
      const sendFn = vi.fn().mockReturnValue(true);

      // Start first request
      const promise1 = requestScreenshot(sendFn, 1000);

      // Start second request (should cancel first)
      const promise2 = requestScreenshot(sendFn, 100);

      // First should resolve to null
      const result1 = await promise1;
      expect(result1).toBeNull();

      // Second times out
      const result2 = await promise2;
      expect(result2).toBeNull();
    });
  });

  describe('getAverageFps', () => {
    it('should return 0 for empty history', () => {
      expect(getAverageFps()).toBe(0);
    });

    it('should calculate average', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      updateMetrics({ fps: 50, particle_count: 1000, coverage: 0.5 });
      updateMetrics({ fps: 70, particle_count: 1000, coverage: 0.5 });

      expect(getAverageFps()).toBe(60);
    });
  });

  describe('getAverageParticleCount', () => {
    it('should return 0 for empty history', () => {
      expect(getAverageParticleCount()).toBe(0);
    });

    it('should calculate average and round', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      updateMetrics({ fps: 60, particle_count: 1001, coverage: 0.5 });
      updateMetrics({ fps: 60, particle_count: 1002, coverage: 0.5 });

      expect(getAverageParticleCount()).toBe(1001);
    });
  });

  describe('getMetricsHistory', () => {
    it('should return copy of history', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });

      const history1 = getMetricsHistory();
      const history2 = getMetricsHistory();

      expect(history1).not.toBe(history2); // Different arrays
      expect(history1).toEqual(history2);   // Same content
    });
  });

  describe('clearMetrics', () => {
    it('should clear all metrics', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      updateVisibility({ visible_particles: 800, culled_particles: 200, avg_brightness: 0.7 });
      handleScreenshotResponse({ base64: 'test', width: 100, height: 100 });

      clearMetrics();

      expect(getLatestMetrics()).toBeNull();
      expect(getLatestVisibility()).toBeNull();
      expect(getLatestScreenshot()).toBeNull();
      expect(getMetricsHistory()).toHaveLength(0);
    });

    it('should cancel pending screenshot request', async () => {
      const sendFn = vi.fn().mockReturnValue(true);

      const promise = requestScreenshot(sendFn, 5000);
      clearMetrics();

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('getMetricsSummary', () => {
    it('should return defaults when no metrics', () => {
      const summary = getMetricsSummary();
      expect(summary.fps).toBe(0);
      expect(summary.avgFps).toBe(0);
      expect(summary.particleCount).toBe(0);
      expect(summary.coverage).toBe(0);
      expect(summary.visibility).toBeNull();
      expect(summary.hasScreenshot).toBe(false);
      expect(summary.historyLength).toBe(0);
    });

    it('should return current metrics', () => {
      updateMetrics({ fps: 60, particle_count: 1000, coverage: 0.5 });
      updateMetrics({ fps: 50, particle_count: 900, coverage: 0.4 });
      updateVisibility({ visible_particles: 800, culled_particles: 200, avg_brightness: 0.7 });
      handleScreenshotResponse({ base64: 'test', width: 100, height: 100 });

      const summary = getMetricsSummary();
      expect(summary.fps).toBe(50); // Latest
      expect(summary.avgFps).toBe(55);
      expect(summary.particleCount).toBe(900); // Latest
      expect(summary.coverage).toBe(0.4); // Latest
      expect(summary.visibility).not.toBeNull();
      expect(summary.hasScreenshot).toBe(true);
      expect(summary.historyLength).toBe(2);
    });
  });
});
