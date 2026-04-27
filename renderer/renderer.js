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
  vm: { sourcePath: null, lastResult: null, instrumentProgram: 0, isDrums: false, mode: 'melodic' },
  fxChain: [],
  inputDeviceId: '',
  proEnabled: false,
  proSource: 'free',
};

// Pull persisted prefs on launch: mic deviceId so the very first recording
// uses the user's choice, plus Pro state so gates render correctly.
window.api.getSettings().then((s) => {
  state.inputDeviceId = s.inputDeviceId || '';
  state.proEnabled = !!s.proEnabled;
  state.proSource = s.proSource || 'free';
  applyProGates();
});

// ==================== Pro tier ====================

function applyProGates() {
  const pro = state.proEnabled;
  // Voice -> MIDI: swap the lock indicator and the gate landing card.
  const lock = document.getElementById('vm-lock');
  if (lock) lock.classList.toggle('hidden', pro);
  const gate = document.getElementById('vm-gate');
  const content = document.getElementById('vm-content');
  if (gate && content) {
    gate.classList.toggle('hidden', pro);
    content.classList.toggle('hidden', !pro);
  }
  // Stove duration: amber border + warning when free + value > 60.
  if (durationInput) {
    updateDurationGate();
  }
  // Settings plan badge.
  const badge = document.getElementById('plan-badge');
  if (badge) {
    if (pro) {
      badge.textContent = state.proSource === 'dev' ? 'Pro (dev)' : 'Pro';
      badge.classList.remove('plan-free');
      badge.classList.add('plan-pro');
    } else {
      badge.textContent = 'Free';
      badge.classList.add('plan-free');
      badge.classList.remove('plan-pro');
    }
  }
  const upgrade = document.getElementById('plan-upgrade');
  if (upgrade) upgrade.classList.toggle('hidden', pro);
}

// Real Buy Pro modal. Replaces the v1.1.4 "coming soon" placeholder.
// TODO: replace https://gumroad.com/l/cookup-pro with the user's
// confirmed Gumroad permalink once they share it. Hotfix patches just
// this string.
const GUMROAD_PRODUCT_URL = 'https://gumroad.com/l/cookup-pro';

function openBuyModal() {
  document.getElementById('buy-aftermath').classList.add('hidden');
  document.getElementById('buy-modal').classList.remove('hidden');
}
function closeBuyModal() {
  document.getElementById('buy-modal').classList.add('hidden');
}
document.getElementById('buy-close').addEventListener('click', closeBuyModal);
document.getElementById('buy-go').addEventListener('click', async () => {
  await window.api.openExternal(GUMROAD_PRODUCT_URL);
  // Don't auto-close: surface the "check your email" line so the user
  // knows what to do when they come back.
  document.getElementById('buy-aftermath').classList.remove('hidden');
});

function showDevToast(msg) {
  const t = document.getElementById('dev-toast');
  document.getElementById('dev-toast-text').textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2200);
}
document.getElementById('dev-toast-dismiss').addEventListener('click', () => {
  document.getElementById('dev-toast').classList.add('hidden');
});

// Upgrade buttons (Stove, Voice->MIDI gate, Settings) all route to the
// same Buy modal.
function openUpgradeModal() { openBuyModal(); }
document.getElementById('vm-upgrade').addEventListener('click', openUpgradeModal);
document.getElementById('vm-learn').addEventListener('click', openUpgradeModal);
document.getElementById('plan-upgrade').addEventListener('click', openUpgradeModal);

function fmtRelativeDays(iso) {
  if (!iso) return '';
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  return days + ' days ago';
}

function renderLicenseSection(license) {
  const enter = document.getElementById('license-enter');
  const manage = document.getElementById('license-manage');
  const summary = document.getElementById('license-summary');
  const planUpgrade = document.getElementById('plan-upgrade');
  if (license) {
    enter.classList.add('hidden');
    manage.classList.remove('hidden');
    if (planUpgrade) planUpgrade.classList.add('hidden');
    const emailBit = license.email ? ` for <b>${license.email}</b>` : '';
    summary.innerHTML =
      `Activated${emailBit} &middot; key ending in <b>${license.last4}</b> ` +
      `&middot; verified <b>${fmtRelativeDays(license.validatedAt)}</b>`;
  } else {
    enter.classList.remove('hidden');
    manage.classList.add('hidden');
    if (planUpgrade && !state.proEnabled) planUpgrade.classList.remove('hidden');
    summary.innerHTML = '';
  }
}

document.getElementById('s-license-save').addEventListener('click', async () => {
  const key = document.getElementById('s-license').value;
  const msg = document.getElementById('s-license-msg');
  const btn = document.getElementById('s-license-save');
  if (!key.trim()) {
    msg.textContent = 'Paste a license key first.';
    msg.style.color = '#ffb1bc';
    return;
  }
  msg.textContent = 'Verifying with Gumroad...';
  msg.style.color = '#9ca3af';
  btn.disabled = true;
  try {
    const r = await window.api.setLicense(key);
    if (r.ok) {
      msg.innerHTML = '&#10003; Pro unlocked. Thanks for buying.';
      msg.style.color = '#86efac';
      document.getElementById('s-license').value = '';
      // Auto-close the Buy modal if the user happened to leave it open.
      closeBuyModal();
    } else if (r.networkError) {
      msg.textContent = r.message;
      msg.style.color = '#fbbf24';
    } else {
      msg.textContent = r.message;
      msg.style.color = '#ffb1bc';
    }
  } catch (e) {
    msg.textContent = 'Unexpected error: ' + (e.message || e);
    msg.style.color = '#ffb1bc';
  } finally {
    btn.disabled = false;
  }
  const s = await window.api.getSettings();
  state.proEnabled = !!s.proEnabled;
  state.proSource = s.proSource || 'free';
  applyProGates();
  renderLicenseSection(s.license);
});

document.getElementById('s-license-deactivate').addEventListener('click', async () => {
  const ok = confirm(
    'Deactivate this Pro license on this machine? The key stays valid; ' +
    'you can re-activate it here or on another machine.'
  );
  if (!ok) return;
  await window.api.deactivateLicense();
  document.getElementById('s-license-msg').textContent = 'License deactivated on this machine.';
  document.getElementById('s-license-msg').style.color = '#9ca3af';
  const s = await window.api.getSettings();
  state.proEnabled = !!s.proEnabled;
  state.proSource = s.proSource || 'free';
  applyProGates();
  renderLicenseSection(s.license);
});

// Background re-validation past the offline grace period: tell the user.
window.api.onLicenseNeedsReverify((p) => {
  showDevToast('Pro license needs re-verifying - open Settings to retry');
});

// Dev backdoor: Ctrl+Shift+P while Settings dialog is open toggles dev Pro.
// Not surfaced in the UI on purpose; intentional discoverability via source.
document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p'))) return;
  if (settingsModal.classList.contains('hidden')) return;
  e.preventDefault();
  const r = await window.api.toggleDevPro();
  state.proEnabled = !!r.proEnabled;
  state.proSource = r.dev ? 'dev' : (state.proEnabled ? 'license' : 'free');
  applyProGates();
  showDevToast(r.dev ? 'Dev: Pro mode enabled' : 'Dev: Pro mode disabled');
});

// Cook time UX has two layers:
//   1. soft warning above 60s (15+ min wall-time, sliding-window stitching)
//   2. hard Pro gate: free tier capped at 60s, amber border + Pro CTA above
const durationInput = document.getElementById('duration');
const durationWarn = document.getElementById('duration-warn');
function updateDurationGate() {
  if (!durationInput || !durationWarn) return;
  const v = parseInt(durationInput.value, 10) || 0;
  const overSoft = v > 60;
  durationWarn.classList.toggle('hidden', !overSoft);
  if (overSoft && !state.proEnabled) {
    durationInput.classList.add('pro-locked');
    durationWarn.innerHTML =
      '<b>Cook Time over 60s requires Pro.</b> Free tier caps at 60s. ' +
      '<a href="#" id="duration-upgrade-link">Upgrade</a>';
    const link = document.getElementById('duration-upgrade-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); openUpgradeModal(); });
  } else if (overSoft) {
    durationInput.classList.remove('pro-locked');
    durationWarn.innerHTML =
      '<b>Heads up:</b> durations &gt;60s use sliding-window stitching ' +
      '(model regenerates every 18s with the prior chunk as primer). ' +
      'Quality degrades past 30s on CPU. Expect 15&ndash;25 min wall-time ' +
      'for &gt;120s. The Cancel button works during cook.';
  } else {
    durationInput.classList.remove('pro-locked');
  }
}
if (durationInput) {
  durationInput.addEventListener('input', updateDurationGate);
  updateDurationGate();
}

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
  // We never echo back the activated key for two reasons: it's secret-ish,
  // and showing it confuses the manage/enter UX. Manage mode handles display.
  $('#s-license').value = '';
  state.inputDeviceId = s.inputDeviceId || '';
  state.proEnabled = !!s.proEnabled;
  state.proSource = s.proSource || 'free';
  applyProGates();
  renderLicenseSection(s.license);
  document.getElementById('s-license-msg').textContent = '';
  await refreshMicList();
  try { $('#s-version').textContent = 'v' + (await window.api.getVersion()); } catch (_) {}
  settingsModal.classList.remove('hidden');
}
function closeSettings() { settingsModal.classList.add('hidden'); }
async function saveSettings() {
  state.inputDeviceId = $('#s-mic').value || '';
  await window.api.setSettings({
    pythonPath: $('#s-py').value.trim(),
    serverPort: parseInt($('#s-port').value, 10) || 7781,
    outputDir: $('#s-out').value.trim(),
    inputDeviceId: state.inputDeviceId,
  });
  closeSettings();
}

async function refreshMicList() {
  const sel = $('#s-mic');
  sel.innerHTML = '';
  try {
    // enumerateDevices() only returns labels for inputs the user has
    // already granted permission to. Trigger a one-shot getUserMedia()
    // so labels show up populated; we discard the stream immediately.
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (_) { /* user may deny; we'll show "device N" labels */ }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'System default';
    sel.appendChild(def);
    inputs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      if (d.deviceId === state.inputDeviceId) o.selected = true;
      sel.appendChild(o);
    });
    if (state.inputDeviceId === '') sel.value = '';
  } catch (e) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(could not enumerate)';
    sel.appendChild(o);
  }
}
$('#s-mic-refresh') && $('#s-mic-refresh').addEventListener('click', refreshMicList);

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
  state.songs.forEach((s, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    // First ingredient is the one MusicGen actually uses; mark it.
    name.textContent = (i === 0 ? '★ ' : '') + s.name;
    if (i === 0) name.title = 'This is the melody reference MusicGen uses';
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove';
    rm.addEventListener('click', () => {
      state.songs = state.songs.filter((x) => x.path !== s.path);
      renderSongs();
    });
    li.appendChild(name); li.appendChild(rm);
    list.appendChild(li);
  });
  // Surface the "first-only" note when there are 2+ ingredients.
  const note = document.getElementById('ingredient-note');
  if (note) note.classList.toggle('hidden', state.songs.length < 2);
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
    const constraints = state.inputDeviceId
      ? { audio: { deviceId: { exact: state.inputDeviceId } } }
      : { audio: true };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
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

// ----- Shared per-job timer (Spice / Voice->MIDI) -----
// Each is a tiny object so two jobs can't share state by accident.
function makeJobTimer({ statusEl, statusTextEl, timeEl, barEl }) {
  return {
    start: 0,
    last: { done: 0, total: 0, seen: false },
    interval: null,
    estimateSec: 0,
    begin(estimate) {
      this.start = Date.now();
      this.last = { done: 0, total: 0, seen: false };
      this.estimateSec = estimate || 60;
      if (this.interval) clearInterval(this.interval);
      this.interval = setInterval(() => this.tick(), 250);
      this.tick();
    },
    tick() {
      const elapsed = (Date.now() - this.start) / 1000;
      let pct, remaining;
      if (this.last.seen && this.last.total > 0 && this.last.done > 0) {
        pct = Math.min(99, (this.last.done / this.last.total) * 100);
        const projected = elapsed * (this.last.total / this.last.done);
        remaining = Math.max(0, projected - elapsed);
        this.estimateSec = projected;
      } else {
        if (elapsed > this.estimateSec * 0.9) {
          this.estimateSec = Math.max(this.estimateSec, elapsed * 1.4);
        }
        pct = Math.min(95, (elapsed / Math.max(1, this.estimateSec)) * 100);
        remaining = this.estimateSec - elapsed;
      }
      if (barEl) barEl.style.width = pct + '%';
      if (timeEl) {
        if (!this.last.seen && remaining < 5) {
          timeEl.textContent = fmtTime(elapsed) + ' elapsed';
        } else if (remaining < 5 && pct > 95) {
          timeEl.textContent = 'Almost done...';
        } else {
          timeEl.textContent =
            fmtTime(elapsed) + ' elapsed · ~' + fmtTime(Math.max(0, remaining)) + ' left';
        }
      }
    },
    finish(success) {
      if (this.interval) { clearInterval(this.interval); this.interval = null; }
      if (barEl) barEl.style.width = success ? '100%' : '0%';
      if (timeEl && success) {
        const total = (Date.now() - this.start) / 1000;
        timeEl.textContent = 'Done in ' + fmtTime(total);
      }
    },
    feedProgress(done, total, label) {
      this.last = { done, total, seen: true };
      if (statusTextEl && label) statusTextEl.textContent = label;
    },
  };
}

const spiceTimer = makeJobTimer({
  statusEl: $('#spice-status'),
  statusTextEl: $('#spice-status-text'),
  timeEl: $('#spice-status-time'),
  barEl: $('#spice-status-bar-fill'),
});
const vmTimer = makeJobTimer({
  statusEl: $('#vm-status'),
  statusTextEl: $('#vm-status-text'),
  timeEl: $('#vm-status-time'),
  barEl: $('#vm-status-bar-fill'),
});

// Distinct progress markers so each tab only updates its own bar.
window.api.onPyLog((s) => {
  const fxm = s.match(/fxprogress\s+(\d+)\s*\/\s*(\d+)/);
  if (fxm) spiceTimer.feedProgress(parseInt(fxm[1], 10), parseInt(fxm[2], 10),
    'Seasoning ' + fxm[1] + '%');
  const vmm = s.match(/vmprogress\s+(\d+)\s*\/\s*(\d+)/);
  if (vmm) vmTimer.feedProgress(parseInt(vmm[1], 10), parseInt(vmm[2], 10),
    'Transcribing ' + vmm[1] + '%');
});

// ==================== Stove: Cook button ====================

let cookCancelled = false;
const cancelCookBtn = $('#cancel-cook');

cancelCookBtn.addEventListener('click', async () => {
  if (cancelCookBtn.disabled) return;
  cancelCookBtn.disabled = true;
  cancelCookBtn.textContent = 'Cancelling...';
  cookCancelled = true;
  try { await window.api.cancelJob(); } catch (_) {}
});

generateBtn.addEventListener('click', async () => {
  const prompt = $('#prompt').value.trim();
  // Cook is always clickable. Empty prompt + no ingredient = unconditional
  // MusicGen, the server picks something up.
  let durationSec = parseInt($('#duration').value, 10);
  // Pro gate on duration. Show toast and bail; don't silently clamp because
  // the user explicitly typed something they wanted.
  if (durationSec > 60 && !state.proEnabled) {
    flashStoveStatus('This duration requires Pro. Stick to ≤60s or upgrade.');
    return;
  }

  resultBox.classList.add('hidden');
  statusBox.classList.remove('hidden');
  statusText.textContent = 'Lighting the burner...';
  statusTime.textContent = '';
  statusBarFill.style.width = '0%';
  flames.classList.add('on');
  burner.classList.add('hot');
  generateBtn.disabled = true;
  generateBtn.textContent = 'Cooking...';
  cookCancelled = false;
  cancelCookBtn.disabled = false;
  cancelCookBtn.textContent = 'Cancel';
  cancelCookBtn.classList.remove('hidden');

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
    const msg = err && err.message || String(err);
    statusText.textContent = cookCancelled || /cancel/i.test(msg)
      ? 'Cancelled.'
      : 'Error: ' + msg;
    finishCookTimer(false);
    if (cookCancelled || /cancel/i.test(msg)) {
      setTimeout(() => statusBox.classList.add('hidden'), 1500);
    }
  } finally {
    flames.classList.remove('on');
    burner.classList.remove('hot');
    generateBtn.disabled = false;
    generateBtn.textContent = 'Cook';
    cancelCookBtn.disabled = true;
    cookCancelled = false;
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
  AutoTune: { params: { key: 'C', mode: 'major', strength: 1.0 }, schema: [
    { k: 'key', label: 'Key', options: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] },
    { k: 'mode', label: 'Mode', options: ['major','minor'] },
    { k: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 },
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
    { type: 'AutoTune', params: { key: 'C', mode: 'major', strength: 0.5 }},
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
    { type: 'AutoTune', params: { key: 'A', mode: 'minor', strength: 1.0 }},
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

let spiceCancelled = false;
$('#spice-cancel').addEventListener('click', async () => {
  const btn = $('#spice-cancel');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Cancelling...';
  spiceCancelled = true;
  try { await window.api.cancelJob(); } catch (_) {}
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
  spiceCancelled = false;
  const cancelBtn = $('#spice-cancel');
  cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel';
  // Heuristic estimate: ~1 sec per active effect (pedalboard runs near-realtime).
  const active = state.fxChain.filter((s) => s.enabled !== false).length || 1;
  spiceTimer.begin(Math.max(2, active * 1.5));
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
    spiceTimer.finish(true);
    $('#spice-status').classList.add('hidden');
    $('#spice-result').classList.remove('hidden');
  } catch (e) {
    const msg = e && e.message || String(e);
    $('#spice-status-text').textContent = (spiceCancelled || /cancel/i.test(msg))
      ? 'Cancelled.' : 'Error: ' + msg;
    spiceTimer.finish(false);
    if (spiceCancelled || /cancel/i.test(msg)) {
      setTimeout(() => $('#spice-status').classList.add('hidden'), 1500);
    }
  } finally {
    cancelBtn.disabled = true;
    spiceCancelled = false;
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

const vmModeGrid = $('#vm-mode-grid');
vmModeGrid.addEventListener('click', (e) => {
  const b = e.target.closest('.vm-mode');
  if (!b) return;
  vmModeGrid.querySelectorAll('.vm-mode').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.vm.mode = b.dataset.mode;
  // Drums uses its own classification pipeline; bass/lead override the
  // GM program at the server. Show the right helper UI for each mode.
  const isDrums = state.vm.mode === 'drums';
  $('#vm-instrument-card').classList.toggle('hidden',
    isDrums || state.vm.mode === 'bass' || state.vm.mode === 'lead');
  $('#vm-beatbox-guide').classList.toggle('hidden', !isDrums);
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

let vmCancelled = false;
$('#vm-cancel').addEventListener('click', async () => {
  const btn = $('#vm-cancel');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Cancelling...';
  vmCancelled = true;
  try { await window.api.cancelJob(); } catch (_) {}
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
  vmCancelled = false;
  const cancelBtn = $('#vm-cancel');
  cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel';
  // Rough estimate: basic-pitch is ~0.4x realtime per chunk on CPU. Without
  // knowing source duration we just guess 30s; the per-chunk progress will
  // recalibrate within the first chunk.
  vmTimer.begin(30);
  try {
    const r = await window.api.vocalToMidi({
      vocalPath: state.vm.sourcePath,
      mode: state.vm.mode,
      instrument: state.vm.instrumentProgram,
      isDrums: state.vm.isDrums,
    });
    if (!r || r.error) {
      const msg = r && r.error || 'unknown';
      $('#vm-status-text').textContent = (vmCancelled || /cancel/i.test(msg))
        ? 'Cancelled.' : 'Failed: ' + msg;
      vmTimer.finish(false);
      if (vmCancelled || /cancel/i.test(msg)) {
        setTimeout(() => $('#vm-status').classList.add('hidden'), 1500);
      }
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
    vmTimer.finish(true);
    $('#vm-status').classList.add('hidden');
    $('#vm-result').classList.remove('hidden');
    if (!r.rendered) {
      $('#vm-status-text').textContent = 'Transcribed but render failed (fluidsynth missing). MIDI saved at ' + r.midi_file;
      $('#vm-status').classList.remove('hidden');
    }
  } catch (e) {
    const msg = e && e.message || String(e);
    $('#vm-status-text').textContent = (vmCancelled || /cancel/i.test(msg))
      ? 'Cancelled.' : 'Error: ' + msg;
    vmTimer.finish(false);
  } finally {
    cancelBtn.disabled = true;
    vmCancelled = false;
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
  // For beatbox/drums mode the server hands us a `drum` label per note;
  // when present we lay them out as labeled rows ordered by drum kind so
  // the user can read the rhythm at a glance.
  const isDrums = notes[0] && notes[0].drum;
  const dur = Math.max(1, ...notes.map((n) => n.end));
  const pad = 4;

  if (isDrums) {
    const order = ['Kick','Snare','Clap','LowTom','MidTom','HiTom',
                   'ClosedHat','PedalHat','OpenHat','Crash','Ride','SideStick'];
    const used = order.filter((d) => notes.some((n) => n.drum === d));
    const rowH = (c.height - 2 * pad) / Math.max(1, used.length);
    ctx.font = '11px monospace';
    used.forEach((label, i) => {
      const y = pad + i * rowH;
      ctx.fillStyle = '#444';
      ctx.fillRect(pad + 60, y + rowH / 2, c.width - 2 * pad - 60, 1);
      ctx.fillStyle = '#cfcfd6';
      ctx.fillText(label, pad + 4, y + rowH / 2 + 4);
    });
    for (const n of notes) {
      const i = used.indexOf(n.drum);
      if (i < 0) continue;
      const x = pad + 60 + (n.start / dur) * (c.width - 2 * pad - 60);
      const y = pad + i * rowH + rowH / 2 - 4;
      const alpha = 0.4 + 0.6 * (n.velocity / 127);
      ctx.fillStyle = `rgba(217, 119, 6, ${alpha})`;
      ctx.fillRect(x, y, 8, 8);
    }
    return;
  }

  const minPitch = Math.min(...notes.map((n) => n.pitch));
  const maxPitch = Math.max(...notes.map((n) => n.pitch));
  const span = Math.max(1, maxPitch - minPitch);
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
