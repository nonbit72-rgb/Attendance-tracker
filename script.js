/* =============================================
   ATTEND TRACK - SCRIPT.JS  (v2)
   Changes vs v1:
   - Lecture records now include a `time` field (HH:MM)
   - Duplicate guard: same subject + date + time is blocked
   - Bar chart drawn on home page (Canvas API, no libraries)
   - DB bumped to version 2; migration adds `time` to old records
   ============================================= */

'use strict';

/* ==========================================
   CONSTANTS
   ========================================== */
const DB_NAME        = 'AttendTrackDB';
const DB_VERSION     = 2;           // bumped: adds time field
const STORE_LECTURES = 'lectures';
const STORE_IMAGES   = 'images';

const IMG_MAX_DIM    = 900;
const IMG_QUALITY    = 0.75;
const WARN_THRESHOLD = 75;          // % below which attendance is highlighted

/* Colors for up to 8 subjects */
const CHART_COLORS = [
  '#1abc9c', '#3498db', '#9b59b6', '#e67e22',
  '#e74c3c', '#2ecc71', '#f1c40f', '#00bcd4'
];

/* ==========================================
   APP STATE
   ========================================== */
const state = {
  db: null,
  lectures: [],
  editingId: null,
  deleteTargetId: null,
  selectedStatus: 'Present',
  pendingImages:    { 1: null, 2: null },
  removeImages:     { 1: false, 2: false },
  existingImageIds: { 1: null, 2: null },
  chartDirty: true,
};

/* ==========================================
   INDEXEDDB  –  version 2
   ========================================== */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db     = e.target.result;
      const oldVer = e.oldVersion;

      /* ---- Fresh install ---- */
      if (oldVer < 1) {
        const ls = db.createObjectStore(STORE_LECTURES, {
          keyPath: 'id', autoIncrement: true
        });
        ls.createIndex('date',    'date',    { unique: false });
        ls.createIndex('subject', 'subject', { unique: false });
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id', autoIncrement: true });
      }

      /* ---- Migration v1 → v2: stamp empty time on old records ---- */
      if (oldVer === 1) {
        const tx    = e.target.transaction;
        const store = tx.objectStore(STORE_LECTURES);
        store.openCursor().onsuccess = function (ce) {
          const cursor = ce.target.result;
          if (!cursor) return;
          if (cursor.value.time === undefined) {
            cursor.update({ ...cursor.value, time: '' });
          }
          cursor.continue();
        };
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* ---- Generic DB helpers ---- */

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbAdd(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbPut(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/* ==========================================
   DUPLICATE CHECK
   Same subject + date + time cannot coexist.
   excludeId: when editing, skip the record itself.
   ========================================== */
function isDuplicate(subject, date, time, excludeId) {
  return state.lectures.some(l =>
    l.id      !== excludeId &&
    l.subject === subject   &&
    l.date    === date      &&
    l.time    === time
  );
}

/* ==========================================
   IMAGE COMPRESSION
   ========================================== */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      let { width, height } = img;
      if (width > IMG_MAX_DIM || height > IMG_MAX_DIM) {
        if (width >= height) {
          height = Math.round((height / width) * IMG_MAX_DIM);
          width  = IMG_MAX_DIM;
        } else {
          width  = Math.round((width / height) * IMG_MAX_DIM);
          height = IMG_MAX_DIM;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', IMG_QUALITY
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

/* ==========================================
   DATA LOAD & CACHE
   ========================================== */
async function loadLectures() {
  state.lectures = await dbGetAll(STORE_LECTURES);
}

async function dataChanged() {
  await loadLectures();
  state.chartDirty = true;

  const active = document.querySelector('.section.active');
  if (active) {
    if (active.id === 'section-home')     renderHome();
    if (active.id === 'section-lectures') renderLectures();
  }
  refreshFilterOptions();
}

/* ==========================================
   NAVIGATION
   ========================================== */
const SECTION_LABELS = {
  home:     'Dashboard',
  add:      'Add Lecture',
  lectures: 'Lectures',
};

function navigate(page) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('section-' + page).classList.add('active');
  document.getElementById('nav-' + page).classList.add('active');
  document.getElementById('header-subtitle').textContent = SECTION_LABELS[page];

  if (page === 'home')     renderHome();
  if (page === 'lectures') renderLectures();
  if (page === 'add' && state.editingId === null) resetAddForm();
}

/* ==========================================
   HOME – PILLS + DONUT CHART + BAR CHART
   ========================================== */
function renderHome() {
  renderSummaryPills();
  if (state.chartDirty) {
    drawAttendanceChart();
    drawBarChart();
    state.chartDirty = false;
  }
  renderBunkCalc();
}

function renderSummaryPills() {
  const total   = state.lectures.length;
  const present = state.lectures.filter(l => l.status === 'Present').length;
  const absent  = total - present;

  document.getElementById('home-summary').innerHTML = `
    <div class="summary-pill pill-total">
      <span class="pill-value">${total}</span>
      <span class="pill-label">Total</span>
    </div>
    <div class="summary-pill pill-present">
      <span class="pill-value">${present}</span>
      <span class="pill-label">Present</span>
    </div>
    <div class="summary-pill pill-absent">
      <span class="pill-value">${absent}</span>
      <span class="pill-label">Absent</span>
    </div>
  `;
}

/* ---- Donut chart (unchanged from v1) ---- */
function drawAttendanceChart() {
  const canvas = document.getElementById('attendance-chart');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const outerR = Math.min(W, H) / 2 - 16;
  const innerR = outerR * 0.58;

  ctx.clearRect(0, 0, W, H);

  const statsMap = buildSubjectStats();
  const subjects = Object.keys(statsMap);
  const legendEl = document.getElementById('chart-legend');

  if (subjects.length === 0) {
    legendEl.innerHTML = `<p class="no-data-msg">No lectures yet.<br>Tap <strong>Add</strong> to start.</p>`;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = '#1e2f43';
    ctx.fill('evenodd');
    return;
  }

  let startAngle = -Math.PI / 2;
  const segSpan  = (Math.PI * 2) / subjects.length;
  const arcs     = [];

  subjects.forEach((subj, i) => {
    const s     = statsMap[subj];
    const pct   = s.total > 0 ? s.present / s.total : 0;
    const color = CHART_COLORS[i % CHART_COLORS.length];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + segSpan);
    ctx.closePath();
    ctx.fillStyle = color + '30';
    ctx.fill();

    const presentSpan = segSpan * pct;
    if (presentSpan > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, startAngle + presentSpan);
      ctx.arc(cx, cy, innerR, startAngle + presentSpan, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(startAngle + segSpan) * outerR,
               cy + Math.sin(startAngle + segSpan) * outerR);
    ctx.strokeStyle = '#0d1b2a';
    ctx.lineWidth = 2;
    ctx.stroke();

    arcs.push({ subj, s, pct, color });
    startAngle += segSpan;
  });

  /* Center label */
  const totalL  = state.lectures.length;
  const totalP  = state.lectures.filter(l => l.status === 'Present').length;
  const overall = totalL > 0 ? Math.round((totalP / totalL) * 100) : 0;

  ctx.fillStyle = '#e8f0f8';
  ctx.font      = `bold ${Math.round(outerR * 0.32)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(overall + '%', cx, cy - 8);
  ctx.fillStyle = '#7a9bbf';
  ctx.font      = `${Math.round(outerR * 0.16)}px sans-serif`;
  ctx.fillText('overall', cx, cy + outerR * 0.22);

  legendEl.innerHTML = arcs.map(({ subj, s, pct, color }) => {
    const p      = Math.round(pct * 100);
    const isWarn = s.total > 0 && p < WARN_THRESHOLD;
    const short  = subj.length > 32 ? subj.slice(0, 30) + '…' : subj;
    return `
      <div class="legend-item ${isWarn ? 'warn-item' : ''}">
        <span class="legend-dot" style="background:${color}"></span>
        <span class="legend-name" title="${subj}">${short}</span>
        <span class="legend-pct" style="color:${isWarn ? 'var(--warn-color)' : color}">${p}%</span>
        ${isWarn ? '<span class="legend-warn-badge">⚠ Low</span>' : ''}
      </div>`;
  }).join('');
}

/* ---- Bar chart: per-subject attendance % ---- */
function drawBarChart() {
  const wrap   = document.querySelector('.bar-chart-wrap');
  const canvas = document.getElementById('bar-chart');

  const statsMap = buildSubjectStats();
  const subjects = Object.keys(statsMap);

  if (subjects.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';

  /* Layout constants */
  const BAR_H    = 36;
  const BAR_GAP  = 10;
  const PAD_TOP  = 8;
  const PAD_BOT  = 30;   /* axis label space */
  const PAD_L    = 0;
  const PAD_R    = 52;   /* % value on right */

  const W       = wrap.clientWidth || 320;
  const totalH  = PAD_TOP + subjects.length * (BAR_H + BAR_GAP) - BAR_GAP + PAD_BOT;
  const barAreaW = W - PAD_L - PAD_R;

  /* Set canvas dimensions (prevents blur on high-DPI) */
  const dpr     = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = totalH * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, totalH);

  /* Grid lines at 0 / 75 / 100 */
  [0, 75, 100].forEach(mark => {
    const x = PAD_L + (mark / 100) * barAreaW;

    /* Vertical grid line */
    ctx.strokeStyle = '#1e2f43';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP);
    ctx.lineTo(x, totalH - PAD_BOT);
    ctx.stroke();

    /* Axis label */
    ctx.fillStyle    = '#3d5a78';
    ctx.font         = '10px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(mark + '%', x, totalH - PAD_BOT + 5);
  });

  /* Dashed warning line at 75% */
  const warnX = PAD_L + (WARN_THRESHOLD / 100) * barAreaW;
  ctx.strokeStyle = 'rgba(243,156,18,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(warnX, PAD_TOP);
  ctx.lineTo(warnX, totalH - PAD_BOT);
  ctx.stroke();
  ctx.setLineDash([]);

  /* Draw each bar */
  subjects.forEach((subj, i) => {
    const s      = statsMap[subj];
    const pct    = s.total > 0 ? s.present / s.total : 0;
    const pctInt = Math.round(pct * 100);
    const color  = CHART_COLORS[i % CHART_COLORS.length];
    const isWarn = s.total > 0 && pctInt < WARN_THRESHOLD;
    const y      = PAD_TOP + i * (BAR_H + BAR_GAP);
    const bw     = pct * barAreaW;

    /* Background track */
    ctx.fillStyle = '#1e2f43';
    roundRect(ctx, PAD_L, y, barAreaW, BAR_H, 7);
    ctx.fill();

    /* Filled portion */
    if (bw > 1) {
      ctx.fillStyle = isWarn ? '#e67e22' : color;
      roundRect(ctx, PAD_L, y, bw, BAR_H, 7);
      ctx.fill();
    }

    /* Subject label: inside bar if bar is wide enough, else after it */
    const shortName = subj.length > 26 ? subj.slice(0, 24) + '…' : subj;
    const nameInside = bw > 70;
    ctx.fillStyle    = nameInside ? 'rgba(255,255,255,0.9)' : '#7a9bbf';
    ctx.font         = '500 11px sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(shortName, nameInside ? PAD_L + 8 : PAD_L + bw + 6, y + BAR_H / 2);

    /* % label on the right */
    ctx.fillStyle    = isWarn ? '#f39c12' : color;
    ctx.font         = 'bold 12px sans-serif';
    ctx.textAlign    = 'right';
    ctx.fillText(pctInt + '%', W - 4, y + BAR_H / 2);
  });
}

/** Draws a rounded rectangle path (helper) */
function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

/** Builds { subject: { total, present } } from cached lectures */
function buildSubjectStats() {
  const map = {};
  state.lectures.forEach(l => {
    if (!map[l.subject]) map[l.subject] = { total: 0, present: 0 };
    map[l.subject].total++;
    if (l.status === 'Present') map[l.subject].present++;
  });
  return map;
}

/* ==========================================
   ADD / EDIT FORM
   ========================================== */
function resetAddForm() {
  state.editingId        = null;
  state.selectedStatus   = 'Present';
  state.pendingImages    = { 1: null, 2: null };
  state.removeImages     = { 1: false, 2: false };
  state.existingImageIds = { 1: null, 2: null };

  document.getElementById('edit-lecture-id').value = '';
  document.getElementById('subject-select').value  = '';
  document.getElementById('custom-subject').value  = '';
  document.getElementById('custom-subject-group').classList.add('hidden');

  /* Default: today + current time rounded to nearest 5 min */
  const now   = new Date();
  document.getElementById('lecture-date').value = now.toISOString().split('T')[0];

  const rawMins  = now.getMinutes();
  const roundMin = Math.round(rawMins / 5) * 5;
  const carry    = roundMin === 60 ? 1 : 0;
  const h        = (now.getHours() + carry) % 24;
  const m        = roundMin % 60;
  document.getElementById('lecture-time').value =
    String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

  selectStatus('Present');
  clearProofPreview(1); clearProofPreview(2);
  resetProofInput(1);   resetProofInput(2);

  document.getElementById('form-heading').textContent  = 'Add Lecture';
  document.getElementById('btn-submit').textContent    = 'Add Lecture';
  document.getElementById('btn-cancel-edit').classList.add('hidden');
}

function selectStatus(status) {
  state.selectedStatus = status;
  document.getElementById('btn-present').classList.toggle('active', status === 'Present');
  document.getElementById('btn-absent').classList.toggle('active',  status === 'Absent');
}

/* Show / hide custom subject input */
document.getElementById('subject-select').addEventListener('change', function () {
  const grp = document.getElementById('custom-subject-group');
  if (this.value === 'Other') {
    grp.classList.remove('hidden');
  } else {
    grp.classList.add('hidden');
    document.getElementById('custom-subject').value = '';
  }
});

async function handleProofUpload(slot, input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const blob = await compressImage(file);
    state.pendingImages[slot] = blob;
    state.removeImages[slot]  = false;
    showProofThumbnail(slot, URL.createObjectURL(blob));
  } catch (err) {
    showToast('Image error: ' + err.message);
  }
}

function showProofThumbnail(slot, src) {
  document.getElementById('proof-preview-' + slot).innerHTML = `
    <img src="${src}" alt="Proof ${slot}" />
    <button class="proof-remove-btn" onclick="removeProof(${slot})" title="Remove">✕</button>
  `;
}

function clearProofPreview(slot) {
  document.getElementById('proof-preview-' + slot).innerHTML = '';
}

function resetProofInput(slot) {
  document.getElementById('proof-input-' + slot).value = '';
}

function removeProof(slot) {
  state.pendingImages[slot] = null;
  state.removeImages[slot]  = true;
  clearProofPreview(slot);
  resetProofInput(slot);
}

async function submitLecture() {
  /* Resolve subject */
  let subject = document.getElementById('subject-select').value;
  if (!subject) { showToast('Please select a subject'); return; }
  if (subject === 'Other') {
    subject = document.getElementById('custom-subject').value.trim();
    if (!subject) { showToast('Please enter a custom subject name'); return; }
  }

  const date = document.getElementById('lecture-date').value;
  if (!date) { showToast('Please select a date'); return; }

  const time = document.getElementById('lecture-time').value;
  if (!time) { showToast('Please enter the lecture time'); return; }

  const status = state.selectedStatus;

  /* Block duplicate subject + date + time combination */
  if (isDuplicate(subject, date, time, state.editingId)) {
    showToast('⚠ Duplicate: same subject, date & time already exists');
    return;
  }

  if (state.editingId !== null) {
    await updateLecture(state.editingId, subject, date, time, status);
  } else {
    await addLecture(subject, date, time, status);
  }
}

async function addLecture(subject, date, time, status) {
  try {
    const imageIds = await savePendingImages();
    await dbAdd(STORE_LECTURES, {
      subject, date, time, status,
      imageId1: imageIds[1] || null,
      imageId2: imageIds[2] || null,
      createdAt: Date.now(),
    });
    await dataChanged();
    resetAddForm();
    showToast('Lecture added ✓');
    navigate('lectures');
  } catch (err) {
    showToast('Error saving: ' + err.message);
  }
}

async function updateLecture(id, subject, date, time, status) {
  try {
    const existing = await dbGet(STORE_LECTURES, id);
    if (!existing) { showToast('Record not found'); return; }

    let imageId1 = existing.imageId1;
    let imageId2 = existing.imageId2;

    for (const slot of [1, 2]) {
      const oldId = existing['imageId' + slot];
      if (state.removeImages[slot] || state.pendingImages[slot]) {
        if (oldId !== null) await dbDelete(STORE_IMAGES, oldId);
        if (state.pendingImages[slot]) {
          const newId = await dbAdd(STORE_IMAGES, { blob: state.pendingImages[slot] });
          if (slot === 1) imageId1 = newId;
          else            imageId2 = newId;
        } else {
          if (slot === 1) imageId1 = null;
          else            imageId2 = null;
        }
      }
    }

    await dbPut(STORE_LECTURES, { ...existing, subject, date, time, status, imageId1, imageId2 });
    state.editingId = null;
    await dataChanged();
    resetAddForm();
    showToast('Lecture updated ✓');
    navigate('lectures');
  } catch (err) {
    showToast('Error updating: ' + err.message);
  }
}

async function savePendingImages() {
  const ids = { 1: null, 2: null };
  for (const slot of [1, 2]) {
    if (state.pendingImages[slot]) {
      ids[slot] = await dbAdd(STORE_IMAGES, { blob: state.pendingImages[slot] });
    }
  }
  return ids;
}

async function editLecture(id) {
  const record = state.lectures.find(l => l.id === id);
  if (!record) return;

  state.editingId        = id;
  state.pendingImages    = { 1: null, 2: null };
  state.removeImages     = { 1: false, 2: false };
  state.existingImageIds = { 1: record.imageId1, 2: record.imageId2 };

  const subjectSel = document.getElementById('subject-select');
  const predefined = Array.from(subjectSel.options).map(o => o.value);
  if (predefined.includes(record.subject)) {
    subjectSel.value = record.subject;
    document.getElementById('custom-subject-group').classList.add('hidden');
  } else {
    subjectSel.value = 'Other';
    document.getElementById('custom-subject-group').classList.remove('hidden');
    document.getElementById('custom-subject').value = record.subject;
  }

  document.getElementById('lecture-date').value    = record.date;
  document.getElementById('lecture-time').value    = record.time || '';
  document.getElementById('edit-lecture-id').value = id;
  selectStatus(record.status);

  for (const slot of [1, 2]) {
    const imgId = record['imageId' + slot];
    clearProofPreview(slot); resetProofInput(slot);
    if (imgId !== null) {
      const imgRecord = await dbGet(STORE_IMAGES, imgId);
      if (imgRecord) showProofThumbnail(slot, URL.createObjectURL(imgRecord.blob));
    }
  }

  document.getElementById('form-heading').textContent  = 'Edit Lecture';
  document.getElementById('btn-submit').textContent    = 'Save Changes';
  document.getElementById('btn-cancel-edit').classList.remove('hidden');
  navigate('add');
}

function cancelEdit() {
  state.editingId = null;
  resetAddForm();
  navigate('lectures');
}

/* ==========================================
   DELETE FLOW
   ========================================== */
function promptDelete(id) {
  state.deleteTargetId = id;
  document.getElementById('delete-modal').classList.remove('hidden');
}

function closeDeleteModal() {
  state.deleteTargetId = null;
  document.getElementById('delete-modal').classList.add('hidden');
}

async function confirmDelete() {
  const id = state.deleteTargetId;
  closeDeleteModal();
  if (id == null) return;
  try {
    const record = state.lectures.find(l => l.id === id);
    if (record) {
      if (record.imageId1 !== null) await dbDelete(STORE_IMAGES, record.imageId1);
      if (record.imageId2 !== null) await dbDelete(STORE_IMAGES, record.imageId2);
    }
    await dbDelete(STORE_LECTURES, id);
    await dataChanged();
    showToast('Lecture deleted');
  } catch (err) {
    showToast('Delete failed: ' + err.message);
  }
}

/* ==========================================
   LECTURES LIST
   ========================================== */
function renderLectures() {
  const filterSubject = document.getElementById('filter-subject').value;
  let list = filterSubject
    ? state.lectures.filter(l => l.subject === filterSubject)
    : state.lectures;

  /* Sort newest first (date + time) */
  list = list.slice().sort((a, b) => {
    const ka = (a.date || '') + 'T' + (a.time || '00:00');
    const kb = (b.date || '') + 'T' + (b.time || '00:00');
    return kb.localeCompare(ka);
  });

  document.getElementById('lectures-count').textContent =
    list.length + ' record' + (list.length !== 1 ? 's' : '');

  if (list.length === 0) {
    document.getElementById('lecture-list').innerHTML =
      `<p class="no-data-msg">No lectures found.</p>`;
    return;
  }

  document.getElementById('lecture-list').innerHTML = list.map(l => {
    const hasProof   = l.imageId1 !== null || l.imageId2 !== null;
    const isAbsent   = l.status === 'Absent';
    const shortSub   = l.subject.length > 50 ? l.subject.slice(0, 48) + '…' : l.subject;
    const timePart   = l.time ? ` · ${formatTime(l.time)}` : '';

    return `
      <div class="lecture-card ${isAbsent ? 'absent-card' : 'present-card'}">
        <div class="card-header">
          <span class="card-subject">${escapeHtml(shortSub)}</span>
          <span class="card-status-badge ${isAbsent ? 'badge-absent' : 'badge-present'}">${l.status}</span>
        </div>
        <div class="card-date">📅 ${escapeHtml(formatDate(l.date))}${escapeHtml(timePart)}</div>
        <div class="card-actions">
          ${hasProof ? `<button class="card-btn btn-view-proof" onclick="viewProof(${l.id})">🖼 Proof</button>` : ''}
          <button class="card-btn btn-edit"   onclick="editLecture(${l.id})">✎ Edit</button>
          <button class="card-btn btn-delete" onclick="promptDelete(${l.id})">🗑 Delete</button>
        </div>
      </div>`;
  }).join('');
}

function refreshFilterOptions() {
  const subjects = [...new Set(state.lectures.map(l => l.subject))].sort();
  const sel      = document.getElementById('filter-subject');
  const current  = sel.value;

  sel.innerHTML = '<option value="">All Subjects</option>' +
    subjects.map(s => {
      const short = s.length > 40 ? s.slice(0, 38) + '…' : s;
      return `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(short)}</option>`;
    }).join('');
}

/* ==========================================
   PROOF MODAL
   ========================================== */
async function viewProof(lectureId) {
  const record = state.lectures.find(l => l.id === lectureId);
  if (!record) return;

  const container = document.getElementById('modal-images');
  container.innerHTML = '';

  for (const slot of [1, 2]) {
    const imgId = record['imageId' + slot];
    if (imgId !== null) {
      const imgRecord = await dbGet(STORE_IMAGES, imgId);
      if (imgRecord) {
        const src = URL.createObjectURL(imgRecord.blob);
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Proof ' + slot;
        img.onload = () => URL.revokeObjectURL(src);
        container.appendChild(img);
      }
    }
  }
  document.getElementById('proof-modal').classList.remove('hidden');
}

function closeProofModal() {
  document.getElementById('proof-modal').classList.add('hidden');
  document.getElementById('modal-images').innerHTML = '';
}

/* ==========================================
   TOAST
   ========================================== */
let _toastTimer = null;

function showToast(msg) {
  const el    = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  const clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => document.getElementById('toast').classList.add('hidden'), 2800);
}

/* ==========================================
   UTILITIES
   ========================================== */
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Converts 24h "HH:MM" to "H:MM AM/PM" */
function formatTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h    = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ==========================================
   SERVICE WORKER REGISTRATION
   ========================================== */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('serviceworker.js')
      .catch(err => console.warn('SW registration failed:', err));
  }
}
/* ==========================================
   BUNK CALCULATOR
   Overall target : 85%
   Per-subject target: 60%
   ========================================== */
function renderBunkCalc() {
  const el = document.getElementById('bunk-section');
  if (!el) return;

  const OVERALL_TARGET  = 0.80;
  const SUBJECT_TARGET  = 0.60;

  const total   = state.lectures.length;
  const present = state.lectures.filter(l => l.status === 'Present').length;

  /* ---- Overall card ---- */
  let overallHTML = '';
  if (total === 0) {
    overallHTML = `
      <div class="bunk-overall">
        <div>
          <div class="bunk-overall-label">Overall (80% target)</div>
          <div class="bunk-overall-sub">No lectures recorded yet</div>
        </div>
        <div class="bunk-badge bunk-safe"><small>Status</small>—</div>
      </div>`;
  } else {
    const pct = present / total;
    let badgeClass, badgeText, badgeSub;

    if (pct >= OVERALL_TARGET) {
      /* How many can I skip and still stay ≥ 80%? */
      const canSkip = Math.floor((present - OVERALL_TARGET * total) / OVERALL_TARGET);
      if (canSkip === 0) {
        badgeClass = 'bunk-safe';
        badgeSub   = 'Status';
        badgeText  = 'At limit';
      } else {
        badgeClass = 'bunk-can';
        badgeSub   = 'Can Skip';
        badgeText  = canSkip + (canSkip === 1 ? ' lecture' : ' lectures');
      }
    } else {
      /* How many must I attend to reach 80%? */
      const mustAttend = Math.ceil((OVERALL_TARGET * total - present) / (1 - OVERALL_TARGET));
      badgeClass = 'bunk-must';
      badgeSub   = 'Must Attend';
      badgeText  = mustAttend + (mustAttend === 1 ? ' lecture' : ' lectures');
    }

    const pctDisplay = Math.round(pct * 100);
    overallHTML = `
      <div class="bunk-overall">
        <div>
          <div class="bunk-overall-label">Overall (85% target)</div>
          <div class="bunk-overall-sub">
            ${present}/${total} present · currently ${pctDisplay}%
          </div>
        </div>
        <div class="bunk-badge ${badgeClass}">
          <small>${badgeSub}</small>${badgeText}
        </div>
      </div>`;
  }

  /* ---- Per-subject rows ---- */
  const statsMap = buildSubjectStats();
  const subjects = Object.keys(statsMap);

  let rowsHTML = '';
  subjects.forEach(subj => {
    const s   = statsMap[subj];
    const pct = s.total > 0 ? s.present / s.total : 0;
    const pctDisplay = Math.round(pct * 100);
    const short = subj.length > 30 ? subj.slice(0, 28) + '…' : subj;

    let rowClass, badgeClass, badgeText;

    if (s.total === 0) return;

    if (pct >= SUBJECT_TARGET) {
      const canSkip = Math.floor((s.present - SUBJECT_TARGET * s.total) / SUBJECT_TARGET);
      if (canSkip === 0) {
        rowClass   = 'can-bunk';
        badgeClass = 'can';
        badgeText  = 'At limit';
      } else {
        rowClass   = 'can-bunk';
        badgeClass = 'can';
        badgeText  = '✓ Skip ' + canSkip;
      }
    } else {
      const mustAttend = Math.ceil((SUBJECT_TARGET * s.total - s.present) / (1 - SUBJECT_TARGET));
      rowClass   = 'must-attend';
      badgeClass = 'must';
      badgeText  = '✗ Attend ' + mustAttend;
    }

    rowsHTML += `
      <div class="bunk-row ${rowClass}">
        <span class="bunk-row-subject" title="${subj}">${escapeHtml(short)}</span>
        <span class="bunk-row-pct">${pctDisplay}%</span>
        <span class="bunk-row-badge ${badgeClass}">${badgeText}</span>
      </div>`;
  });

  if (subjects.length > 0) {
    rowsHTML = `
      <div class="bunk-row" style="background:transparent;border:none;padding:2px 4px;">
        <span style="font-size:10px;color:var(--text-faint);">Subject (60% target)</span>
      </div>` + rowsHTML;
  }

  el.innerHTML = overallHTML + rowsHTML;
}
/* ==========================================
   APP INIT
   ========================================== */
async function initApp() {
  try {
    state.db = await openDB();
    await loadLectures();
    refreshFilterOptions();
    renderHome();
    registerServiceWorker();
  } catch (err) {
    console.error('App init failed:', err);
    document.getElementById('app-main').innerHTML =
      `<p style="color:#e74c3c;padding:20px;">Failed to initialise database: ${err.message}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', initApp);

/* Redraw bar chart on orientation change */
window.addEventListener('resize', () => {
  if (state.lectures.length > 0 && document.getElementById('section-home').classList.contains('active')) {
    drawBarChart();
  }
});
