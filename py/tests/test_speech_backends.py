"""Pluggable transcription (studio.speech): faster-whisper on CUDA (float16) when CTranslate2 sees a GPU, else the CPU
(int8), and back to the CPU when CUDA will not run; mlx-whisper on Apple silicon; STUDIO_WHISPER_BACKEND / _MODEL /
_LANGUAGE; the same segment shape and noise filters on every backend. Fake models only: nothing is downloaded."""
import hashlib
import sys
import types
from types import SimpleNamespace

import numpy as np
import pytest

import studio.speech as speech

SEGS = [{"start": 0.5, "end": 2.0, "text": " Look,  a lion on the left. ", "no_speech_prob": 0.1, "avg_logprob": -0.2, "compression_ratio": 1.3},
        {"start": 2.0, "end": 2.4, "text": "uh", "no_speech_prob": 0.2, "avg_logprob": -0.8, "compression_ratio": 1.0},          # lone unsure word
        {"start": 3.0, "end": 4.0, "text": "Thank you for watching!", "no_speech_prob": 0.1, "avg_logprob": -0.1, "compression_ratio": 1.0}]


@pytest.fixture
def clean(tmp_path, monkeypatch):
    for k in ("STUDIO_WHISPER_BACKEND", "STUDIO_WHISPER_MODEL", "STUDIO_WHISPER_LANGUAGE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(speech, "CACHE", tmp_path / "speech")
    monkeypatch.setattr(speech, "_audio", lambda path: np.zeros(16000 * 5, dtype="float32"))
    monkeypatch.setattr(speech, "_models", {})
    monkeypatch.setattr(speech, "_cuda_failed", False)
    monkeypatch.setattr(speech, "_apple_silicon", lambda: False)
    monkeypatch.setattr(speech, "_has", lambda m: False)
    return tmp_path


class FakeWhisper:
    def __init__(self, name, dev, compute, lang="en", prob=0.9, fail_on=None):
        self.name, self.dev, self.compute, self.lang, self.prob, self.fail_on = name, dev, compute, lang, prob, fail_on
        self.calls = []

    def detect_language(self, audio, vad_filter=False):
        if self.fail_on == self.dev:
            raise RuntimeError("Library cublas64_12.dll is not found")
        return self.lang, self.prob, []

    def transcribe(self, audio, **kw):
        self.calls.append(kw)
        return [SimpleNamespace(**s) for s in SEGS], None


def fake_loader(monkeypatch, **kw):
    loaded = []

    def load(name, dev, compute):
        m = FakeWhisper(name, dev, compute, **kw)
        loaded.append(m)
        return m
    monkeypatch.setattr(speech, "_load", load)
    return loaded


def gpus(monkeypatch, n):
    monkeypatch.setitem(sys.modules, "ctranslate2", types.SimpleNamespace(get_cuda_device_count=lambda: n))


def test_defaults_keep_english_medium_en_and_the_old_cache_key(clean, tmp_path):
    cfg = speech.settings()
    assert cfg == {"backend": "faster-whisper", "model": "medium.en", "detect": "small", "langs": ("en",)}
    old = hashlib.sha1(b"clip.mp4|12.3|medium.en|v2").hexdigest()[:16]
    assert speech._key(tmp_path / "CLIP.mp4", 12.31) == old, "clips cached before backends were pluggable stay cached"


def test_cuda_when_ctranslate2_sees_a_gpu_else_cpu_int8(clean, monkeypatch, tmp_path):
    gpus(monkeypatch, 0)
    assert speech.device() == ("cpu", "int8")
    gpus(monkeypatch, 1)
    assert speech.device() == ("cuda", "float16")
    loaded = fake_loader(monkeypatch)
    out = speech.transcribe(tmp_path / "a.mp4", 5.0)
    assert {(m.name, m.dev, m.compute) for m in loaded} == {("small", "cuda", "float16"), ("medium.en", "cuda", "float16")}
    assert out == {"file": "a.mp4", "lang": "en", "segments": [{"start": 0.5, "end": 2.0, "text": "Look, a lion on the left."}]}
    assert "language" not in loaded[-1].calls[0], "an English-only model is not told the language"
    monkeypatch.setitem(sys.modules, "ctranslate2", None)  # not importable: the CPU, no error
    assert speech.device() == ("cpu", "int8")


def test_a_cuda_that_will_not_run_falls_back_to_the_cpu(clean, monkeypatch, tmp_path):
    gpus(monkeypatch, 1)
    loaded = fake_loader(monkeypatch, fail_on="cuda")
    out = speech.transcribe(tmp_path / "a.mp4", 5.0)
    assert out["segments"] and speech.device() == ("cpu", "int8")
    assert loaded[-1].dev == "cpu" and loaded[-1].compute == "int8"


def test_other_speech_is_dropped_unless_its_language_is_kept(clean, monkeypatch, tmp_path):
    gpus(monkeypatch, 0)
    fake_loader(monkeypatch, lang="ja")
    assert speech.transcribe(tmp_path / "a.mp4", 5.0)["segments"] == []
    monkeypatch.setenv("STUDIO_WHISPER_LANGUAGE", "en,ja")
    loaded = fake_loader(monkeypatch, lang="ja")
    out = speech.transcribe(tmp_path / "a.mp4", 5.0)
    assert out["lang"] == "ja" and out["segments"], "a new language setting is its own cache entry"
    assert loaded[-1].name == "medium" and loaded[-1].calls[0]["language"] == "ja"
    monkeypatch.setenv("STUDIO_WHISPER_MODEL", "medium.en")
    with pytest.raises(RuntimeError, match="English only"):
        speech.transcribe(tmp_path / "b.mp4", 5.0)


def test_off_transcribes_nothing_and_caches_nothing(clean, monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_WHISPER_BACKEND", "off")
    monkeypatch.setattr(speech, "_load", lambda *a: pytest.fail("no model with the backend off"))
    assert speech.transcribe(tmp_path / "a.mp4", 5.0) == {"file": "a.mp4", "lang": None, "segments": []}
    assert not (tmp_path / "speech").exists()


def test_mlx_on_apple_silicon_maps_to_the_same_segments(clean, monkeypatch, tmp_path):
    sent = {}

    def transcribe(audio, **kw):
        sent.update(kw, audio=audio)
        return {"text": "...", "language": "en", "segments": [{"id": i, "seek": 0, "tokens": [], "temperature": 0.0, **s} for i, s in enumerate(SEGS)]}
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=transcribe))
    monkeypatch.setattr(speech, "_apple_silicon", lambda: True)
    monkeypatch.setattr(speech, "_has", lambda m: m == "mlx_whisper")
    monkeypatch.setattr(speech, "_load", lambda *a: pytest.fail("faster-whisper is not used on mlx"))
    cfg = speech.settings()
    assert cfg["backend"] == "mlx" and cfg["model"] == speech.MLX_MODEL
    out = speech.transcribe(tmp_path / "a.mp4", 5.0, hint="lion, Serengeti")
    assert out == {"file": "a.mp4", "lang": "en", "segments": [{"start": 0.5, "end": 2.0, "text": "Look, a lion on the left."}]}
    assert sent["path_or_hf_repo"] == speech.MLX_MODEL and sent["initial_prompt"] == "lion, Serengeti" and sent["audio"].dtype == np.float32
    assert speech._key(tmp_path / "a.mp4", 5.0) != hashlib.sha1(b"a.mp4|5.0|medium.en|v2").hexdigest()[:16], "mlx words are cached apart"


def test_mlx_asked_for_but_missing_says_how_to_install(clean, monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_WHISPER_BACKEND", "mlx")
    with pytest.raises(RuntimeError, match="pip install mlx-whisper"):
        speech.transcribe(tmp_path / "a.mp4", 5.0)


def test_auto_off_a_mac_and_an_unknown_name_mean_faster_whisper(clean, monkeypatch):
    monkeypatch.setattr(speech, "_has", lambda m: True)  # mlx installed, but not on Apple silicon
    assert speech.settings()["backend"] == "faster-whisper"
    monkeypatch.setenv("STUDIO_WHISPER_BACKEND", "whisper.cpp")
    assert speech.settings()["backend"] == "faster-whisper"
    monkeypatch.setenv("STUDIO_WHISPER_BACKEND", "faster-whisper")
    monkeypatch.setenv("STUDIO_WHISPER_MODEL", "large-v3-turbo")
    assert speech.settings()["model"] == "large-v3-turbo"
