// controls.js — clean single implementation
import { setTotalSeconds, setExpectedShots, setThreshold, setDebounceMs, setBeepOnShot, getBeepOnShot } from '../timer/config.js';
import { resetTimer, stopTimer, incrementStageAttempt, setStageContext } from '../timer/core.js';
import { setOutputDevice, getAudioContext, supportsSetSinkId } from '../audio/context.js';
import { pollDetector, setListenMode, stopMic } from '../audio/detector.js';
import { setRmsColumnVisible } from './shotsTable.js';
import { playBeep } from '../audio/beep.js';
import { formatTime } from '../timer/utils.js';

const $ = (s) => document.querySelector(s);
let __deviceChangeHandlerAdded = false;

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  if (!el) return;
  el.classList.remove('hidden', 'error', 'success');
  if (type === 'error') el.classList.add('error');
  if (type === 'success') el.classList.add('success');
  el.textContent = msg;
}
function clearStatus() { const el = document.getElementById('status'); if (!el) return; el.classList.add('hidden'); }

// Briefly add a 'pressed' class to a button to indicate it was clicked.
function transientPress(btn, ms = 250) {
  if (!btn) return;
  try {
    btn.classList.add('pressed');
    setTimeout(() => { try { btn.classList.remove('pressed'); } catch (e) {} }, ms);
  } catch (e) { /* ignore */ }
}

async function requestMicPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    const statusEl = document.getElementById('status');
    if (statusEl) setStatus('Microphone permission denied. Please allow access and try again.', 'error');
    else alert('Please allow microphone access when the browser asks.');
    return false;
  }
}

async function populateDeviceLists() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const allowed = await requestMicPermission(); if (!allowed) return;
  const micSelect = document.getElementById('micSelect');
  const spkSelect = document.getElementById('speakerSelect');
  if (!micSelect || !spkSelect) return;
  const prevMic = micSelect.value, prevSpk = spkSelect.value;
  const detectBtn = document.getElementById('detectBtn'); if (detectBtn) detectBtn.disabled = true;
  const statusEl = document.getElementById('status'); if (statusEl) { statusEl.textContent = 'Scanning devices'; const spin = document.createElement('span'); spin.className = 'spinner'; statusEl.appendChild(spin); }
  micSelect.innerHTML = ''; spkSelect.innerHTML = '';
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch (e) { if (detectBtn) detectBtn.disabled = false; const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'Could not enumerate devices'; micSelect.appendChild(opt); spkSelect.appendChild(opt.cloneNode(true)); if (statusEl) setStatus('Could not enumerate audio devices. Check microphone permission.', 'error'); return; }
  finally { if (detectBtn) detectBtn.disabled = false; }
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId || '';
    opt.textContent = d.label || `${d.kind} (${(d.deviceId||'').slice(0,8)})`;
    if (d.kind === 'audioinput' && micSelect) micSelect.appendChild(opt);
    // Only populate output selector if the platform supports programmatic output selection
    if (d.kind === 'audiooutput' && spkSelect && supportsSetSinkId()) spkSelect.appendChild(opt);
  });
  if (micSelect.options.length === 0) { const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'No microphones found'; micSelect.appendChild(opt); }
  if (spkSelect.options.length === 0) { const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'No speakers found'; spkSelect.appendChild(opt); }
  // If setSinkId is not supported (iOS Safari, etc.) disable the speaker selector and show a help tip
  try {
    if (!supportsSetSinkId()) {
      if (spkSelect) {
        spkSelect.disabled = true;
        spkSelect.style.display = 'none';
      }
      // Do not create an explanatory tip on mobile/iOS to avoid extra UI clutter.
    }
  } catch (e) { /* ignore */ }
  if (prevMic) micSelect.value = prevMic; if (prevSpk) spkSelect.value = prevSpk; if (statusEl) { setStatus(`Found ${micSelect.options.length} mic(s) and ${spkSelect.options.length} speaker(s)`, 'success'); setTimeout(clearStatus, 3000); }
}

export function initControls({ onStart = () => {}, onCalibrate = () => {}, onNewParticipant = () => {} } = {}) {
  const attach = () => {
    // Detect mobile/touch platforms and avoid automatic device detection there
    const isMobilePlatform = (() => {
      try {
        const ua = navigator.userAgent || '';
        const isMobileUa = /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua);
        const prefersCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        return isMobileUa || prefersCoarse;
      } catch (e) { return false; }
    })();

    // On desktop-like platforms attempt to auto-detect devices. On mobile or
    // when programmatic output switching isn't available, hide selectors and
    // defer detection to explicit user action.
    if (!isMobilePlatform && supportsSetSinkId()) {
      (async () => { try { await populateDeviceLists(); } catch (e) { console.warn('Auto device detection failed:', e); } })();
    } else {
      try {
        const detectBtnEl = document.getElementById('detectBtn'); if (detectBtnEl) detectBtnEl.style.display = 'none';
        // Hide mic selector on mobile platforms — system will route the active mic
        const micLabel = document.getElementById('micLabel'); if (micLabel) micLabel.style.display = 'none';
        // Hide speaker selector whenever setSinkId is not supported (e.g., iOS)
        const spkSel = document.getElementById('speakerSelect'); if (spkSel && spkSel.parentNode) spkSel.parentNode.style.display = 'none';
        // Show a gentle note only when speaker control is hidden due to lack of setSinkId
        if (!supportsSetSinkId()) {
          const devicesSection = document.getElementById('devices');
          if (devicesSection) {
            const note = document.createElement('div');
            note.className = 'system-output-note input-hint';
            note.textContent = 'Audio input/output is controlled by your device — use system controls (Control Center or OS settings) to change microphones or speakers.';
            devicesSection.appendChild(note);
          }
        }
      } catch (e) { /* ignore DOM errors */ }
    }

    // Listen loop state
    let listenRaf = null;
    const listenBtn = $('#listenBtn');

    async function startListening() {
      if (listenRaf) return;
      try { const ctx = getAudioContext(); if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume(); } catch (e) { /* ignore */ }
      try { setListenMode(true); } catch (e) { console.warn('Could not set Listen mode:', e); }
        // indicate listening via Stop button animation instead of a status message
        const stopBtnAnim = document.getElementById('stopBtn'); if (stopBtnAnim) stopBtnAnim.classList.add('btn-anim');
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      async function loop(now) {
        let rms = 0;
        try { const maybe = await pollDetector(now); if (typeof maybe === 'number') rms = maybe; } catch (e) { console.warn('Listen loop error', e); }
        // Update a UI element if present
        const rmsEl = document.getElementById('rmsValue');
        if (rmsEl) {
          try {
            // display with two decimal places for consistent and readable feedback
            rmsEl.textContent = (typeof rms === 'number' && Number.isFinite(rms)) ? rms.toFixed(2) : String(rms);
          } catch (e) {
            rmsEl.textContent = String(Math.round(rms));
          }
        }
        if (rms > 1) await sleep(1000);
        if (!listenRaf) return;
        listenRaf = requestAnimationFrame(loop);
      }
      listenRaf = requestAnimationFrame(loop);
  if (listenBtn) listenBtn.textContent = 'Stop';
    }

  function stopListening() { try { if (listenRaf) { cancelAnimationFrame(listenRaf); listenRaf = null; if (listenBtn) listenBtn.textContent = 'Listen'; } try { setListenMode(false); } catch (e) { console.warn('Could not clear Listen mode', e); } try { stopMic(); } catch (e) { console.warn('stopListening: stopMic failed', e); } clearStatus(); const stopBtnEl = document.getElementById('stopBtn'); if (stopBtnEl) stopBtnEl.classList.remove('btn-anim'); } catch (err) { console.warn('stopListening: unexpected error', err); } finally { try { stopTimer(); } catch (e) { /* ignore */ } } }

  // Timer/interaction state
  let isTimerActive = false; // true when the stage countdown is actively running
  let canRepeatStage = false; // true after a stop/finish so the user may re-run the stage

  // Enable or disable Start/Stop controls depending on course/stage selection
  // and timer state. Backwards compatible: if called with a single boolean
  // argument both buttons are toggled the same; otherwise pass (startEnabled, stopEnabled).
  function setStartStopEnabled(startEnabled, stopEnabled) {
    try {
      if (typeof stopEnabled === 'undefined') stopEnabled = startEnabled;
      if (startBtn) {
        startBtn.disabled = !startEnabled;
        startBtn.setAttribute('aria-disabled', String(!startEnabled));
        if (!startEnabled) startBtn.classList.add('disabled'); else startBtn.classList.remove('disabled');
      }
      if (stopBtn) {
        stopBtn.disabled = !stopEnabled;
        stopBtn.setAttribute('aria-disabled', String(!stopEnabled));
        if (!stopEnabled) stopBtn.classList.add('disabled'); else stopBtn.classList.remove('disabled');
      }
    } catch (e) { /* ignore UI errors */ }
  }

  // Helper to enable/disable the Next button and to pulse it
  function setNextEnabled(enabled) {
    try {
      if (nextStageBtn) {
        nextStageBtn.disabled = !enabled;
        nextStageBtn.setAttribute('aria-disabled', String(!enabled));
        if (!enabled) nextStageBtn.classList.add('disabled'); else nextStageBtn.classList.remove('disabled');
      }
    } catch (e) { /* ignore */ }
  }
  function setNextPulse(pulse) {
    try {
      if (!nextStageBtn) return;
      if (pulse) nextStageBtn.classList.add('btn-anim'); else nextStageBtn.classList.remove('btn-anim');
    } catch (e) { /* ignore */ }
  }

  function updateStageButtonState() {
    try {
      const courseSel = document.getElementById('courseSelect');
      const stageSel = document.getElementById('stageSelect');
      // If the course UI isn't present, allow normal behavior
      if (!courseSel || !stageSel) { setStartStopEnabled(true); return; }
      // If no course chosen, allow Start/Stop
      if (!courseSel.value) { setStartStopEnabled(true); return; }
      // If a stage is selected and it's not the scoring pseudo-stage, enable buttons
      const sel = stageSel.value;
      const onStage = Boolean(sel) && sel !== 'scoring';
      setStartStopEnabled(onStage);
      // Next button logic:
      // - If we're showing scoring (before first stage), pulse Next and enable it.
      // - If we're on a numeric stage and the timer is active, disable Next until Stop is clicked.
      // - Otherwise enable Next and remove pulse.
      if (sel === 'scoring') {
        setNextEnabled(true);
        setNextPulse(true);
      } else if (onStage && isTimerActive) {
        setNextEnabled(false);
        setNextPulse(false);
      } else {
        setNextEnabled(true);
        setNextPulse(false);
      }
      // If disabling, clear any pending start and stop any active listening/timer to avoid stray activity
      if (!onStage) {
        try { clearPendingStart(); } catch (e) {}
        try { stopListening(); } catch (e) {}
        try { stopMic(); } catch (e) {}
        try { stopTimer(); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

    if (navigator.mediaDevices && !__deviceChangeHandlerAdded) { navigator.mediaDevices.addEventListener('devicechange', async () => { try { await populateDeviceLists(); } catch (e) { console.warn('devicechange handler failed', e); } }); __deviceChangeHandlerAdded = true; }

    // Inputs
    const totalSecInput   = document.getElementById('totalSecInput');
    const shotsCountInput = document.getElementById('shotsCountInput');
    const thresholdInput  = document.getElementById('thresholdInput');
    const debounceInput   = document.getElementById('debounceInput');
    if (totalSecInput) totalSecInput.addEventListener('change', e => { const n = Number(e.target.value); if (!Number.isFinite(n) || n <= 0) return; setTotalSeconds(Math.floor(n)); });
    if (shotsCountInput) shotsCountInput.addEventListener('change', e => { const n = parseInt(e.target.value, 10); if (!Number.isFinite(n) || n < 0) return; setExpectedShots(n); });
    if (thresholdInput) thresholdInput.addEventListener('input', e => { const v = parseFloat(e.target.value); if (!Number.isFinite(v)) return; const clamped = Math.min(127, Math.max(0, v)); setThreshold(clamped); const valEl = document.getElementById('thresholdValue'); if (valEl) valEl.textContent = String(Math.round(clamped)); });
    if (debounceInput) debounceInput.addEventListener('input', e => { const ms = Number(e.target.value); if (!Number.isFinite(ms) || ms < 0) return; setDebounceMs(Math.round(ms)); const valEl = document.getElementById('debounceValue'); if (valEl) valEl.textContent = String(Math.round(ms)); });

    // Beep checkbox
    const beepChk = document.getElementById('beepOnShot');
    if (beepChk) { try { beepChk.checked = !!getBeepOnShot(); } catch (e) {} beepChk.addEventListener('change', e => { try { setBeepOnShot(Boolean(e.target.checked)); } catch (err) { console.warn('Failed to set beep-on-shot', err); } }); }

    // RMS column checkbox
    const showRmsChk = document.getElementById('showRmsColumn');
    if (showRmsChk) { showRmsChk.checked = false; try { setRmsColumnVisible(Boolean(showRmsChk.checked)); } catch (e) {} showRmsChk.addEventListener('change', e => { try { setRmsColumnVisible(Boolean(e.target.checked)); } catch (err) { console.warn('Failed to toggle RMS column', err); } }); }

    // UI zoom control (discrete steps to avoid jank while sliding)
    const ZOOM_STEPS = [80, 100, 120, 140, 160];
    const uiZoomMinus = document.getElementById('uiZoomMinus');
    const uiZoomPlus = document.getElementById('uiZoomPlus');
    const uiZoomValue = document.getElementById('uiZoomValue');
    function applyZoom(pct) {
      try {
        const root = document.documentElement;
        const base = 16 * (pct / 100);
        root.style.fontSize = `${base}px`;
        if (uiZoomValue) uiZoomValue.textContent = `${pct}%`;
      } catch (e) { console.warn('applyZoom failed', e); }
    }
    function clampToStep(pct) { // find nearest allowed step (exact match expected)
      for (let i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] === pct) return pct;
      // fallback: pick closest
      let best = ZOOM_STEPS[0]; let minD = Math.abs(pct - best);
      for (let s of ZOOM_STEPS) { const d = Math.abs(pct - s); if (d < minD) { minD = d; best = s; } }
      return best;
    }
  // initialise to platform default (desktop:100, mobile:160). Session-only — do not persist.
    try {
      const ua = navigator.userAgent || '';
      const isMobileUa = /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua);
      const prefersCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const isMobile = isMobileUa || prefersCoarse;
  const initial = isMobile ? 160 : 100;
      applyZoom(initial);
    } catch (e) { /* ignore */ }
    function stepZoom(direction) {
      try {
        const cur = (() => { const txt = uiZoomValue ? uiZoomValue.textContent.replace('%','') : '100'; return Number(txt); })();
        const idx = Math.max(0, ZOOM_STEPS.indexOf(clampToStep(cur)));
        const nextIdx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + (direction > 0 ? 1 : -1)));
        const next = ZOOM_STEPS[nextIdx];
        applyZoom(next);
      } catch (e) { console.warn('stepZoom failed', e); }
    }
    if (uiZoomMinus) {
      uiZoomMinus.addEventListener('click', () => stepZoom(-1));
      // Add touchstart for better responsiveness on Android/iOS; preventDefault to avoid duplicate click
      uiZoomMinus.addEventListener('touchstart', (ev) => { try { ev.preventDefault(); stepZoom(-1); } catch (e) {} }, { passive: false });
    }
    if (uiZoomPlus) {
      uiZoomPlus.addEventListener('click', () => stepZoom(1));
      uiZoomPlus.addEventListener('touchstart', (ev) => { try { ev.preventDefault(); stepZoom(1); } catch (e) {} }, { passive: false });
    }

    // Theme toggle (dark mode) — persist as 'light' or 'dark'
    const themeToggle = document.getElementById('themeToggle');
    const THEME_KEY = 'shot-timer-theme';
    function applyTheme(t) {
      try {
        if (t === 'dark') {
          document.documentElement.setAttribute('data-theme', 'dark');
          const btn = document.getElementById('themeBtn'); if (btn) { btn.setAttribute('aria-pressed','true'); btn.textContent = '☀️'; }
        } else {
          document.documentElement.removeAttribute('data-theme');
          const btn = document.getElementById('themeBtn'); if (btn) { btn.setAttribute('aria-pressed','false'); btn.textContent = '🌙'; }
        }
        if (themeToggle) themeToggle.checked = (t === 'dark');
      } catch (e) { console.warn('applyTheme failed', e); }
    }
    try {
      const storedTheme = localStorage.getItem(THEME_KEY);
      if (storedTheme) applyTheme(storedTheme);
      else {
        // default: respect CSS prefers-color-scheme (already handled by CSS), but set checkbox accordingly
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (themeToggle) themeToggle.checked = prefersDark;
      }
    } catch (e) { /* ignore */ }
    if (themeToggle) themeToggle.addEventListener('change', e => {
      const t = e.target.checked ? 'dark' : 'light';
      applyTheme(t);
      try { localStorage.setItem(THEME_KEY, t); } catch (err) { /* ignore */ }
    });

    // Speaker select — hide or guard on platforms that don't support setSinkId
    const speakerSelect = document.getElementById('speakerSelect');
    try {
      if (speakerSelect && supportsSetSinkId()) {
        speakerSelect.addEventListener('change', async e => {
          try {
            await setOutputDevice(e.target.value);
            setStatus(`Using output device: ${speakerSelect.selectedOptions[0]?.text || e.target.value}`, 'success');
          } catch (err) {
            setStatus('Failed to set output device — this browser may not support setSinkId.', 'error');
          }
        });
      } else if (speakerSelect) {
        // hide the control on platforms where we can't programmatically switch output
        speakerSelect.style.display = 'none';
        const spkLabel = speakerSelect.parentNode; if (spkLabel) spkLabel.style.display = 'none';
        // show a gentle visible note so users know the system manages output routing
        try {
          // Respect a saved dismissal so the note doesn't reappear for users who already acknowledged it
          const DISMISS_KEY = 'shot-timer-system-output-note-dismissed';
          const dismissed = (() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; } })();
          if (!dismissed) {
            let note = document.getElementById('systemOutputNote');
            if (!note) {
              note = document.createElement('div');
              note.id = 'systemOutputNote';
              note.className = 'system-output-note input-hint';
              const icon = document.createElement('span');
              icon.className = 'info-icon';
              icon.setAttribute('role', 'img');
              icon.setAttribute('aria-label', 'Info');
              icon.textContent = 'ℹ️';
              note.appendChild(icon);
              const txt = document.createElement('span');
              txt.textContent = 'Using system audio output — change output via your device (Control Center on iPhone, system audio settings, or Bluetooth).';
              note.appendChild(txt);
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'dismiss-note-btn';
              btn.setAttribute('aria-label', 'Dismiss system audio note');
              btn.textContent = 'Got it';
              btn.addEventListener('click', () => {
                try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
                note.style.display = 'none';
              });
              note.appendChild(btn);
              // insert after the (now-hidden) speaker label if possible, otherwise append to devices section
              if (spkLabel && spkLabel.parentNode) spkLabel.parentNode.appendChild(note);
              else {
                const devices = document.getElementById('devices'); if (devices) devices.appendChild(note);
              }
            }
          }
        } catch (e) { /* ignore DOM errors */ }
      }
    } catch (e) { /* ignore */ }

    // Control buttons
  const startBtn = $('#startBtn');
    const stopBtn = $('#stopBtn');
    const nextStageBtn = document.getElementById('nextStageBtn');
    const calibrateBtn = $('#calibrateBtn');
    const detectBtn = $('#detectBtn');
    const resetCourseBtn = $('#resetCourseBtn');

  // Pending randomized start timer (ms)
  let startDelayTimer = null;
  function clearPendingStart() {
    // startDelayTimer may be a timeout or an interval (we use interval for
    // the visible countdown). Clear whichever is present and null the handle.
    try {
      if (startDelayTimer) { clearInterval(startDelayTimer); startDelayTimer = null; }
    } catch (e) {
      try { if (startDelayTimer) { clearTimeout(startDelayTimer); startDelayTimer = null; } } catch (err) { /* ignore */ }
    }
    try { if (startBtn) startBtn.disabled = false; } catch (e) {}
  }

  if (startBtn) startBtn.addEventListener('click', async () => {
    // Visual feedback for user's press
    transientPress(startBtn);
    try { stopListening(); setListenMode(false); } catch (err) {}
    // If we're permitted to repeat the stage (after a Stop), ensure microphone
    // permission / device is available before starting the pre-start sequence.
    if (canRepeatStage && !isTimerActive) {
      // user intent: repeating the stage — re-acquire mic before starting
      const ok = await requestMicPermission();
      if (!ok) {
        // leave UI in stopped state; inform user
        try { setStatus('Microphone required to repeat stage. Start cancelled.', 'error'); } catch (e) {}
        return;
      }
      // Increment the attempt count so the saved label becomes 2a/2b etc.
      try { incrementStageAttempt(); } catch (e) {}
      // Refresh stage context so the timer/core uses the updated attempt label (safety)
      try { setStageContext({}); } catch (e) {}
      // Clear the repeat flag; we'll start a fresh run now
      canRepeatStage = false;
    }
    // If Start was already in a running state, treat as Reset and clear running indicator
    try { if (startBtn.classList.contains('running')) { try { resetTimer(); } catch (e) {} startBtn.classList.remove('running'); startBtn.classList.remove('btn-anim'); return; } } catch (e) {}
    // If a previous run is active, reset it first so Start acts like the old Reset
    try { resetTimer(); } catch (e) { /* ignore */ }
    // Prevent double-starts: disable the button while waiting for the random delay
    try { startBtn.disabled = true; } catch (e) {}
  // Random pre-start between 1 and 3 seconds. We'll show a red countdown on
  // the main clock counting down the random time (rocket-launch style), then
  // play the beep and start the actual stage countdown.
  const preMs = 1000 + Math.floor(Math.random() * 2001);
    const displayEl = document.getElementById('display');
    // Apply visual prestart indicator
    if (displayEl) displayEl.classList.add('prestart');
    const preStartAt = performance.now();
  startDelayTimer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - preStartAt;
      const remaining = Math.max(0, preMs - elapsed);
  if (displayEl) displayEl.textContent = formatTime(Math.ceil(remaining));
  // animate Start button during pre-start to indicate countdown
  const startBtnEl = document.getElementById('startBtn'); if (startBtnEl) { startBtnEl.classList.add('btn-anim'); startBtnEl.classList.add('running'); }
      if (remaining <= 0) {
        // clear interval
        clearPendingStart();
  if (displayEl) displayEl.classList.remove('prestart');
  const startBtnEl2 = document.getElementById('startBtn'); if (startBtnEl2) startBtnEl2.classList.remove('btn-anim');
        // play beep and immediately start the real countdown, skipping the
        // startTimer initial beep to avoid double beep
        try { playBeep(); } catch (e) {}
        if (typeof onStart === 'function') onStart({ skipInitialBeep: true });
      }
    }, 100);
  });
  if (stopBtn) stopBtn.addEventListener('click', () => {
    // Visual feedback for user's press
    transientPress(stopBtn);
    // Stop listening and cancel any pending pre-start; do not reset recorded shots
    try { stopListening(); } catch (e) { /* ignore */ }
    try { stopMic(); } catch (e) { /* ignore */ }
    try { stopTimer(); } catch (e) { /* ignore */ }
    clearPendingStart();
  // Re-enable Start and disable Stop so only Start is active (user may repeat)
  try { setStartStopEnabled(true, false); } catch (e) {}
    // clear any running/animation states — do not clear recorded shots
    try { if (startBtn) { startBtn.classList.remove('running'); startBtn.classList.remove('btn-anim'); } } catch (e) {}
    try { if (stopBtn) stopBtn.classList.remove('btn-anim'); } catch (e) {}
    // After stopping a stage explicitly, mark timer inactive and animate Next to indicate progression
    try { isTimerActive = false; } catch (e) {}
    try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
    // Allow the user to repeat this stage; the Start handler will re-acquire mic
    try { canRepeatStage = true; } catch (e) {}
  });
  // Animate Next button when clicked; controls.js doesn't handle advancing — courseChooser will — but visual feedback is useful
  if (nextStageBtn) {
    nextStageBtn.addEventListener('click', () => {
      try { nextStageBtn.classList.add('btn-anim'); } catch (e) {}
    });
  }

  // Wire course/stage selects to enable/disable Start/Stop appropriately
  try {
    const courseSel = document.getElementById('courseSelect');
    const stageSel = document.getElementById('stageSelect');
    if (courseSel) courseSel.addEventListener('change', updateStageButtonState);
    if (stageSel) stageSel.addEventListener('change', updateStageButtonState);
    // initial state
    updateStageButtonState();
    // Watch for Next -> Save label changes so we can enforce Save-state UX
    if (nextStageBtn && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        try {
          const txt = (nextStageBtn.textContent || '').trim();
          if (txt === 'Save') {
            // When Save is visible, disable Start/Stop and pulse Save
            try { setStartStopEnabled(false, false); } catch (e) {}
            try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
          } else {
            // Restore regular state when leaving Save
            try { updateStageButtonState(); } catch (e) {}
          }
        } catch (e) { /* ignore */ }
      });
      mo.observe(nextStageBtn, { characterData: true, childList: true, subtree: true });
    }
  } catch (e) { /* ignore */ }

  // When a stage finishes, clear transient animations and mark Start as no longer running
  document.addEventListener('stageFinished', () => {
    try { if (startBtn) { startBtn.classList.remove('running'); startBtn.classList.remove('btn-anim'); } } catch (e) {}
    try { if (stopBtn) stopBtn.classList.remove('btn-anim'); } catch (e) {}
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Stage finished naturally — timer no longer active
      try { isTimerActive = false; } catch (e) {}
      // Stop pulsing should stop; allow Next to pulse so user can advance
      try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
      // After natural finish, Start should be disabled to avoid accidental extra time,
      // but Stop should be enabled so user can clear listening if needed.
      try { setStartStopEnabled(false, true); } catch (e) {}
    // Allow repeating the stage (user may click Stop then Start to repeat)
    try { canRepeatStage = true; } catch (e) {}
  });

  // When a stage starts, animate only Stop; remove Start animation
  document.addEventListener('stageStarted', () => {
    try { if (startBtn) { startBtn.classList.remove('btn-anim'); startBtn.classList.remove('running'); } } catch (e) {}
    try { if (stopBtn) stopBtn.classList.add('btn-anim'); } catch (e) {}
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Timer is active now
      try { isTimerActive = true; } catch (e) {}
      // Keep Stop pulsing until user clicks it
      try { if (stopBtn) stopBtn.classList.add('btn-anim'); } catch (e) {}
      // Disable Next while timer is active
      try { setNextEnabled(false); setNextPulse(false); } catch (e) {}
      // While the timer is running, Start must be disabled to prevent adding time;
      // Stop remains enabled so the user can stop early.
      try { setStartStopEnabled(false, true); } catch (e) {}
  });

  // When timer is explicitly stopped (via Stop), clear the active animations
  document.addEventListener('timerStopped', () => {
    try { if (startBtn) startBtn.classList.remove('btn-anim'); } catch (e) {}
    try { if (stopBtn) stopBtn.classList.remove('btn-anim'); } catch (e) {}
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Timer was stopped externally — ensure active flag cleared and Next is available
      try { isTimerActive = false; } catch (e) {}
      try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
      // When stopped by the user, allow Start to remain disabled (so they explicitly
      // advance using Next), but ensure Stop is enabled so audio can be managed.
    try { setStartStopEnabled(false, true); } catch (e) {}
    try { canRepeatStage = true; } catch (e) {}
  });
  if (resetCourseBtn) resetCourseBtn.addEventListener('click', () => { clearPendingStart(); if (typeof onNewParticipant === 'function') onNewParticipant(); });
    if (calibrateBtn) calibrateBtn.addEventListener('click', () => { clearPendingStart(); if (typeof onCalibrate === 'function') onCalibrate(); });

    if (listenBtn) listenBtn.addEventListener('click', async () => { if (listenBtn.textContent === 'Listen') await startListening(); else stopListening(); });
    if (detectBtn) detectBtn.addEventListener('click', async () => { await populateDeviceLists(); });

    // Show/hide setup buttons based on whether the collapsed setup area is expanded
    function updateSetupButtonsVisibility() {
      const collapsedArea = document.getElementById('collapsedArea');
      const expanded = collapsedArea && !collapsedArea.classList.contains('collapsed');
      const visible = Boolean(expanded);
      if (detectBtn) detectBtn.style.display = visible ? '' : 'none';
      if (listenBtn) listenBtn.style.display = visible ? '' : 'none';
      if (calibrateBtn) calibrateBtn.style.display = visible ? '' : 'none';
    }
    // initial visibility
    updateSetupButtonsVisibility();
    // if a collapse toggle exists, update on click
    const collapseToggle = document.getElementById('collapseToggle');
    if (collapseToggle) collapseToggle.addEventListener('click', () => { setTimeout(updateSetupButtonsVisibility, 50); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
}

export function setUiTotalSecondsUI(v) { const el = document.getElementById('totalSecInput'); if (!el) return; el.value = String(v); try { setTotalSeconds(Number(v)); } catch (e) { /* ignore */ } }
export function setUiExpectedShotsUI(v) { const el = document.getElementById('shotsCountInput'); if (!el) return; el.value = String(v); try { setExpectedShots(Number(v)); } catch (e) { /* ignore */ } }
