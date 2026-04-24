/**
 * OSC Output for TouchDesigner
 *
 * Sends tracking data via OSC protocol.
 *
 * Address structure:
 *   /parlor/fps                    [float] - Current FPS
 *   /parlor/frame/width            [int]   - Frame width in pixels
 *   /parlor/frame/height           [int]   - Frame height in pixels
 *   /parlor/frame/portrait         [int]   - 1 if portrait mode, 0 if landscape
 *   /parlor/pose/detected          [int]   - 1 if pose detected, 0 otherwise
 *   /parlor/pose/landmark/{i}      [x,y,z,vis] - Individual landmark (0-32)
 *   /parlor/pose/landmarks         [blob]  - All 33 landmarks packed (33 * 4 floats)
 *   /parlor/face/detected          [int]   - 1 if face detected, 0 otherwise
 *   /parlor/face/bbox              [x,y,w,h] - Face bounding box (normalized 0-1)
 *   /parlor/face/confidence        [float] - Face detection confidence
 */

import { Client } from 'node-osc';
import type { TrackingFrame, Landmark } from '../shared/types';

let oscClient: Client | null = null;
let enabled = false;
let currentHost = '127.0.0.1';
let currentPort = 9000;

// Message counting for rate display
let messageCount = 0;
let lastRateCheck = Date.now();
let currentRate = 0;

interface OscConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface OscStats {
  enabled: boolean;
  host: string;
  port: number;
  messagesPerSecond: number;
}

/**
 * Initialize OSC client
 */
export function initOsc(config: OscConfig): void {
  if (oscClient) {
    oscClient.close();
  }

  enabled = config.enabled;
  currentHost = config.host;
  currentPort = config.port;

  // Reset counters
  messageCount = 0;
  lastRateCheck = Date.now();
  currentRate = 0;

  if (!enabled) {
    console.log('OSC disabled');
    return;
  }

  oscClient = new Client(config.host, config.port);
  console.log(`OSC client initialized: ${config.host}:${config.port}`);
}

/**
 * Send tracking frame via OSC
 */
export function sendTrackingFrame(frame: TrackingFrame): void {
  if (!oscClient || !enabled) return;

  try {
    // Count messages for rate calculation
    messageCount++;

    // FPS
    oscClient.send('/parlor/fps', frame.fps);

    // Frame info (dimensions and orientation)
    oscClient.send('/parlor/frame/width', frame.frameWidth);
    oscClient.send('/parlor/frame/height', frame.frameHeight);
    oscClient.send('/parlor/frame/portrait', frame.isPortrait ? 1 : 0);

    // Pose data
    if (frame.pose && frame.pose.landmarks.length > 0) {
      oscClient.send('/parlor/pose/detected', 1);

      // Send individual landmarks for easy TouchDesigner access
      const landmarks = frame.pose.landmarks;
      for (let i = 0; i < Math.min(landmarks.length, 33); i++) {
        const lm = landmarks[i];
        oscClient.send(
          `/parlor/pose/landmark/${i}`,
          lm.x,
          lm.y,
          lm.z,
          lm.visibility ?? 1.0
        );
      }

      // Also send packed blob for efficiency
      const packedLandmarks = packLandmarks(landmarks);
      oscClient.send('/parlor/pose/landmarks', {
        type: 'blob',
        value: packedLandmarks,
      });
    } else {
      oscClient.send('/parlor/pose/detected', 0);
    }

    // Face data
    if (frame.face) {
      oscClient.send('/parlor/face/detected', 1);
      oscClient.send(
        '/parlor/face/bbox',
        frame.face.bbox.x,
        frame.face.bbox.y,
        frame.face.bbox.width,
        frame.face.bbox.height
      );
    } else {
      oscClient.send('/parlor/face/detected', 0);
    }
  } catch (error) {
    console.error('OSC send error:', error);
  }
}

/**
 * Pack landmarks into a binary blob (Float32Array)
 */
function packLandmarks(landmarks: Landmark[]): Buffer {
  const floatCount = landmarks.length * 4; // x, y, z, visibility
  const buffer = Buffer.alloc(floatCount * 4); // 4 bytes per float

  for (let i = 0; i < landmarks.length; i++) {
    const offset = i * 16; // 4 floats * 4 bytes
    buffer.writeFloatLE(landmarks[i].x, offset);
    buffer.writeFloatLE(landmarks[i].y, offset + 4);
    buffer.writeFloatLE(landmarks[i].z, offset + 8);
    buffer.writeFloatLE(landmarks[i].visibility ?? 1.0, offset + 12);
  }

  return buffer;
}

/**
 * Close OSC client
 */
export function closeOsc(): void {
  if (oscClient) {
    oscClient.close();
    oscClient = null;
  }
}

/**
 * Check if OSC is enabled and connected
 */
export function isOscEnabled(): boolean {
  return enabled && oscClient !== null;
}

/**
 * Get OSC statistics (config + send rate)
 */
export function getOscStats(): OscStats {
  const now = Date.now();
  const elapsed = (now - lastRateCheck) / 1000;

  // Update rate every second
  if (elapsed >= 1) {
    currentRate = messageCount / elapsed;
    messageCount = 0;
    lastRateCheck = now;
  }

  return {
    enabled,
    host: currentHost,
    port: currentPort,
    messagesPerSecond: Math.round(currentRate),
  };
}
