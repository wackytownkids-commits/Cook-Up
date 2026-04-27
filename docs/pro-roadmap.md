# Cook Up Pro — Feature Roadmap

Brainstorm of candidate Pro features beyond the v1.1.4 launch set
(Voice → MIDI, long-form generation, ACE-Step Full Song mode in v1.2.0).
Not implemented; entries are sized by rough effort and bundle impact.

---

## 1. Stem Separation
Split any audio file into vocals / drums / bass / other tracks. Drag any
stem out of the app into a DAW. Powers a "Remix any song" workflow.

- Tech: **Demucs** (already a transitive dep of `audiocraft` — we may not
  even need new pip installs). Use `demucs.api.Separator` for programmatic
  use.
- UI: new tab "Kitchen Sink" with file picker → 4 result waveforms +
  per-stem drag-handles.
- Bundle impact: weights are ~75 MB, downloaded on first use.
- Effort: 2–3 days.

## 2. Realtime Monitoring
Hold the mic open, route through the Spice Rack chain, hear the processed
audio in your headphones with low latency. Lets users dial in vocal effects
in real time before committing to a take.

- Tech: Web Audio API for input → AudioWorklet that streams float blocks
  to a Python subprocess running pedalboard in a hot loop, returns
  processed blocks back. End-to-end ~30 ms latency target.
- Hard parts: avoiding GIL contention in Python during processing;
  buffer-underrun handling.
- Bundle impact: none (pedalboard already bundled).
- Effort: 1–2 weeks. Realtime audio is finicky.

## 3. VST/AU Plugin Hosting
Load any VST3 or AudioUnit plugin file into the Spice Rack. Pedalboard
supports this natively (`pedalboard.load_plugin(path)`); we just need a
file picker and a way to expose the plugin's parameters as sliders.

- Tech: `pedalboard.load_plugin` returns an instance whose parameters are
  introspectable.
- UI: new effect type "Custom Plugin", file dialog selects .vst3/.component,
  parameters auto-render as sliders.
- Bundle impact: none.
- Effort: 3–5 days for a robust UI; 1 day for MVP that exposes params as
  raw key→float pairs.

## 4. Multi-Track Timeline
Layer multiple Cook outputs + vocal takes + effects bus on a simple
timeline view. Bounce to a single mixed WAV.

- Tech: HTML5 canvas for the timeline; per-track `<audio>` elements played
  back via Web Audio API graph; scipy/soundfile for the bounce.
- UI: drag clips between tracks, set start time, mute/solo, master fader.
- Bundle impact: none.
- Effort: 2–3 weeks. This is most of a tiny DAW.

## 5. Master Chain Presets (LANDR-style)
"Ready for streaming" mastering button. Auto-applies a calibrated chain:
multiband compressor → EQ tilt → limiter targeting -14 LUFS for Spotify,
-16 LUFS for Apple Music, etc.

- Tech: pedalboard chain + `pyloudnorm` for target-LUFS measurement and
  loop-tune of limiter ceiling.
- UI: dropdown for target platform, "Master" button in result section.
- Bundle impact: ~5 MB (pyloudnorm + numpy already there).
- Effort: 3–4 days including calibration.

## 6. Cookbook Cloud Sync
Recipes (prompt + heat + bpm + ingredients metadata) and finished tracks
sync to a Cook Up account so users can resume work on another machine.

- Tech: Supabase or Firebase for the backend; signed URLs for audio.
- Privacy: never upload audio without an opt-in toggle per file.
- Bundle impact: small (just a fetch client).
- Effort: 1–2 weeks for a real implementation including auth.
- Caveat: pulls Cook Up out of "purely local" — needs a clear privacy
  story.

## 7. Priority CPU Mode
Set the Python subprocess to higher OS thread priority to reduce
generation time on busy machines. Windows: `psutil.HIGH_PRIORITY_CLASS`,
mac: `nice -10`. ~5–15% wall-time improvement.

- Tech: psutil already bundled.
- UI: toggle in Settings.
- Bundle impact: none.
- Effort: half a day.
- Why Pro: avoids accidental thermal throttling for casual users.

## 8. Higher-Quality Model Variants
Bundle MusicGen-Large (3.3B) and AudioLDM2 alongside the default
MusicGen-Melody-Medium. Users pick quality vs speed per cook.

- Tech: model picker in Stove + lazy-download for non-default weights.
- Bundle impact: download-on-demand only — base installer unchanged.
  Per-model weights: MusicGen-Large ~6 GB, AudioLDM2 ~1.2 GB.
- Effort: 2–3 days per model integrated.

## 9. Custom SoundFont Upload
Voice → MIDI currently renders through the bundled FluidR3Mono_GM. Pro
users can drag in their own .sf2/.sf3 files (orchestral, retro game,
custom drum kits) and use them for rendering.

- Tech: file picker → store path in settings → pass to fluidsynth.exe
  subprocess.
- UI: new field in the Voice → MIDI tab "Custom soundfont (.sf2/.sf3)".
- Bundle impact: none — user-supplied files.
- Effort: half a day.

---

## Sequencing thoughts

If we ship 2-3 of these in v1.3, candidate set:
1. **Stem Separation** — biggest immediate wow factor, low bundle cost
2. **VST/AU Plugin Hosting** — unlocks unbounded effect creativity for
   anyone who already owns plugins
3. **Master Chain Presets** — finishing-touch feature that lands cleanly
   on top of the existing Spice Rack

Skip Realtime Monitoring and Multi-Track Timeline until the user base
signals demand — they're high-effort and we'd be building most of a DAW.
