// Cookup - HTTP client for the local MusicGen + effects + voice server.
// All long jobs (generate / vocal-to-midi / apply-effects) talk to the
// Python server on localhost; we disable the fetch timeout entirely for
// those paths because the cancel button is the right escape hatch, and
// there's no proxy in between that could otherwise drop a long socket.

const fetch = require('node-fetch');

const DEFAULT_BASE = 'http://127.0.0.1:7781';
const NO_TIMEOUT = 0; // node-fetch v2: 0 disables the timeout entirely.

async function postJson(url, payload, opts = {}) {
  const { timeout = NO_TIMEOUT, signal } = opts;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout,
    signal,
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
  return body;
}

// Translate low-level fetch failures into something the user can act on.
// node-fetch surfaces a `FetchError` for socket timeouts and a TypeError
// (or AbortError) for AbortController-driven cancels.
function friendlyFetchError(err) {
  const msg = String(err && err.message || err || 'unknown');
  if (err && err.name === 'AbortError') return 'Cancelled.';
  if (/network timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
    return 'Generation took longer than expected. Try a shorter duration, or hit Cancel to start over.';
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(msg)) {
    return 'Lost connection to the local server. Try again — if it keeps happening, restart Cookup.';
  }
  return msg;
}

async function generateBeat({
  prompt,
  referenceSongs = [],
  heat = 'sear',
  bpm = null,
  durationSec = 15,
  outputDir,
  serverBase = DEFAULT_BASE,
  signal,
  onProgress = () => {},
}) {
  onProgress('Sending to the stove...');
  try {
    const body = await postJson(`${serverBase}/generate`, {
      prompt: (prompt || '').trim(),
      duration: durationSec,
      heat,
      bpm,
      reference_paths: referenceSongs.map((s) => s.path),
      output_dir: outputDir,
    }, { signal });
    onProgress('Done.');
    return {
      filePath: body.file,
      durationSec: body.duration,
      title: body.file ? body.file.split(/[\\/]/).pop() : 'beat.wav',
    };
  } catch (e) {
    throw new Error(friendlyFetchError(e));
  }
}

async function vocalToMidi({
  vocalPath, mode = 'melodic', instrument = 0, isDrums = false,
  outputDir, serverBase = DEFAULT_BASE, signal,
}) {
  try {
    return await postJson(`${serverBase}/vocal-to-midi`, {
      vocal_path: vocalPath,
      mode,
      instrument,
      is_drums: isDrums,
      output_dir: outputDir,
    }, { signal });
  } catch (e) {
    throw new Error(friendlyFetchError(e));
  }
}

async function applyEffects({ inputPath, chain, outputDir, serverBase = DEFAULT_BASE, signal }) {
  try {
    return await postJson(`${serverBase}/effects`, {
      input_path: inputPath,
      chain,
      output_dir: outputDir,
    }, { signal });
  } catch (e) {
    throw new Error(friendlyFetchError(e));
  }
}

async function analyzeVocal({ inputPath, serverBase = DEFAULT_BASE, signal }) {
  try {
    return await postJson(`${serverBase}/analyze-vocal`, {
      input_path: inputPath,
    }, { signal });
  } catch (e) {
    throw new Error(friendlyFetchError(e));
  }
}

async function cancelJob(serverBase = DEFAULT_BASE) {
  try {
    await fetch(`${serverBase}/cancel`, { method: 'POST', timeout: 2000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function checkHealth(serverBase = DEFAULT_BASE) {
  try {
    const res = await fetch(`${serverBase}/health`, { timeout: 1500 });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch (_) {
    return { ok: false };
  }
}

async function warmup(serverBase = DEFAULT_BASE) {
  // No timeout: warming a fresh-installed model can take minutes if the
  // user has a slow disk and the audiocraft cache hasn't been hit yet.
  const res = await fetch(`${serverBase}/warmup`, {
    method: 'POST',
    timeout: NO_TIMEOUT,
  });
  return res.json();
}

module.exports = {
  generateBeat,
  vocalToMidi,
  applyEffects,
  analyzeVocal,
  cancelJob,
  checkHealth,
  warmup,
  DEFAULT_BASE,
};
