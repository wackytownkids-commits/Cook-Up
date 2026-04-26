// Cookup - renderer logic for v1.1.0:
// Stove (text-to-music + mic record), Spice Rack (effects), Voice -> MIDI,
// Cookbook. Plus auto-updater wiring carried forward from v1.0.x.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  songs: [],
  lastResult: null,
  bpm: 90,
  heat: 'sear',
  knobAngle: 0,
  dragging: false,
  spice: { sourcePath: null, lastResult: null, originalForAB: null },
  vm: { sourcePath: null, lastResult: null, instrumentProgram: 0, isDrums: false },
  fxChain: [],
};

// ==================== Tabs ====================

$$('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.view').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const id = 'view-' + b.dataset.tab;
    document.getElementById(id).classList.add('active');
  });
});

// ==================== Settings ====================

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
    outputDir: $('#s-out').value.trim(),
  });
  closeSettings();
}

// ==================== Stove: ingredients ====================

$('#pick-songs').addEventListener('click', async () => {
  const picked = await window.api.pickSongs();
  for (const s of picked) {
    if (!state.songs.find((x) => x.path === s.path)) state.songs.push(s);
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
    rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove';
    rm.addEventListener('click', () => {
      state.songs = state.songs.filter((x) => x.path !== s.path);
      renderSongs();
    });
    li.appendChild(name); li.appendChild(rm);
    list.appendChild(li);
  }
}

// ==================== WAV recorder (mic -> 16-bit PCM blob) ====================

class WavRecorder {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.chunks = [];
    this.sampleRate = 0;
    this.stream = null;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      // Copy because the buffer gets reused.
      this.chunks.push(new Float32Array(ch));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }
  async stop() {
    this.processor.disconnect();
    this.source.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
    return this.encodeWav(this.chunks, this.sampleRate);
  }
  encodeWav(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const flat = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { flat.set(c, off); off += c.length; }
    // Convert float32 to 16-bit PCM.
    const pcm = new Int16Array(flat.length);
    for (let i = 0; i < flat.length; i++) {
      const s = Math.max(-1, Math.min(1, flat[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return makeWavBlob(pcm, sampleRate, 1);
  }
}

function makeWavBlob(pcm16, sampleRate, channels) {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm16.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  let p = 0;
  function w(s) { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); }
  function u32(n) { v.setUint32(p, n, true); p += 4; }
  function u16(n) { v.setUint16(p, n, true); p += 2; }
  w('RIFF'); u32(36 + dataSize); w('WAVE');
  w('fmt '); u32(16); u16(1); u16(channels);
  u32(sampleRate); u32(byteRate); u16(blockAlign); u16(16);
  w('data'); u32(dataSize);
  for (let i = 0; i < pcm16.length; i++) { v.setInt16(p, pcm16[i], true); p += 2; }
  return new Uint8Array(buf);
}

let activeRecorder = null;
let recorderTarget = null; // 'stove' | 'spice' | 'vm'

async function startRecording(target, statusEl, btn) {
  if (activeRecorder) return;
  recorderTarget = target;
  activeRecorder = new WavRecorder();
  try {
    await activeRecorder.start();
    statusEl.classList.remove('hidden');
    statusEl.textContent = '● Recording... click again to stop';
    btn.textContent = '■ Stop';
    btn.classList.add('recording');
  } catch (e) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Mic access failed: ' + (e.message || e);
    activeRecorder = null;
    recorderTarget = null;
  }
}

async function stopRecording(statusEl, btn) {
  if (!activeRecorder) return;
  const bytes = await activeRecorder.stop();
  activeRecorder = null;
  btn.textContent = '🎙 Record';
  btn.classList.remove('recording');
  statusEl.textContent = 'Saving...';
  const filePath = await window.api.saveRecording(Array.from(bytes));
  statusEl.textContent = 'Saved: ' + filePath.split(/[\\/]/).pop();
  return filePath;
}

// Stove record button: adds the recording as a melody reference.
const stoveRecBtn = $('#record-vocal');
const stoveRecStatus = $('#recorder-status');
stoveRecBtn.addEventListener('click', async () => {
  if (activeRecorder && recorderTarget === 'stove') {
    const filePath = await stopRecording(stoveRecStatus, stoveRecBtn);
    if (filePath) {
      state.songs.push({ path: filePath, name: 'Recorded vocal' });
      renderSongs();
    }
    recorderTarget = null;
  } else if (!activeRecorder) {
    startRecording('stove', stoveRecStatus, stoveRecBtn);
  }
});

// ==================== Burner dial ====================

const BPM_MIN = 60, BPM_MAX = 180, KNOB_SWEEP = 270;
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
knob.addEventListener('mousedown', (e) => { state.dragging = true; e.preventDefault(); });
window.addEventListener('mouseup', () => { state.dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  const rect = knob.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  let angle = Math.atan2(dx, -dy) * 180 / Math.PI;
  angle = Math.max(-KNOB_SWEEP / 2, Math.min(KNOB_SWEEP / 2, angle));
  const pct = (angle + KNOB_SWEEP / 2) / KNOB_SWEEP;
  setBpm(BPM_MIN + pct * (BPM_MAX - BPM_MIN));
});
burner.addEventListener('wheel', (e) => {
  e.preventDefault();
  setBpm(state.bpm + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

const heatGroup = $('#heat-group');
heatGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.heat');
  if (!btn) return;
  heatGroup.querySelectorAll('.heat').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.heat = btn.dataset.heat;
});

// ==================== Oven status ====================

const ovenPill = $('#oven-status');
const ovenText = $('#oven-text');
async function updateOvenStatus() {
  const h = await window.api.health();
  if (h && h.ok) {
    ovenPill.classList.remove('err');
    if (h.loaded) {
      ovenPill.classList.add('ready');
      ovenText.textContent = `Ready · ${h.device || 'cpu'}`;
    } else {
      ovenPill.classList.remove('ready');
      ovenText.textContent = 'Oven up · model warms on first Cook';
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

// ==================== Cook timer / progress ====================

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
  lastDone = 0; lastTotal = 0;
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
    statusTime.textContent = fmtTime(elapsed) + ' elapsed · still cooking...';
  } else {
    statusTime.textContent =
      fmtTime(elapsed) + ' elapsed · ~' + fmtTime(Math.max(0, remaining)) + ' left';
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
function maybeUpdateFromPyLog(logLine) {
  const matches = logLine.match(/(\d{1,6})\s*\/\s*(\d{1,6})/g);
  if (matches && matches.length) {
    const last = matches[matches.length - 1];
    const m = last.match(/(\d+)\s*\/\s*(\d+)/);
    const done = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (total >= 50 && total <= 100000 && done <= total) {
      lastDone = done; lastTotal = total; modelProgressSeen = true;
      statusText.textContent = 'Cooking ' + Math.round((done / total) * 100) + '%';
    }
  }
  if (/loading .* on/.test(logLine)) statusText.textContent = 'Warming model...';
  if (/model loaded/.test(logLine)) statusText.textContent = 'Cooking 0%';
}
window.api.onPyLog((s) => { maybeUpdateFromPyLog(s); });

// ==================== Stove: Cook button ====================

generateBtn.addEventListener('click', async () => {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { flashStoveStatus('Write a recipe first.'); return; }
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
    const res = await window.api.generate({
      prompt,
      referenceSongs: state.songs,
      heat: state.heat,
      bpm: state.bpm,
      durationSec,
    });
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

function flashStoveStatus(msg) {
  statusBox.classList.remove('hidden');
  statusText.textContent = msg;
  setTimeout(() => { statusBox.classList.add('hidden'); }, 2000);
}

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
$('#send-to-spice').addEventListener('click', () => {
  if (!state.lastResult) return;
  setSpiceSource(state.lastResult.filePath, state.lastResult.title);
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.view').forEach((x) => x.classList.remove('active'));
  document.querySelector('.tab[data-tab="spice"]').classList.add('active');
  document.getElementById('view-spice').classList.add('active');
});

// ==================== Spice Rack ====================

const FX_DEFS = {
  Compressor: { params: { threshold_db: -20, ratio: 4, attack_ms: 1, release_ms: 100 }, schema: [
    { k: 'threshold_db', label: 'Threshold dB', min: -60, max: 0, step: 0.5 },
    { k: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1 },
    { k: 'attack_ms', label: 'Attack ms', min: 0.1, max: 100, step: 0.1 },
    { k: 'release_ms', label: 'Release ms', min: 1, max: 1000, step: 1 },
  ]},
  Reverb: { params: { room_size: 0.5, damping: 0.5, wet_level: 0.33, dry_level: 0.4, width: 1.0 }, schema: [
    { k: 'room_size', label: 'Room', min: 0, max: 1, step: 0.01 },
    { k: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01 },
    { k: 'wet_level', label: 'Wet', min: 0, max: 1, step: 0.01 },
    { k: 'dry_level', label: 'Dry', min: 0, max: 1, step: 0.01 },
    { k: 'width', label: 'Width', min: 0, max: 1, step: 0.01 },
  ]},
  Delay: { params: { delay_seconds: 0.25, feedback: 0.3, mix: 0.4 }, schema: [
    { k: 'delay_seconds', label: 'Time s', min: 0, max: 2, step: 0.01 },
    { k: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01 },
    { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
  ]},
  PitchShift: { params: { semitones: 0 }, schema: [
    { k: 'semitones', label: 'Semitones', min: -12, max: 12, step: 0.1 },
  ]},
  Chorus: { params: { rate_hz: 1.0, depth: 0.25, centre_delay_ms: 7, feedback: 0.0, mix: 0.5 }, schema: [
    { k: 'rate_hz', label: 'Rate Hz', min: 0.1, max: 10, step: 0.1 },
    { k: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01 },
    { k: 'centre_delay_ms', label: 'Centre ms', min: 1, max: 30, step: 0.5 },
    { k: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01 },
    { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
  ]},
  Phaser: { params: { rate_hz: 0.5, depth: 0.5, centre_frequency_hz: 1300, feedback: 0.0, mix: 0.5 }, schema: [
    { k: 'rate_hz', label: 'Rate Hz', min: 0.1, max: 10, step: 0.1 },
    { k: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01 },
    { k: 'centre_frequency_hz', label: 'Centre Hz', min: 200, max: 5000, step: 10 },
    { k: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01 },
    { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
  ]},
  Distortion: { params: { drive_db: 12 }, schema: [
    { k: 'drive_db', label: 'Drive dB', min: 0, max: 40, step: 0.5 },
  ]},
  Limiter: { params: { threshold_db: -3, release_ms: 100 }, schema: [
    { k: 'threshold_db', label: 'Threshold dB', min: -20, max: 0, step: 0.5 },
    { k: 'release_ms', label: 'Release ms', min: 1, max: 500, step: 1 },
  ]},
  HighpassFilter: { params: { cutoff_frequency_hz: 100 }, schema: [
    { k: 'cutoff_frequency_hz', label: 'Cutoff Hz', min: 20, max: 1000, step: 1 },
  ]},
  LowpassFilter: { params: { cutoff_frequency_hz: 8000 }, schema: [
    { k: 'cutoff_frequency_hz', label: 'Cutoff Hz', min: 200, max: 20000, step: 10 },
  ]},
  LadderFilter: { params: { cutoff_hz: 1000, resonance: 0.5, drive: 1.0 }, schema: [
    { k: 'cutoff_hz', label: 'Cutoff Hz', min: 50, max: 20000, step: 10 },
    { k: 'resonance', label: 'Resonance', min: 0, max: 1, step: 0.01 },
    { k: 'drive', label: 'Drive', min: 1, max: 8, step: 0.1 },
  ]},
  NoiseGate: { params: { threshold_db: -50, ratio: 10, attack_ms: 1, release_ms: 100 }, schema: [
    { k: 'threshold_db', label: 'Threshold dB', min: -80, max: 0, step: 0.5 },
    { k: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1 },
    { k: 'attack_ms', label: 'Attack ms', min: 0.1, max: 100, step: 0.1 },
    { k: 'release_ms', label: 'Release ms', min: 1, max: 1000, step: 1 },
  ]},
  Gain: { params: { gain_db: 0 }, schema: [
    { k: 'gain_db', label: 'Gain dB', min: -24, max: 24, step: 0.5 },
  ]},
  AutoTune: { params: { key: 'C', mode: 'major', strength: 'hard' }, schema: [
    { k: 'key', label: 'Key', options: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] },
    { k: 'mode', label: 'Mode', options: ['major','minor'] },
    { k: 'strength', label: 'Strength', options: ['hard','soft'] },
  ]},
  DeEsser: { params: { threshold_db: -25 }, schema: [
    { k: 'threshold_db', label: 'Threshold dB', min: -40, max: 0, step: 0.5 },
  ]},
  Doubler: { params: { cents: 10, delay_ms: 20, mix: 0.4 }, schema: [
    { k: 'cents', label: 'Cents', min: 1, max: 50, step: 1 },
    { k: 'delay_ms', label: 'Delay ms', min: 5, max: 50, step: 1 },
    { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
  ]},
  VocalExciter: { params: { drive: 0.3 }, schema: [
    { k: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01 },
  ]},
};

const PRESETS = {
  'Modern Pop Vocal': [
    { type: 'Compressor', params: { threshold_db: -18, ratio: 3, attack_ms: 5, release_ms: 80 }},
    { type: 'DeEsser', params: { threshold_db: -22 }},
    { type: 'AutoTune', params: { key: 'C', mode: 'major', strength: 'soft' }},
    { type: 'Reverb', params: { room_size: 0.4, wet_level: 0.18, dry_level: 0.85, damping: 0.5, width: 0.9 }},
    { type: 'Limiter', params: { threshold_db: -2, release_ms: 50 }},
  ],
  'Lo-Fi': [
    { type: 'LowpassFilter', params: { cutoff_frequency_hz: 6000 }},
    { type: 'Chorus', params: { rate_hz: 0.8, depth: 0.3, centre_delay_ms: 8, feedback: 0.1, mix: 0.4 }},
    { type: 'Distortion', params: { drive_db: 6 }},
    { type: 'Reverb', params: { room_size: 0.3, wet_level: 0.2, dry_level: 0.8, damping: 0.6, width: 0.7 }},
  ],
  'Telephone': [
    { type: 'HighpassFilter', params: { cutoff_frequency_hz: 400 }},
    { type: 'LowpassFilter', params: { cutoff_frequency_hz: 3500 }},
    { type: 'Distortion', params: { drive_db: 10 }},
  ],
  'Stadium': [
    { type: 'Reverb', params: { room_size: 0.95, wet_level: 0.45, dry_level: 0.6, damping: 0.4, width: 1.0 }},
    { type: 'Delay', params: { delay_seconds: 0.35, feedback: 0.3, mix: 0.25 }},
    { type: 'Chorus', params: { rate_hz: 0.6, depth: 0.2, centre_delay_ms: 8, feedback: 0.05, mix: 0.3 }},
  ],
  'Robotic Auto-Tune': [
    { type: 'AutoTune', params: { key: 'A', mode: 'minor', strength: 'hard' }},
    { type: 'Chorus', params: { rate_hz: 1.5, depth: 0.4, centre_delay_ms: 6, feedback: 0.2, mix: 0.5 }},
    { type: 'Delay', params: { delay_seconds: 0.18, feedback: 0.25, mix: 0.2 }},
  ],
  'Whisper Intimate': [
    { type: 'Compressor', params: { threshold_db: -28, ratio: 4, attack_ms: 8, release_ms: 120 }},
    { type: 'DeEsser', params: { threshold_db: -28 }},
    { type: 'Reverb', params: { room_size: 0.2, wet_level: 0.15, dry_level: 0.9, damping: 0.7, width: 0.6 }},
    { type: 'LowpassFilter', params: { cutoff_frequency_hz: 11000 }},
  ],
  'Doubled Wide': [
    { type: 'Doubler', params: { cents: 12, delay_ms: 22, mix: 0.45 }},
    { type: 'Reverb', params: { room_size: 0.3, wet_level: 0.18, dry_level: 0.85, damping: 0.5, width: 1.0 }},
  ],
  'Radio Voice': [
    { type: 'HighpassFilter', params: { cutoff_frequency_hz: 120 }},
    { type: 'Compressor', params: { threshold_db: -22, ratio: 5, attack_ms: 2, release_ms: 60 }},
    { type: 'DeEsser', params: { threshold_db: -22 }},
    { type: 'Gain', params: { gain_db: 3 }},
    { type: 'Limiter', params: { threshold_db: -1, release_ms: 50 }},
  ],
  'Cathedral': [
    { type: 'Reverb', params: { room_size: 1.0, wet_level: 0.55, dry_level: 0.5, damping: 0.2, width: 1.0 }},
    { type: 'Delay', params: { delay_seconds: 0.5, feedback: 0.35, mix: 0.2 }},
  ],
  'Tape Saturation': [
    { type: 'Distortion', params: { drive_db: 4 }},
    { type: 'Chorus', params: { rate_hz: 0.5, depth: 0.15, centre_delay_ms: 7, feedback: 0.1, mix: 0.25 }},
    { type: 'LowpassFilter', params: { cutoff_frequency_hz: 12000 }},
    { type: 'HighpassFilter', params: { cutoff_frequency_hz: 80 }},
  ],
};

const presetGrid = $('#preset-grid');
for (const name of Object.keys(PRESETS)) {
  const b = document.createElement('button');
  b.className = 'preset';
  b.textContent = name;
  b.addEventListener('click', () => {
    state.fxChain = JSON.parse(JSON.stringify(PRESETS[name])).map((s) => ({
      ...s, enabled: true, _id: Math.random().toString(36).slice(2, 9),
    }));
    renderFxChain();
  });
  presetGrid.appendChild(b);
}

function renderFxChain() {
  const ul = $('#fx-chain');
  ul.innerHTML = '';
  state.fxChain.forEach((step, idx) => {
    const li = document.createElement('li');
    li.className = 'fx-card';
    if (!step.enabled) li.classList.add('bypass');
    const head = document.createElement('div');
    head.className = 'fx-head';
    const title = document.createElement('span');
    title.className = 'fx-title';
    title.textContent = step.type;
    const ctrls = document.createElement('span');
    ctrls.className = 'fx-ctrls';

    const upBtn = makeMini('▲', 'Move up');
    upBtn.addEventListener('click', () => moveFx(idx, -1));
    const downBtn = makeMini('▼', 'Move down');
    downBtn.addEventListener('click', () => moveFx(idx, +1));
    const bypassBtn = makeMini(step.enabled ? 'On' : 'Off', 'Bypass');
    bypassBtn.classList.toggle('on', !!step.enabled);
    bypassBtn.addEventListener('click', () => {
      step.enabled = !step.enabled; renderFxChain();
    });
    const rmBtn = makeMini('✕', 'Remove');
    rmBtn.addEventListener('click', () => {
      state.fxChain.splice(idx, 1); renderFxChain();
    });

    ctrls.append(upBtn, downBtn, bypassBtn, rmBtn);
    head.append(title, ctrls);
    li.appendChild(head);

    const def = FX_DEFS[step.type];
    if (def) {
      const params = document.createElement('div');
      params.className = 'fx-params';
      for (const s of def.schema) {
        const row = document.createElement('div');
        row.className = 'fx-row';
        const lbl = document.createElement('label');
        lbl.textContent = s.label;
        row.appendChild(lbl);
        if (s.options) {
          const sel = document.createElement('select');
          for (const opt of s.options) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (step.params[s.k] === opt) o.selected = true;
            sel.appendChild(o);
          }
          sel.addEventListener('change', () => { step.params[s.k] = sel.value; });
          row.appendChild(sel);
        } else {
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = s.min; inp.max = s.max; inp.step = s.step;
          inp.value = step.params[s.k];
          const val = document.createElement('span');
          val.className = 'fx-val';
          val.textContent = step.params[s.k];
          inp.addEventListener('input', () => {
            step.params[s.k] = parseFloat(inp.value);
            val.textContent = inp.value;
          });
          row.appendChild(inp);
          row.appendChild(val);
        }
        params.appendChild(row);
      }
      li.appendChild(params);
    }
    ul.appendChild(li);
  });
}
function makeMini(text, title) {
  const b = document.createElement('button');
  b.className = 'fx-mini'; b.textContent = text; b.title = title;
  return b;
}
function moveFx(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.fxChain.length) return;
  const tmp = state.fxChain[idx];
  state.fxChain[idx] = state.fxChain[j];
  state.fxChain[j] = tmp;
  renderFxChain();
}

$('#add-fx-btn').addEventListener('click', () => {
  const t = $('#add-fx-select').value;
  const def = FX_DEFS[t];
  if (!def) return;
  state.fxChain.push({
    type: t,
    enabled: true,
    _id: Math.random().toString(36).slice(2, 9),
    params: JSON.parse(JSON.stringify(def.params)),
  });
  renderFxChain();
});
$('#clear-chain').addEventListener('click', () => { state.fxChain = []; renderFxChain(); });

function setSpiceSource(filePath, displayName) {
  state.spice.sourcePath = filePath;
  state.spice.originalForAB = filePath;
  $('#spice-source-name').textContent = displayName || filePath.split(/[\\/]/).pop();
  const aud = $('#spice-source-audio');
  aud.src = 'file:///' + encodeURI(filePath.replace(/\\/g, '/'));
  aud.classList.remove('hidden');
}
$('#spice-pick').addEventListener('click', async () => {
  const f = await window.api.pickAudio();
  if (f) setSpiceSource(f);
});
const spiceRecBtn = $('#spice-record');
spiceRecBtn.addEventListener('click', async () => {
  if (activeRecorder && recorderTarget === 'spice') {
    const filePath = await stopRecording($('#spice-source-name'), spiceRecBtn);
    if (filePath) setSpiceSource(filePath, 'Recorded vocal');
    recorderTarget = null;
  } else if (!activeRecorder) {
    const statusSpan = $('#spice-source-name');
    statusSpan.classList.remove('hidden');
    startRecording('spice', statusSpan, spiceRecBtn);
  }
});

$('#magic-vocal').addEventListener('click', async () => {
  if (!state.spice.sourcePath) {
    $('#magic-result').textContent = 'Pick or record a vocal first.';
    return;
  }
  $('#magic-result').textContent = 'Listening...';
  try {
    const r = await window.api.analyzeVocal({ inputPath: state.spice.sourcePath });
    if (!r || r.error) {
      $('#magic-result').textContent = 'Analyze failed: ' + (r && r.error || 'unknown');
      return;
    }
    const p = r.pitch_hz;
    const summary =
      `pitch ${Math.round(p.low)}-${Math.round(p.high)} Hz · ` +
      `dynamic range ${r.dynamic_range_db.toFixed(1)} dB · ` +
      `sibilance ${(r.sibilance_ratio * 100).toFixed(0)}%`;
    $('#magic-result').innerHTML =
      `<b>${r.suggested_preset}</b> &mdash; ${r.rationale}<br><span class="muted">${summary}</span>` +
      ` <button id="magic-apply" class="ghost small">Apply preset</button>`;
    document.getElementById('magic-apply').addEventListener('click', () => {
      const preset = PRESETS[r.suggested_preset];
      if (!preset) return;
      state.fxChain = JSON.parse(JSON.stringify(preset)).map((s) => ({
        ...s, enabled: true, _id: Math.random().toString(36).slice(2, 9),
      }));
      renderFxChain();
    });
  } catch (e) {
    $('#magic-result').textContent = 'Analyze failed: ' + (e.message || e);
  }
});

$('#apply-fx').addEventListener('click', async () => {
  if (!state.spice.sourcePath) {
    $('#spice-status-text').textContent = 'Pick a source first.';
    $('#spice-status').classList.remove('hidden');
    return;
  }
  $('#spice-result').classList.add('hidden');
  $('#spice-status').classList.remove('hidden');
  $('#spice-status-text').textContent = 'Processing chain...';
  try {
    const r = await window.api.applyFx({
      inputPath: state.spice.sourcePath,
      chain: state.fxChain,
    });
    state.spice.lastResult = r.file;
    $('#spice-result-title').textContent = r.file.split(/[\\/]/).pop();
    const aud = $('#spice-preview-audio');
    aud.src = 'file:///' + encodeURI(r.file.replace(/\\/g, '/'));
    aud.load();
    $('#spice-status').classList.add('hidden');
    $('#spice-result').classList.remove('hidden');
  } catch (e) {
    $('#spice-status-text').textContent = 'Error: ' + (e.message || e);
  }
});

$('#spice-ab').addEventListener('click', () => {
  const aud = $('#spice-preview-audio');
  if (!aud.src || !state.spice.originalForAB) return;
  const isProcessed = aud.dataset.showing !== 'orig';
  if (isProcessed) {
    aud.src = 'file:///' + encodeURI(state.spice.originalForAB.replace(/\\/g, '/'));
    aud.dataset.showing = 'orig';
    $('#spice-result-title').textContent = '[ A: original ] '
      + state.spice.originalForAB.split(/[\\/]/).pop();
  } else {
    aud.src = 'file:///' + encodeURI(state.spice.lastResult.replace(/\\/g, '/'));
    aud.dataset.showing = 'proc';
    $('#spice-result-title').textContent = '[ B: processed ] '
      + state.spice.lastResult.split(/[\\/]/).pop();
  }
  aud.load();
});

$('#spice-reveal').addEventListener('click', () => {
  if (state.spice.lastResult) window.api.reveal(state.spice.lastResult);
});
$('#spice-drag').addEventListener('dragstart', (e) => {
  if (!state.spice.lastResult) { e.preventDefault(); return; }
  e.preventDefault();
  window.api.startDrag(state.spice.lastResult);
});

// ==================== Voice -> MIDI ====================

const instrumentGrid = $('#instrument-grid');
instrumentGrid.addEventListener('click', (e) => {
  const b = e.target.closest('.inst');
  if (!b) return;
  instrumentGrid.querySelectorAll('.inst').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.vm.instrumentProgram = parseInt(b.dataset.program, 10);
  state.vm.isDrums = b.dataset.drums === 'true';
});

function setVmSource(filePath, displayName) {
  state.vm.sourcePath = filePath;
  $('#vm-source-name').textContent = displayName || filePath.split(/[\\/]/).pop();
  const aud = $('#vm-source-audio');
  aud.src = 'file:///' + encodeURI(filePath.replace(/\\/g, '/'));
  aud.classList.remove('hidden');
}

$('#vm-pick').addEventListener('click', async () => {
  const f = await window.api.pickAudio();
  if (f) setVmSource(f);
});
const vmRecBtn = $('#vm-record');
vmRecBtn.addEventListener('click', async () => {
  if (activeRecorder && recorderTarget === 'vm') {
    const filePath = await stopRecording($('#vm-source-name'), vmRecBtn);
    if (filePath) setVmSource(filePath, 'Recorded vocal');
    recorderTarget = null;
  } else if (!activeRecorder) {
    const statusSpan = $('#vm-source-name');
    statusSpan.classList.remove('hidden');
    startRecording('vm', statusSpan, vmRecBtn);
  }
});

$('#vm-go').addEventListener('click', async () => {
  if (!state.vm.sourcePath) {
    $('#vm-status-text').textContent = 'Pick or record a vocal first.';
    $('#vm-status').classList.remove('hidden');
    return;
  }
  $('#vm-result').classList.add('hidden');
  $('#vm-status').classList.remove('hidden');
  $('#vm-status-text').textContent = 'Transcribing pitch... (first run is slow)';
  try {
    const r = await window.api.vocalToMidi({
      vocalPath: state.vm.sourcePath,
      instrument: state.vm.instrumentProgram,
      isDrums: state.vm.isDrums,
    });
    if (!r || r.error) {
      $('#vm-status-text').textContent = 'Failed: ' + (r && r.error || 'unknown');
      return;
    }
    state.vm.lastResult = r.audio_file || null;
    drawPianoRoll(r.notes || []);
    if (r.audio_file) {
      const aud = $('#vm-preview-audio');
      aud.src = 'file:///' + encodeURI(r.audio_file.replace(/\\/g, '/'));
      aud.load();
      aud.classList.remove('hidden');
    } else {
      $('#vm-preview-audio').classList.add('hidden');
    }
    $('#vm-status').classList.add('hidden');
    $('#vm-result').classList.remove('hidden');
    if (!r.rendered) {
      $('#vm-status-text').textContent = 'Transcribed but render failed (fluidsynth missing). MIDI saved at ' + r.midi_file;
      $('#vm-status').classList.remove('hidden');
    }
  } catch (e) {
    $('#vm-status-text').textContent = 'Error: ' + (e.message || e);
  }
});

$('#vm-reveal').addEventListener('click', () => {
  if (state.vm.lastResult) window.api.reveal(state.vm.lastResult);
});
$('#vm-drag').addEventListener('dragstart', (e) => {
  if (!state.vm.lastResult) { e.preventDefault(); return; }
  e.preventDefault();
  window.api.startDrag(state.vm.lastResult);
});

function drawPianoRoll(notes) {
  const c = $('#piano-roll');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, c.width, c.height);
  if (!notes.length) {
    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText('No notes detected.', 12, 22);
    return;
  }
  const minPitch = Math.min(...notes.map((n) => n.pitch));
  const maxPitch = Math.max(...notes.map((n) => n.pitch));
  const span = Math.max(1, maxPitch - minPitch);
  const dur = Math.max(1, ...notes.map((n) => n.end));
  const pad = 4;
  for (const n of notes) {
    const x = pad + (n.start / dur) * (c.width - 2 * pad);
    const w = Math.max(2, ((n.end - n.start) / dur) * (c.width - 2 * pad));
    const y = (1 - (n.pitch - minPitch) / span) * (c.height - 2 * pad) + pad;
    const h = 6;
    const alpha = 0.4 + 0.6 * (n.velocity / 127);
    ctx.fillStyle = `rgba(217, 119, 6, ${alpha})`;
    ctx.fillRect(x, y, w, h);
  }
}

// ==================== Cookbook ====================

$('#cookbook-open-folder').addEventListener('click', async () => {
  const s = await window.api.getSettings();
  if (s.outputDir) window.api.reveal(s.outputDir);
});
$('#cookbook-refresh').addEventListener('click', () => updateOvenStatus());

// ==================== Auto-updater ====================

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

// First render of empty fx chain so the UI is consistent.
renderFxChain();
