// Cookup - HTTP client for the local MusicGen + effects + voice server.

const fetch = require('node-fetch');

const DEFAULT_BASE = 'http://127.0.0.1:7781';

async function postJson(url, payload, timeoutMs = 10 * 60 * 1000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
  return body;
}

async function generateBeat({
  prompt,
  referenceSongs = [],
  heat = 'sear',
  bpm = null,
  durationSec = 15,
  outputDir,
  serverBase = DEFAULT_BASE,
  onProgress = () => {},
}) {
  if (!prompt || !prompt.trim()) throw new Error('Recipe is empty - describe the beat you want.');
  onProgress('Sending to the stove...');
  const body = await postJson(`${serverBase}/generate`, {
    prompt: prompt.trim(),
    duration: durationSec,
    heat,
    bpm,
    reference_paths: referenceSongs.map((s) => s.path),
    output_dir: outputDir,
  });
  onProgress('Done.');
  return {
    filePath: body.file,
    durationSec: body.duration,
    title: body.file ? body.file.split(/[\\/]/).pop() : 'beat.wav',
  };
}

async function vocalToMidi({
  vocalPath, mode = 'melodic', instrument = 0, isDrums = false,
  outputDir, serverBase = DEFAULT_BASE,
}) {
  const body = await postJson(`${serverBase}/vocal-to-midi`, {
    vocal_path: vocalPath,
    mode,
    instrument,
    is_drums: isDrums,
    output_dir: outputDir,
  });
  return body;
}

async function applyEffects({ inputPath, chain, outputDir, serverBase = DEFAULT_BASE }) {
  const body = await postJson(`${serverBase}/effects`, {
    input_path: inputPath,
    chain,
    output_dir: outputDir,
  });
  return body;
}

async function analyzeVocal({ inputPath, serverBase = DEFAULT_BASE }) {
  const body = await postJson(`${serverBase}/analyze-vocal`, {
    input_path: inputPath,
  });
  return body;
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
  const res = await fetch(`${serverBase}/warmup`, {
    method: 'POST',
    timeout: 10 * 60 * 1000,
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
