// js/timer/core.js
import { playBeep } from '../audio/beep.js';
import { pollDetector } from '../audio/detector.js';
import { formatTime } from './utils.js';
import { getTotalSeconds, getCalibrationOffset, setCalibrationOffset, getBeepOnShot } from './config.js';
import { getAudioContext } from '../audio/context.js';
import { addShotRow, clearShotsTable } from '../ui/shotsTable.js';

let rafId = null;
let startTime = 0;          // performance.now() when timer started
let totalDuration = 0;      // ms (derived from totalSeconds)
let shotLog = [];           // array of { idx, timestampMs }
let participantShots = [];  // flattened shots for the current participant across stages
let timerFinished = false;  // becomes true once countdown reaches zero
let acceptShots = false;    // whether incoming shot events should be recorded
// Track attempt counts per stage so repeated runs can be labeled (2, 2a, 2b...)
const _attempts = {}; // key -> count (1 = first attempt, 2 = first repeat -> 'a')
let _currentStageKey = null; // string key for current stage context

function _makeKey(courseId, stageId) {
  return `${courseId || ''}:${stageId != null ? String(stageId) : ''}`;
}

export function setStageContext({ courseId = '', courseName = '', stageId = null } = {}) {
  _currentStageKey = _makeKey(courseId, stageId);
  if (!_attempts[_currentStageKey]) _attempts[_currentStageKey] = 1; // first attempt
}

export function incrementStageAttempt() {
  if (!_currentStageKey) return 1;
  _attempts[_currentStageKey] = (_attempts[_currentStageKey] || 1) + 1;
  return _attempts[_currentStageKey];
}

export function getStageAttemptLabel({ courseId = '', stageId = null } = {}) {
  // If courseId/stageId are provided prefer them, otherwise use current context
  const key = (courseId || stageId != null) ? _makeKey(courseId, stageId) : _currentStageKey;
  if (!key) return stageId != null ? String(stageId) : '';
  const parts = key.split(':');
  const sid = parts[1] || '';
  const count = _attempts[key] || 1;
  if (!sid) return '';
  if (count <= 1) return sid;
  // count 2 -> 'a', 3 -> 'b', etc.
  const letter = String.fromCharCode('a'.charCodeAt(0) + (count - 2));
  return `${sid}${letter}`;
}

function updateDisplay(remainingMs) {
  const el = document.getElementById('display');
  if (el) el.textContent = formatTime(Math.max(0, remainingMs));
}

/* -----------------------------------------------------------------
let timerFinished = false;  // becomes true once countdown reaches zero
   Public API – called from UI (controls.js)
----------------------------------------------------------------- */
export function startTimer(options = {}) {
  // Pull the latest user settings
  totalDuration = getTotalSeconds() * 1000;
  // Reset state
  startTime = performance.now();
  shotLog = [];
  // allow recording shots for this run (including late shots after finish)
  acceptShots = true;
  timerFinished = false;
  clearShotsTable();
  updateDisplay(totalDuration);
  // Play initial cue unless caller asked to skip it (used when controls plays
  // the cue at the end of a randomized pre-start delay).
  if (!options.skipInitialBeep) playBeep();

  // Kick off the animation loop
  rafId = requestAnimationFrame(tick);
  // notify other UI components that the stage started
  try {
    document.dispatchEvent(new CustomEvent('stageStarted', { detail: { when: performance.now() } }));
  } catch (e) { /* ignore */ }
}

/** Called by the detector when a shot is heard */
export function handleShot(timestampMs, rms = null) {
  if (!startTime) return; // ignore if timer not started
  if (!acceptShots) {
    // Shots are being suppressed (timer stopped) — ignore
    console.debug('handleShot: shot ignored because acceptShots is false');
    return;
  }

  // Guard against extra shots after the timer has expired
  // Apply calibration offset (subtract measured system latency)
  const offset = getCalibrationOffset ? getCalibrationOffset() : 0;
  const adjustedTs = Math.max(0, timestampMs - (offset || 0));
  const elapsed = adjustedTs - startTime;
  // Allow recording shots even after the stage has finished so they can be
  // displayed (and highlighted) as errant/late shots. The UI highlights
  // shots where elapsed > stage length.
  const shotIdx = shotLog.length; // zero‑based
  // compute delta from previous shot (ms) — for first shot delta is the elapsed
  const prev = shotLog.length > 0 ? shotLog[shotLog.length - 1] : null;
  const delta = prev ? (adjustedTs - prev.ts) : elapsed;
  shotLog.push({ idx: shotIdx, ts: adjustedTs, rawTs: timestampMs, elapsed, rms, delta });
  console.debug('handleShot: recorded shot', { shotIdx, adjustedTs, timestampMs, elapsed, rms, delta });
  addShotRow(shotIdx, delta, elapsed, adjustedTs, rms);
  if (getBeepOnShot && getBeepOnShot()) playBeep();
}

// Archive the current stage's shots into the participant-wide log.
// Accepts optional metadata about the stage (courseId, courseName, stageId).
export function archiveStageShots({ courseId = '', courseName = '', stageId = null } = {}) {
  if (!shotLog || shotLog.length === 0) return 0;
  const baseIdx = participantShots.length;
  for (const s of shotLog) {
    // create a flattened record
    participantShots.push(Object.assign({}, s, {
      participantIdx: participantShots.length,
      courseId,
      courseName,
      stageId
    }));
  }
  const n = shotLog.length;
  console.debug(`archiveStageShots: archived ${n} shots (stage ${stageId})`);
  return n;
}

/* -----------------------------------------------------------------
   Internal animation loop – updates the countdown & polls detector
----------------------------------------------------------------- */
function tick(now) {
  // Compute elapsed/remaining time and update the display
  const elapsed = now - startTime;
  const remaining = totalDuration - elapsed;
  updateDisplay(Math.max(0, remaining));

  // Poll the microphone detector (passes the *global* now timestamp)
  pollDetector(now);

  if (remaining <= 0) {
    // Timer finished behaviour: play optional final beep once, then keep the
    // loop running so the detector continues to listen for errant shots
    // after the stage ends (these will be recorded and highlighted as late).
    if (!timerFinished) {
      // Play the final beep unconditionally (same as the initial cue at start)
      playBeep();
      timerFinished = true;
      // notify other UI components that the stage finished
      try {
        document.dispatchEvent(new CustomEvent('stageFinished', { detail: { when: performance.now() } }));
      } catch (e) {
        console.warn('Could not dispatch stageFinished event', e);
      }
    }
    // continue polling the detector so late shots are captured
    rafId = requestAnimationFrame(tick);
    return;
  }
  rafId = requestAnimationFrame(tick);
}

export function resetTimer() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  startTime = 0;
  timerFinished = false;
  totalDuration = 0;
  // Reset only the current stage shot log; participantShots persist until cleared
  shotLog = [];
  clearShotsTable();
  updateDisplay(0);
  // After a hard reset, do not accept further shots until a new startTimer()
  acceptShots = false;
}

// Stop the active countdown without clearing the current shot log.
// This cancels the internal RAF loop and prevents further shots from
// being recorded until startTimer() is called again.
export function stopTimer() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  // stop accepting new shots but preserve shotLog for review/export
  acceptShots = false;
  try {
    document.dispatchEvent(new CustomEvent('timerStopped', { detail: { when: performance.now() } }));
  } catch (e) { /* ignore */ }
}
export function calibrateLatency() {
  (async () => {
    // Simple calibration flow:
    // 1) Play an audible beep.
    // 2) Wait for the detector to notify a shot timestamp.
    // 3) Latency = detectionTimestamp - playbackTime.
    // We'll repeat a few times and use the median to be robust.
    const samples = [];
    const attempts = 5;
    const timeoutMs = 2000;

    // temporary shot capture
    let resolveCapture;
    const captured = [];

    function tempShotHandler(ts) {
      captured.push(ts);
      if (resolveCapture) resolveCapture(ts);
    }

    // swap in our temporary handler and remember previous
    const { setShotCallback } = await import('../audio/detector.js');
    const prev = setShotCallback(tempShotHandler);

    const start = performance.now();
    for (let i = 0; i < attempts; i++) {
      // play beep and wait for detection or timeout
      const playbackTime = performance.now();
      playBeep();
      const p = new Promise(res => { resolveCapture = res; });
      let detectedAt = null;
      try {
        detectedAt = await Promise.race([
          p,
          new Promise(res => setTimeout(() => res(null), timeoutMs))
        ]);
      } catch (e) {
        detectedAt = null;
      }
      resolveCapture = null;
      if (detectedAt) {
        const latency = detectedAt - playbackTime;
        samples.push(latency);
        console.log('calibration: sample', i, 'latencyMs=', latency);
  // short delay between beeps
        await new Promise(r => setTimeout(r, 250));
      } else {
        console.warn('calibration: no detection for sample', i);
      }
    }

    // restore previous shot callback
    try { setShotCallback(prev); } catch (e) { console.warn('calibrate: could not restore shot callback', e); }

    if (samples.length === 0) {
      console.warn('calibration: no acoustic detections; attempting internal loopback fallback');

      // Internal loopback fallback: measure latency inside the AudioContext
      const ctx = getAudioContext();
      if (!ctx) {
        alert('Calibration failed: no detections and no AudioContext available. Ensure microphone permission and try again.');
        return;
      }

      // Helper: detect peak on an analyser node
      const detectPeak = (analyser, dataArray, timeoutMs = 1000) => new Promise(res => {
        const start = performance.now();
        let rafId = null;
        function check() {
          try {
            analyser.getByteTimeDomainData(dataArray);
          } catch (e) {
            res(null);
            return;
          }
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = dataArray[i] - 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          if (rms > 5) { // internal threshold for loopback peak
            res(performance.now());
            return;
          }
          if (performance.now() - start > timeoutMs) {
            res(null);
            return;
          }
          rafId = requestAnimationFrame(check);
        }
        rafId = requestAnimationFrame(check);
      });

      const lbSamples = [];
      const lbAttempts = 5;
      for (let i = 0; i < lbAttempts; i++) {
        // create a short oscillator routed through an analyser
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const buf = new Uint8Array(analyser.frequencyBinCount || 128);
        osc.frequency.value = 1200;
        gain.gain.setValueAtTime(0.5, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.connect(gain).connect(analyser).connect(ctx.destination);

        const playbackTime = performance.now();
        osc.start();
        osc.stop(ctx.currentTime + 0.12);

        const detectedAt = await detectPeak(analyser, buf, 800);
        if (detectedAt) {
          lbSamples.push(detectedAt - playbackTime);
          console.log('calibration(loopback): sample', i, 'latencyMs=', detectedAt - playbackTime);
        } else {
          console.warn('calibration(loopback): no internal detection for sample', i);
        }
        await new Promise(r => setTimeout(r, 150));
      }

      if (lbSamples.length === 0) {
        alert('Calibration failed: no detections (acoustic or internal). Check microphone and speaker routing.');
        return;
      }

      lbSamples.sort((a,b) => a-b);
      const mid2 = Math.floor(lbSamples.length/2);
      const median2 = lbSamples.length % 2 === 1 ? lbSamples[mid2] : (lbSamples[mid2-1]+lbSamples[mid2])/2;
      setCalibrationOffset(Math.round(median2));
      console.log('calibration(loopback): median latency ms =', median2);
      alert(`Calibration (internal loopback) complete — median latency ${Math.round(median2)} ms recorded. Note: this measures internal audio graph latency, not acoustic microphone pickup.`);
      return;
    }

    // compute median latency
    samples.sort((a,b) => a-b);
    const mid = Math.floor(samples.length/2);
    const median = samples.length % 2 === 1 ? samples[mid] : (samples[mid-1]+samples[mid])/2;
    // store offset (we subtract measured latency from timestamps during reporting)
    setCalibrationOffset(Math.round(median));
    console.log('calibration: median latency ms =', median);
    alert(`Calibration complete — median latency ${Math.round(median)} ms recorded.`);
  })();
}

  // Return a copy of the shot log for export/inspection
  export function getShotLog() {
    return shotLog.slice();
  }

  // Export the shot log as CSV and return the CSV string
  export function exportShotsCsv() {
    const rows = [];
    // header
    rows.push(['idx','elapsed_ms','delta_ms','raw_ts','calibrated_ts','rms'].join(','));
    const log = getShotLog();
    for (const s of log) {
      const idx = s.idx;
      const elapsed = (typeof s.elapsed === 'number') ? s.elapsed.toFixed(3) : '';
      const delta = (typeof s.delta === 'number') ? s.delta.toFixed(3) : '';
      const raw = (typeof s.rawTs === 'number') ? s.rawTs.toFixed(3) : '';
      const cal = (typeof s.ts === 'number') ? s.ts.toFixed(3) : '';
      const rms = (typeof s.rms === 'number') ? s.rms.toFixed(4) : '';
      rows.push([idx, elapsed, delta, raw, cal, rms].join(','));
    }
    return rows.join('\n');
  }

  // Export the participant's entire shot set as CSV
  export function exportParticipantCsv() {
    const rows = [];
    // header includes course/stage metadata and participant index
    rows.push(['pidx','courseId','courseName','stageId','elapsed_ms','delta_ms','raw_ts','calibrated_ts','rms'].join(','));
    for (const s of participantShots) {
      const pidx = s.participantIdx != null ? s.participantIdx : '';
      const courseId = s.courseId || '';
      const courseName = s.courseName || '';
      const stageId = s.stageId != null ? s.stageId : '';
      const elapsed = (typeof s.elapsed === 'number') ? s.elapsed.toFixed(3) : '';
      const delta = (typeof s.delta === 'number') ? s.delta.toFixed(3) : '';
      const raw = (typeof s.rawTs === 'number') ? s.rawTs.toFixed(3) : '';
      const cal = (typeof s.ts === 'number') ? s.ts.toFixed(3) : '';
      const rms = (typeof s.rms === 'number') ? s.rms.toFixed(4) : '';
      rows.push([pidx, courseId, JSON.stringify(courseName), stageId, elapsed, delta, raw, cal, rms].join(','));
    }
    return rows.join('\n');
  }

  // Clear the participant-wide stored shots (start a new participant)
  export function clearParticipantShots() {
    participantShots = [];
    console.debug('clearParticipantShots: participant shot store cleared');
  }
