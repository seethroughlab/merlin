/**
 * TD Bridge Metrics
 *
 * Store and expose performance metrics from TouchDesigner.
 * Includes FPS, particle counts, visibility, and screenshots.
 */

const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Performance metrics from TD
 */
export interface TDMetrics {
  fps: number;
  particleCount: number;
  coverage: number; // 0-1, how much of screen has particles
  timestamp: number;
}

/**
 * Screenshot data from TD
 */
export interface TDScreenshot {
  base64: string;
  width: number;
  height: number;
  timestamp: number;
}

/**
 * Visibility metrics
 */
export interface VisibilityMetrics {
  visibleParticles: number;
  culledParticles: number;
  avgBrightness: number;
  /**
   * Average per-pixel difference between the particle render output
   * (`particle_render_out`) and the raw webcam (`syphonspoutin1`).
   * Near 0 = the final composite is essentially the webcam (particles
   * not contributing visibly). Above ~0.01 = particles are altering
   * the final image.
   *
   * Optional — TD may not always emit this field (older TD projects).
   * When absent, treat as "unknown" rather than 0.
   */
  renderVsWebcamDiff?: number;
  timestamp: number;
}

// Store recent metrics (rolling window)
const METRICS_HISTORY_SIZE = 60; // 60 samples
let metricsHistory: TDMetrics[] = [];
let latestMetrics: TDMetrics | null = null;
let latestScreenshot: TDScreenshot | null = null;
let latestVisibility: VisibilityMetrics | null = null;

// Pending screenshot request
let screenshotResolve: ((screenshot: TDScreenshot | null) => void) | null = null;
let screenshotTimeout: NodeJS.Timeout | null = null;

/**
 * One in-flight sprite load: resolved by `handleSpriteLoaded` when the
 * matching `sprite_loaded` WS message arrives from TD. Keyed by assetId
 * so concurrent loads (rare) don't collide and so `waitForSpriteLoad`
 * is robust if called slightly late (the resolver still has its key).
 */
interface PendingSpriteLoad {
  resolve: (r: SpriteLoadResult) => void;
  timeoutId: NodeJS.Timeout;
}
const pendingSpriteLoads = new Map<string, PendingSpriteLoad>();

/**
 * Outcome of a `waitForSpriteLoad` call.
 */
export interface SpriteLoadResult {
  success: boolean;
  error?: string;
  /** True if no `sprite_loaded` message arrived within timeoutMs. */
  timedOut?: boolean;
}

/**
 * Update metrics from TD
 */
export function updateMetrics(metrics: { fps: number; particle_count: number; coverage: number }): void {
  const entry: TDMetrics = {
    fps: metrics.fps,
    particleCount: metrics.particle_count,
    coverage: metrics.coverage,
    timestamp: Date.now(),
  };

  latestMetrics = entry;
  metricsHistory.push(entry);

  // Keep rolling window
  if (metricsHistory.length > METRICS_HISTORY_SIZE) {
    metricsHistory.shift();
  }
}

/**
 * Update visibility metrics from TD
 */
export function updateVisibility(visibility: {
  visible_particles: number;
  culled_particles: number;
  avg_brightness: number;
  render_vs_webcam_diff?: number;
}): void {
  latestVisibility = {
    visibleParticles: visibility.visible_particles,
    culledParticles: visibility.culled_particles,
    avgBrightness: visibility.avg_brightness,
    ...(typeof visibility.render_vs_webcam_diff === 'number'
      ? { renderVsWebcamDiff: visibility.render_vs_webcam_diff }
      : {}),
    timestamp: Date.now(),
  };
}

/**
 * Handle screenshot response from TD
 */
export function handleScreenshotResponse(screenshot: {
  base64: string;
  width: number;
  height: number;
}): void {
  const result: TDScreenshot = {
    ...screenshot,
    timestamp: Date.now(),
  };

  latestScreenshot = result;

  // Resolve pending request
  if (screenshotResolve) {
    if (screenshotTimeout) {
      clearTimeout(screenshotTimeout);
      screenshotTimeout = null;
    }
    screenshotResolve(result);
    screenshotResolve = null;
  }

  console.log(`[TDMetrics ${ts()}] Screenshot received: ${screenshot.width}x${screenshot.height}`);
}

/**
 * Request a screenshot from TD
 * Returns a promise that resolves with the screenshot or null on timeout
 */
export function requestScreenshot(
  sendFn: (msg: object) => boolean,
  timeoutMs: number = 5000
): Promise<TDScreenshot | null> {
  return new Promise((resolve) => {
    // Cancel any pending request
    if (screenshotResolve) {
      screenshotResolve(null);
    }
    if (screenshotTimeout) {
      clearTimeout(screenshotTimeout);
    }

    // Send request
    const sent = sendFn({ type: 'request_screenshot' });
    if (!sent) {
      console.warn(`[TDMetrics ${ts()}] Failed to send screenshot request - not connected`);
      resolve(null);
      return;
    }

    // Set up response handler
    screenshotResolve = resolve;

    // Set timeout
    screenshotTimeout = setTimeout(() => {
      console.warn(`[TDMetrics ${ts()}] Screenshot request timed out`);
      if (screenshotResolve) {
        screenshotResolve(null);
        screenshotResolve = null;
      }
      screenshotTimeout = null;
    }, timeoutMs);
  });
}

/**
 * Wait for TD's `sprite_loaded` ACK for a specific assetId.
 *
 * `pushSpriteTexture` is fire-and-forget — TD takes a moment to load
 * the file and update its movieFileIn TOP. Without awaiting the ACK,
 * a screenshot taken immediately afterward would render the *previous*
 * sprite still on the GPU. Call this after `pushSpriteTexture` to
 * block until the new texture is actually live.
 *
 * Resolves with `{success, error?}` when the matching ACK arrives,
 * or `{success: false, timedOut: true}` after `timeoutMs`.
 */
export function waitForSpriteLoad(
  assetId: string,
  timeoutMs: number = 8000
): Promise<SpriteLoadResult> {
  return new Promise((resolve) => {
    // Cancel any previous wait for this assetId — only one consumer
    // should be waiting per asset. Logging here is critical: without
    // it, a second concurrent waitForSpriteLoad for the same id
    // silently invalidates the first and the original caller sees a
    // failed result with no in-process signal that anything was wrong.
    const existing = pendingSpriteLoads.get(assetId);
    if (existing) {
      console.warn(`[TDMetrics ${ts()}] waitForSpriteLoad(${assetId}) superseded by a newer wait — previous caller will see error="superseded by newer wait"`);
      clearTimeout(existing.timeoutId);
      existing.resolve({ success: false, error: 'superseded by newer wait' });
    }

    const timeoutId = setTimeout(() => {
      const pending = pendingSpriteLoads.get(assetId);
      if (pending) {
        pendingSpriteLoads.delete(assetId);
        console.warn(`[TDMetrics ${ts()}] sprite_loaded ACK timed out for ${assetId}`);
        pending.resolve({ success: false, timedOut: true });
      }
    }, timeoutMs);

    pendingSpriteLoads.set(assetId, { resolve, timeoutId });
  });
}

/**
 * Resolve any pending `waitForSpriteLoad(assetId)` with the ACK from
 * TD. Called by `protocol.ts` when a `sprite_loaded` message arrives.
 * No-op if nobody was waiting on this assetId (also fine — the
 * pre-existing onSpriteLoaded callback path still fires in protocol.ts).
 */
export function handleSpriteLoaded(result: {
  assetId: string;
  success: boolean;
  error?: string;
}): void {
  const pending = pendingSpriteLoads.get(result.assetId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingSpriteLoads.delete(result.assetId);
  pending.resolve({ success: result.success, error: result.error });
}

/**
 * Get latest metrics
 */
export function getLatestMetrics(): TDMetrics | null {
  return latestMetrics;
}

/**
 * Get average FPS over recent history
 */
export function getAverageFps(): number {
  if (metricsHistory.length === 0) return 0;
  const sum = metricsHistory.reduce((acc, m) => acc + m.fps, 0);
  return sum / metricsHistory.length;
}

/**
 * Get average particle count over recent history
 */
export function getAverageParticleCount(): number {
  if (metricsHistory.length === 0) return 0;
  const sum = metricsHistory.reduce((acc, m) => acc + m.particleCount, 0);
  return Math.round(sum / metricsHistory.length);
}

/**
 * Get metrics history for graphing
 */
export function getMetricsHistory(): TDMetrics[] {
  return [...metricsHistory];
}

/**
 * Get latest screenshot
 */
export function getLatestScreenshot(): TDScreenshot | null {
  return latestScreenshot;
}

/**
 * Get latest visibility metrics
 */
export function getLatestVisibility(): VisibilityMetrics | null {
  return latestVisibility;
}

/**
 * Clear all metrics (e.g., on disconnect)
 */
export function clearMetrics(): void {
  metricsHistory = [];
  latestMetrics = null;
  latestScreenshot = null;
  latestVisibility = null;

  if (screenshotResolve) {
    screenshotResolve(null);
    screenshotResolve = null;
  }
  if (screenshotTimeout) {
    clearTimeout(screenshotTimeout);
    screenshotTimeout = null;
  }

  // Resolve any in-flight sprite-load waits with a disconnect failure
  // so the awaiting generate_sprite handler doesn't hang forever.
  for (const [assetId, pending] of pendingSpriteLoads) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ success: false, error: 'TD disconnected' });
    pendingSpriteLoads.delete(assetId);
  }
}

/**
 * Get metrics summary for UI/debugging
 */
export function getMetricsSummary(): {
  fps: number;
  avgFps: number;
  particleCount: number;
  coverage: number;
  visibility: VisibilityMetrics | null;
  hasScreenshot: boolean;
  historyLength: number;
} {
  return {
    fps: latestMetrics?.fps ?? 0,
    avgFps: getAverageFps(),
    particleCount: latestMetrics?.particleCount ?? 0,
    coverage: latestMetrics?.coverage ?? 0,
    visibility: latestVisibility,
    hasScreenshot: latestScreenshot !== null,
    historyLength: metricsHistory.length,
  };
}
