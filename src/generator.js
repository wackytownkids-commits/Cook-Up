// Cookup - talks to the local MusicGen Python server.
// The server is spawned by main.js and listens on http://127.0.0.1:COOKUP_PORT.

const fetch = require('node-fetch');

const DEFAULT_BASE = 'http://127.0.0.1:7781';

/**
 * generateBeat
 *   prompt           - vibe description
 *   referenceSongs   - [{ path, name }] first one is used as melody conditioning
 *   heat             - "simmer" | "sear" | "flambe"
 *   bpm              - number | null
 *   durationSec      - 4..30
 *   outputDir        - absolute path
 *   serverBase       - override base URL (defaults to DEFAULT_BASE)
 *   onProgress(msg)  - status updates
 * returns { filePath, durationSec, title }
 */
async function generateBeat({
  prompt,
  referenceSongs = [],
  heat = 'sear',
  bpm = null,
  durationSec = 15,
  outputDir,
  serverBase = DEFAULT_BASE,
  onProgress = () => {}
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Recipe is empty - describe the beat you want.');
  }

  onProgress('Sending to the stove...');

  const payload = {
    prompt: prompt.trim(),
    duration: durationSec,
    heat,
    bpm,
    reference_paths: referenceSongs.map(s => s.path),
    output_dir: outputDir
  };

  const res = await fetch(`${serverBase}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // MusicGen generation can take a while on CPU - give it up to 10 min.
    timeout: 10 * 60 * 1000,
    body: JSON.stringify(payload)
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Server error ${res.status}`);
  }

  onProgress('Done.');
  return {
    filePath: body.file,
    durationSec: body.duration,
    title: body.file ? body.file.split(/[\\/]/).pop() : 'beat.wav'
  };
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
    timeout: 10 * 60 * 1000
  });
  return res.json();
}

module.exports = { generateBeat, checkHealth, warmup, DEFAULT_BASE };
