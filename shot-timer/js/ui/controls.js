// controls.js — clean single implementation
import { setTotalSeconds, setExpectedShots, setThreshold, setDebounceMs, setBeepOnShot, getBeepOnShot } from '../timer/config.js';
import { setOutputDevice, getAudioContext } from '../audio/context.js';
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
  if (prevMic) micSelect.value = prevMic; if (prevSpk) spkSelect.value = prevSpk; if (statusEl) { setStatus(`Found ${micSelect.options.length} mic(s) and ${spkSelect.options.length} speaker(s)`, 'success'); setTimeout(clearStatus, 3000); }
}

export function initControls({ onStart = () => {}, onReset = () => {}, onCalibrate = () => {}, onNewParticipant = () => {} } = {}) {
  const attach = () => {
    (async () => { try { await populateDeviceLists(); } catch (e) { console.warn('Auto device detection failed:', e); } })();

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

    // UI zoom control (persists in localStorage)
    const uiZoom = document.getElementById('uiZoom');
    const uiZoomValue = document.getElementById('uiZoomValue');
    const ZOOM_KEY = 'shot-timer-ui-zoom';
    function applyZoom(pct) {
      try {
        const root = document.documentElement;
        // base font-size of 16px scaled by percent
        const base = 16 * (pct / 100);
        root.style.fontSize = `${base}px`;
        if (uiZoomValue) uiZoomValue.textContent = `${pct}%`;
      } catch (e) { console.warn('applyZoom failed', e); }
    }
    // initialise from storage or input default
    try {
      const stored = localStorage.getItem(ZOOM_KEY);
      const v = stored ? Number(stored) : (uiZoom ? Number(uiZoom.value) : 100);
      if (uiZoom) uiZoom.value = String(v);
      applyZoom(v);
    } catch (e) { /* ignore */ }
    if (uiZoom) uiZoom.addEventListener('input', e => {
      const v = Number(e.target.value) || 100;
      applyZoom(v);
      try { localStorage.setItem(ZOOM_KEY, String(v)); } catch (err) { /* ignore */ }
    });

    // Theme toggle (dark mode) — persist as 'light' or 'dark'
    const themeToggle = document.getElementById('themeToggle');
    const THEME_KEY = 'shot-timer-theme';
    function applyTheme(t) {
      try {
        if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
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

    // Speaker select
    const speakerSelect = document.getElementById('speakerSelect');
    if (speakerSelect) speakerSelect.addEventListener('change', async e => { try { await setOutputDevice(e.target.value); setStatus(`Using output device: ${speakerSelect.selectedOptions[0]?.text || e.target.value}`, 'success'); } catch (err) { setStatus('Failed to set output device — this browser may not support setSinkId.', 'error'); } });

    // Control buttons
  const startBtn = $('#startBtn');
  const resetBtn = $('#resetBtn');
    const calibrateBtn = $('#calibrateBtn');
    const detectBtn = $('#detectBtn');
    const newParticipantBtn = $('#newParticipantBtn');

  if (startBtn) startBtn.addEventListener('click', async () => { try { stopListening(); setListenMode(false); } catch (err) {} if (typeof onStart === 'function') onStart(); });
    if (resetBtn) resetBtn.addEventListener('click', () => { if (typeof onReset === 'function') onReset(); });
    if (newParticipantBtn) newParticipantBtn.addEventListener('click', () => { if (typeof onNewParticipant === 'function') onNewParticipant(); });
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
