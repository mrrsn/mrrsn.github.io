// js/ui/courseChooser.js
import { setUiTotalSecondsUI, setUiExpectedShotsUI } from './controls.js';
import { getShotLog, exportShotsCsv, archiveStageShots, exportParticipantCsv, clearParticipantShots, resetTimer, setStageContext, getStageAttemptLabel } from '../timer/core.js';
import { showStatus } from './status.js';

let courses = [];

// Helper: append multiline text to an element as separate <p> nodes so newlines are visible.
function appendMultilineAsParagraphs(el, text) {
  if (!el) return;
  // allow either a single string or already-multiline input
  const lines = String(text || '').split('\n');
  lines.forEach(line => {
    const p = document.createElement('p');
    p.textContent = line;
    el.appendChild(p);
  });
}

export async function initCourseChooser() {
  console.debug('initCourseChooser: start');
  // For now we only expect a single course file; load the folder listing would be future work
  try {
    console.debug('initCourseChooser: about to fetch course JSON');
    // Use AbortController to avoid hanging forever on a stalled fetch.
    const controller = new AbortController();
    const timeoutMs = 5000; // 5s timeout
    const to = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch('./data/courses/fbi-pistol-qualification.json', { signal: controller.signal });
    } finally {
      clearTimeout(to);
    }
    if (!res || !res.ok) throw new Error('Could not fetch course JSON');
    const json = await res.json();
    courses = [json];
    console.debug('initCourseChooser: fetched and parsed course JSON', json && json.id ? json.id : '(no id)');
  } catch (e) {
    console.warn('courseChooser: failed to load courses:', e);
    try { showStatus('Failed to load course data. Check that ./data/courses is accessible.', 'error'); } catch (err) {}
    return;
  }

  const courseSelect = document.getElementById('courseSelect');
  const stageSelect = document.getElementById('stageSelect');
  if (!courseSelect || !stageSelect) return;

  // Helper to apply a stage (used by the stage select and Next button)
  function applyStage(course, stage) {
    setUiTotalSecondsUI(stage.timeSec);
    setUiExpectedShotsUI(stage.shots);
    // Inform timer/core of the current stage context so attempts can be tracked
    try { setStageContext({ courseId: course.id, courseName: course.name, stageId: stage.id }); } catch (e) {}
  // Stage instructions already display current stage; no popup needed.
    // Populate the large instruction area with separate lines:
    // 1) Stage title (Stage N)
    // 2) "{yards} yards from {startPosition}"
    // 3) Details/notes
    const titleEl = document.getElementById('stageTitle');
    const metaEl = document.getElementById('stageMeta');
    const detailsEl = document.getElementById('stageDetails');
    if (titleEl) titleEl.textContent = `Stage ${stage.id}`;
    // Yards/meta line should show only distance; start position will be appended to rounds line.
    if (metaEl) {
      const yards = (stage.distanceYards !== undefined) ? stage.distanceYards : (stage.distance || null);
      let metaText = '';
      if (yards !== null && yards !== undefined && yards !== '') {
        const yardsNum = Number(yards);
        metaText = !Number.isNaN(yardsNum) ? `${yardsNum} yard${yardsNum === 1 ? '' : 's'}` : String(yards);
      }
      metaEl.textContent = metaText;
    }
    // Rounds/time line (e.g., "8 rounds in 8 seconds from Ready")
    const roundsEl = document.getElementById('stageRounds');
    if (roundsEl) {
      const shots = stage.shots != null ? stage.shots : '';
      const time = stage.timeSec != null ? stage.timeSec : '';
      const start = stage.startPosition || stage.start || '';
      let roundsText = '';
      if (shots && time) roundsText = `${shots} round${shots === 1 ? '' : 's'} in ${time} second${time === 1 ? '' : 's'}`;
      else if (shots) roundsText = `${shots} round${shots === 1 ? '' : 's'}`;
      else if (time) roundsText = `${time} second${time === 1 ? '' : 's'}`;
      if (roundsText && start) roundsText = `${roundsText} from ${start}`;
      roundsEl.textContent = roundsText;
    }
    if (detailsEl) {
      // Clear previous details and render stage notes as paragraphs so newlines show.
      detailsEl.innerHTML = '';
      if (stage.notes) appendMultilineAsParagraphs(detailsEl, stage.notes);
      // (No course-level scoring injected here; scoring is shown via the Scoring pseudo-stage.)
    }
  // Reset next button label (in case it was changed to Save previously)
  const nextBtnEl = document.getElementById('nextStageBtn');
  if (nextBtnEl) nextBtnEl.textContent = 'Next';
  }

  // Helper to apply course-level scoring instructions as a pseudo-stage
  function applyScoring(course) {
    const titleEl = document.getElementById('stageTitle');
    const metaEl = document.getElementById('stageMeta');
    const roundsEl = document.getElementById('stageRounds');
    const detailsEl = document.getElementById('stageDetails');
    if (titleEl) titleEl.textContent = 'Scoring Instructions';
    if (metaEl) metaEl.textContent = '';
    if (roundsEl) roundsEl.textContent = '';
    if (detailsEl) {
      detailsEl.innerHTML = '';
      // Build scoring lines from structured data (scoreRules must be an array of strings).
      try {
        const lines = [];
        if (Array.isArray(course.scoreRules)) {
          course.scoreRules.forEach(r => { if (r) lines.push(String(r)); });
        }

  // Totals: use roundCount and top-level totalTimeSec.
  const totalShots = course.roundCount || '';
  const totalTime = course.totalTimeSec || '';
        if (totalShots !== '') appendMultilineAsParagraphs(detailsEl, `Total shots: ${totalShots}`);
        if (totalTime !== '') appendMultilineAsParagraphs(detailsEl, `Total time: ${totalTime}s`);

        // Append rules (if any)
        lines.forEach(l => appendMultilineAsParagraphs(detailsEl, l));
      } catch (e) { /* ignore */ }
    }
    const nextBtn = document.getElementById('nextStageBtn'); if (nextBtn) nextBtn.textContent = 'Next';
  }

  // populate courseSelect
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    courseSelect.appendChild(opt);
  });

  courseSelect.addEventListener('change', () => {
    console.debug('courseSelect: change ->', courseSelect.value);
    const sel = courseSelect.value;
    const course = courses.find(c => c.id === sel);
    // clear stages
    stageSelect.innerHTML = '<option value="">(select a stage)</option>';
    const notesEl = document.getElementById('courseNotes');
    if (!course) {
      if (notesEl) notesEl.textContent = 'Select a course to see course notes.';
      return;
    }
    // populate a pseudo-stage for scoring instructions first, then real stages
    const scoreOpt = document.createElement('option');
    scoreOpt.value = 'scoring';
    scoreOpt.textContent = 'Scoring Instructions';
    stageSelect.appendChild(scoreOpt);
    // populate stages
    course.stages.forEach(s => {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = `Stage ${s.id}: ${s.shots} shots, ${s.timeSec}s`;
      stageSelect.appendChild(opt);
    });
    // populate course notes
    if (notesEl) notesEl.textContent = course.notes || '';
  // default to showing scoring instructions first
  stageSelect.value = 'scoring';
  // ensure controls respond to this programmatic change
  try { stageSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  applyScoring(course);
  });

  // Auto-apply when the user selects a stage
  stageSelect.addEventListener('change', () => {
    console.debug('stageSelect: change ->', stageSelect.value);
    const courseId = courseSelect.value;
    const sel = stageSelect.value;
    const course = courses.find(c => c.id === courseId);
    if (!course) return;
    if (sel === 'scoring') {
      applyScoring(course);
      return;
    }
    const stageId = Number(sel);
    const stage = course.stages.find(s => s.id === stageId);
    if (!stage) return;
    applyStage(course, stage);
  });

  // Next stage button: advance the stage select and apply
  // The controls module may detach/restore the Next button from the DOM during
  // initialization. To handle that reliably we provide an initializer that will
  // wire the button if present, or watch for it to be inserted and wire then.
  function nextButtonHandler(evt) {
    // evt may be a DOM event; handler should read current DOM state each time
    const nextBtnEl = (evt && evt.currentTarget) ? evt.currentTarget : document.getElementById('nextStageBtn');
    const courseId = courseSelect.value;
    const course = courses.find(c => c.id === courseId);
    if (!course || !course.stages || course.stages.length === 0) return;
    // If button is currently 'Save', export CSV
    if (nextBtnEl && nextBtnEl.textContent === 'Save') {
      try {
        archiveStageShots({ courseId: course.id, courseName: course.name, stageId: getStageAttemptLabel({ courseId: course.id, stageId: Number(stageSelect.value) || null }) || null });
      } catch (e) { console.warn('archiveStageShots failed during Save', e); }
      const name = prompt('Enter filename (without extension) for participant CSV export', 'participant-results');
      if (!name) return;
      try {
        const csv = exportParticipantCsv();
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) { console.error('Failed to export participant CSV', e); alert('Export failed: ' + String(e)); }
      return;
    }

    const sel = stageSelect.value;
    // If currently viewing scoring instructions, advance to first real stage
    if (sel === 'scoring') {
      if (course.stages && course.stages.length > 0) {
        const first = course.stages[0];
        stageSelect.value = String(first.id);
        try { stageSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        applyStage(course, first);
      }
      return;
    }

    const current = Number(sel) || 0;
    // find index of current stage in course.stages
    const idx = course.stages.findIndex(s => s.id === current);
    // If we're on the last stage, pressing Next should show scoring instructions and then turn Next->Save
    if (idx === course.stages.length - 1) {
      try { archiveStageShots({ courseId: course.id, courseName: course.name, stageId: getStageAttemptLabel({ courseId: course.id, stageId: Number(stageSelect.value) || null }) || null }); } catch (e) { console.warn('archiveStageShots failed', e); }
      try { resetTimer(); } catch (e) { console.warn('resetTimer failed', e); }
  stageSelect.value = 'scoring';
  try { stageSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  applyScoring(course);
      const nextBtnEl2 = document.getElementById('nextStageBtn'); if (nextBtnEl2) nextBtnEl2.textContent = 'Save';
      return;
    }

    const nextIdx = (idx + 1) % course.stages.length;
    const nextStage = course.stages[nextIdx];
    try { archiveStageShots({ courseId: course.id, courseName: course.name, stageId: getStageAttemptLabel({ courseId: course.id, stageId: Number(stageSelect.value) || null }) || null }); } catch (e) { console.warn('archiveStageShots failed', e); }
    try { resetTimer(); } catch (e) { console.warn('resetTimer failed', e); }
  stageSelect.value = String(nextStage.id);
  try { stageSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  applyStage(course, nextStage);
  }

  function initNextButtonEl(el) {
    if (!el) return;
    // ensure label defaults to Next
    try { if (!el.textContent || !el.textContent.trim()) el.textContent = 'Next'; } catch (e) {}
    // Avoid duplicating handlers by removing any existing nextButtonHandler reference
    try { el.removeEventListener('click', nextButtonHandler); } catch (e) {}
    el.addEventListener('click', nextButtonHandler);
    // Observe text changes so we can react to Save state
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        try {
          const txt = (el.textContent || '').trim();
          if (txt === 'Save') {
            try { setStartStopEnabled(false, false); } catch (e) {}
            try { /* pulse Save visually via controls' helpers */ } catch (e) {}
          } else {
            try { /* restore regular state if needed */ } catch (e) {}
          }
        } catch (e) { /* ignore */ }
      });
      mo.observe(el, { characterData: true, childList: true, subtree: true });
    }
  }

  // Wire immediately if present, otherwise watch for the button to be inserted
  const existingNext = document.getElementById('nextStageBtn');
  if (existingNext) initNextButtonEl(existingNext);
  else if (typeof MutationObserver !== 'undefined') {
    const bodyObserver = new MutationObserver((records, obs) => {
      const el = document.getElementById('nextStageBtn');
      if (el) { initNextButtonEl(el); obs.disconnect(); }
    });
    try { bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
  } else {
    // Fallback: poll for the element for a short period
    const poll = setInterval(() => { const el = document.getElementById('nextStageBtn'); if (el) { clearInterval(poll); initNextButtonEl(el); } }, 250);
    setTimeout(() => clearInterval(poll), 5000);
  }

  // When the stage finishes, if this is the last stage of the course change Next -> Save
  document.addEventListener('stageFinished', (ev) => {
    const courseId = courseSelect.value;
    const course = courses.find(c => c.id === courseId);
    if (!course) return;
    const current = Number(stageSelect.value) || 0;
    const idx = course.stages.findIndex(s => s.id === current);
    if (idx === course.stages.length - 1) {
      const nextBtnEl = document.getElementById('nextStageBtn');
      if (nextBtnEl) nextBtnEl.textContent = 'Save';
      // After the final stage, show scoring instructions in the details area
      try {
        const detailsEl = document.getElementById('stageDetails');
        if (detailsEl && course) {
          applyScoring(course);
        }
      } catch (e) { /* ignore */ }
    }
  });
}
