"""
FILE: py/studio/speech.py
PURPOSE: What people say in the footage, as subtitles: speech found (Silero VAD) and written down (faster-whisper),
         on this PC, free. Each clip once, cached by its file name and length, so a copy of the same clip (the
         Google Photos copy and the original from Drive) is never transcribed twice.
OVERVIEW: transcribe(path) -> {"lang", "segments": [{start, end, text}]} for one clip; subtitles(shots) maps the
          segments of the parts of clips an edit uses onto its timeline and returns SRT text (Netflix timed-text
          rules: at most 42 characters a line, two lines, about 20 characters a second, at least 1 s on screen).
DEPENDENCIES: faster-whisper (MIT; its "small" model is fetched once from Hugging Face, about 0.5 GB), ffmpeg
USAGE: python -m studio speech scan   (every video in the library; a vlog build also does its own clips)
NOTES: Speech is written down as heard. Nothing is translated or tidied by a language model, so a subtitle never
       says something nobody said. Wind, engines and animal sounds are not speech: VAD drops them.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from studio.config import DATA

CACHE = DATA / "speech"
DETECT, MODEL = "small", "medium.en"  # small finds the language; English speech is written by medium.en (fewer slips)
LANGS = ("en",)          # subtitles only for speech this sure to be English: other guesses on wind and engines were noise
HALLUCINATIONS = re.compile(r"subtit|редактор|корректор|thank you for watching|amara\.org|♪", re.I)
_models: dict = {}


def _key(path: Path, duration: float | None = None) -> str:
    return hashlib.sha1(f"{path.name.lower()}|{round(float(duration or 0), 1)}|{MODEL}|v2".encode()).hexdigest()[:16]


def _whisper(name: str = MODEL):
    if name not in _models:
        from faster_whisper import WhisperModel

        _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _models[name]


def _audio(path: Path):
    """16 kHz mono samples through the studio's ffmpeg (PyAV builds differ; ffmpeg reads every camera's files)."""
    import subprocess

    import numpy as np

    from studio.config import ffmpeg_bin

    r = subprocess.run([str(ffmpeg_bin()), "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True, timeout=600)
    return np.frombuffer(r.stdout, dtype="float32") if r.returncode == 0 and r.stdout else None


def transcribe(path: Path, duration: float | None = None, hint: str = "") -> dict:
    """One clip's speech: {"lang", "segments": [{"start", "end", "text"}]} (empty when nobody talks). Cached. `hint`:
    words the speech is likely to hold (the trip's places, the animals), so "hartebeest" is not heard as "heart disease"."""
    CACHE.mkdir(parents=True, exist_ok=True)
    hit = CACHE / f"{_key(path, duration)}.json"
    if hit.exists():
        return json.loads(hit.read_text(encoding="utf-8"))
    audio = _audio(path)
    if audio is None or len(audio) < 16000 * 0.5:  # no sound track, or under half a second
        hit.write_text(json.dumps({"file": path.name, "lang": None, "segments": []}), encoding="utf-8")
        return {"file": path.name, "lang": None, "segments": []}
    out = {"file": path.name, "lang": None, "segments": []}
    lang, prob, _ = _whisper(DETECT).detect_language(audio[: 16000 * 30], vad_filter=True)
    if lang in LANGS and prob >= 0.6:
        segs, _ = _whisper(MODEL).transcribe(audio, vad_filter=True, vad_parameters={"min_silence_duration_ms": 500}, beam_size=5,
                                             condition_on_previous_text=False, initial_prompt=hint or None)
        seen: dict[str, int] = {}
        for s in segs:
            text = re.sub(r"\s+", " ", s.text or "").strip()
            seen[text.lower()] = seen.get(text.lower(), 0) + 1
            # Whisper's habits on noise: a lone low-confidence word, garbled repeats, subtitle credits, the same line again.
            if (not text or s.no_speech_prob > 0.5 or s.avg_logprob < -0.9 or s.compression_ratio > 2.4 or HALLUCINATIONS.search(text)
                    or (s.avg_logprob < -0.6 and len(text) < 12) or seen[text.lower()] > 1):
                continue
            out["segments"].append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
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
