// js/ui/status.js
// Centralized status notification helper. Ensures only one hide timer is active
// at a time so messages don't get hidden prematurely when new messages appear.
const FADE_MS = 240; // match CSS transition duration
let hideTimer = null;
let fadeTimer = null;

// Show the status message with a short fade-in. When hiding, perform a fade-out
// then add the global .hidden class (which uses display:none) after the fade
// completes so the transition is visible.
export function showStatus(message, ms = 3000) {
  const el = document.getElementById('status');
  if (!el) return;
  // clear any pending timers
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

  // Ensure element is in the layout (remove hidden which sets display:none)
  el.classList.remove('hidden');
  // force reflow so that the following class addition triggers transition
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;
  el.textContent = String(message);
  el.classList.add('status-visible');

  if (ms > 0) {
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // start fade-out
      el.classList.remove('status-visible');
      // after fade completes, remove from layout
      fadeTimer = setTimeout(() => { el.classList.add('hidden'); fadeTimer = null; }, FADE_MS);
    }, ms);
  }
}

export function hideStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  // trigger fade-out then hide after transition
  el.classList.remove('status-visible');
  fadeTimer = setTimeout(() => { el.classList.add('hidden'); fadeTimer = null; }, FADE_MS);
}
