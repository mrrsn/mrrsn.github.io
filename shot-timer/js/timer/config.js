// js/timer/config.js
// These values are read/write from the UI (controls.js)
// Export getters/setters so other modules stay decoupled.

let totalSeconds   = 5;   // default – can be changed via UI
let expectedShots  = 3;    // default – can be changed via UI
let shotThreshold  = 30;   // RMS threshold (0‑127) – UI slider
let debounceMs     = 100;  // minimum gap between detections
let calibrationOffsetMs = 0; // milliseconds to subtract from detected timestamps
let beepOnShot = false; // whether to play a beep when a shot is recorded

export function setTotalSeconds(v)   { totalSeconds   = Number(v); }
export function getTotalSeconds()   { return totalSeconds; }

export function setExpectedShots(v) { expectedShots  = Number(v); }
export function getExpectedShots() { return expectedShots; }
// validate sensible inputs
export function setTotalSecondsSafe(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n < 1) return;
	totalSeconds = Math.floor(n);
}
export function setExpectedShotsSafe(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) return;
	expectedShots = Math.max(0, Math.floor(n));
}

export function setThreshold(v)     { 
	const n = Number(v);
	if (!Number.isFinite(n)) return;
	shotThreshold = Math.min(127, Math.max(0, n));
}
export function getThreshold()     { return shotThreshold; }

export function setDebounceMs(v)    { 
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) return;
	debounceMs = Math.round(n);
}
export function getDebounceMs()    { return debounceMs; }

export function setCalibrationOffset(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return;
  calibrationOffsetMs = Math.round(n);
}
export function getCalibrationOffset() { return calibrationOffsetMs; }

export function setBeepOnShot(v) { beepOnShot = Boolean(v); }
export function getBeepOnShot() { return beepOnShot; }
