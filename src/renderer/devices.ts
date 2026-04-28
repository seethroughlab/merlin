/**
 * Device Selection
 *
 * Centralized state for the user-chosen camera and microphone.
 * Persists selection through electron-store via window.electronAPI.
 */

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

let selectedCameraId: string | undefined;
let selectedMicrophoneId: string | undefined;

const micChangeCallbacks = new Set<(id: string | undefined) => void>();
const deviceChangeCallbacks = new Set<() => void>();
let deviceChangeBound = false;

export function getSelectedCameraId(): string | undefined {
  return selectedCameraId;
}

export function getSelectedMicrophoneId(): string | undefined {
  return selectedMicrophoneId;
}

/**
 * Initialize device selection from saved settings.
 * Call once after window.electronAPI is available.
 */
export async function initDeviceSelection(): Promise<void> {
  if (!window.electronAPI) return;
  try {
    const settings = await window.electronAPI.getSettings();
    selectedCameraId = (settings.selectedCameraId as string | undefined) || undefined;
    selectedMicrophoneId = (settings.selectedMicrophoneId as string | undefined) || undefined;
  } catch (err) {
    console.error('[devices] Failed to load device settings:', err);
  }
}

/**
 * Persist and apply a new camera selection. Caller is responsible for
 * restarting the camera stream.
 */
export function setSelectedCameraId(id: string | undefined): void {
  selectedCameraId = id;
  if (window.electronAPI) {
    window.electronAPI.saveSetting('selectedCameraId', id ?? null).catch((err) => {
      console.error('[devices] Failed to save selectedCameraId:', err);
    });
  }
}

/**
 * Persist a new microphone selection and notify subscribers so they can
 * restart any active mic streams.
 */
export function setSelectedMicrophoneId(id: string | undefined): void {
  selectedMicrophoneId = id;
  if (window.electronAPI) {
    window.electronAPI.saveSetting('selectedMicrophoneId', id ?? null).catch((err) => {
      console.error('[devices] Failed to save selectedMicrophoneId:', err);
    });
  }
  for (const cb of micChangeCallbacks) {
    try {
      cb(id);
    } catch (err) {
      console.error('[devices] Mic change callback error:', err);
    }
  }
}

/**
 * Subscribe to mic selection changes (used by whisper to hot-swap streams).
 */
export function onMicrophoneChange(cb: (id: string | undefined) => void): () => void {
  micChangeCallbacks.add(cb);
  return () => micChangeCallbacks.delete(cb);
}

/**
 * Subscribe to OS-level device list changes (plug/unplug).
 */
export function onDeviceListChange(cb: () => void): () => void {
  deviceChangeCallbacks.add(cb);
  if (!deviceChangeBound && navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      for (const fn of deviceChangeCallbacks) {
        try {
          fn();
        } catch (err) {
          console.error('[devices] devicechange callback error:', err);
        }
      }
    });
    deviceChangeBound = true;
  }
  return () => deviceChangeCallbacks.delete(cb);
}

/**
 * Enumerate available video and audio input devices. Labels are only
 * populated after a getUserMedia permission has been granted in this
 * session, so call this AFTER initial camera/mic acquisition.
 */
export async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === 'videoinput'),
    microphones: all.filter((d) => d.kind === 'audioinput'),
  };
}

/**
 * Check whether the saved id is still present in the device list. Returns
 * the saved id if present, otherwise undefined (caller should fall back to
 * default and re-save).
 */
export function resolveDeviceId(
  savedId: string | undefined,
  available: MediaDeviceInfo[]
): string | undefined {
  if (!savedId) return undefined;
  return available.some((d) => d.deviceId === savedId) ? savedId : undefined;
}
