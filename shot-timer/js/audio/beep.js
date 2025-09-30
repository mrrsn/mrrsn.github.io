// js/audio/beep.js
import { getAudioContext, ensureAudioRunning } from './context.js';

export async function playBeep() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    // Some mobile browsers keep the audio context suspended until a
    // user gesture (or resume call). Ensure it's running to avoid
    // audible glitches on first playback.
    await ensureAudioRunning();
  } catch (e) { /* ignore */ }

  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();

  const now = ctx.currentTime;
  const startAt = now + 0.02; // schedule 20ms in future to avoid scheduling jitter
  const duration = 0.15; // seconds

  osc.frequency.value = 1200;               // 1.2 kHz tone
  gain.gain.setValueAtTime(0.0001, startAt);
  // use a short linear ramp up, then ramp down to silence for a clean tail
  gain.gain.linearRampToValueAtTime(0.5, startAt + 0.01);
  gain.gain.linearRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startAt);
  osc.stop(startAt + duration + 0.01);

  // Cleanup to avoid holding references which can sometimes cause
  // audio glitches on certain mobile browsers when nodes are reused.
  osc.addEventListener('ended', () => {
    try { osc.disconnect(); } catch (e) {}
    try { gain.disconnect(); } catch (e) {}
  });
}
