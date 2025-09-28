// js/audio/context.js
let audioCtx = null;
let outputDeviceId = null;

/**
 * Initialise the global AudioContext.
 * Called once from main.js.
 */
export async function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive'
    });
  }

  // Populate the speaker selector (UI lives in ui/controls.js)
  const speakerSelect = document.getElementById('speakerSelect');
  if (speakerSelect) {
    // Grab the list of audiooutput devices (may need a prior getUserMedia)
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        speakerSelect.innerHTML = '';
        devices
          .filter(d => d.kind === 'audiooutput')
          .forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Speaker (${d.deviceId.slice(0, 8)})`;
            speakerSelect.appendChild(opt);
          });
        outputDeviceId = speakerSelect.value;
      } catch (err) {
        console.warn('Could not enumerate devices in initAudio:', err);
      }
    } else {
      console.warn('navigator.mediaDevices.enumerateDevices not available; speaker list will remain empty');
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
  outputDeviceId = deviceId;
  if (audioCtx && typeof audioCtx.destination.setSinkId === 'function') {
    try {
      await audioCtx.destination.setSinkId(deviceId);
    } catch (e) {
      console.warn('setSinkId failed:', e);
    }
  }
}
