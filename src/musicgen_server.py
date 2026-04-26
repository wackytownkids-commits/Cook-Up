"""
Cookup - local MusicGen + voice-to-MIDI + effects-rack server.

Loads Meta's MusicGen-Melody and exposes a small HTTP API on localhost.

Endpoints:
  GET  /health                 -> {"ok": bool, "model": str, "device": str}
  POST /warmup                 -> ensure model is loaded
  POST /generate               -> MusicGen text-to-music with optional melody refs
  POST /vocal-to-midi          -> basic-pitch -> MIDI -> fluidsynth render
  POST /effects                -> apply pedalboard chain + DIY effects to a WAV
  POST /analyze-vocal          -> Magic Vocal heuristic analysis of a vocal WAV
"""

import os
import sys
import time
import json
import shutil
import traceback
import subprocess
import threading
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify

# ---------- model state ----------
MODEL = None
MODEL_NAME = os.environ.get("COOKUP_MODEL", "facebook/musicgen-melody")
DEVICE = None

# Cooperative cancellation. /cancel sets the event; long-running jobs
# poll it (per-token in MusicGen, per-chunk in basic-pitch, per-effect
# in the FX chain) and raise CancelledByUser when set. Each request that
# starts a job calls .clear() first so a stale signal doesn't kill it.
CANCEL_EVENT = threading.Event()
JOB_LOCK = threading.Lock()


class CancelledByUser(Exception):
    pass


def begin_job():
    """Clear any leftover cancel signal before starting work."""
    CANCEL_EVENT.clear()


def check_cancelled():
    if CANCEL_EVENT.is_set():
        raise CancelledByUser("cancelled by user")


app = Flask(__name__)


def app_root():
    """Resolve the python-runtime sibling assets directory.

    When packaged, python-runtime/ lives under resources/python-runtime/ and
    this server runs as resources/app.asar.unpacked/src/musicgen_server.py.
    Either way, cookup-assets/ sits next to the python.exe.
    """
    # python.exe is the executable that imported us; sys.executable is the
    # most reliable anchor whether packaged or in dev.
    return Path(sys.executable).parent


def assets_dir():
    return app_root() / "cookup-assets"


def soundfont_path():
    # Prefer SF3 (compressed) if present; fall back to SF2 if someone
    # swapped in a different soundfont locally.
    sf3 = assets_dir() / "FluidR3Mono_GM.sf3"
    if sf3.exists():
        return sf3
    return assets_dir() / "TimGM6mb.sf2"


def fluidsynth_exe():
    candidate = assets_dir() / "fluidsynth" / "bin" / "fluidsynth.exe"
    if candidate.exists():
        return str(candidate)
    # Fallback: maybe on PATH (dev environments).
    found = shutil.which("fluidsynth")
    return found


def pick_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model():
    global MODEL, DEVICE
    if MODEL is not None:
        return
    from audiocraft.models import MusicGen
    DEVICE = pick_device()
    print(f"[cookup] loading {MODEL_NAME} on {DEVICE}...", flush=True)
    t0 = time.time()
    MODEL = MusicGen.get_pretrained(MODEL_NAME, device=DEVICE)
    print(f"[cookup] model loaded in {time.time()-t0:.1f}s", flush=True)


def heat_to_params(heat: str):
    heat = (heat or "sear").lower()
    if heat == "simmer":
        return {"temperature": 0.8, "cfg_coef": 2.5, "top_k": 200}
    if heat == "flambe" or heat == "flambé":
        return {"temperature": 1.2, "cfg_coef": 4.5, "top_k": 350}
    return {"temperature": 1.0, "cfg_coef": 3.0, "top_k": 250}


def safe_filename(stem: str, suffix: str = ".wav") -> str:
    safe = "".join(c for c in stem if c.isalnum() or c in " -_").strip().replace(" ", "_")[:40] or "out"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{safe}__{stamp}{suffix}"


def smooth_chunk_boundaries(audio_np, sample_rate, chunk_seconds=18.0, fade_seconds=0.075):
    """Equal-power crossfade over chunk boundaries.

    MusicGen >30s outputs are autoregressive sliding windows stitched without
    a crossfade, which often clicks at boundaries. We can't see the exact
    stitch points after the fact, but the audiocraft default extend_stride
    is 18s, so we apply a short equal-power fade every 18s as a best-effort
    de-click. fade_seconds is the half-width of the fade region.
    """
    import numpy as np
    if audio_np.ndim == 1:
        audio_np = audio_np[:, None]
    n_samples, n_ch = audio_np.shape
    fade_n = max(8, int(fade_seconds * sample_rate))
    chunk_n = int(chunk_seconds * sample_rate)
    if n_samples <= chunk_n + fade_n:
        return audio_np  # short clip, nothing to do
    # Equal-power windows.
    t = np.linspace(0, np.pi / 2, fade_n, endpoint=False)
    fade_in = np.sin(t)[:, None]
    fade_out = np.cos(t)[:, None]
    out = audio_np.copy()
    boundary = chunk_n
    while boundary + fade_n <= n_samples:
        a_start = boundary - fade_n
        a_end = boundary
        b_start = boundary
        b_end = boundary + fade_n
        # Blend: a's tail with b's head, both already at full level
        # (MusicGen's stitch is hard-cut, not overlap-add). We treat the
        # samples around the boundary as the "split" and apply a short
        # raised-cosine fade across it to soften any pop.
        head = out[a_start:a_end] * fade_out
        tail = out[b_start:b_end] * fade_in
        # Blend head with the average so we don't lose energy:
        blended_head = head + tail * 0  # keep head's content faded out
        # Actually replace [a_start:b_end] with cross-faded blend of original:
        orig_head = out[a_start:a_end].copy()
        orig_tail = out[b_start:b_end].copy()
        out[a_start:a_end] = orig_head * fade_out + orig_tail * fade_in
        # tail region replaced by faded-in version blended with itself faded-out
        # (this keeps continuity at the join while not double-counting energy)
        boundary += chunk_n
    return out


# ---------- endpoints ----------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "loaded": MODEL is not None,
        "soundfont": soundfont_path().exists(),
        "fluidsynth": fluidsynth_exe() is not None,
    })


@app.route("/cancel", methods=["POST"])
def cancel():
    """Signal any running job to abort at its next checkpoint.

    Cheap, idempotent. The actual abort happens when the running job
    next calls check_cancelled() or its progress callback fires."""
    CANCEL_EVENT.set()
    return jsonify({"ok": True})


@app.route("/warmup", methods=["POST"])
def warmup():
    try:
        load_model()
        return jsonify({"ok": True, "device": DEVICE})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/generate", methods=["POST"])
def generate():
    try:
        with JOB_LOCK:
            begin_job()
        data = request.get_json(force=True)
        prompt = (data.get("prompt") or "").strip()
        # Empty prompt is allowed: with melody references we run pure
        # melody-conditioned generation; without references we run
        # unconditional. Audiocraft's MusicGen accepts description=None.

        duration = int(data.get("duration", 15))
        duration = max(4, min(duration, 600))

        heat = data.get("heat", "sear")
        bpm = data.get("bpm")
        reference_paths = data.get("reference_paths") or []
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        load_model()

        # Hook the per-token callback to (a) print progress for the
        # renderer's bar, AND (b) raise if cancellation has been requested.
        def progress_cb(done, total):
            print(f'{done:6d} / {total:6d}', end='\r', flush=True)
            if CANCEL_EVENT.is_set():
                raise CancelledByUser("cancelled by user")
        MODEL._progress_callback = progress_cb

        # Build the description we hand to MusicGen. None means "no text
        # conditioning" — audiocraft handles this by emitting a learned
        # null-text embedding.
        if prompt:
            enriched = f"{prompt}, {int(bpm)} bpm" if bpm else prompt
        elif bpm:
            enriched = f"instrumental music at {int(bpm)} bpm"
        else:
            enriched = None

        params = heat_to_params(heat)
        MODEL.set_generation_params(
            duration=duration,
            temperature=params["temperature"],
            cfg_coef=params["cfg_coef"],
            top_k=params["top_k"],
        )

        print(f"[cookup] cooking: prompt={enriched!r} "
              f"heat={heat} duration={duration}s refs={len(reference_paths)}",
              flush=True)

        audio_tensor = None
        sr = None
        if reference_paths:
            import librosa
            import torch as _torch
            ref = reference_paths[0]
            if os.path.exists(ref):
                audio_np, sr = librosa.load(ref, sr=None, mono=False)
                if audio_np.ndim == 1:
                    audio_np = audio_np[None, :]
                audio_tensor = _torch.from_numpy(audio_np).float()
                max_samples = sr * 30
                if audio_tensor.shape[-1] > max_samples:
                    audio_tensor = audio_tensor[..., :max_samples]

        t0 = time.time()
        if audio_tensor is not None and "melody" in MODEL_NAME:
            wav = MODEL.generate_with_chroma(
                descriptions=[enriched],
                melody_wavs=audio_tensor.unsqueeze(0),
                melody_sample_rate=sr,
                progress=True,
            )
        else:
            wav = MODEL.generate(descriptions=[enriched], progress=True)
        print(f"[cookup] generated in {time.time()-t0:.1f}s", flush=True)

        import soundfile as sf
        # Filename stem from prompt if any; otherwise use a kitchen pun stem.
        out_path = str(Path(output_dir) / safe_filename(prompt or "surprise"))

        audio = wav[0].cpu()
        peak = float(audio.abs().max())
        if peak > 0:
            audio = audio * (0.95 / peak)
        audio_np = audio.numpy().T

        # De-click chunk boundaries on long outputs.
        if duration > 30:
            audio_np = smooth_chunk_boundaries(audio_np, MODEL.sample_rate)

        import soundfile as sf
        sf.write(out_path, audio_np, MODEL.sample_rate, subtype="PCM_16")

        return jsonify({"status": "ok", "file": out_path, "duration": duration})

    except CancelledByUser:
        # Caller asked us to stop. No partial output file was written
        # because audiocraft never returned a tensor.
        return jsonify({"error": "cancelled", "cancelled": True}), 499
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            if MODEL is not None:
                MODEL._progress_callback = None
        except Exception:
            pass


# ---------- vocal-to-MIDI ----------

def beatbox_to_drum_midi(vocal_path, output_dir):
    """Detect onsets in a beatbox recording and classify each as a GM drum hit.

    Returns a (pretty_midi.PrettyMIDI, list[dict]) tuple. The dict list is
    {start, end, pitch, velocity, drum} per detected hit, suitable for the
    piano-roll viz with human-readable drum names.

    Classifier is a hand-tuned decision tree over per-onset spectral features
    (low/mid/high band energy + spectral centroid + ZCR). Not perfect, but
    way more useful than a generic note-detector for "boom/tss/ka" input.
    """
    import numpy as np
    import librosa
    import pretty_midi

    audio, sr = librosa.load(vocal_path, sr=22050, mono=True)
    if audio.size < sr // 4:
        return pretty_midi.PrettyMIDI(), []

    # Onset detection with envelope-based picking.
    onset_frames = librosa.onset.onset_detect(
        y=audio, sr=sr, hop_length=256, backtrack=True,
        delta=0.05, wait=2,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=256)
    if onset_times.size == 0:
        return pretty_midi.PrettyMIDI(), []

    # GM drum program (channel 9) note numbers.
    KICK = 36; SIDE_STICK = 37; SNARE = 38; CLAP = 39
    CLOSED_HAT = 42; PEDAL_HAT = 44; OPEN_HAT = 46
    LOW_TOM = 41; MID_TOM = 47; HI_TOM = 50
    CRASH = 49; RIDE = 51

    DRUM_NAMES = {
        KICK: "Kick", SIDE_STICK: "SideStick", SNARE: "Snare", CLAP: "Clap",
        CLOSED_HAT: "ClosedHat", PEDAL_HAT: "PedalHat", OPEN_HAT: "OpenHat",
        LOW_TOM: "LowTom", MID_TOM: "MidTom", HI_TOM: "HiTom",
        CRASH: "Crash", RIDE: "Ride",
    }

    nyq = sr / 2
    win_n = int(0.05 * sr)  # 50ms classification window

    def band_energy(seg, lo, hi):
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        freqs = np.fft.rfftfreq(len(seg), 1 / sr)
        mask = (freqs >= lo) & (freqs < min(hi, nyq))
        return float(np.sum(spec[mask] ** 2))

    midi = pretty_midi.PrettyMIDI()
    drum_inst = pretty_midi.Instrument(program=0, is_drum=True, name="BeatboxDrums")
    midi.instruments.append(drum_inst)

    notes_meta = []
    for t_start in onset_times:
        s_idx = int(t_start * sr)
        e_idx = min(len(audio), s_idx + win_n)
        seg = audio[s_idx:e_idx]
        if seg.size < 64:
            continue
        # Normalize the segment so loud kicks and quiet hats see comparable
        # band ratios; classification is about shape not absolute level.
        peak = float(np.max(np.abs(seg)))
        if peak < 1e-4:
            continue
        nseg = seg / peak
        e_low = band_energy(nseg, 20, 200)
        e_mid = band_energy(nseg, 200, 4000)
        e_hi  = band_energy(nseg, 4000, 16000)
        e_total = e_low + e_mid + e_hi + 1e-12
        f_low = e_low / e_total
        f_mid = e_mid / e_total
        f_hi  = e_hi / e_total
        zcr = float(np.mean(np.abs(np.diff(np.sign(nseg))) > 0))
        # Sustain: how long the energy stays above 25% of peak.
        env = np.abs(librosa.stft(seg.astype(np.float32), n_fft=256, hop_length=128))
        env_t = np.mean(env, axis=0)
        if env_t.size:
            env_t /= max(env_t.max(), 1e-6)
            sustain = float(np.sum(env_t > 0.25)) / env_t.size
        else:
            sustain = 0.0

        # Decision tree.
        if f_low > 0.55 and zcr < 0.18:
            note = KICK
        elif f_hi > 0.55 and zcr > 0.40:
            note = OPEN_HAT if sustain > 0.5 else CLOSED_HAT
        elif f_hi > 0.45 and sustain > 0.6:
            note = CRASH
        elif f_mid > 0.45 and zcr > 0.25 and sustain < 0.5:
            note = SNARE
        elif f_mid > 0.45 and sustain > 0.5:
            note = CLAP
        elif f_low > 0.4 and zcr > 0.22:
            note = LOW_TOM
        else:
            note = MID_TOM

        velocity = int(min(127, max(40, peak * 127 * 1.1)))
        # Each drum hit ~150ms; channel 9 ignores duration but pretty_midi
        # needs end > start.
        end = float(t_start) + 0.15
        drum_inst.notes.append(pretty_midi.Note(
            velocity=velocity, pitch=int(note),
            start=float(t_start), end=end,
        ))
        notes_meta.append({
            "start": float(t_start), "end": end,
            "pitch": int(note), "velocity": velocity,
            "drum": DRUM_NAMES.get(note, "Drum"),
        })

    return midi, notes_meta


@app.route("/vocal-to-midi", methods=["POST"])
def vocal_to_midi():
    try:
        with JOB_LOCK:
            begin_job()
        data = request.get_json(force=True)
        vocal_path = data.get("vocal_path")
        if not vocal_path or not os.path.exists(vocal_path):
            return jsonify({"error": "vocal_path missing or file not found"}), 400

        # mode: 'melodic' | 'drums' | 'bass' | 'lead'
        mode = (data.get("mode") or "melodic").lower()
        instrument_program = int(data.get("instrument", 0))  # GM program 0 = piano
        is_drums = bool(data.get("is_drums", False))
        # Bass / lead modes override defaults.
        if mode == "bass":
            instrument_program, is_drums = 33, False
        elif mode == "lead":
            instrument_program, is_drums = 80, False
        elif mode == "drums":
            is_drums = True
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        # Two pipelines: beatbox-to-drums OR pitched basic-pitch.
        if mode == "drums":
            print(f"[cookup] beatbox-to-drums on {vocal_path}", flush=True)
            print("vmprogress 50 / 100", flush=True)
            check_cancelled()
            midi_data, drum_notes_meta = beatbox_to_drum_midi(vocal_path, output_dir)
            print("vmprogress 100 / 100", flush=True)
        else:
            try:
                from basic_pitch.inference import predict
                from basic_pitch import ICASSP_2022_MODEL_PATH
            except Exception as e:
                return jsonify({"error": f"basic-pitch unavailable: {e}"}), 503

            # Chunk audio into 20s windows so we can show per-chunk progress
            # AND check for cancellation between chunks.
            import librosa
            import soundfile as sf
            import pretty_midi
            import numpy as np

            CHUNK_SEC = 20.0
            audio, sr = librosa.load(vocal_path, sr=22050, mono=True)
            total_sec = len(audio) / sr
            n_chunks = max(1, int(np.ceil(total_sec / CHUNK_SEC)))
            print(f"[cookup] basic-pitch: {total_sec:.1f}s in {n_chunks} chunk(s)", flush=True)

            merged = pretty_midi.PrettyMIDI()
            merged_inst = pretty_midi.Instrument(program=instrument_program, is_drum=is_drums)
            merged.instruments.append(merged_inst)

            tmp_chunks_dir = Path(output_dir) / ".cookup-chunks"
            tmp_chunks_dir.mkdir(parents=True, exist_ok=True)

            for i in range(n_chunks):
                check_cancelled()
                start_s = i * CHUNK_SEC
                end_s = min(total_sec, (i + 1) * CHUNK_SEC)
                seg = audio[int(start_s * sr): int(end_s * sr)]
                if seg.size < sr // 4:
                    continue
                chunk_path = tmp_chunks_dir / f"chunk_{i:03d}.wav"
                sf.write(str(chunk_path), seg, sr, subtype="PCM_16")
                check_cancelled()
                _, midi_data, _ = predict(
                    str(chunk_path),
                    ICASSP_2022_MODEL_PATH,
                    onset_threshold=0.5,
                    frame_threshold=0.3,
                    minimum_note_length=80,
                    minimum_frequency=50,
                    maximum_frequency=2000,
                )
                # Bass mode: pull notes down an octave so they live in
                # bass register regardless of where the user sang.
                pitch_offset = -12 if mode == "bass" else 0
                for inst in midi_data.instruments:
                    for note in inst.notes:
                        merged_inst.notes.append(pretty_midi.Note(
                            velocity=note.velocity,
                            pitch=max(0, min(127, note.pitch + pitch_offset)),
                            start=note.start + start_s,
                            end=note.end + start_s,
                        ))
                try: chunk_path.unlink()
                except Exception: pass
                pct = int(round(((i + 1) / n_chunks) * 100))
                print(f"vmprogress {pct} / 100", flush=True)

            try: tmp_chunks_dir.rmdir()
            except Exception: pass
            midi_data = merged
            drum_notes_meta = None
        stem = Path(vocal_path).stem
        suffix_tag = ("_" + mode) if mode != "melodic" else "_midi"
        mid_out = Path(output_dir) / safe_filename(stem + suffix_tag, ".mid")
        midi_data.write(str(mid_out))

        # 3. Render via fluidsynth.exe to WAV.
        sf2 = soundfont_path()
        fs = fluidsynth_exe()
        wav_out = Path(output_dir) / safe_filename(stem + "_rendered", ".wav")
        rendered = False
        if fs and sf2.exists():
            cmd = [
                fs, "-ni", "-g", "1.0", "-r", "44100",
                "-F", str(wav_out),
                str(sf2), str(mid_out),
            ]
            print(f"[cookup] fluidsynth: {' '.join(cmd)}", flush=True)
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            rendered = (r.returncode == 0 and wav_out.exists())
            if not rendered:
                print(f"[cookup] fluidsynth stderr: {r.stderr}", flush=True)

        # Build a piano-roll-friendly notes list for the renderer. For
        # drums mode we already have nicely-tagged metadata; otherwise
        # derive it from the MIDI tracks.
        if drum_notes_meta is not None:
            notes = drum_notes_meta
        else:
            notes = []
            for inst in midi_data.instruments:
                for n in inst.notes:
                    notes.append({
                        "start": float(n.start),
                        "end": float(n.end),
                        "pitch": int(n.pitch),
                        "velocity": int(n.velocity),
                    })
            notes.sort(key=lambda x: x["start"])

        return jsonify({
            "status": "ok",
            "midi_file": str(mid_out),
            "audio_file": str(wav_out) if rendered else None,
            "notes": notes,
            "rendered": rendered,
            "mode": mode,
        })
    except CancelledByUser:
        # Best-effort cleanup of any temp chunk WAVs the cancellation
        # interrupted before merge.
        try:
            tmp = Path(output_dir) / ".cookup-chunks"
            if tmp.exists():
                for f in tmp.glob("*.wav"):
                    try: f.unlink()
                    except Exception: pass
                try: tmp.rmdir()
                except Exception: pass
        except Exception:
            pass
        return jsonify({"error": "cancelled", "cancelled": True}), 499
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ---------- effects rack ----------

NOTE_NAMES_TO_PC = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4,
    "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9,
    "A#": 10, "Bb": 10, "B": 11,
}
SCALE_INTERVALS = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),
}


def autotune_audio(audio, sr, key="C", mode="major", strength=1.0):
    """Snap pitch to the nearest note in the chosen key using PSOLA.

    The previous implementation chopped audio into per-frame segments and
    ran librosa.effects.pitch_shift on each one. That layered phase-vocoder
    artifacts at every segment boundary, producing audible static. PSOLA
    (Pitch-Synchronous Overlap-Add) handles the entire signal coherently
    given a continuous target-pitch contour.

    strength: 0.0 = no correction, 1.0 = full snap (Cher mode), 0.5 = subtle.
    Accepts the legacy strings 'hard' (1.0) and 'soft' (0.5) too.
    """
    import numpy as np
    import librosa
    import psola

    if isinstance(strength, str):
        strength = 1.0 if strength == "hard" else 0.5
    strength = float(max(0.0, min(1.0, strength)))

    pc = NOTE_NAMES_TO_PC.get(str(key).split()[0], 0)
    intervals = SCALE_INTERVALS.get(mode, SCALE_INTERVALS["major"])
    scale_pcs = sorted({(pc + i) % 12 for i in intervals})

    if audio.ndim == 2:
        # Treat as mono for analysis, mix back to stereo at the end.
        mono = audio.mean(axis=1).astype(np.float32)
    else:
        mono = audio.astype(np.float32)

    fmin, fmax = 70.0, 1000.0
    f0, voiced, _ = librosa.pyin(
        mono, fmin=fmin, fmax=fmax, sr=sr,
        frame_length=2048, hop_length=256, fill_na=np.nan,
    )

    # Build a target-pitch contour by snapping each voiced frame to the
    # nearest in-scale note, blended with the original by `strength`.
    target = np.copy(f0)
    voiced_idx = np.where(voiced & ~np.isnan(f0))[0]
    if voiced_idx.size:
        midi = librosa.hz_to_midi(f0[voiced_idx])
        # For each voiced frame, find the closest in-scale MIDI value.
        rounded = np.round(midi)
        snapped = np.copy(rounded)
        for i, n in enumerate(rounded):
            note_pc = int(n) % 12
            best = min(scale_pcs, key=lambda s: min(abs(s - note_pc), 12 - abs(s - note_pc)))
            # Pick the nearest octave's version of `best` to `n`.
            cand = int(n) - note_pc + best
            cands = [cand - 12, cand, cand + 12]
            snapped[i] = min(cands, key=lambda c: abs(c - n))
        snapped_hz = librosa.midi_to_hz(snapped)
        # Blend strength: 0 means keep original f0, 1 means full snap.
        target[voiced_idx] = (
            strength * snapped_hz + (1 - strength) * f0[voiced_idx]
        )

    # Smooth the contour over ~30ms so frame-to-frame jitter doesn't leak
    # into the vocoder as warble.
    from scipy.ndimage import median_filter
    smoothed = np.copy(target)
    voiced_mask = ~np.isnan(target)
    if voiced_mask.any():
        smoothed[voiced_mask] = median_filter(target[voiced_mask], size=5)
    smoothed = np.where(np.isnan(smoothed), 0.0, smoothed).astype(np.float32)

    if audio.ndim == 2:
        try:
            l = psola.vocode(audio[:, 0].astype(np.float32), sr,
                             target_pitch=smoothed, fmin=fmin, fmax=fmax)
            r = psola.vocode(audio[:, 1].astype(np.float32), sr,
                             target_pitch=smoothed, fmin=fmin, fmax=fmax)
            m = min(l.shape[0], r.shape[0])
            return np.stack([l[:m], r[:m]], axis=1)
        except Exception:
            traceback.print_exc()
            return audio
    try:
        return psola.vocode(mono, sr, target_pitch=smoothed, fmin=fmin, fmax=fmax)
    except Exception:
        traceback.print_exc()
        return audio


def deesser(audio, sr, threshold_db=-25.0):
    """Crude de-esser: detect 5-9kHz energy, attenuate when above threshold."""
    import numpy as np
    from scipy.signal import butter, sosfiltfilt
    sos_band = butter(4, [5000, min(9000, sr/2 - 1)], btype="bandpass", fs=sr, output="sos")
    if audio.ndim == 2:
        sib_l = sosfiltfilt(sos_band, audio[:, 0])
        sib_r = sosfiltfilt(sos_band, audio[:, 1])
        sib = (sib_l + sib_r) / 2
    else:
        sib = sosfiltfilt(sos_band, audio)
    win = max(64, int(0.005 * sr))
    energy = np.convolve(sib ** 2, np.ones(win) / win, mode="same")
    energy_db = 10 * np.log10(np.maximum(energy, 1e-12))
    threshold_lin = 10 ** (threshold_db / 10)
    excess = np.maximum(0, energy - threshold_lin)
    gain = 1 / (1 + 4 * (excess / max(threshold_lin, 1e-6)))
    if audio.ndim == 2:
        return audio * gain[:, None]
    return audio * gain


def doubler(audio, sr, cents=10.0, delay_ms=20.0, mix=0.4):
    """Parallel doubler: detune left/right copies, slight delay, pan wide."""
    import numpy as np
    import librosa
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=1)
    n = audio.shape[0]
    delay_n = int(delay_ms * sr / 1000)
    # Left side: pitched up +cents
    l_in = audio[:, 0]
    r_in = audio[:, 1]
    l_doubled = librosa.effects.pitch_shift(l_in, sr=sr, n_steps=cents / 100.0)
    r_doubled = librosa.effects.pitch_shift(r_in, sr=sr, n_steps=-cents / 100.0)
    # Pad delays
    l_pad = np.concatenate([np.zeros(delay_n), l_doubled])[:n]
    r_pad = np.concatenate([np.zeros(delay_n), r_doubled])[:n]
    out_l = audio[:, 0] * (1 - mix) + l_pad * mix
    out_r = audio[:, 1] * (1 - mix) + r_pad * mix
    return np.stack([out_l, out_r], axis=1)


def vocal_exciter(audio, sr, drive=0.3):
    """High-shelf around 8 kHz with mild tanh saturation."""
    import numpy as np
    from scipy.signal import butter, sosfiltfilt
    sos_hi = butter(2, 8000, btype="highpass", fs=sr, output="sos")
    if audio.ndim == 2:
        hi_l = sosfiltfilt(sos_hi, audio[:, 0])
        hi_r = sosfiltfilt(sos_hi, audio[:, 1])
        excited_l = np.tanh(hi_l * (1 + drive * 5)) * (1 + drive)
        excited_r = np.tanh(hi_r * (1 + drive * 5)) * (1 + drive)
        return np.stack([audio[:, 0] + excited_l * 0.3,
                         audio[:, 1] + excited_r * 0.3], axis=1)
    hi = sosfiltfilt(sos_hi, audio)
    excited = np.tanh(hi * (1 + drive * 5)) * (1 + drive)
    return audio + excited * 0.3


def apply_pedalboard_chain(audio, sr, effects):
    """Build a pedalboard.Pedalboard from a list of effect specs.

    Each spec: {"type": "Reverb", "params": {"room_size": 0.5, ...}}
    Unknown effect types are skipped silently.
    """
    import pedalboard
    board_effects = []
    EFFECT_MAP = {
        "Compressor": pedalboard.Compressor,
        "Reverb": pedalboard.Reverb,
        "Delay": pedalboard.Delay,
        "PitchShift": pedalboard.PitchShift,
        "LadderFilter": pedalboard.LadderFilter,
        "Chorus": pedalboard.Chorus,
        "Phaser": pedalboard.Phaser,
        "Distortion": pedalboard.Distortion,
        "Limiter": pedalboard.Limiter,
        "HighpassFilter": pedalboard.HighpassFilter,
        "LowpassFilter": pedalboard.LowpassFilter,
        "NoiseGate": pedalboard.NoiseGate,
        "Gain": pedalboard.Gain,
    }
    for spec in effects:
        cls = EFFECT_MAP.get(spec.get("type"))
        if not cls:
            continue
        try:
            board_effects.append(cls(**(spec.get("params") or {})))
        except Exception as e:
            print(f"[cookup] effect {spec.get('type')} init failed: {e}", flush=True)
    if not board_effects:
        return audio
    board = pedalboard.Pedalboard(board_effects)
    if audio.ndim == 1:
        return board(audio.astype("float32"), sr)
    # pedalboard expects [channels, samples].
    out = board(audio.T.astype("float32"), sr)
    return out.T


@app.route("/effects", methods=["POST"])
def effects():
    try:
        with JOB_LOCK:
            begin_job()
        import numpy as np
        import soundfile as sf

        data = request.get_json(force=True)
        in_path = data.get("input_path")
        if not in_path or not os.path.exists(in_path):
            return jsonify({"error": "input_path missing or file not found"}), 400
        chain = data.get("chain") or []
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        audio, sr = sf.read(in_path, always_2d=False)
        # Normalize to float32.
        if audio.dtype.kind in ("i", "u"):
            audio = audio.astype("float32") / max(1.0, np.iinfo(audio.dtype).max)

        # Apply each effect in chain order. DIY effects intercept by name;
        # everything else falls through to pedalboard.
        active = [s for s in chain if s.get("enabled", True)]
        n_active = max(1, len(active))
        done = 0
        for step in chain:
            t = step.get("type")
            p = step.get("params") or {}
            if not step.get("enabled", True):
                continue
            check_cancelled()
            try:
                if t == "AutoTune":
                    audio = autotune_audio(audio, sr,
                                           key=p.get("key", "C"),
                                           mode=p.get("mode", "major"),
                                           strength=p.get("strength", "hard"))
                elif t == "DeEsser":
                    audio = deesser(audio, sr, threshold_db=p.get("threshold_db", -25.0))
                elif t == "Doubler":
                    audio = doubler(audio, sr,
                                    cents=p.get("cents", 10.0),
                                    delay_ms=p.get("delay_ms", 20.0),
                                    mix=p.get("mix", 0.4))
                elif t == "VocalExciter":
                    audio = vocal_exciter(audio, sr, drive=p.get("drive", 0.3))
                else:
                    audio = apply_pedalboard_chain(audio, sr, [{"type": t, "params": p}])
            except CancelledByUser:
                raise
            except Exception as e:
                traceback.print_exc()
                print(f"[cookup] effect {t} failed: {e}", flush=True)
            done += 1
            pct = int(round((done / n_active) * 100))
            print(f"fxprogress {pct} / 100", flush=True)

        # Peak normalize so we don't clip; leave a little headroom.
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0.99:
            audio = audio * (0.95 / peak)

        out_path = str(Path(output_dir) / safe_filename(Path(in_path).stem + "_fx"))
        sf.write(out_path, audio, sr, subtype="PCM_16")
        return jsonify({"status": "ok", "file": out_path})
    except CancelledByUser:
        return jsonify({"error": "cancelled", "cancelled": True}), 499
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ---------- Magic Vocal analyzer ----------

@app.route("/analyze-vocal", methods=["POST"])
def analyze_vocal():
    try:
        import numpy as np
        import librosa
        data = request.get_json(force=True)
        in_path = data.get("input_path")
        if not in_path or not os.path.exists(in_path):
            return jsonify({"error": "input_path missing or file not found"}), 400

        audio, sr = librosa.load(in_path, sr=None, mono=True)
        if audio.size < sr // 2:
            return jsonify({"error": "clip too short to analyze (<0.5s)"}), 400

        # Pitch range (50th and 95th percentiles of voiced f0).
        f0, voiced, _ = librosa.pyin(audio, fmin=70, fmax=1000, sr=sr,
                                     frame_length=2048, hop_length=512)
        voiced_f0 = f0[voiced & ~np.isnan(f0)]
        if voiced_f0.size:
            pitch_low = float(np.percentile(voiced_f0, 5))
            pitch_high = float(np.percentile(voiced_f0, 95))
            pitch_med = float(np.median(voiced_f0))
        else:
            pitch_low = pitch_high = pitch_med = 0.0

        # Dynamic range (rms of loudest 20% over rms of quietest 20%).
        frame_n = 2048
        rms = librosa.feature.rms(y=audio, frame_length=frame_n, hop_length=512)[0]
        rms_sorted = np.sort(rms)
        q_low = float(np.mean(rms_sorted[:max(1, len(rms_sorted) // 5)]))
        q_high = float(np.mean(rms_sorted[-max(1, len(rms_sorted) // 5):]))
        dyn_db = 20 * np.log10(max(q_high, 1e-9) / max(q_low, 1e-9))

        # Sibilance: ratio of 5-9kHz energy to 80-3000Hz energy.
        from scipy.signal import butter, sosfiltfilt
        if sr / 2 > 9000:
            sos_sib = butter(4, [5000, 9000], btype="bandpass", fs=sr, output="sos")
            sib = sosfiltfilt(sos_sib, audio)
        else:
            sib = audio * 0
        sos_voc = butter(4, [80, 3000], btype="bandpass", fs=sr, output="sos")
        voc = sosfiltfilt(sos_voc, audio)
        sib_rms = float(np.sqrt(np.mean(sib ** 2)))
        voc_rms = float(np.sqrt(np.mean(voc ** 2)))
        sib_ratio = sib_rms / max(voc_rms, 1e-9)

        # Noise floor: the 5th percentile of frame-level RMS.
        noise_floor_db = 20 * np.log10(max(q_low, 1e-9))

        # Heuristic preset pick.
        if dyn_db > 18 and sib_ratio > 0.10:
            preset = "Modern Pop Vocal"
            why = "wide dynamic range + sibilance"
        elif noise_floor_db < -50 and dyn_db < 9:
            preset = "Whisper Intimate"
            why = "very low noise floor + small dynamic range"
        elif sib_ratio > 0.18:
            preset = "Radio Voice"
            why = "high sibilance, sounds spoken-word"
        elif dyn_db > 20:
            preset = "Stadium"
            why = "huge dynamic range"
        else:
            preset = "Doubled Wide"
            why = "balanced source"

        return jsonify({
            "status": "ok",
            "pitch_hz": {"low": pitch_low, "median": pitch_med, "high": pitch_high},
            "dynamic_range_db": dyn_db,
            "sibilance_ratio": sib_ratio,
            "noise_floor_db": noise_floor_db,
            "suggested_preset": preset,
            "rationale": why,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("COOKUP_PORT", "7781"))
    host = os.environ.get("COOKUP_HOST", "127.0.0.1")
    print(f"[cookup] server listening on http://{host}:{port}", flush=True)
    # threaded=True so /cancel can fire while a job is in flight.
    app.run(host=host, port=port, threaded=True, use_reloader=False)
