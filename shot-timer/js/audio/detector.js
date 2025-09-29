// js/audio/detector.js
import { getAudioContext } from './context.js';
import { getThreshold, getDebounceMs } from '../timer/config.js';

let micStream = null;
let analyser  = null;
let dataArray = null;
let shotCallback = null;   // will be set by core timer
let lastShotTs = 0;        // timestamp of last accepted shot (ms)
let _suppressShots = false; // when true, don't call shotCallback (used for Listen mode)

/**
 * Public API – register the function that should be called
 * whenever a shot is detected.
 * @param {function(number)} cb  – receives the timestamp (ms) of the shot
 */
export function setShotCallback(cb) {
  const prev = shotCallback;
  shotCallback = cb;
  return prev;
}

/**
 * Internal: start the microphone, create an AnalyserNode.
 * Called lazily the first time we need to listen.
 */
async function initMic() {
  if (micStream) return; // already initialized

  const constraints = { audio: true };
  console.debug('initMic: requesting microphone permission');
  try {
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.debug('initMic: getUserMedia succeeded');
  } catch (err) {
    console.error('getUserMedia failed in initMic:', err);
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Could not access microphone.';
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) {
    console.warn('initMic: no AudioContext available from getAudioContext()');
    // still continue — getAudioContext should usually be set by initAudio
  }
  const source = ctx.createMediaStreamSource(micStream);
  analyser = ctx.createAnalyser();
  // keep FFT small for low latency but ensure buffer size is meaningful
  analyser.fftSize = 256;               // small FFT → low latency
  const bufLen = analyser.frequencyBinCount || 128;
  dataArray = new Uint8Array(bufLen);
  source.connect(analyser);
  console.debug('initMic: analyser created, fftSize=', analyser.fftSize, 'bufferLen=', dataArray.length);
}

/**
 * Main loop – called via requestAnimationFrame from timer/core.js.
 * It checks the RMS level and fires `shotCallback` when the level
 * exceeds the user‑defined threshold *and* the debounce window has passed.
 */
export async function pollDetector(nowMs) {
  await initMic();
  if (!analyser || !dataArray) return; // microphone/init failed

  try {
    analyser.getByteTimeDomainData(dataArray);
  } catch (err) {
    console.error('analyser.getByteTimeDomainData failed:', err);
    return;
  }
  // Compute RMS (root‑mean‑square) of the waveform
  let sumSq = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] - 128; // centre around 0
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / dataArray.length); // 0‑127 range

  // Update the live meter (UI lives in ui/controls.js)
  const meter = document.getElementById('rmsMeter');
  if (meter) meter.value = rms;

  const rmsVal = document.getElementById('rmsValue');
  if (rmsVal) rmsVal.textContent = rms.toFixed(2);

  // Debug: log RMS so developers can tune threshold during Listen
  if (window && window.console && typeof console.debug === 'function') {
    console.debug('detector: rms=', rms.toFixed(2), 'threshold=', getThreshold());
  }

  const threshold = getThreshold();   // user‑controlled (0‑100)
  const debounce  = getDebounceMs();  // e.g., 300 ms

  if (rms > threshold && nowMs - lastShotTs > debounce) {
    lastShotTs = nowMs;
    if (_suppressShots) {
      console.debug('detector: shot suppressed (Listen mode) at', nowMs);
    } else {
      if (typeof shotCallback === 'function') {
        // pass rms as second argument for richer reporting
        try {
          shotCallback(nowMs, rms);
        } catch (e) {
          // ensure detector loop doesn't crash on badly-shaped callbacks
          console.error('detector: shotCallback threw', e);
        }
      }
    }
  }
  // Return the current RMS so callers (e.g., Listen mode) can inspect it
  return rms;
}

/**
 * Enable or disable Listen mode suppression of shot callbacks.
 * When enabled, the detector will update RMS UI but will not notify the
 * timer core about shots (useful for live testing without recording shots).
 */
export function setListenMode(enabled) {
  _suppressShots = Boolean(enabled);
  console.debug('detector: setListenMode ->', _suppressShots);
}

/**
 * Stop and release the microphone stream and analyser nodes.
 * Useful when the user explicitly wants to stop listening and free the device.
 */
export function stopMic() {
  try {
    if (micStream) {
      try { micStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      micStream = null;
    }
  } catch (e) { console.warn('stopMic: error stopping mic stream', e); }
  try { analyser = null; dataArray = null; } catch (e) { /* ignore */ }
  _suppressShots = false;
  lastShotTs = 0;
  console.debug('detector: stopMic — microphone stream released');
}
