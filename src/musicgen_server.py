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
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify

# ---------- model state ----------
MODEL = None
MODEL_NAME = os.environ.get("COOKUP_MODEL", "facebook/musicgen-melody")
DEVICE = None

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
        data = request.get_json(force=True)
        prompt = (data.get("prompt") or "").strip()
        if not prompt:
            return jsonify({"error": "prompt is empty"}), 400

        duration = int(data.get("duration", 15))
        duration = max(4, min(duration, 600))

        heat = data.get("heat", "sear")
        bpm = data.get("bpm")
        reference_paths = data.get("reference_paths") or []
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        load_model()

        enriched = prompt
        if bpm:
            enriched = f"{prompt}, {int(bpm)} bpm"

        params = heat_to_params(heat)
        MODEL.set_generation_params(
            duration=duration,
            temperature=params["temperature"],
            cfg_coef=params["cfg_coef"],
            top_k=params["top_k"],
        )

        print(f"[cookup] cooking: '{enriched}' "
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
        out_path = str(Path(output_dir) / safe_filename(prompt))

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

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ---------- vocal-to-MIDI ----------

@app.route("/vocal-to-midi", methods=["POST"])
def vocal_to_midi():
    try:
        data = request.get_json(force=True)
        vocal_path = data.get("vocal_path")
        if not vocal_path or not os.path.exists(vocal_path):
            return jsonify({"error": "vocal_path missing or file not found"}), 400

        instrument_program = int(data.get("instrument", 0))  # GM program 0 = piano
        is_drums = bool(data.get("is_drums", False))
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        # 1. basic-pitch -> MIDI
        try:
            from basic_pitch.inference import predict
            from basic_pitch import ICASSP_2022_MODEL_PATH
        except Exception as e:
            return jsonify({"error": f"basic-pitch unavailable: {e}"}), 503

        print(f"[cookup] basic-pitch on {vocal_path}", flush=True)
        model_output, midi_data, note_events = predict(
            vocal_path,
            ICASSP_2022_MODEL_PATH,
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=80,
            minimum_frequency=50,
            maximum_frequency=2000,
        )

        # 2. Force the chosen instrument on every track of the predicted MIDI.
        for inst in midi_data.instruments:
            inst.program = instrument_program
            inst.is_drum = is_drums

        stem = Path(vocal_path).stem
        mid_out = Path(output_dir) / safe_filename(stem + "_midi", ".mid")
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

        # 4. Build a piano-roll-friendly notes list for the renderer.
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
        })
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


def autotune_audio(audio, sr, key="C", mode="major", strength="hard"):
    """Snap pitch to the nearest note in the chosen key.

    strength="hard": full snap (Cher-style).
    strength="soft": blend 50% with original f0.
    """
    import numpy as np
    import librosa
    pc = NOTE_NAMES_TO_PC.get(key.split()[0], 0)
    intervals = SCALE_INTERVALS.get(mode, SCALE_INTERVALS["major"])
    scale = sorted({(pc + i) % 12 for i in intervals})

    if audio.ndim == 2:
        # Pull to mono for pitch tracking; apply same shift to both channels.
        mono = audio.mean(axis=1)
    else:
        mono = audio
    f0, voiced_flag, _ = librosa.pyin(
        mono, fmin=80, fmax=1000, sr=sr, frame_length=2048, hop_length=512
    )
    n_frames = len(f0)
    out = np.zeros_like(audio if audio.ndim == 2 else mono)
    hop = 512
    for i in range(n_frames):
        if not voiced_flag[i] or np.isnan(f0[i]):
            target_shift = 0.0
        else:
            midi_note = librosa.hz_to_midi(f0[i])
            note_pc = int(round(midi_note)) % 12
            distances = [(s - note_pc) % 12 for s in scale]
            distances_signed = [d if d <= 6 else d - 12 for d in distances]
            best = min(distances_signed, key=lambda d: abs(d))
            target_midi = round(midi_note) + best
            cents_shift = (target_midi - midi_note) * 100
            if strength == "soft":
                cents_shift *= 0.5
            target_shift = cents_shift / 100.0  # semitones
        seg_start = i * hop
        seg_end = min(seg_start + hop, len(mono))
        if seg_end <= seg_start:
            continue
        seg = (audio[seg_start:seg_end] if audio.ndim == 2
               else audio[seg_start:seg_end])
        if abs(target_shift) > 1e-3 and seg.shape[0] > 64:
            try:
                if audio.ndim == 2:
                    shifted_l = librosa.effects.pitch_shift(seg[:, 0], sr=sr, n_steps=target_shift)
                    shifted_r = librosa.effects.pitch_shift(seg[:, 1], sr=sr, n_steps=target_shift)
                    shifted = np.stack([shifted_l, shifted_r], axis=1)
                else:
                    shifted = librosa.effects.pitch_shift(seg, sr=sr, n_steps=target_shift)
                # Length match (pitch_shift may differ by a few samples).
                m = min(seg.shape[0], shifted.shape[0])
                out[seg_start:seg_start + m] = shifted[:m]
            except Exception:
                out[seg_start:seg_end] = seg
        else:
            out[seg_start:seg_end] = seg
    return out


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
        for step in chain:
            t = step.get("type")
            p = step.get("params") or {}
            if not step.get("enabled", True):
                continue
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
            except Exception as e:
                traceback.print_exc()
                print(f"[cookup] effect {t} failed: {e}", flush=True)

        # Peak normalize so we don't clip; leave a little headroom.
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0.99:
            audio = audio * (0.95 / peak)

        out_path = str(Path(output_dir) / safe_filename(Path(in_path).stem + "_fx"))
        sf.write(out_path, audio, sr, subtype="PCM_16")
        return jsonify({"status": "ok", "file": out_path})
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
    app.run(host=host, port=port, threaded=False, use_reloader=False)
