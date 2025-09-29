// js/audio/context.js
let audioCtx = null;
let outputDeviceId = null;

/**
 * Initialise the global AudioContext.
 * Called once from main.js.
 */
export async function initAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive'
      });
    } catch (e) {
      console.warn('initAudio: could not create AudioContext', e);
      audioCtx = null;
      return;
    }
  }

  // Populate the speaker selector (UI lives in ui/controls.js)
  const speakerSelect = document.getElementById('speakerSelect');
  if (speakerSelect) {
    // Only attempt to enumerate and populate speaker outputs when the platform
    // actually supports programmatic output selection (AudioContext.destination.setSinkId).
    // On many mobile browsers (notably iOS Safari) setSinkId is not available and
    // attempting to enumerate or programmatically switch outputs can lead to
    // confusing behaviour. In that case we leave outputDeviceId as null and
    // let the system (user agent) handle audio routing.
    if (audioCtx && audioCtx.destination && typeof audioCtx.destination.setSinkId === 'function') {
      // Do not enumerate devices during audio initialization. Device
      // enumeration (which may trigger permission UI on some platforms)
      // is performed only when the user explicitly requests it via the
      // Detect button / device scan in the controls UI (populateDeviceLists).
      // Here, just clear the speaker list so the UI is in a known state.
      try {
        speakerSelect.innerHTML = '';
        outputDeviceId = speakerSelect.value || null;
      } catch (err) {
        console.warn('initAudio: could not prepare speakerSelect:', err);
      }
    } else {
      // Platform doesn't support setSinkId — avoid enumerating/attempting to switch
      // outputs and rely on the system default (e.g., iOS Control Center routing).
      speakerSelect.innerHTML = '';
      speakerSelect.style.display = 'none';
      outputDeviceId = null;
    }
  }
}

/**
 * Returns the shared AudioContext (read‑only).
 */
export function getAudioContext() {
  return audioCtx;
}

/**
 * Returns true if the browser supports setting the output device programmatically
 * (AudioContext.destination.setSinkId), false otherwise.
 */
export function supportsSetSinkId() {
  return !!(audioCtx && audioCtx.destination && typeof audioCtx.destination.setSinkId === 'function');
}

/**
 * Force the output device for the *destination* node (Chrome/Edge only).
 */
export async function setOutputDevice(deviceId) {
  if (!audioCtx || !audioCtx.destination || typeof audioCtx.destination.setSinkId !== 'function') {
    console.warn('setOutputDevice: setSinkId not supported on this platform; ignoring setOutputDevice request');
    return;
  }
  try {
    await audioCtx.destination.setSinkId(deviceId);
    outputDeviceId = deviceId;
  } catch (e) {
    console.warn('setSinkId failed:', e);
  }
}
