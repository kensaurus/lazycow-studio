"""The AI provider registry and its four protocol adapters (studio.providers, studio.ai), offline: the registry's
contract (schema, every keyEnv in .env.example, never text-to-video, labelRequired per capability, commercial licences
only), fal / Replicate / kie.ai / ElevenLabs / Stability through the same fake HTTP as test_ai.py with recorded answers
(py/tests/fixtures/providers), the price chain and no_price, kie.ai's errors inside an HTTP 200, a submit that timed out
never sent again, 429 retried after Retry-After, output normalisation, select and save-price, and that a project without
workflow.json works exactly as before (fal defaults)."""
import copy
import io
import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from studio import ai, projects
from studio.providers import base, normalise, registry
from tests.test_ai import FAL, Fake, env, fal_routes, make_reel, rows  # noqa: F401 - the shared fixture and fakes

FIX = Path(__file__).parent / "fixtures" / "providers"
ROOT = Path(__file__).resolve().parents[2]
EL = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"
RP = "r8_0123456789abcdefABCDEF0123456789abcdef"
KIE = "0123456789abcdef0123456789abcdef"
ST = "sk-0123456789abcdefABCDEF0123456789abcdefABCD"
SLEPT: list = []   # the seconds ai._sleep was asked to wait, per test


def fx(name: str):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


class Raw(Fake):
    """The fake that also keeps each request's raw bytes (multipart bodies)."""

    def __call__(self, method, url, *, data=None, headers=None, timeout=60):
        out = super().__call__(method, url, data=data, headers=headers, timeout=timeout)
        self.calls[-1]["raw"] = data
        return out


@pytest.fixture
def penv(env, monkeypatch):  # noqa: F811
    """test_ai's env with every provider's key, a workflow file in the temp folder, and a sleep that only records."""
    with env.joinpath(".env").open("a", encoding="utf-8") as f:
        f.write(f"ELEVENLABS_API_KEY={EL}\nREPLICATE_API_TOKEN={RP}\nKIE_API_KEY={KIE}\nSTABILITY_API_KEY={ST}\n")
    for k in ("ELEVENLABS_API_KEY", "REPLICATE_API_TOKEN", "KIE_API_KEY", "STABILITY_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(ai, "WORKFLOW", env / "workflow.json")
    SLEPT.clear()
    monkeypatch.setattr(ai, "_sleep", SLEPT.append)
    return env


def use(monkeypatch, routes, cls=Raw):
    fake = cls(routes)
    monkeypatch.setattr(ai, "_call", fake)
    return fake


# ---------- the registry's contract ----------

def test_the_registry_is_valid_and_every_key_name_is_in_env_example():
    reg = registry.load()
    assert registry.validate(reg) == []
    listed = (ROOT / ".env.example").read_text(encoding="utf-8")
    for pid, names in registry.key_envs().items():
        for name in names:
            assert f"\n{name}=" in listed, f"{pid}: {name} is not in .env.example"
            assert registry.KEY_ENV_RX.match(name) or name in registry.LEGACY_KEY_ENVS


def test_capabilities_are_closed_never_text_to_video_and_label_rules_belong_to_capabilities():
    reg = registry.load()
    assert tuple(reg["capabilities"]) == registry.CAPABILITIES
    assert {c: v["labelRequired"] for c, v in reg["capabilities"].items() if v["labelRequired"]} == {"voice": True, "img2video": True}
    for pid, p in reg["providers"].items():
        assert "labelRequired" not in p
        for mid, m in p["models"].items():
            assert m["capability"] in registry.CAPABILITIES and "labelRequired" not in m, (pid, mid)
    bad = copy.deepcopy(reg)
    bad["capabilities"]["text-to-video"] = {"labelRequired": True}
    assert any("never registered" in p or "closed" in p for p in registry.validate(bad))
    bad = copy.deepcopy(reg)
    bad["providers"]["fal"]["models"]["fal-ai/x/text-to-video"] = {"capability": "img2video", "licence": "commercial"}
    assert any("text-to-video is never registered" in p for p in registry.validate(bad))
    bad = copy.deepcopy(reg)
    bad["providers"]["elevenlabs"]["labelRequired"] = False
    assert any("belongs to the capability" in p for p in registry.validate(bad))


def test_non_commercial_models_risky_defaults_and_odd_key_names_are_refused():
    reg = registry.load()
    bad = copy.deepcopy(reg)
    bad["providers"]["replicate"]["models"]["someone/nc"] = {"capability": "music", "licence": "cc-by-nc-4.0"}
    assert any("no commercial licence" in p for p in registry.validate(bad))
    bad = copy.deepcopy(reg)
    bad["providers"]["kie"]["models"]["ai-music-api/generate"]["default"] = True
    problems = registry.validate(bad)
    assert any("never a default" in p for p in problems) and any("2 defaults" in p for p in problems)
    bad = copy.deepcopy(reg)
    bad["providers"]["kie"]["keyEnv"] = "STUDIO_PY"
    assert any("keyEnv" in p for p in registry.validate(bad))
    assert reg["providers"]["kie"]["models"]["ai-music-api/generate"]["risk"] == "unofficial"


def test_phase_0_constants_come_from_the_registry_with_todays_fal_tools():
    assert {t: v[:3] for t, v in ai.TOOLS.items()} == {
        "review": ("openrouter", "google/gemini-3.8-flash", False),
        "slowmo": ("fal", "fal-ai/rife/video", False),
        "sharpen": ("fal", "topaz/upscale/video/precision", False),  # fal no longer lists fal-ai/topaz/upscale/video
        "music": ("fal", "fal-ai/stable-audio-25/text-to-audio", False),
        "voice": ("fal", "fal-ai/minimax/speech-02-hd", True),
        "living": ("fal", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", True),
        "foley": ("fal", "fal-ai/mmaudio-v2", False),
        "behind": ("fal", "fal-ai/birefnet/v2/video", False)}
    assert ai.KEY_NAMES["fal"] == "FAL_KEY" and ai.KEY_NAMES["openrouter"] == "OPENROUTER_API_KEY_PARKED" and ai.KEY_NAMES["elevenlabs"] == "ELEVENLABS_API_KEY"
    assert "own" not in ai.KEY_NAMES, "your own server's key is saved with its address (save_llm)"
    assert ai.FALLBACK_PRICES["fal-ai/kling-video/v2.5-turbo/pro/image-to-video"] == (0.07, "seconds")
    assert ai.PROVIDER_NAMES["kie"] == "kie.ai" and ai.VOICE_ID == "Japanese_CalmLady"


def test_templates_keep_types_drop_missing_values_and_paths_read_json_strings():
    t = {"duration": "{seconds:str}", "n": "{seconds:int}", "x": "{nope}", "deep": {"v": "{voice}"}, "list": ["{u}"], "text": "say {voice}!"}
    assert base.finish(t, {"seconds": 5, "voice": "A", "u": "https://x"}) == {"duration": "5", "n": 5, "deep": {"v": "A"}, "list": ["https://x"], "text": "say A!"}
    assert base.dig(fx("kie/record_success.json"), "data.resultJson.~json.resultUrls.0") == "https://tempfile.aiquickdraw.com/k/line.mp3"
    assert base.first_url([{"url": "https://a"}]) == "https://a"


# ---------- no workflow.json: exactly as before ----------

def test_without_workflow_json_every_capability_uses_the_fal_default(penv, monkeypatch):
    assert not ai.WORKFLOW.exists()
    for cap in registry.CAPABILITIES:
        b = ai.block(cap)
        assert b["source"] == "default" and b["on"] is True
        assert (b["provider"], b["model"]) == (registry.default_model(cap) or (None, None))
    make_reel(penv, monkeypatch=monkeypatch)
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, {"prices": []})])])
    items = ai.plan("day-test", ["sharpen", "music", "voice"])
    assert {(i["tool"], i["provider"], i["model"]) for i in items} == {("sharpen", "fal", "topaz/upscale/video/precision"),
                                                                     ("music", "fal", "fal-ai/stable-audio-25/text-to-audio"),
                                                                     ("voice", "fal", "fal-ai/minimax/speech-02-hd")}
    assert ai.credit_line("music") == "AI-generated (Stable Audio 2.5, via fal.ai)"


# ---------- the price chain ----------

def test_the_price_chain_live_then_list_then_yours_then_no_price(penv, monkeypatch):
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, {"prices": [{"endpoint_id": "fal-ai/rife/video", "unit_price": 0.002, "unit": "seconds"}]})])])
    got = ai.prices_for([("fal", "fal-ai/rife/video"), ("fal", "fal-ai/mmaudio-v2"), ("elevenlabs", "eleven_v3")])
    assert got[("fal", "fal-ai/rife/video")]["unit_price"] == 0.002 and got[("fal", "fal-ai/rife/video")]["source"] == "fal pricing API"
    assert "live table unavailable" in got[("fal", "fal-ai/mmaudio-v2")]["source"]
    assert got[("elevenlabs", "eleven_v3")] == {**got[("elevenlabs", "eleven_v3")], "unit_price": 0.08, "unit": "1000 characters"}
    assert len(fake.find("pricing")) == 1, "fal is asked once for all its models"
    # A model with no list price: your price is used; without it the call is refused before anything is spent.
    monkeypatch.setattr(ai, "list_price", lambda p, m: None)
    assert ("kie", "topaz/video-upscale") not in ai.prices_for([("kie", "topaz/video-upscale")])
    ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": 0.05, "unit": "seconds"})
    assert ai.prices_for([("kie", "topaz/video-upscale")])[("kie", "topaz/video-upscale")]["unit_price"] == 0.05
    ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": None})
    ai.select({"capability": "upscale", "provider": "kie", "model": "topaz/video-upscale"})
    make_reel(penv, monkeypatch=monkeypatch)
    with pytest.raises(ai.AiError) as err:
        ai.plan("day-test", ["sharpen"])
    assert err.value.code == "no_price" and "Enter its price" in str(err.value)


def test_topaz_precision_is_priced_in_fals_units_two_a_second_at_1080p(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, {"prices": [{"endpoint_id": "topaz/upscale/video/precision", "unit_price": 0.01, "unit": "units"}]})])])
    item = ai.plan("day-test", ["sharpen"])[0]
    assert item["target"] == 2 and item["quantity"] == 5.0 and item["usd"] == 0.05, "2.5 s of 1080p output = 5 units ($0.20 per 10 s)"


def test_a_list_price_older_than_90_days_carries_a_warning(penv, monkeypatch):
    m = registry.model("elevenlabs", "eleven_v3")
    monkeypatch.setitem(m, "price", {**m["price"], "asOf": "2025-01-01"})
    p = ai.list_price("elevenlabs", "eleven_v3")
    assert p["stale"] and "over 90 days ago" in p["warning"]
    assert ai.list_price("elevenlabs", "eleven_flash_v2_5")["stale"] is False


# ---------- adapters: async_task (Replicate, kie.ai) ----------

def test_replicate_music_submits_once_polls_urls_get_downloads_and_normalises(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    from studio import sound
    monkeypatch.setattr(sound, "LIB", penv / "audio")
    fake = use(monkeypatch, [("GET", "api.replicate.com/v1/models/stability-ai/stable-audio-2.5", [(200, fx("replicate/model_ok.json"))]),
                             ("POST", "api.replicate.com/v1/models/stability-ai/stable-audio-2.5/predictions",
                              [(429, {"detail": "slow down"}, {"Retry-After": "7"}), (201, fx("replicate/prediction_starting.json"))]),
                             ("GET", "api.replicate.com/v1/predictions/p7x2k", [(200, fx("replicate/prediction_processing.json")),
                                                                               (200, fx("replicate/prediction_succeeded.json"))]),
                             ("GET", "replicate.delivery/", [(200, b"ID3mp3bytes")])])
    sel = ai.select({"capability": "music", "provider": "replicate", "model": "stability-ai/stable-audio-2.5"})
    assert sel["block"]["source"] == "workflow" and json.loads(ai.WORKFLOW.read_text())["blocks"]["music"]["provider"] == "replicate"
    out = ai.run({"slug": "day-test", "tools": ["music"]})
    sub = fake.find("/predictions")[0]
    assert sub["headers"]["authorization"] == f"Bearer {RP}" and sub["body"]["input"]["duration"] == 11 and "Instrumental" in sub["body"]["input"]["prompt"]
    assert len([c for c in fake.calls if c["method"] == "POST"]) == 2, "the 429 was asked again; nothing else was sent twice"
    assert 7.0 in SLEPT, "Retry-After honoured"
    p = projects.load("day-test")
    assert p["music"]["id"].endswith(".wav"), "normalised to wav"
    side = json.loads((penv / "audio" / "music" / (p["music"]["id"] + ".json")).read_text(encoding="utf-8"))
    assert side["creator"] == "Stable Audio 2.5 (AI, via Replicate)" and side["source"] == "Replicate"
    assert [n["licence"] for n in p["ai"] if n["tool"] == "music"] == ["AI-generated for this reel (Stable Audio 2.5 via Replicate, commercial use)"]
    assert rows()[-1]["provider"] == "replicate" and rows()[-1]["usd"] == 0.2 and out["spent"] == 0.2
    assert ai.credit_line("music") == "AI-generated (Stable Audio 2.5, via Replicate)"


def test_kie_voice_reads_its_result_json_and_records_the_credits_it_reports(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    fake = use(monkeypatch, [("POST", "api.kie.ai/api/v1/jobs/createTask", [(200, fx("kie/create_ok.json"))]),
                             ("GET", "api.kie.ai/api/v1/jobs/recordInfo", [(200, fx("kie/record_generating.json")), (200, fx("kie/record_success.json")),
                                                                          (200, fx("kie/record_generating.json")), (200, fx("kie/record_success.json"))]),
                             ("GET", "tempfile.aiquickdraw.com", [(200, b"ID3voice")])])
    with pytest.raises(ai.AiError) as err:
        ai.select({"capability": "voice", "provider": "kie", "model": "elevenlabs/text-to-speech-turbo-2-5"})
    assert err.value.code == "no_voice"
    ai.select({"capability": "voice", "provider": "kie", "model": "elevenlabs/text-to-speech-turbo-2-5", "voice": "jpVoice01abc"})
    ai.run({"slug": "day-test", "tools": ["voice"]})
    created = fake.find("createTask")
    assert len(created) == 2 and created[0]["body"] == {"model": "elevenlabs/text-to-speech-turbo-2-5",
                                                        "input": {"text": "山にこもって、どこまで進むか。", "voice": "jpVoice01abc", "language_code": "ja"}}
    assert "taskId=task_kie_123" in fake.find("recordInfo")[0]["url"]
    v = projects.load("day-test")["voice"]
    assert v["voiceId"] == "jpVoice01abc" and len(v["lines"]) == 2 and all(line["file"].endswith(".mp3") for line in v["lines"])
    r = rows()[-1]
    assert r["provider"] == "kie" and r["usd"] == round(2 * 2.4 * 0.005, 6) and r["note"].startswith("actual"), "kie's creditsConsumed, in USD"


def test_kie_errors_inside_an_http_200_are_read_from_the_body(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    ai.select({"capability": "voice", "provider": "kie", "model": "elevenlabs/text-to-speech-turbo-2-5", "voice": "jpVoice01abc"})
    use(monkeypatch, [("POST", "api.kie.ai/api/v1/jobs/createTask", [(200, fx("kie/create_no_credit.json"))])])
    with pytest.raises(ai.AiError) as err:
        ai.run({"slug": "day-test", "tools": ["voice"]})
    assert err.value.code == "no_credits" and "kie.ai says the account is out of credit" in str(err.value)
    assert rows()[-1]["usd"] == 0.0
    use(monkeypatch, [("GET", "api.kie.ai/api/v1/chat/credit", [(200, fx("kie/create_bad_key.json"))])])
    with pytest.raises(ai.AiError) as err:
        ai.check_key({"provider": "kie", "key": KIE})
    assert err.value.code == "bad_key", "a 200 with code 401 in the body is a refused key"
    use(monkeypatch, [("POST", "api.kie.ai/api/v1/jobs/createTask", [(200, fx("kie/create_ok.json"))]),
                      ("GET", "api.kie.ai/api/v1/jobs/recordInfo", [(200, fx("kie/record_fail.json"))])])
    with pytest.raises(ai.AiError, match="voice not found"):
        ai.run({"slug": "day-test", "tools": ["voice"]})


# ---------- adapters: sync_http (ElevenLabs, Stability) ----------

def test_elevenlabs_voice_posts_the_text_and_uses_its_character_cost(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    fake = use(monkeypatch, [("POST", "api.elevenlabs.io/v1/text-to-speech/jpVoice01abc", [(200, b"ID3eleven", {"Content-Type": "audio/mpeg", "character-cost": "15"})]),
                             ("GET", "api.elevenlabs.io/v2/voices", [(200, fx("elevenlabs/voices.json"))])])
    got = ai.voices({"provider": "elevenlabs", "search": "ja"})
    assert [v["id"] for v in got["voices"]] == ["jpVoice01abc", "jpVoice02def"] and got["next"] == "tok_2"
    assert "search=ja" in fake.find("v2/voices")[0]["url"] and fake.find("v2/voices")[0]["headers"]["xi-api-key"] == EL
    ai.select({"capability": "voice", "provider": "elevenlabs", "model": "eleven_v3", "voice": "jpVoice01abc"})
    ai.run({"slug": "day-test", "tools": ["voice"]})
    call = fake.find("text-to-speech")[0]
    assert call["url"].endswith("/v1/text-to-speech/jpVoice01abc?output_format=mp3_44100_128")
    assert call["body"] == {"text": "山にこもって、どこまで進むか。", "model_id": "eleven_v3", "language_code": "ja"}
    assert call["headers"]["xi-api-key"] == EL and "authorization" not in call["headers"]
    assert rows()[-1]["usd"] == round(2 * 15 * 0.08 / 1000, 6), "15 characters a line at $0.08 per 1,000"
    assert [n["label_required"] for n in projects.load("day-test")["ai"] if n["tool"] == "voice"] == [True], "the voice capability's rule"


def test_stability_music_is_multipart_with_the_model_named(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    from studio import sound
    monkeypatch.setattr(sound, "LIB", penv / "audio")
    fake = use(monkeypatch, [("POST", "api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio", [(200, b"RIFFwav", {"Content-Type": "audio/wav"})])])
    ai.select({"capability": "music", "provider": "stability", "model": "stable-audio-2.5"})
    ai.run({"slug": "day-test", "tools": ["music"]})
    call = fake.calls[-1]
    assert call["headers"]["content-type"].startswith("multipart/form-data") and call["headers"]["authorization"] == f"Bearer {ST}"
    assert call["headers"]["accept"] == "audio/*"
    body = call["raw"].decode("utf-8", "replace")
    assert 'name="model"\r\n\r\nstable-audio-2.5' in body and 'name="duration"\r\n\r\n11' in body and 'name="output_format"\r\n\r\nwav' in body
    assert rows()[-1]["usd"] == 0.08 and rows()[-1]["provider"] == "stability"


def test_a_json_answer_where_a_file_was_expected_is_an_error(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    ai.select({"capability": "voice", "provider": "elevenlabs", "model": "eleven_flash_v2_5", "voice": "jpVoice01abc"})
    use(monkeypatch, [("POST", "api.elevenlabs.io/v1/text-to-speech", [(200, {"message": "quota"}, {"Content-Type": "application/json"})])])
    with pytest.raises(ai.AiError, match="sent back no file"):
        ai.run({"slug": "day-test", "tools": ["voice"]})


# ---------- timeouts and polling ----------

def test_a_submit_that_timed_out_is_never_sent_again_and_counts_as_billed(penv, monkeypatch):
    fake = use(monkeypatch, [("POST", "queue.fal.run/fal-ai/rife/video", [socket.timeout("timed out")])])
    with pytest.raises(ai.AiError) as err:
        ai.fal_run("fal-ai/rife/video", {"video_url": "https://x"})
    assert err.value.code == "timeout" and err.value.charged and len(fake.calls) == 1
    m = registry.model("replicate", "stability-ai/stable-audio-2.5")
    fake = use(monkeypatch, [("POST", "api.replicate.com", [socket.timeout("timed out")])])
    from studio.providers import async_task
    with pytest.raises(ai.AiError) as err:
        async_task.run(ai._ctx("replicate"), "stability-ai/stable-audio-2.5", m, {"prompt": "x"}, 60)
    assert err.value.charged and len(fake.calls) == 1
    m = registry.model("elevenlabs", "eleven_v3")
    fake = use(monkeypatch, [("POST", "api.elevenlabs.io", [socket.timeout("timed out")])])
    from studio.providers import sync_http
    with pytest.raises(ai.AiError) as err:
        sync_http.run(ai._ctx("elevenlabs"), "eleven_v3", m, {"text": "こんにちは", "voice": "v1"})
    assert err.value.charged and len(fake.calls) == 1
    # Through the ledger: the estimate stays, since the provider may have made it.
    use(monkeypatch, [("POST", "queue.fal.run/fal-ai/rife/video", [socket.timeout("timed out")])])
    with pytest.raises(ai.AiError):
        ai.charge("fal", "m", "music", "s", 0.2, lambda: ai.fal_run("fal-ai/rife/video", {}))
    assert rows()[-1]["usd"] == 0.2


def test_status_checks_back_off_from_3_to_15_seconds_and_a_lost_one_is_just_asked_again(penv, monkeypatch):
    monkeypatch.setattr(ai, "POLL", 3.0)
    q = fx("fal/in_queue.json")
    use(monkeypatch, [("POST", "queue.fal.run/fal-ai/rife/video", [(200, fx("fal/submit.json"))]),
                      ("GET", "requests/r1/status", [(200, q), (503, {}), socket.timeout("timed out"), (200, q), (200, q), (200, q), (200, fx("fal/completed.json"))]),
                      ("GET", "queue.fal.run/fal-ai/rife/requests/r1", [(200, {"video": {"url": "https://cdn.example/v.mp4"}})])])
    out = ai.fal_run("fal-ai/rife/video", {"video_url": "https://x"})
    assert out["video"]["url"] == "https://cdn.example/v.mp4"
    assert SLEPT == [3.0, 4.5, 6.75, 10.125, 15.0, 15.0]


# ---------- output normalisation ----------

def test_normalise_shapes_each_capability(tmp_path):
    seen = []

    def ff(args, timeout=600):
        seen.append(args)
        Path(args[-1]).write_bytes(b"x")
    src, orig = tmp_path / "in.bin", tmp_path / "orig.mp4"
    normalise.voice(src, tmp_path / "v.mp3", ff)
    assert seen[-1][seen[-1].index("-ac") + 1] == "1" and seen[-1][seen[-1].index("-ar") + 1] == "44100" and "libmp3lame" in seen[-1]
    normalise.music(src, tmp_path / "m.wav", 12, ff)
    assert seen[-1][seen[-1].index("-t") + 1] == "12.000" and "pcm_s16le" in seen[-1]
    normalise.sfx(src, tmp_path / "s.m4a", ff)
    assert "aac" in seen[-1] and seen[-1][-1].endswith(".m4a")
    normalise.upscale(src, orig, tmp_path / "u.mp4", ff, h264=True)
    assert seen[-1][seen[-1].index("-c:v") + 1] == "copy" and "1:a:0?" in seen[-1]
    normalise.upscale(src, orig, tmp_path / "u2.mp4", ff, h264=False)
    assert "libx264" in seen[-1], "an H.265 or ProRes result becomes H.264"
    normalise.img2video(src, tmp_path / "i.mp4", ff)
    assert "crop=1080:1920" in seen[-1][seen[-1].index("-vf") + 1]
    normalise.bg_cut(src, orig, tmp_path / "b.webm", ff, kind="alpha")
    assert "yuva420p" in seen[-1]


def test_normalise_voice_and_music_with_the_real_ffmpeg(tmp_path):
    from studio.config import ffmpeg_bin, ffprobe_bin

    def ff(args, timeout=600):
        subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-loglevel", "error", "-y", *args], check=True, capture_output=True, timeout=120)
    src = tmp_path / "stereo.wav"
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=20:sample_rate=48000", "-ac", "2", str(src)],
                   check=True, capture_output=True, timeout=60)
    probe = lambda p: json.loads(subprocess.run([str(ffprobe_bin()), "-v", "error", "-show_entries", "stream=channels,sample_rate,codec_name:format=duration",  # noqa: E731
                                                 "-of", "json", str(p)], capture_output=True, text=True, timeout=60).stdout)
    v = probe(normalise.voice(src, tmp_path / "v.mp3", ff))
    assert v["streams"][0]["channels"] == 1 and v["streams"][0]["sample_rate"] == "44100" and v["streams"][0]["codec_name"] == "mp3"
    m = probe(normalise.music(src, tmp_path / "m.wav", 12, ff))
    assert abs(float(m["format"]["duration"]) - 12) < 0.05 and m["streams"][0]["codec_name"] == "pcm_s16le"


# ---------- select and save-price ----------

def test_select_refuses_non_commercial_risky_unknown_and_text_to_video_models(penv, monkeypatch):
    use(monkeypatch, [("GET", "api.replicate.com/v1/models/topazlabs/video-upscale", [(200, fx("replicate/model_nc.json"))])])
    with pytest.raises(ai.AiError) as err:
        ai.select({"capability": "upscale", "provider": "replicate", "model": "topazlabs/video-upscale"})
    assert err.value.code == "licence" and "non-commercial" in str(err.value)
    assert not ai.WORKFLOW.exists(), "nothing saved"
    with pytest.raises(ai.AiError) as err:
        ai.select({"capability": "music", "provider": "kie", "model": "ai-music-api/generate"})
    assert err.value.code == "risk" and "acceptRisk" in str(err.value)
    out = ai.select({"capability": "music", "provider": "kie", "model": "ai-music-api/generate", "acceptRisk": True})
    assert out["block"]["model"] == "ai-music-api/generate" and any("unofficial" in w for w in out["warnings"])
    for bad in ({"capability": "music", "provider": "fal", "model": "fal-ai/rife/video"},           # a slow-motion model
                {"capability": "img2video", "provider": "fal", "model": "fal-ai/kling/text-to-video"},
                {"capability": "voice", "provider": "nobody", "model": "x"},
                {"capability": "text-to-video", "provider": "fal", "model": "x"}):
        with pytest.raises(ai.AiError):
            ai.select(bad)
    # llm and vision take any model the provider serves (OpenRouter by name); Together does not watch video.
    assert ai.select({"capability": "vision", "provider": "openrouter", "model": "google/gemini-3.9-pro"})["block"]["model"] == "google/gemini-3.9-pro"
    assert ai._review_model({}) == "google/gemini-3.9-pro"
    with pytest.raises(ai.AiError):
        ai.select({"capability": "vision", "provider": "together", "model": "some/model"})


def test_select_live_licence_check_for_fal_reset_and_off(penv, monkeypatch):
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/models?endpoint_id=fal-ai/film/video",
                              [(200, {"models": [{"endpoint_id": "fal-ai/film/video", "metadata": {"license_type": "commercial"}}]})])])
    out = ai.select({"capability": "slowmo", "provider": "fal", "model": "fal-ai/film/video"})
    assert out["block"] == {**out["block"], "provider": "fal", "model": "fal-ai/film/video", "source": "workflow"}
    assert "authorization" not in fake.calls[-1]["headers"], "fal's catalogue is read without the key"
    assert ai.select({"capability": "slowmo", "reset": True})["block"]["model"] == "fal-ai/rife/video"
    ai.select({"capability": "voice", "on": False})
    with pytest.raises(ai.AiError) as err:
        ai._choice("voice")
    assert err.value.code == "off"


def test_save_price_validates_and_removes(penv):
    with pytest.raises(ai.AiError, match="unit: one of"):
        ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": 0.1, "unit": "bananas"})
    for bad in (-1, True, "1", 5000):
        with pytest.raises(ai.AiError, match="usd"):
            ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": bad, "unit": "seconds"})
    with pytest.raises(ai.AiError):
        ai.save_price({"provider": "kie", "model": "nope", "usd": 1, "unit": "seconds"})
    out = ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": 0.05, "unit": "seconds"})
    assert ai.workflow()["prices"]["kie:topaz/video-upscale"]["usd"] == 0.05 and out["price"]["usd"] == 0.04, "the registry's list price still comes first"
    assert ai.save_price({"provider": "kie", "model": "topaz/video-upscale", "usd": None})["removed"] is True
    assert ai.workflow()["prices"] == {}


# ---------- keys, balances, the registry view ----------

def test_new_providers_keys_are_checked_saved_and_their_balances_read(penv, monkeypatch):
    fake = use(monkeypatch, [("GET", "api.elevenlabs.io/v1/models", [(200, [{"model_id": "eleven_v3"}])]),
                             ("GET", "api.elevenlabs.io/v1/user/subscription", [(200, fx("elevenlabs/subscription.json"))]),
                             ("GET", "api.stability.ai/v1/user/balance", [(200, fx("stability/balance.json"))]),
                             ("GET", "api.kie.ai/api/v1/chat/credit", [(200, fx("kie/credit.json"))]),
                             ("GET", "api.fal.ai/v1/account/billing", [(403, {})]),
                             ("GET", "openrouter.ai/api/v1/key", [(200, {"data": {"usage": 1, "limit": 5, "limit_remaining": 4}})])])
    new = "sk_fedcba9876543210fedcba9876543210fedcba9876543210"
    out = ai.save_key({"provider": "elevenlabs", "key": new})
    assert out["saved"] and f"ELEVENLABS_API_KEY={new}" in penv.joinpath(".env").read_text() and new not in json.dumps(out)
    assert fake.find("v1/models")[-1]["headers"]["xi-api-key"] == new
    from studio import research
    monkeypatch.setattr(research, "api_key", lambda: "")
    c = ai.credits({"fresh": True})["providers"]
    assert c["elevenlabs"]["left"] == 88000 and c["elevenlabs"]["unit"] == "characters"
    assert c["stability"]["left"] == 431.5 and c["kie"]["left"] == 812.5 and "note" in c["replicate"]
    s = ai.status()
    assert s["keys"]["elevenlabs"] is True and set(s["keys"]) >= {"fal", "openrouter", "together"}
    assert all(k not in json.dumps(c) + json.dumps(s) for k in (new, RP, KIE, ST, FAL))
    assert ai._scrub(f"bad {RP} and {new}") == "bad … and …"


def test_the_providers_view_never_holds_a_key_and_the_cli_prints_it(penv, monkeypatch, capsys):
    v = ai.providers_view()
    text = json.dumps(v)
    assert all(k not in text for k in (EL, RP, KIE, ST, FAL))
    by = {p["id"]: p for p in v["providers"]}
    assert by["elevenlabs"]["hasKey"] and by["elevenlabs"]["protocol"] == "sync_http" and by["kie"]["protocol"] == "async_task"
    assert v["capabilities"]["voice"]["labelRequired"] and v["capabilities"]["voice"]["block"]["source"] == "default"
    eleven = {m["id"]: m for m in by["elevenlabs"]["models"]}
    assert eleven["eleven_v3"]["price"]["usd"] == 0.08 and eleven["eleven_v3"]["voiceRequired"]
    assert {m["id"]: m["risk"] for m in by["kie"]["models"]}["ai-music-api/generate"] == "unofficial"
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    ai.main(["providers"])
    line = capsys.readouterr().out.strip().splitlines()[-1]
    assert line.startswith("RESULT ") and json.loads(line[7:])["ok"] is True
    assert all(k not in line for k in (EL, RP, KIE, ST, FAL))
