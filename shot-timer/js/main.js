// js/main.js
import { initControls } from './ui/controls.js';
import { initAudio } from './audio/context.js';
import { startTimer, resetTimer, handleShot, calibrateLatency } from './timer/core.js';
import { setShotCallback } from './audio/detector.js';
import { initCourseChooser } from './ui/courseChooser.js';
import { showStatus } from './ui/status.js';
import { clearParticipantShots } from './timer/core.js';

// ---------------------------------------------------------------------
// Wire everything together once the DOM is ready
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // 1️⃣ Initialise audio (creates AudioContext, selects output device)
  await initAudio();

  // 2️⃣ Register the *shot* callback – the detector will call us
  //    whenever the microphone RMS exceeds the user‑defined threshold.
  // Pass the core's exported handler directly.
  setShotCallback(handleShot);

  // 3️⃣ Initialise UI controls (buttons, sliders, etc.)
  initControls({
  onStart:   () => startTimer(),
    onCalibrate: () => calibrateLatency(),
    onNewParticipant: () => {
      // Prompt to avoid accidental resets
  const ok = confirm('Reset course for the next shooter? This will clear shot memory for the entire course and reset to the first stage. Proceed?');
      if (!ok) return;

      // Clear stored participant shots and reset UI for a new participant
      try { clearParticipantShots(); } catch (e) { console.warn('Failed to clear participant shots', e); }
      // Reset the timer state for the next participant (keeps UI inputs)
      try { resetTimer(); } catch (e) { /* ignore */ }
      // Ensure the UI is reset for the currently selected course only.
      // If no course is selected, leave selection unchanged. If a course is
      // selected, reset that course's stage selection to stage 1 (first stage).
      let didResetStage = false;
      try {
        const courseSelect = document.getElementById('courseSelect');
        const stageSelect = document.getElementById('stageSelect');
        if (courseSelect && courseSelect.value && stageSelect) {
          const firstStage = Array.from(stageSelect.options).find(o => o.value);
          if (firstStage) {
            stageSelect.value = firstStage.value;
            stageSelect.dispatchEvent(new Event('change', { bubbles: true }));
            didResetStage = true;
          }
        }
      } catch (e) { console.warn('Failed to reset stage selection for Reset Course', e); }

      if (didResetStage) showStatus('Course reset for next shooter — stage reset to 1', 2000);
    }
  });

  // 4️⃣ Course chooser
  initCourseChooser();

  // Ensure the three primary action buttons are pixel‑aligned: sometimes fonts
  // or rendering cause tiny height differences. Sync heights after fonts
  // settle and on window resize.
  function syncActionButtonSizes() {
  // Order: Start, Stop, Next (Stop sits between Start and Next)
  const ids = ['startBtn', 'stopBtn', 'nextStageBtn'];
    const els = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (els.length < 2) return;
    // reset any inline height we previously set
    els.forEach(e => e.style.height = '');
    // compute the max rendered height and apply it to all three
    const heights = els.map(e => Math.ceil(e.getBoundingClientRect().height));
    const max = Math.max(...heights);
    els.forEach(e => e.style.height = max + 'px');
  }

  // Run shortly after load (fonts may influence sizes), and on resize.
  setTimeout(syncActionButtonSizes, 120);
  window.addEventListener('resize', () => { setTimeout(syncActionButtonSizes, 30); });
  // Some mobile browsers change metrics on orientation; add a handler and a
  // longer delayed sync for slow rendering/fonts.
  window.addEventListener('orientationchange', () => { setTimeout(syncActionButtonSizes, 200); setTimeout(syncActionButtonSizes, 600); });
  setTimeout(syncActionButtonSizes, 400);
});
