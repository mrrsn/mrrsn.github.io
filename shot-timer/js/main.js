// js/main.js
import { initControls } from './ui/controls.js';
import { initAudio } from './audio/context.js';
import { startTimer, resetTimer, handleShot, calibrateLatency } from './timer/core.js';
import { setShotCallback } from './audio/detector.js';
import { initCourseChooser } from './ui/courseChooser.js';
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
  onReset:   () => resetTimer(),
    onCalibrate: () => calibrateLatency(),
    onNewParticipant: () => {
      // Prompt to avoid accidental resets
      const ok = confirm('Start a new participant? This will clear current participant shots and reset the current stage to the first stage. Proceed?');
      if (!ok) return;

      // Clear stored participant shots and reset UI for a new participant
      try { clearParticipantShots(); } catch (e) { console.warn('Failed to clear participant shots', e); }
      // Reset the timer state for the next participant (keeps UI inputs)
      try { resetTimer(); } catch (e) { /* ignore */ }
      // Ensure the UI is set to the first stage of the currently selected course (or pick the first course)
      try {
        const courseSelect = document.getElementById('courseSelect');
        if (courseSelect) {
          if (!courseSelect.value) {
            const firstCourse = Array.from(courseSelect.options).find(o => o.value);
            if (firstCourse) {
              courseSelect.value = firstCourse.value;
              courseSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }
        const stageSelect = document.getElementById('stageSelect');
        if (stageSelect) {
          const firstStage = Array.from(stageSelect.options).find(o => o.value);
          if (firstStage) {
            stageSelect.value = firstStage.value;
            stageSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } catch (e) { console.warn('Failed to reset stage selection for new participant', e); }

      const status = document.getElementById('status');
      if (status) { status.classList.remove('hidden'); status.textContent = 'New participant started — stage reset to 1'; setTimeout(() => status.classList.add('hidden'), 2000); }
    }
  });

  // 4️⃣ Course chooser
  initCourseChooser();
});
