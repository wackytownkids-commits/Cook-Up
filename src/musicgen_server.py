"""
Cookup - local MusicGen server.

Loads Meta's MusicGen-Melody model once and exposes a tiny HTTP API
on localhost. Cookup's Electron main process spawns this on launch.

Endpoints:
  GET  /health           -> {"ok": true, "model": "<name>", "device": "<cpu|mps|cuda>"}
  POST /generate         -> {"status": "ok", "file": "<path.wav>"}
     body JSON:
       prompt: str                 # required
       duration: int = 15          # seconds, max 30 for melody model
       heat: str = "sear"          # "simmer" | "sear" | "flambe"
       bpm: int | None             # optional tempo hint
       reference_paths: [str]      # optional audio files to condition on
       output_dir: str             # where to save the WAV

We use MusicGen-Melody so that uploaded reference songs actually shape
the output (it accepts an audio input as "melody conditioning"). On
Apple Silicon we use the MPS backend; otherwise CPU. First run downloads
~2GB of weights from Hugging Face, then everything is local forever.
"""

import os
import sys
import time
import json
import traceback
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify


# Defer heavy imports until after the server is up, so /health responds
# fast while the model loads.
MODEL = None
MODEL_NAME = os.environ.get("COOKUP_MODEL", "facebook/musicgen-melody")
DEVICE = None

app = Flask(__name__)


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
    """Map the kitchen metaphor to MusicGen sampling params."""
    heat = (heat or "sear").lower()
    if heat == "simmer":
        return {"temperature": 0.8, "cfg_coef": 2.5, "top_k": 200}
    if heat == "flambe" or heat == "flambé":
        return {"temperature": 1.2, "cfg_coef": 4.5, "top_k": 350}
    # sear (default)
    return {"temperature": 1.0, "cfg_coef": 3.0, "top_k": 250}


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "loaded": MODEL is not None,
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
        duration = max(4, min(duration, 600))  # hard ceiling at 10 minutes
        # MusicGen trains on 30s chunks; longer outputs stitch chunks together
        # autoregressively. Audiocraft handles the stitching when duration > 30.

        heat = data.get("heat", "sear")
        bpm = data.get("bpm")
        reference_paths = data.get("reference_paths") or []
        output_dir = data.get("output_dir") or str(Path.home() / "Music" / "Cookup")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        # Ensure model is loaded.
        load_model()

        # Fold BPM into the prompt if provided.
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

        # Melody conditioning: pass the FIRST reference audio into generate_with_chroma.
        # MusicGen-Melody only accepts one melody reference; if the user gave us
        # multiple, we pick the first. (Future: mix them down first.)
        audio_tensor = None
        sr = None
        if reference_paths:
            # Use librosa for reference audio - handles WAV/MP3/M4A/FLAC without
            # needing torchcodec or ffmpeg, which torchaudio.load now requires.
            import librosa
            import torch as _torch
            ref = reference_paths[0]
            if os.path.exists(ref):
                # sr=None keeps the original rate, mono=False keeps channels.
                audio_np, sr = librosa.load(ref, sr=None, mono=False)
                if audio_np.ndim == 1:
                    audio_np = audio_np[None, :]  # [samples] -> [1, samples]
                audio_tensor = _torch.from_numpy(audio_np).float()
                # Clip to 30s so long tracks don't eat memory.
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

        # Save WAV via soundfile (bundled libsndfile, no ffmpeg/torchcodec needed).
        import soundfile as sf
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe = "".join(c for c in prompt if c.isalnum() or c in " -_").strip().replace(" ", "_")[:40] or "beat"
        out_path = str(Path(output_dir) / f"{safe}__{stamp}.wav")

        audio = wav[0].cpu()
        # Peak-normalize with a little headroom so nothing clips.
        peak = float(audio.abs().max())
        if peak > 0:
            audio = audio * (0.95 / peak)
        # MusicGen gives [channels, samples]; soundfile wants [samples, channels].
        audio_np = audio.numpy().T
        sf.write(out_path, audio_np, MODEL.sample_rate, subtype="PCM_16")

        return jsonify({"status": "ok", "file": out_path, "duration": duration})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("COOKUP_PORT", "7781"))
    host = os.environ.get("COOKUP_HOST", "127.0.0.1")
    # Start the server immediately; the model loads on first /warmup or /generate.
    print(f"[cookup] server listening on http://{host}:{port}", flush=True)
    app.run(host=host, port=port, threaded=False, use_reloader=False)
