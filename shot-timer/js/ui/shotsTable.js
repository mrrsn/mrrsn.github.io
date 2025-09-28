// js/ui/shotsTable.js
import { formatTime } from '../timer/utils.js';
import { getExpectedShots, getTotalSeconds } from '../timer/config.js';

export function addShotRow(idx, deltaMs, elapsedMs, timestampMs, rms = null) {
  const table = document.getElementById('shotsTable');
  let tbody = table ? table.querySelector('tbody') : null;

  // Diagnostic logging to help understand why the table might be missing
  if (!table) {
    console.debug('addShotRow diagnostic: #shotsTable not found in DOM. document.readyState=', document.readyState);
  } else if (!tbody) {
    console.debug('addShotRow diagnostic: #shotsTable found but tbody missing. table children=', table.children.length);
  }

  // If table is missing, try to create a visible placeholder inside #shotsPanel
  if (!table) {
    const panel = document.getElementById('shotsPanel');
    if (panel) {
      console.warn('addShotRow: #shotsTable missing — creating placeholder table inside #shotsPanel');
      const newTable = document.createElement('table');
      newTable.id = 'shotsTable';
      newTable.innerHTML = `
        <thead>
          <tr>
            <th>#</th>
            <th>Stage</th>
            <th>Time</th>
            <th>Δ (ms)</th>
            <th>RMS</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      panel.appendChild(newTable);
      tbody = newTable.querySelector('tbody');
    }
  }

  // If table exists but tbody was missing, create one and append
  if (table && !tbody) {
    tbody = document.createElement('tbody');
    table.appendChild(tbody);
  }

  if (!tbody) {
    console.warn('addShotRow: #shotsTable tbody not found; cannot append row');
    return;
  }
  const row = document.createElement('tr');

  const formatted = formatTime(elapsedMs);
  // delta shown with 1 decimal ms precision
  const deltaStr = (typeof deltaMs === 'number') ? deltaMs.toFixed(1) : '';
  const elapsedStr = (typeof elapsedMs === 'number') ? elapsedMs.toFixed(1) : '';
  row.innerHTML = `
    <td>${idx + 1}</td>
    <td>Shot ${idx + 1} of ${getExpectedShots()}</td>
    <td>${formatted}</td>
    <td>${deltaStr}</td>
    <td>${(typeof rms === 'number') ? rms.toFixed(2) : ''}</td>
  `;

  // Highlight if this shot is after the total stage time or beyond expected count
  try {
    const stageMs = getTotalSeconds() * 1000;
    if (typeof elapsedMs === 'number' && elapsedMs > stageMs) {
      row.classList.add('late');
    }
  } catch (e) {
    // ignore
  }
  if (idx + 1 > getExpectedShots()) {
    row.classList.add('over-count');
  }
  tbody.appendChild(row);
  // update simple summary
  const summary = document.getElementById('shotsSummaryCount');
  if (summary) summary.textContent = String(tbody.children.length);
}

export function clearShotsTable() {
  const tbody = document.querySelector('#shotsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const summary = document.getElementById('shotsSummaryCount');
  if (summary) summary.textContent = '0';
}

// Show or hide the RMS column by toggling a class on the table.
export function setRmsColumnVisible(visible) {
  const table = document.getElementById('shotsTable');
  if (!table) return;
  if (visible) table.classList.remove('hide-rms');
  else table.classList.add('hide-rms');
}

// Initialize default: hide RMS column initially so the checkbox default is unchecked.
try { setRmsColumnVisible(false); } catch (e) { /* ignore during load */ }
