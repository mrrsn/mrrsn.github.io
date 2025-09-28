// js/ui/courseChooser.js
import { setUiTotalSecondsUI, setUiExpectedShotsUI } from './controls.js';
import { getShotLog, exportShotsCsv, archiveStageShots, exportParticipantCsv, clearParticipantShots, resetTimer } from '../timer/core.js';

let courses = [];

export async function initCourseChooser() {
  // For now we only expect a single course file; load the folder listing would be future work
  try {
    const res = await fetch('./data/courses/fbi-pistol-qualification.json');
    if (!res.ok) throw new Error('Could not fetch course JSON');
    const json = await res.json();
    courses = [json];
  } catch (e) {
    console.warn('courseChooser: failed to load courses:', e);
    return;
  }

  const courseSelect = document.getElementById('courseSelect');
  const stageSelect = document.getElementById('stageSelect');
  if (!courseSelect || !stageSelect) return;

  // Helper to apply a stage (used by the stage select and Next button)
  function applyStage(course, stage) {
    setUiTotalSecondsUI(stage.timeSec);
    setUiExpectedShotsUI(stage.shots);
    const status = document.getElementById('status');
    if (status) {
      status.classList.remove('hidden');
      status.textContent = `Applied ${course.name} — Stage ${stage.id}: ${stage.shots} shots in ${stage.timeSec}s`;
      setTimeout(() => { status.classList.add('hidden'); }, 3000);
    }
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
    if (detailsEl) detailsEl.textContent = stage.notes || '';
    // Reset next button label (in case it was changed to Save previously)
    const nextBtnEl = document.getElementById('nextStageBtn');
    if (nextBtnEl) nextBtnEl.textContent = 'Next Stage in Course';
  }

  // populate courseSelect
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    courseSelect.appendChild(opt);
  });

  courseSelect.addEventListener('change', () => {
    const sel = courseSelect.value;
    const course = courses.find(c => c.id === sel);
    // clear stages
    stageSelect.innerHTML = '<option value="">(select a stage)</option>';
    const notesEl = document.getElementById('courseNotes');
    if (!course) {
      if (notesEl) notesEl.textContent = 'Select a course to see course notes.';
      return;
    }
    // populate stages
    course.stages.forEach(s => {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = `Stage ${s.id}: ${s.shots} shots, ${s.timeSec}s`;
      stageSelect.appendChild(opt);
    });
    // populate course notes
    if (notesEl) notesEl.textContent = course.notes || '';
    // auto-select first stage and apply it
    if (course.stages && course.stages.length > 0) {
      const first = course.stages[0];
      stageSelect.value = String(first.id);
      applyStage(course, first);
    }
  });

  // Auto-apply when the user selects a stage
  stageSelect.addEventListener('change', () => {
    const courseId = courseSelect.value;
    const stageId = Number(stageSelect.value);
    const course = courses.find(c => c.id === courseId);
    if (!course) return;
    const stage = course.stages.find(s => s.id === stageId);
    if (!stage) return;
    applyStage(course, stage);
  });

  // Next stage button: advance the stage select and apply
  const nextBtn = document.getElementById('nextStageBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const courseId = courseSelect.value;
      const course = courses.find(c => c.id === courseId);
      if (!course || !course.stages || course.stages.length === 0) return;
      // If button is currently 'Save', export CSV
      if (nextBtn.textContent === 'Save') {
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
        } catch (e) {
          console.error('Failed to export participant CSV', e);
          alert('Export failed: ' + String(e));
        }
        return;
      }

      const current = Number(stageSelect.value) || 0;
      // find index of current stage in course.stages
      const idx = course.stages.findIndex(s => s.id === current);
      const nextIdx = (idx + 1) % course.stages.length;
      const nextStage = course.stages[nextIdx];
  // before advancing archive current stage shots into participant store
      try {
        archiveStageShots({ courseId: course.id, courseName: course.name, stageId: Number(stageSelect.value) || null });
      } catch (e) {
        console.warn('archiveStageShots failed', e);
      }
      // Reset the timer state (clear current stage shots/display) before applying the next stage
      try { resetTimer(); } catch (e) { console.warn('resetTimer failed', e); }
  // update select and apply
  stageSelect.value = String(nextStage.id);
  // trigger apply
  applyStage(course, nextStage);
    });
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
    }
  });
}
