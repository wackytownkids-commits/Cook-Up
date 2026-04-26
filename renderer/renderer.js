// Cookup - renderer logic
// Stove vibe: burner dial (tempo), heat mode (simmer/sear/flambe),
// animated flames while cooking, drag-out when plated.

const $ = (sel) => document.querySelector(sel);

const state = {
  songs: [],
  lastResult: null,
  bpm: 90,
  heat: 'sear',
  knobAngle: 0,
  dragging: false
};

// ----- Settings -----

const settingsModal = $('#settings');
$('#settings-btn').addEventListener('click', openSettings);
$('#s-cancel').addEventListener('click', closeSettings);
$('#s-save').addEventListener('click', saveSettings);
$('#s-pick-out').addEventListener('click', async () => {
  const dir = await window.api.pickOutputDir();
  if (dir) $('#s-out').value = dir;
});

async function openSettings() {
  const s = await window.api.getSettings();
  $('#s-py').value = s.pythonPath || '';
  $('#s-port').value = s.serverPort || 7781;
  $('#s-out').value = s.outputDir || '';
  try { $('#s-version').textContent = 'v' + (await window.api.getVersion()); } catch (_) {}
  settingsModal.classList.remove('hidden');
}
function closeSettings() { settingsModal.classList.add('hidden'); }
async function saveSettings() {
  await window.api.setSettings({
    pythonPath: $('#s-py').value.trim(),
    serverPort: parseInt($('#s-port').value, 10) || 7781,
    outputDir: $('#s-out').value.trim()
  });
  closeSettings();
}

// ----- Ingredients -----

$('#pick-songs').addEventListener('click', async () => {
  const picked = await window.api.pickSongs();
  for (const s of picked) {
    if (!state.songs.find(x => x.path === s.path)) state.songs.push(s);
  }
  renderSongs();
});

function renderSongs() {
  const list = $('#song-list');
  list.innerHTML = '';
  for (const s of state.songs) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s.name;
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '\u2715'; rm.title = 'Remove';
    rm.addEventListener('click', () => {
      state.songs = state.songs.filter(x => x.path !== s.path);
      renderSongs();
    });
    li.appendChild(name); li.appendChild(rm);
    list.appendChild(li);
  }
}

// ----- Burner dial (drag to set BPM) -----

const BPM_MIN = 60;
const BPM_MAX = 180;
const KNOB_SWEEP = 270;

const burner = $('#burner');
const knob = $('#burner-knob');
const bpmLabel = $('#bpm-value');

function setBpm(bpm) {
  bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
  state.bpm = bpm;
  const pct = (bpm - BPM_MIN) / (BPM_MAX - BPM_MIN);
  const angle = pct * KNOB_SWEEP - KNOB_SWEEP / 2;
  state.knobAngle = angle;
  knob.style.transform = `rotate(${angle}deg)`;
  bpmLabel.textContent = bpm;
  burner.dataset.bpm = bpm;
}
setBpm(90);

knob.addEventListener('mousedown', (e) => {
  state.dragging = true;
  e.preventDefault();
});
window.addEventListener('mouseup', () => { state.dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  const rect = knob.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  let angle = Math.atan2(dx, -dy) * 180 / Math.PI;
  angle = Math.max(-KNOB_SWEEP/2, Math.min(KNOB_SWEEP/2, angle));
  const pct = (angle + KNOB_SWEEP/2) / KNOB_SWEEP;
  setBpm(BPM_MIN + pct * (BPM_MAX - BPM_MIN));
});
burner.addEventListener('wheel', (e) => {
  e.preventDefault();
  setBpm(state.bpm + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ----- Heat mode -----

const heatGroup = $('#heat-group');
heatGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.heat');
  if (!btn) return;
  heatGroup.querySelectorAll('.heat').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.heat = btn.dataset.heat;
});

// ----- Oven status -----

const ovenPill = $('#oven-status');
const ovenText = $('#oven-text');

async function updateOvenStatus() {
  const h = await window.api.health();
  if (h && h.ok) {
    ovenPill.classList.remove('err');
    if (h.loaded) {
      ovenPill.classList.add('ready');
      ovenText.textContent = `Ready \u00B7 ${h.device || 'cpu'}`;
    } else {
      ovenPill.classList.remove('ready');
      ovenText.textContent = 'Oven up \u00B7 model will warm on first Cook';
    }
  } else {
    ovenPill.classList.add('err');
    ovenText.textContent = 'Oven offline';
  }
}
updateOvenStatus();
setInterval(updateOvenStatus, 4000);

window.api.onPyLog((s) => {
  if (/loading .* on/.test(s)) ovenText.textContent = 'Warming model...';
  if (/model loaded/.test(s)) {
    ovenText.textContent = 'Ready';
    ovenPill.classList.add('ready');
  }
});

// ----- Generate -----

const generateBtn = $('#generate');
const statusBox = $('#status');
const statusText = $('#status-text');
const statusTime = $('#status-time');
const statusBarFill = $('#status-bar-fill');
const resultBox = $('#result');
const resultTitle = $('#result-title');
const dragHandle = $('#drag-handle');
const flames = $('#flames');

window.api.onProgress((msg) => { statusText.textContent = msg; });

// ----- Cook timer (elapsed + estimated remaining + progress bar) -----
// Initial guess: CPU takes roughly 12x the output duration, plus ~60s
// to load the model from disk on the very first cook of a session.
// Recalibrate live from any tqdm "[elapsed<eta]" pattern we see in py:log.

let cookStart = 0;
let cookEstimateSec = 0;
let cookTimer = null;
let modelProgressSeen = false;
let lastDone = 0;
let lastTotal = 0;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function startCookTimer(durationSec) {
  cookStart = Date.now();
  modelProgressSeen = false;
  lastDone = 0;
  lastTotal = 0;
  const modelWarm = ovenPill.classList.contains('ready');
  const coldPenalty = modelWarm ? 0 : 90;
  cookEstimateSec = durationSec * 18 + coldPenalty;
  if (cookTimer) clearInterval(cookTimer);
  cookTimer = setInterval(tickCookTimer, 250);
  tickCookTimer();
}

function tickCookTimer() {
  const elapsed = (Date.now() - cookStart) / 1000;
  let pct, remaining;

  if (modelProgressSeen && lastTotal > 0 && lastDone > 0) {
    pct = Math.min(99, (lastDone / lastTotal) * 100);
    const projectedTotal = elapsed * (lastTotal / lastDone);
    remaining = Math.max(0, projectedTotal - elapsed);
    cookEstimateSec = projectedTotal;
  } else {
    if (elapsed > cookEstimateSec * 0.9) {
      cookEstimateSec = Math.max(cookEstimateSec, elapsed * 1.4);
    }
    pct = Math.min(95, (elapsed / Math.max(1, cookEstimateSec)) * 100);
    remaining = cookEstimateSec - elapsed;
  }

  statusBarFill.style.width = pct + '%';

  if (!modelProgressSeen && remaining < 5) {
    // We genuinely don't know - be honest instead of lying "0 left".
    statusTime.textContent = fmtTime(elapsed) + ' elapsed \u00B7 still cooking...';
  } else {
    statusTime.textContent =
      fmtTime(elapsed) + ' elapsed \u00B7 ~' + fmtTime(Math.max(0, remaining)) + ' left';
  }
}

function finishCookTimer(success) {
  if (cookTimer) { clearInterval(cookTimer); cookTimer = null; }
  statusBarFill.style.width = success ? '100%' : '0%';
  if (success) {
    const total = (Date.now() - cookStart) / 1000;
    statusTime.textContent = 'Done in ' + fmtTime(total);
  }
}

// Audiocraft prints '   42 /   500\r' for each generated token batch
// (audiocraft/models/musicgen.py line 243). Parse that to drive the bar.
function maybeUpdateFromPyLog(logLine) {
  const matches = logLine.match(/(\d{1,6})\s*\/\s*(\d{1,6})/g);
  if (matches && matches.length) {
    const last = matches[matches.length - 1];
    const m = last.match(/(\d+)\s*\/\s*(\d+)/);
    const done = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (total >= 50 && total <= 100000 && done <= total) {
      lastDone = done;
      lastTotal = total;
      modelProgressSeen = true;
      statusText.textContent = 'Cooking ' + Math.round((done / total) * 100) + '%';
    }
  }
  if (/loading .* on/.test(logLine)) statusText.textContent = 'Warming model...';
  if (/model loaded/.test(logLine)) statusText.textContent = 'Cooking 0%';
}

window.api.onPyLog((s) => { maybeUpdateFromPyLog(s); });

generateBtn.addEventListener('click', async () => {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { flashStatus('Write a recipe first.'); return; }

  const durationSec = parseInt($('#duration').value, 10);

  resultBox.classList.add('hidden');
  statusBox.classList.remove('hidden');
  statusText.textContent = 'Lighting the burner...';
  statusTime.textContent = '';
  statusBarFill.style.width = '0%';
  flames.classList.add('on');
  burner.classList.add('hot');
  generateBtn.disabled = true;
  generateBtn.textContent = 'Cooking...';

  startCookTimer(durationSec);

  try {
    const payload = {
      prompt,
      referenceSongs: state.songs,
      heat: state.heat,
      bpm: state.bpm,
      durationSec
    };
    const res = await window.api.generate(payload);
    state.lastResult = res;
    resultTitle.textContent = res.title;
    const previewEl = $('#preview-audio');
    if (previewEl && res.filePath) {
      previewEl.src = 'file:///' + encodeURI(res.filePath.replace(/\\/g, '/'));
      previewEl.load();
    }
    finishCookTimer(true);
    setTimeout(() => {
      resultBox.classList.remove('hidden');
      statusBox.classList.add('hidden');
    }, 600);
  } catch (err) {
    statusText.textContent = 'Error: ' + (err.message || String(err));
    finishCookTimer(false);
  } finally {
    flames.classList.remove('on');
    burner.classList.remove('hot');
    generateBtn.disabled = false;
    generateBtn.textContent = 'Cook';
  }
});

function flashStatus(msg) {
  statusBox.classList.remove('hidden');
  statusText.textContent = msg;
  setTimeout(() => { statusBox.classList.add('hidden'); }, 2000);
}

// ----- Drag into Logic -----

dragHandle.addEventListener('dragstart', (e) => {
  if (!state.lastResult) { e.preventDefault(); return; }
  e.preventDefault();
  window.api.startDrag(state.lastResult.filePath);
});

$('#reveal').addEventListener('click', () => {
  if (state.lastResult) window.api.reveal(state.lastResult.filePath);
});

$('#again').addEventListener('click', () => {
  resultBox.classList.add('hidden');
  $('#prompt').focus();
});

// ----- Auto-updater -----

const updateToast = $('#update-toast');
const updateToastText = $('#update-toast-text');
const updateMsg = $('#s-update-msg');

$('#s-check-updates').addEventListener('click', async () => {
  updateMsg.textContent = 'Checking...';
  const r = await window.api.checkForUpdates();
  if (!r || !r.ok) {
    updateMsg.textContent = r && r.reason === 'dev-mode'
      ? 'Updates only run in the installed app.'
      : 'Could not check: ' + (r && r.reason || 'unknown');
  } else {
    updateMsg.textContent = r.version ? `Found ${r.version} - downloading...` : 'You are up to date.';
  }
});

window.api.onUpdateStatus((p) => {
  if (!p) return;
  if (p.state === 'available') updateMsg.textContent = `Downloading ${p.version || ''}...`;
  if (p.state === 'none') updateMsg.textContent = 'You are up to date.';
  if (p.state === 'error') updateMsg.textContent = 'Update error: ' + (p.message || '');
});

window.api.onUpdateDownloaded((p) => {
  updateToastText.textContent = p && p.version
    ? `Update ready (v${p.version}) - restart to install`
    : 'Update ready - restart to install';
  updateToast.classList.remove('hidden');
});

$('#update-restart').addEventListener('click', () => window.api.quitAndInstall());
$('#update-dismiss').addEventListener('click', () => updateToast.classList.add('hidden'));
