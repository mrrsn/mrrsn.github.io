// controls.js — clean single implementation
import { setTotalSeconds, setExpectedShots, setThreshold, setDebounceMs, setBeepOnShot, getBeepOnShot } from '../timer/config.js';
import { resetTimer, stopTimer, incrementStageAttempt, setStageContext } from '../timer/core.js';
import { setOutputDevice, getAudioContext, supportsSetSinkId, ensureAudioRunning } from '../audio/context.js';
import { pollDetector, setListenMode, stopMic, initMic } from '../audio/detector.js';
import { setRmsColumnVisible } from './shotsTable.js';
import { playBeep } from '../audio/beep.js';
import { formatTime } from '../timer/utils.js';
const $ = (s) => document.querySelector(s);
function getEl(id) { try { return document.getElementById(id); } catch (e) { return null; } }
// Guards to avoid re-entrancy and duplicate operations
let __populateDevicesInProgress = false;
let __isListening = false;
let __deviceChangeHandlerAdded = false;
let __autoDeviceAllowed = false;
// Timer handle used to auto-clear the status area; stored so we can cancel when
// the user opens the Details panel or clicks Close.
let statusClearTimer = null;
function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  if (!el) return;
  // Ensure the status container is visible (CSS uses .status-visible to fade it in)
  el.classList.remove('hidden', 'error', 'success');
  el.classList.add('status-visible');
  if (type === 'error') el.classList.add('error');
  if (type === 'success') el.classList.add('success');
  // Instead of stomping the entire element's textContent (which would
  // remove appended controls like spinners or Details), write the
  // message into a dedicated child node. Also ensure a '.status-controls'
  // container exists for transient controls appended by callers.
  let msgEl = el.querySelector('.status-message');
  if (!msgEl) {
    msgEl = document.createElement('span');
    msgEl.className = 'status-message';
    // insert at top so message is always first
    el.insertBefore(msgEl, el.firstChild);
  }
  msgEl.textContent = msg;
  // ensure controls container exists
  let controls = el.querySelector('.status-controls');
  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'status-controls';
    controls.style.marginTop = '0.25rem';
    el.appendChild(controls);
  }
}
function clearStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  // hide and clear any timers
  el.classList.add('hidden');
  el.classList.remove('status-visible', 'error', 'success');
  if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null; }
  // Remove transient children to avoid stale controls lingering
  try {
    const msgEl = el.querySelector('.status-message'); if (msgEl) msgEl.remove();
    const controls = el.querySelector('.status-controls'); if (controls) controls.remove();
    const existing = el.querySelector('.status-details'); if (existing) existing.remove();
  } catch (e) {}
}

function scheduleClear(ms) {
  try {
    if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null; }
    statusClearTimer = setTimeout(() => { try { clearStatus(); } catch (e) {} finally { statusClearTimer = null; } }, ms);
  } catch (e) { /* ignore timer errors */ }
}

// Build a diagnostic object suitable for display/copying
function buildDeviceDiagnostics(devices, permState) {
  const mics = devices.filter(d => d.kind === 'audioinput');
  const spks = devices.filter(d => d.kind === 'audiooutput');
  const labelHidden = mics.some(m => !m.label || m.label.trim() === '');
  return {
    when: new Date().toISOString(),
    ua: navigator.userAgent || '',
    permission: permState || 'unknown',
    sinkSupported: (typeof HTMLAudioElement.prototype.setSinkId === 'function'),
    counts: { mics: mics.length, speakers: spks.length },
    devices: devices.map(d => ({ kind: d.kind, label: d.label || '(hidden)', id: (d.deviceId||'').slice(0,8) })),
    labelHidden
  };
}

// Show a status message plus a Details toggle inside the existing #status
function showStatusWithDetails(message, type, diag, retryFn) {
  try {
    setStatus(message, type);
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
    // remove any existing details container
  const existing = statusEl.querySelector('.status-details');
  if (existing) existing.remove();

  const ctrl = document.createElement('div');
  ctrl.className = 'status-details';
  ctrl.style.marginTop = '0.5rem';
    // Details toggle link
    const detailsBtn = document.createElement('button');
    detailsBtn.type = 'button';
    detailsBtn.className = 'btn-secondary';
    detailsBtn.textContent = 'Details';
    detailsBtn.style.marginRight = '0.5rem';
    ctrl.appendChild(detailsBtn);

    // Retry button (if provided)
    if (typeof retryFn === 'function') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-secondary';
      retryBtn.textContent = 'Retry';
      retryBtn.style.marginRight = '0.5rem';
      retryBtn.addEventListener('click', () => { try { retryFn(); } catch (e) { console.warn('Retry failed', e); } });
      ctrl.appendChild(retryBtn);
    }

    // Close button to let the user dismiss the status/details manually
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginLeft = '0.25rem';
    closeBtn.addEventListener('click', () => { try { clearStatus(); } catch (e) { console.warn('Close failed', e); } });
    ctrl.appendChild(closeBtn);

    // Copy diagnostics button
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-secondary';
    copyBtn.textContent = 'Copy diagnostics';
    copyBtn.style.marginRight = '0.5rem';
    ctrl.appendChild(copyBtn);

    // Hidden pre element with JSON payload
    const pre = document.createElement('pre');
    pre.style.display = 'none';
    pre.style.maxHeight = '200px';
    pre.style.overflow = 'auto';
    pre.style.marginTop = '0.5rem';
    pre.style.background = 'rgba(0,0,0,0.03)';
    pre.style.padding = '0.5rem';
    pre.textContent = diag ? JSON.stringify(diag, null, 2) : '{}';
    ctrl.appendChild(pre);

    // Append the details/control block into the dedicated status-controls
    // container so it doesn't conflict with the status message node.
    let controls = statusEl.querySelector('.status-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'status-controls';
      controls.style.marginTop = '0.25rem';
      statusEl.appendChild(controls);
    }
    controls.appendChild(ctrl);
    // Toggle behavior
    let open = false;
    detailsBtn.addEventListener('click', () => {
      open = !open;
      pre.style.display = open ? '' : 'none';
      detailsBtn.textContent = open ? 'Hide details' : 'Details';
      // If the user opened details, cancel any auto-clear so they can read/copy
      try { if (open && statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null; } } catch (e) {}
    });

    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(pre.textContent);
          setStatus('Diagnostics copied to clipboard', 'success');
          scheduleClear(1500);
        } else {
          // fallback: select and copy
          const ta = document.createElement('textarea');
          ta.value = pre.textContent;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          setStatus('Diagnostics copied to clipboard', 'success');
          scheduleClear(1500);
        }
      } catch (e) {
        console.warn('Copy diagnostics failed', e);
        setStatus('Failed to copy diagnostics', 'error');
        scheduleClear(2000);
      }
    });

  // statusEl.appendChild(ctrl);
    // If a retry function was provided, keep the status visible indefinitely until user action.
    // Otherwise, schedule a default auto-clear in 3s so transient messages don't linger.
    try {
      if (typeof retryFn !== 'function') scheduleClear(3000);
    } catch (e) {}
  } catch (e) { console.warn('showStatusWithDetails failed', e); }
}

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
  if (__populateDevicesInProgress) { console.debug('populateDeviceLists: already in progress — skipping'); return; }
  __populateDevicesInProgress = true;
  console.debug('populateDeviceLists: start');
  const allowed = await requestMicPermission(); if (!allowed) { console.debug('populateDeviceLists: permission denied'); __populateDevicesInProgress = false; return; }
  // Best-effort: query permission state for diagnostics (may not be supported)
  let permState = 'unknown';
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      try {
        const p = await navigator.permissions.query({ name: 'microphone' });
        permState = p && p.state ? p.state : permState;
      } catch (err) { /* some browsers reject this query shape */ }
    }
  } catch (e) { /* ignore */ }
  const micSelect = document.getElementById('micSelect');
  const spkSelect = document.getElementById('speakerSelect');
  if (!micSelect || !spkSelect) return;
  const prevMic = micSelect.value, prevSpk = spkSelect.value;
  const detectBtn = document.getElementById('detectBtn'); if (detectBtn) detectBtn.disabled = true;
  const statusEl = document.getElementById('status');
  if (statusEl) {
    setStatus('Scanning devices');
    const spin = document.createElement('span');
    spin.className = 'spinner';
    // place spinner in the controls container so it doesn't get overwritten
    let controls = statusEl.querySelector('.status-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'status-controls';
      controls.style.marginTop = '0.25rem';
      statusEl.appendChild(controls);
    }
    controls.appendChild(spin);
  }
  micSelect.innerHTML = ''; spkSelect.innerHTML = '';
  let devices = [];
  try {
    console.debug('populateDeviceLists: enumerating devices');
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  catch (e) {
    console.warn('populateDeviceLists: enumerateDevices failed', e);
    if (detectBtn) detectBtn.disabled = false;
    const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'Could not enumerate devices'; micSelect.appendChild(opt); spkSelect.appendChild(opt.cloneNode(true));
    // Build diagnostics and surface them with a Details/Retry UI so users can copy/share
    try {
      const diag = buildDeviceDiagnostics(devices || [], permState);
      if (statusEl) showStatusWithDetails('Could not enumerate audio devices. Check microphone permission.', 'error', diag, async () => { try { __autoDeviceAllowed = true; await populateDeviceLists(); } catch (err) { console.warn('Retry populateDeviceLists failed', err); } });
    } catch (err) {
      if (statusEl) setStatus('Could not enumerate audio devices. Check microphone permission.', 'error');
    }
    return;
  }
  finally { if (detectBtn) detectBtn.disabled = false; }
  __populateDevicesInProgress = false;
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
  if (prevMic) micSelect.value = prevMic; if (prevSpk) spkSelect.value = prevSpk;
  // Build diagnostics and surface a richer status message so users can copy details or retry
  try {
    const diag = buildDeviceDiagnostics(devices, permState);
    if (statusEl) showStatusWithDetails(`Found ${micSelect.options.length} mic(s) and ${spkSelect.options.length} speaker(s)`, 'success', diag, async () => { try { __autoDeviceAllowed = true; await populateDeviceLists(); } catch (err) { console.warn('Retry populateDeviceLists failed', err); } });
  } catch (e) {
    if (statusEl) { setStatus(`Found ${micSelect.options.length} mic(s) and ${spkSelect.options.length} speaker(s)`, 'success'); setTimeout(clearStatus, 3000); }
  }
  console.debug('populateDeviceLists: finished', { mics: micSelect.options.length, speakers: spkSelect.options.length });
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
    // Avoid automatic device detection on load — this can trigger
    // getUserMedia or enumerateDevices and block/require permission during startup.
    // Instead, show the Detect button and let users opt-in to scanning devices.
    if (!isMobilePlatform && supportsSetSinkId()) {
      try {
        const detectBtnEl = document.getElementById('detectBtn'); if (detectBtnEl) detectBtnEl.style.display = '';
      } catch (e) {}
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
  const listenBtn = getEl('listenBtn');

    async function startListening() {
      if (__isListening || listenRaf) return;
      __isListening = true;
        // Prime the mic and resume the audio context before entering Listen mode.
        let primed = false;
        try {
          await initMic();
          await ensureAudioRunning();
          primed = true;
        } catch (e) {
          console.warn('startListening: priming audio failed', e);
          primed = false;
        }
        try {
          if (primed) {
            try { setStatus('Audio primed', 'success'); scheduleClear(5000); } catch (e) {}
          }
        } catch (e) {}
      try { setListenMode(true); } catch (e) { console.warn('Could not set Listen mode:', e); }
  // indicate listening via animation; the Listen control shows 'Stop' while active
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

  function stopListening() { 
    try {
      if (listenRaf) {
        cancelAnimationFrame(listenRaf);
        listenRaf = null;
        if (listenBtn) listenBtn.textContent = 'Listen';
      }
      try { setListenMode(false); } catch (e) { console.warn('Could not clear Listen mode', e); }
      try { stopMic(); } catch (e) { console.warn('stopListening: stopMic failed', e); }
      __isListening = false;
      clearStatus();
    } catch (err) {
      console.warn('stopListening: unexpected error', err);
    }
    // Note: do NOT call stopTimer() here. stopTimer() dispatches the
    // 'timerStopped' event which may cause UI handlers to call stopListening()
    // again, creating a recursion. The caller should invoke stopTimer() when
    // they intend to stop the countdown as well as listening.
  }

  // Timer/interaction state
  let isTimerActive = false; // true when the stage countdown is actively running
  let canRepeatStage = false; // true after a finish/re-run so the user may re-run the stage

  // Enable or disable Start-related controls depending on course/stage selection
  // and timer state. Kept signature compatible with older callers: passing a
  // single boolean toggles both startEnabled and the legacy stopEnabled arg.
  function setStartStopEnabled(startEnabled, stopEnabled) {
    try {
      if (typeof stopEnabled === 'undefined') stopEnabled = startEnabled;
      if (startBtn) {
        startBtn.disabled = !startEnabled;
        startBtn.setAttribute('aria-disabled', String(!startEnabled));
        if (!startEnabled) startBtn.classList.add('disabled'); else startBtn.classList.remove('disabled');
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
      // If nextStageBtn isn't present, nothing to hide/show
      const _nextBtn = nextStageBtn;
      function detachNextButton() {
        try {
          if (!_nextBtn || nextStageBtnDetached) return;
          nextStageBtnParent = _nextBtn.parentNode;
          if (nextStageBtnParent) {
            nextStageBtnNextSibling = _nextBtn.nextSibling;
            nextStageBtnParent.removeChild(_nextBtn);
            nextStageBtnDetached = true;
            console.debug('Next button detached from DOM');
          }
        } catch (e) { console.warn('detachNextButton failed', e); }
      }
      function restoreNextButton() {
        try {
          if (!_nextBtn || !nextStageBtnDetached) return;
          if (nextStageBtnParent) {
            if (nextStageBtnNextSibling && nextStageBtnNextSibling.parentNode === nextStageBtnParent) nextStageBtnParent.insertBefore(_nextBtn, nextStageBtnNextSibling);
            else nextStageBtnParent.appendChild(_nextBtn);
            nextStageBtnDetached = false;
            nextStageBtnParent = null;
            nextStageBtnNextSibling = null;
            console.debug('Next button restored to DOM');
          }
        } catch (e) { console.warn('restoreNextButton failed', e); }
      }
      // If the course UI isn't present, allow normal behavior
      if (!courseSel || !stageSel) { 
        try { detachNextButton(); } catch (e) {}
        setStartStopEnabled(true); 
        return; 
      }
      // If no course chosen, allow Start
      if (!courseSel.value) { 
        try { detachNextButton(); } catch (e) {}
        setStartStopEnabled(true); 
        return; 
      }
      // If a stage is selected and it's not the scoring pseudo-stage, enable buttons
      const sel = stageSel.value;
      const onStage = Boolean(sel) && sel !== 'scoring';
      // Start should be enabled when a stage is present and not currently running.
      // Note: the Stop control was removed in favor of automatic stop after
      // the finish beep; legacy stopEnabled logic is retained for compatibility
      // but Stop is not present in the UI.
      if (onStage) {
        const startEnabled = !isTimerActive;
        const stopEnabled = isTimerActive || !!canRepeatStage; // legacy
        setStartStopEnabled(startEnabled, stopEnabled);
      } else {
        setStartStopEnabled(false, false);
      }
      // Next button logic:
      // - If we're showing scoring (before first stage), pulse Next and enable it.
  // - If we're on a numeric stage and the timer is active, disable Next until the run finishes (auto-stop).
      // - Otherwise enable Next and remove pulse.
      if (sel === 'scoring') {
        try { restoreNextButton(); } catch (e) {}
        setNextEnabled(true);
        setNextPulse(true);
      } else if (onStage && isTimerActive) {
        try { restoreNextButton(); } catch (e) {}
        setNextEnabled(false);
        setNextPulse(false);
      } else {
        try { restoreNextButton(); } catch (e) {}
        setNextEnabled(true);
        setNextPulse(false);
      }
      // If disabling, clear any pending start and stop any active listening/timer to avoid stray activity
      if (!onStage) {
        try { clearPendingStart(); } catch (e) {}
        try { stopListening(); } catch (e) {}
        try { stopMic(); } catch (e) {}
        try { stopTimer(); } catch (e) {}
  // Ensure UI stays disabled when there is no stage selected. Calling
  // stopTimer() above may dispatch 'timerStopped' and change UI state.
  // Force Start to be disabled for the 'no stage' state so the UI is consistent.
  try { setStartStopEnabled(false, false); } catch (e) {}
      }
      // Additionally, when the timer is active, prevent the user from changing
      // the selected course or stage to avoid mid-run context switches.
      try {
        if (courseSel) {
          courseSel.disabled = isTimerActive;
          courseSel.setAttribute('aria-disabled', String(isTimerActive));
        }
        if (stageSel) {
          stageSel.disabled = isTimerActive;
          stageSel.setAttribute('aria-disabled', String(isTimerActive));
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

    if (navigator.mediaDevices && !__deviceChangeHandlerAdded) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        try {
          console.debug('devicechange event');
          if (!__autoDeviceAllowed) { console.debug('devicechange: auto device scan not allowed by user'); return; } // only auto-refresh if user previously allowed detection
          console.debug('devicechange: auto device scan allowed; calling populateDeviceLists');
          await populateDeviceLists();
        } catch (e) { console.warn('devicechange handler failed', e); }
      });
      __deviceChangeHandlerAdded = true;
    }

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
    // Ensure phone default zoom is applied on every full page load. Some
    // browsers may modify root font-size after DOMContentLoaded; reapply on
    // the window load event to guarantee the mobile default of 160%.
    try {
      window.addEventListener('load', () => {
        try {
          const ua2 = navigator.userAgent || '';
          const isMobileUa2 = /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua2);
          const prefersCoarse2 = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
          const isMobile2 = isMobileUa2 || prefersCoarse2;
          if (isMobile2) applyZoom(160);
        } catch (err) { /* ignore */ }
      });
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
      const nextStageBtn = document.getElementById('nextStageBtn');
    const calibrateBtn = $('#calibrateBtn');
    const detectBtn = $('#detectBtn');
    const resetCourseBtn = document.getElementById('resetCourseBtn');

  // Track detached Next button so we can remove it from DOM when no course is
  // selected (keeps DOM simpler and prevents focus/tab stops). We store its
  // original parent and nextSibling to restore it later when a course is
  // selected again.
  let nextStageBtnParent = null;
  let nextStageBtnNextSibling = null;
  let nextStageBtnDetached = false;
  const actionGroup = document.querySelector('.action-group');

  // Auto-stop timer handles: when a stage finishes we keep listening for a
  // short grace period (2s) to capture trailing shots, then stop listening
  // automatically. We also swap the logo to an "active" image during the
  // active-stage window (from first beep until 2s after finish).
  let autoStopTimer = null;
  // Post-finish visual countdown (ms)
  let postStopInterval = null;
  let postStopEndAt = null;
  let savedDisplayText = null;
  let originalLightLogoDisplay = null;
  let originalDarkLogoDisplay = null;
  let originalActiveLogoDisplay = null;
  let originalLightLogoOpacity = null;
  let originalDarkLogoOpacity = null;
  let originalActiveLogoOpacity = null;
  let logoActive = false;

  function clearAutoStop() {
    try { if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } } catch (e) {}
    try { if (postStopInterval) { clearInterval(postStopInterval); postStopInterval = null; postStopEndAt = null; } } catch (e) {}
    try {
      const displayEl = document.getElementById('display');
      if (displayEl) {
        displayEl.classList.remove('postfinish');
        if (savedDisplayText !== null) { displayEl.textContent = savedDisplayText; savedDisplayText = null; }
      }
    } catch (e) {}
  }

  function setActiveStageLogo(active) {
    try {
      const svg = document.querySelector('.svg-logo');
      if (!svg) return;
      if (active) svg.classList.add('active'); else svg.classList.remove('active');
      logoActive = !!active;
    } catch (e) { console.warn('setActiveStageLogo failed', e); }
  }

    // Fun feature: double-click or double-tap the logo to cycle the selected course.
    // This cycles through `#courseSelect` options and then back to none.
    try {
      // Single inline SVG logo now — listen for dblclick/double-tap on it
      const logos = document.querySelectorAll('.svg-logo');
      if (logos && logos.length > 0) {
        // Logo tip: show a small one-time hint above the logo explaining
        // the double-click/double-tap trick. Persist dismissal in localStorage
        // so users don't see it again.
        try {
          const TIP_KEY = 'shot-timer-logo-tip-dismissed';
          const dismissed = (() => { try { return localStorage.getItem(TIP_KEY) === '1'; } catch (e) { return false; } })();
          if (!dismissed) {
            const firstLogo = logos[0];
            const tip = document.createElement('div');
            tip.className = 'logo-tip input-hint';
            tip.style.display = 'flex';
            tip.style.alignItems = 'center';
            tip.style.gap = '0.5rem';
            tip.style.marginBottom = '0.5rem';
            tip.setAttribute('role', 'status');
            tip.setAttribute('aria-live', 'polite');
            const txt = document.createElement('span');
            txt.textContent = 'Tip: double-tap or double-click the logo to quickly cycle courses.';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-secondary';
            btn.textContent = 'Got it!';
            btn.setAttribute('aria-label', 'Dismiss logo tip');
            btn.addEventListener('click', () => {
              try { localStorage.setItem(TIP_KEY, '1'); } catch (e) {}
              try { tip.remove(); } catch (e) {}
            });
            tip.appendChild(txt);
            tip.appendChild(btn);
            try {
              // insert before the first logo element so it visually appears above
              const parent = firstLogo.parentNode || document.body;
              parent.insertBefore(tip, firstLogo);
            } catch (e) { document.body.insertBefore(tip, document.body.firstChild); }
          }
        } catch (e) { /* ignore tip errors */ }
        logos.forEach(logo => {
          try {
            logo.style.cursor = 'pointer';
            // Desktop double-click
            logo.addEventListener('dblclick', (ev) => {
              try { cycleCourse(logo); } catch (e) { console.warn('logo dblclick cycle failed', e); }
            });
            // Touch double-tap detection
            let lastTap = 0;
            logo.addEventListener('touchend', (ev) => {
              try {
                const now = Date.now();
                const delta = now - lastTap;
                // Consider two taps within 350ms a double-tap
                if (delta > 0 && delta < 350) {
                  ev.preventDefault();
                  try { cycleCourse(logo); } catch (e) { console.warn('logo double-tap cycle failed', e); }
                  lastTap = 0;
                } else {
                  lastTap = now;
                }
              } catch (e) { /* ignore */ }
            }, { passive: false });
          } catch (e) { /* ignore per-element errors */ }
        });
      }
    } catch (e) { /* ignore top-level */ }

    // Helper: advance the courseSelect one step (or clear selection when past last)
    function cycleCourse(logoEl) {
      try {
        const courseSelect = document.getElementById('courseSelect');
        if (!courseSelect) return;
        // Prevent cycling courses while a stage timer is active
        if (isTimerActive) {
          try { setStatus('Cannot change course while timer is running', 'error'); scheduleClear(3000); } catch (e) {}
          return;
        }
        const opts = courseSelect.options;
        if (!opts || opts.length === 0) return;
        let idx = courseSelect.selectedIndex;
        if (idx === -1) idx = 0; else idx = idx + 1;
        if (idx >= opts.length) {
          // deselect (set to none)
          try { courseSelect.value = ''; } catch (e) { courseSelect.selectedIndex = -1; }
          try { courseSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
          if (logoEl) transientPress(logoEl);
          return;
        }
        courseSelect.selectedIndex = idx;
        try { courseSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        if (logoEl) transientPress(logoEl);
      } catch (e) { console.warn('cycleCourse failed', e); }
    }

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
  // If we're permitted to repeat the stage (after a previous run), ensure microphone
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
  // Ensure mic and audio context are primed (helps avoid iOS routing/hesitation)
  try { await initMic(); } catch (e) { /* ignore */ }
  try { await ensureAudioRunning(); } catch (e) { /* ignore */ }
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
        // startTimer initial beep to avoid double beep. Also swap the logo to
        // the active-stage image at the moment of the first beep so the UI
        // clearly indicates the stage has begun.
        try { playBeep(); } catch (e) {}
        try { setActiveStageLogo(true); } catch (e) {}
        if (typeof onStart === 'function') onStart({ skipInitialBeep: true });
      }
    }, 100);
  });
  // Stop button removed: stopping is now automatic. If you previously relied
  // on the Stop click, use Next or Reset Course to interrupt flows. The old
  // manual handler behavior is preserved by automatic logic below.
  // Animate Next button when clicked; controls.js doesn't handle advancing — courseChooser will — but visual feedback is useful
  if (nextStageBtn) {
    nextStageBtn.addEventListener('click', () => {
      try { nextStageBtn.classList.add('btn-anim'); } catch (e) {}
    });
  }

  // Ensure Next and Reset clear any pending auto-stop timers so we don't race
  try {
    if (nextStageBtn) nextStageBtn.addEventListener('click', () => { try { clearAutoStop(); setActiveStageLogo(false); } catch (e) {} });
  } catch (e) {}
  try {
    if (resetCourseBtn) resetCourseBtn.addEventListener('click', () => { try { clearAutoStop(); setActiveStageLogo(false); } catch (e) {} });
  } catch (e) {}

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
  // stopBtn removed from UI; no animation to clear
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Stage finished naturally — timer no longer active
      try { isTimerActive = false; } catch (e) {}
      // Stop pulsing should stop; allow Next to pulse so user can advance
      try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
      // After natural finish, Start should be disabled to avoid accidental extra time.
      // We will keep listening for a short grace period and then stop automatically.
      try { setStartStopEnabled(false, false); } catch (e) {}
      // schedule an automatic stop of listening 2s after the time-up beep
      try {
        clearAutoStop();
        // show the active-stage logo during this window
        setActiveStageLogo(true);
        // After the time-up beep we keep listening for trailing shots for
        // 2000ms, show a red post-finish countdown on the main display, then
        // stop listening and restore the logo/display.
        const now = performance.now();
        postStopEndAt = now + 2000;
        // Save current display text and mark as post-finish (red)
        try {
          const displayEl = document.getElementById('display');
          if (displayEl) {
            savedDisplayText = displayEl.textContent;
            displayEl.classList.add('postfinish');
          }
        } catch (e) {}
        // Update the visible countdown every 100ms for smoothness
        try {
          postStopInterval = setInterval(() => {
            try {
              const rem = Math.max(0, Math.round(postStopEndAt - performance.now()));
              const displayEl = document.getElementById('display');
              if (displayEl) displayEl.textContent = formatTime(rem);
            } catch (e) {}
          }, 100);
        } catch (e) {}
        autoStopTimer = setTimeout(() => {
          try { stopTimer(); } catch (e) { console.warn('autoStop: stopTimer failed', e); }
          try { stopListening(); } catch (e) { console.warn('autoStop: stopListening failed', e); }
          try { stopMic(); } catch (e) { console.warn('autoStop: stopMic failed', e); }
          try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
          try { canRepeatStage = true; } catch (e) {}
          // timerStopped handler will clear the post-finish UI and restore logo
          autoStopTimer = null;
        }, 2000);
      } catch (e) { console.warn('Failed to schedule auto-stop', e); }
  // Allow repeating the stage (user may click Start to repeat)
  try { /* canRepeatStage set after auto-stop */ } catch (e) {}
  });

  // When a stage starts, animate only Stop; remove Start animation
  document.addEventListener('stageStarted', () => {
    try { if (startBtn) { startBtn.classList.remove('btn-anim'); startBtn.classList.remove('running'); } } catch (e) {}
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Timer is active now
      try { isTimerActive = true; } catch (e) {}
      // Keep Stop pulsing until user clicks it
      // old Stop animation removed
      // Disable Next while timer is active
      try { setNextEnabled(false); setNextPulse(false); } catch (e) {}
      // While the timer is running, Start must be disabled to prevent adding time;
      // stopping early is handled automatically by the auto-stop flow.
      try { setStartStopEnabled(false, false); } catch (e) {}
      // swap to active logo as soon as the stage begins (first beep)
      try { setActiveStageLogo(true); } catch (e) {}
  });

  // When the timer is stopped (auto-stop or external), clear the active animations
  document.addEventListener('timerStopped', () => {
    try { if (startBtn) startBtn.classList.remove('btn-anim'); } catch (e) {}
    try { if (nextStageBtn) nextStageBtn.classList.remove('btn-anim'); } catch (e) {}
    try { updateStageButtonState(); } catch (e) {}
      // Timer was stopped externally — ensure active flag cleared and Next is available
      try { isTimerActive = false; } catch (e) {}
      try { setNextEnabled(true); setNextPulse(true); } catch (e) {}
      // Clear any pending auto-stop and restore logos immediately
      try { clearAutoStop(); setActiveStageLogo(false); } catch (e) {}
    try {
      // If no course/stage selected, allow Start to be enabled; otherwise
      // keep Start disabled until user interaction sets state.
      const courseSel = document.getElementById('courseSelect');
      const stageSel = document.getElementById('stageSelect');
      if (!courseSel || !stageSel || !courseSel.value) {
        setStartStopEnabled(true, false);
      } else {
        setStartStopEnabled(false, false);
      }
    } catch (e) {}
    try { canRepeatStage = true; } catch (e) {}
  });
  if (resetCourseBtn) resetCourseBtn.addEventListener('click', () => { clearPendingStart(); if (typeof onNewParticipant === 'function') onNewParticipant(); });
    if (calibrateBtn) calibrateBtn.addEventListener('click', () => { clearPendingStart(); if (typeof onCalibrate === 'function') onCalibrate(); });

    if (listenBtn) listenBtn.addEventListener('click', async () => { if (listenBtn.textContent === 'Listen') await startListening(); else stopListening(); });
  if (detectBtn) detectBtn.addEventListener('click', async () => { 
    try {
      __autoDeviceAllowed = true;
      await populateDeviceLists();
      // After device enumeration attempt to prime audio so Start/Listen are snappy.
      let primed = false;
      try {
        await initMic();
        await ensureAudioRunning();
        primed = true;
      } catch (err) {
        primed = false;
        console.warn('Detect: audio priming failed', err);
      }
      if (primed) {
        try { setStatus('Audio primed', 'success'); scheduleClear(5000); } catch (e) {}
      } else {
        try { setStatus('Audio priming failed (try Listen)', 'error'); scheduleClear(3000); } catch (e) {}
      }
    } catch (e) { console.warn('Detect click failed', e); }
  });
  if (detectBtn) detectBtn.addEventListener('click', () => console.debug('Detect button clicked; user allowed auto-detection')); 

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
    // Clean up on page unload to avoid dangling timers/animation frames when navigating away
    try { window.addEventListener('beforeunload', () => { try { clearPendingStart(); stopListening(); } catch (e) {} }); } catch (e) {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
}


export function setUiTotalSecondsUI(v) {
  const el = document.getElementById('totalSecInput');
  if (!el) return;
  el.value = String(v);
  try { setTotalSeconds(Number(v)); } catch (e) { /* ignore */ }
}

export function setUiExpectedShotsUI(v) {
  const el = document.getElementById('shotsCountInput');
  if (!el) return;
  el.value = String(v);
  try { setExpectedShots(Number(v)); } catch (e) { /* ignore */ }
}
