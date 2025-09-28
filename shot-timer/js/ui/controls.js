// controls.js — clean single implementation
import { setTotalSeconds, setExpectedShots, setThreshold, setDebounceMs, setBeepOnShot, getBeepOnShot } from '../timer/config.js';
import { setOutputDevice, getAudioContext, supportsSetSinkId } from '../audio/context.js';
import { pollDetector, setListenMode } from '../audio/detector.js';
import { setRmsColumnVisible } from './shotsTable.js';

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
  devices.forEach(d => { const opt = document.createElement('option'); opt.value = d.deviceId || ''; opt.textContent = d.label || `${d.kind} (${(d.deviceId||'').slice(0,8)})`; if (d.kind === 'audioinput') micSelect.appendChild(opt); if (d.kind === 'audiooutput') spkSelect.appendChild(opt); });
  if (micSelect.options.length === 0) { const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'No microphones found'; micSelect.appendChild(opt); }
  if (spkSelect.options.length === 0) { const opt = document.createElement('option'); opt.disabled = true; opt.textContent = 'No speakers found'; spkSelect.appendChild(opt); }
  // If setSinkId is not supported (iOS Safari, etc.) disable the speaker selector and show a help tip
  try {
    if (!supportsSetSinkId()) {
      spkSelect.disabled = true;
      const tip = document.createElement('div');
      tip.id = 'speakerTip';
      tip.className = 'input-hint';
      tip.textContent = 'Speaker selection is not supported by this browser. To change output on your device use the system audio controls (Control Center for iPhone: tap the audio output icon to pick Speaker or your Bluetooth device).';
      spkSelect.parentNode && spkSelect.parentNode.appendChild(tip);
    }
  } catch (e) { /* ignore */ }
  if (prevMic) micSelect.value = prevMic; if (prevSpk) spkSelect.value = prevSpk; if (statusEl) { setStatus(`Found ${micSelect.options.length} mic(s) and ${spkSelect.options.length} speaker(s)`, 'success'); setTimeout(clearStatus, 3000); }
}

export function initControls({ onStart = () => {}, onReset = () => {}, onCalibrate = () => {}, onNewParticipant = () => {} } = {}) {
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

    if (!isMobilePlatform) {
      (async () => { try { await populateDeviceLists(); } catch (e) { console.warn('Auto device detection failed:', e); } })();
    } else {
      // On mobile, hide device selectors and the Detect button to avoid intrusive permission prompts
      try {
        const detectBtnEl = document.getElementById('detectBtn'); if (detectBtnEl) detectBtnEl.style.display = 'none';
        const micSel = document.getElementById('micSelect'); if (micSel && micSel.parentNode) micSel.parentNode.style.display = 'none';
        const spkSel = document.getElementById('speakerSelect'); if (spkSel && spkSel.parentNode) spkSel.parentNode.style.display = 'none';
        // Add a small note explaining device selection is handled by the system on mobile
        const devicesSection = document.getElementById('devices');
        if (devicesSection) {
          const note = document.createElement('div');
          note.className = 'system-output-note input-hint';
          note.textContent = 'Device detection disabled on mobile. Use your system audio controls to pick microphone or speaker.';
          devicesSection.appendChild(note);
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
      setStatus('Listening (live) — clap to test (no shots will be recorded)', 'success');
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

    function stopListening() { if (!listenRaf) return; cancelAnimationFrame(listenRaf); listenRaf = null; if (listenBtn) listenBtn.textContent = 'Listen'; try { setListenMode(false); } catch (e) { console.warn('Could not clear Listen mode', e); } clearStatus(); }

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
  const resetBtn = $('#resetBtn');
    const calibrateBtn = $('#calibrateBtn');
    const detectBtn = $('#detectBtn');
    const resetCourseBtn = $('#resetCourseBtn');
  
  if (startBtn) startBtn.addEventListener('click', async () => { try { stopListening(); setListenMode(false); } catch (err) {} if (typeof onStart === 'function') onStart(); });
    if (resetBtn) resetBtn.addEventListener('click', () => { if (typeof onReset === 'function') onReset(); });
    if (resetCourseBtn) resetCourseBtn.addEventListener('click', () => { if (typeof onNewParticipant === 'function') onNewParticipant(); });
    if (calibrateBtn) calibrateBtn.addEventListener('click', () => { if (typeof onCalibrate === 'function') onCalibrate(); });

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
