"""
FILE: py/studio/speech.py
PURPOSE: What people say in the footage, as subtitles: speech found and written down on this PC, free. Each clip
         once, cached by its file name and length, so a copy of the same clip (the Google Photos copy and the
         original from Drive) is never transcribed twice.
OVERVIEW: transcribe(path) -> {"lang", "segments": [{start, end, text}]} for one clip; subtitles(shots) maps the
          segments of the parts of clips an edit uses onto its timeline and returns SRT text (Netflix timed-text
          rules: at most 42 characters a line, two lines, about 20 characters a second, at least 1 s on screen).
          Backends (settings(); STUDIO_WHISPER_BACKEND=auto|faster-whisper|mlx|off, default auto):
            faster-whisper  Silero VAD + CTranslate2. With an NVIDIA GPU (ctranslate2.get_cuda_device_count() > 0) it
                            runs on CUDA in float16, else on the CPU in int8; a CUDA that fails to run drops to the CPU.
            mlx             mlx-whisper on Apple silicon (Metal); auto picks it on macOS arm64 when it is installed.
            off             no transcription: every clip reads as silent and nothing is cached.
          STUDIO_WHISPER_MODEL names the model (default medium.en; medium when other languages are kept; mlx:
          mlx-community/whisper-large-v3-turbo). STUDIO_WHISPER_LANGUAGE (default en; a comma list such as en,ja)
          is the speech kept: other languages, and noise guessed as one, are dropped.
DEPENDENCIES: faster-whisper (MIT; "small" + "medium.en" fetched once from Hugging Face) or mlx-whisper (MIT; macOS
              arm64), ffmpeg
USAGE: python -m studio speech scan   (every video in the library; a vlog build also does its own clips)
NOTES: Speech is written down as heard. Nothing is translated or tidied by a language model, so a subtitle never
       says something nobody said. Wind, engines and animal sounds are not speech: VAD drops them (faster-whisper),
       and the same confidence filters (_keep) run on every backend.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import platform
import re
import sys
from pathlib import Path

from studio.config import DATA

CACHE = DATA / "speech"
DETECT, MODEL = "small", "medium.en"  # small finds the language; English speech is written by medium.en (fewer slips)
LANGS = ("en",)          # subtitles only for speech this sure to be English: other guesses on wind and engines were noise
MLX_MODEL = "mlx-community/whisper-large-v3-turbo"  # multilingual; mlx-whisper detects the language itself
BACKENDS = ("auto", "faster-whisper", "mlx", "off")
HALLUCINATIONS = re.compile(r"subtit|редактор|корректор|thank you for watching|amara\.org|♪", re.I)
_models: dict = {}
_cuda_failed = False  # CUDA was found but would not run (a missing cuBLAS or cuDNN): the CPU from then on


def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def settings() -> dict:
    """{backend, model, detect, langs}: STUDIO_WHISPER_BACKEND / _MODEL / _LANGUAGE resolved. auto: mlx on Apple silicon
    when mlx-whisper is installed, else faster-whisper. An unknown backend name counts as auto."""
    want = os.environ.get("STUDIO_WHISPER_BACKEND", "").strip().lower() or "auto"
    want = want if want in BACKENDS else "auto"
    if want == "auto":
        want = "mlx" if _apple_silicon() and _has("mlx_whisper") else "faster-whisper"
    langs = tuple(x.strip().lower() for x in os.environ.get("STUDIO_WHISPER_LANGUAGE", "").split(",") if x.strip()) or LANGS
    model = os.environ.get("STUDIO_WHISPER_MODEL", "").strip()
    if not model:
        model = MLX_MODEL if want == "mlx" else MODEL if langs == ("en",) else "medium"
    if model.endswith(".en") and langs != ("en",):
        raise RuntimeError(f"STUDIO_WHISPER_MODEL={model} writes English only; STUDIO_WHISPER_LANGUAGE={','.join(langs)} needs a "
                           "multilingual model such as medium or large-v3.")
    return {"backend": want, "model": model, "detect": DETECT, "langs": langs}


def _tag(cfg: dict) -> str:
    """What the cache key says about the transcriber. The default (faster-whisper medium.en, English) keeps the key clips
    were cached under before backends were pluggable; CPU and CUDA write the same words, so they share it."""
    tag = cfg["model"] if cfg["backend"] == "faster-whisper" else f"{cfg['backend']}:{cfg['model']}"
    return tag if cfg["langs"] == ("en",) else f"{tag}|{','.join(cfg['langs'])}"


def _key(path: Path, duration: float | None = None) -> str:
    try:
        tag = _tag(settings())
    except RuntimeError:  # a contradictory setting: transcribe() says so; a cache lookup just misses
        tag = MODEL + "|bad"
    return hashlib.sha1(f"{path.name.lower()}|{round(float(duration or 0), 1)}|{tag}|v2".encode()).hexdigest()[:16]


def device() -> tuple[str, str]:
    """(device, compute_type) for faster-whisper: ("cuda", "float16") with an NVIDIA GPU CTranslate2 can use, else
    ("cpu", "int8"). Never raises: no ctranslate2, no driver, or a CUDA that failed once all mean the CPU."""
    if _cuda_failed:
        return "cpu", "int8"
    try:
        import ctranslate2

        n = int(ctranslate2.get_cuda_device_count())
    except Exception:
        n = 0
    return ("cuda", "float16") if n > 0 else ("cpu", "int8")


def _load(name: str, dev: str, compute: str):
    from faster_whisper import WhisperModel

    return WhisperModel(name, device=dev, compute_type=compute)


def _whisper(name: str = MODEL):
    dev, compute = device()
    if (name, dev) not in _models:
        _models[(name, dev)] = _load(name, dev, compute)
    return _models[(name, dev)]


def _audio(path: Path):
    """16 kHz mono samples through the studio's ffmpeg (PyAV builds differ; ffmpeg reads every camera's files)."""
    import subprocess

    import numpy as np

    from studio.config import ffmpeg_bin

    r = subprocess.run([str(ffmpeg_bin()), "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True, timeout=600)
    return np.frombuffer(r.stdout, dtype="float32") if r.returncode == 0 and r.stdout else None


def _faster(audio, cfg: dict, hint: str) -> tuple[str | None, list[dict]]:
    """faster-whisper: the language from the first 30 s (small), then the speech written by the model, VAD on."""
    lang, prob, _ = _whisper(cfg["detect"]).detect_language(audio[: 16000 * 30], vad_filter=True)
    if lang not in cfg["langs"] or prob < 0.6:
        return lang, []
    multi = not cfg["model"].endswith(".en")
    segs, _ = _whisper(cfg["model"]).transcribe(audio, vad_filter=True, vad_parameters={"min_silence_duration_ms": 500}, beam_size=5,
                                                condition_on_previous_text=False, initial_prompt=hint or None,
                                                **({"language": lang} if multi else {}))
    return lang, [{"start": s.start, "end": s.end, "text": s.text, "no_speech_prob": s.no_speech_prob, "avg_logprob": s.avg_logprob,
                   "compression_ratio": s.compression_ratio} for s in segs]


def _faster_safe(audio, cfg: dict, hint: str) -> tuple[str | None, list[dict]]:
    """_faster on CUDA when there is one. A CUDA that will not run (a missing cuBLAS or cuDNN often shows only at the
    first transcription) is given up for the rest of the run and the clip is done again on the CPU."""
    global _cuda_failed
    if device()[0] != "cuda":
        return _faster(audio, cfg, hint)
    try:
        return _faster(audio, cfg, hint)
    except Exception as err:
        print(f"speech: CUDA failed ({str(err)[:160]}); using the CPU", flush=True)
        _cuda_failed = True
        _models.clear()
        return _faster(audio, cfg, hint)


def _mlx(audio, cfg: dict, hint: str) -> tuple[str | None, list[dict]]:
    """mlx-whisper on Apple silicon (ml-explore/mlx-examples whisper, read 2026-11-17): mlx_whisper.transcribe(audio,
    path_or_hf_repo=…) takes a path or a float32 16 kHz waveform and returns {"text", "segments": [{start, end, text,
    avg_logprob, compression_ratio, no_speech_prob, …}], "language"}. With no language given it detects one from the
    first 30 s; a clip in a language not kept is dropped, as faster-whisper's is."""
    import mlx_whisper

    r = mlx_whisper.transcribe(audio, path_or_hf_repo=cfg["model"], condition_on_previous_text=False, initial_prompt=hint or None,
                               verbose=None)
    lang = r.get("language")
    if lang not in cfg["langs"]:
        return lang, []
    return lang, [{k: s.get(k) for k in ("start", "end", "text", "no_speech_prob", "avg_logprob", "compression_ratio")}
                  for s in r.get("segments") or [] if isinstance(s, dict)]


RUN = {"faster-whisper": _faster_safe, "mlx": _mlx}


def _keep(segs: list[dict]) -> list[dict]:
    """Whisper's habits on noise dropped: a lone low-confidence word, garbled repeats, subtitle credits, the same line again."""
    out, seen = [], {}
    for s in segs:
        text = re.sub(r"\s+", " ", s.get("text") or "").strip()
        seen[text.lower()] = seen.get(text.lower(), 0) + 1
        nsp, lp, cr = float(s.get("no_speech_prob") or 0), float(s.get("avg_logprob") or 0), float(s.get("compression_ratio") or 0)
        if (not text or nsp > 0.5 or lp < -0.9 or cr > 2.4 or HALLUCINATIONS.search(text)
                or (lp < -0.6 and len(text) < 12) or seen[text.lower()] > 1):
            continue
        out.append({"start": round(float(s["start"]), 2), "end": round(float(s["end"]), 2), "text": text})
    return out


def transcribe(path: Path, duration: float | None = None, hint: str = "") -> dict:
    """One clip's speech: {"lang", "segments": [{"start", "end", "text"}]} (empty when nobody talks). Cached. `hint`:
    words the speech is likely to hold (the trip's places, the animals), so "hartebeest" is not heard as "heart disease".
    STUDIO_WHISPER_BACKEND=off: every clip is silent and nothing is cached."""
    cfg = settings()
    if cfg["backend"] == "off":
        return {"file": path.name, "lang": None, "segments": []}
    if cfg["backend"] == "mlx" and not _has("mlx_whisper"):
        raise RuntimeError("STUDIO_WHISPER_BACKEND=mlx, but mlx-whisper is not installed (pip install mlx-whisper; Apple silicon only).")
    CACHE.mkdir(parents=True, exist_ok=True)
    hit = CACHE / f"{_key(path, duration)}.json"
    if hit.exists():
        return json.loads(hit.read_text(encoding="utf-8"))
    audio = _audio(path)
    if audio is None or len(audio) < 16000 * 0.5:  # no sound track, or under half a second
        hit.write_text(json.dumps({"file": path.name, "lang": None, "segments": []}), encoding="utf-8")
        return {"file": path.name, "lang": None, "segments": []}
    lang, segs = RUN[cfg["backend"]](audio, cfg, hint)
    out = {"file": path.name, "lang": None, "segments": _keep(segs)}
    out["lang"] = lang if out["segments"] else None
    hit.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def _wrap(text: str, width: int = 42) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


def cues(placed: list[dict]) -> list[dict]:
    """Timeline cues from placed clips: [{"at": where the shot starts in the edit, "from": where in the clip it starts,
    "sec": how long it plays, "speech": transcribe() result}]. A sentence cut by the edit keeps only its part on screen;
    long ones are split into cues of at most two 42-character lines, each read at no more than 20 characters a second."""
    out = []
    for p in placed:
        for s in (p.get("speech") or {}).get("segments", []):
            a, b = max(s["start"], p["from"]), min(s["end"], p["from"] + p["sec"])
            if b - a < 0.6:
                continue
            lines = _wrap(s["text"])
            chunks = [lines[i:i + 2] for i in range(0, len(lines), 2)]
            per = (b - a) / len(chunks)
            for k, ch in enumerate(chunks):
                t0 = p["at"] + (a - p["from"]) + k * per
                need = max(1.0, len(" ".join(ch)) / 20)
                out.append({"start": round(t0, 2), "end": round(t0 + max(per, min(need, per + 0.8)), 2), "text": "\n".join(ch)})
    out.sort(key=lambda c: c["start"])
    for x, y in zip(out, out[1:]):  # never overlapping
        x["end"] = min(x["end"], y["start"] - 0.05)
    return [c for c in out if c["end"] - c["start"] >= 0.5]


def _stamp(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt(cs: list[dict]) -> str:
    return "".join(f"{i}\n{_stamp(c['start'])} --> {_stamp(c['end'])}\n{c['text']}\n\n" for i, c in enumerate(cs, 1))


def scan(paths: list[tuple[Path, float | None]], hint: str = "") -> dict:
    """Transcribe many clips (cached ones are free). Returns how many have speech and in which languages."""
    talk, langs = 0, {}
    for k, (p, d) in enumerate(paths, 1):
        r = transcribe(p, d, hint)
        if r["segments"]:
            talk += 1
            langs[r["lang"]] = langs.get(r["lang"], 0) + 1
        if k % 10 == 0:
            print(f"PROGRESS {k}/{len(paths)} clips", flush=True)
    return {"clips": len(paths), "withSpeech": talk, "languages": langs}
