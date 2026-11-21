"""The AI provider registry and its four protocol adapters (studio.providers, studio.ai), offline: the registry's
contract (schema, every keyEnv in .env.example, never text-to-video, labelRequired per capability, commercial licences
only), fal / Replicate / kie.ai / ElevenLabs / Stability through the same fake HTTP as test_ai.py with recorded answers
(py/tests/fixtures/providers), the price chain and no_price, kie.ai's errors inside an HTTP 200, a submit that timed out
never sent again, 429 retried after Retry-After, output normalisation, select and save-price, and that a project without
workflow.json works exactly as before (fal defaults).
Phase 2 (read 2026-11-18): every provider cites its docs and date, no img2video model runs without the still, and
Runway, MiniMax (video and speech), Together video and vision, OpenRouter video and speech, Higgsfield (presigned
upload), PiAPI (unofficial), Luma (no list price), ElevenLabs music and Gemini writing through research._llm, each
replayed from py/tests/fixtures/providers."""
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
from tests.test_ai import FAL, OR, Fake, env, fal_routes, make_reel, rows  # noqa: F401 - the shared fixture and fakes

FIX = Path(__file__).parent / "fixtures" / "providers"
ROOT = Path(__file__).resolve().parents[2]
EL = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"
RP = "r8_0123456789abcdefABCDEF0123456789abcdef"
KIE = "0123456789abcdef0123456789abcdef"
ST = "sk-0123456789abcdefABCDEF0123456789abcdefABCD"
RW = "key_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
MM = "mm0123456789abcdefABCDEF0123456789abcdefABCD"
HF = "0123abcd-1111-4222-8333-444455556666:fedcba9876543210fedcba9876543210"
GM = "gemini-test-0123456789abcdefABCDEF0123"
PI = "pi0123456789abcdef0123456789abcdef0123456789abcdef"
LU = "luma-api-0123456789abcdef0123456789abcdef"
NEW_KEYS = {"RUNWAY_API_KEY": RW, "MINIMAX_API_KEY": MM, "HIGGSFIELD_API_KEY": HF, "GEMINI_API_KEY": GM, "PIAPI_API_KEY": PI,
            "LUMA_AGENTS_API_KEY": LU}
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
        f.write("".join(f"{k}={v}\n" for k, v in NEW_KEYS.items()))
    for k in ("ELEVENLABS_API_KEY", "REPLICATE_API_TOKEN", "KIE_API_KEY", "STABILITY_API_KEY", *NEW_KEYS):
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


# ---------- phase 2: more providers, each from its own docs (shared/ai-providers.json `docs`, read 2026-11-18) ----------

ITEM = {"tool": "living"}


def jpeg(tmp_path) -> Path:
    """A real small JPEG (the living tool sends a still)."""
    import cv2
    import numpy as np

    p = tmp_path / "still.jpg"
    cv2.imwrite(str(p), np.full((64, 48, 3), 120, dtype=np.uint8))
    return p


def test_every_provider_cites_its_docs_and_date_every_model_is_licensed_and_nothing_is_text_to_video():
    reg = registry.load()
    for pid, p in reg["providers"].items():
        assert p["docs"] and all(u.startswith("https://") for u in p["docs"]), pid
        assert registry.DATE_RX.match(p["asOf"]), pid
        for mid, m in p["models"].items():
            assert m["capability"] in registry.CAPABILITIES, (pid, mid)
            assert str(m["licence"]).lower() in registry.COMMERCIAL, (pid, mid)
            assert not registry.FORBIDDEN.search(json.dumps(m) + mid), (pid, mid)
            if m["capability"] == "img2video":
                assert "image" in m["files"].values(), f"{pid} {mid}: a prompt-only mode would be text-to-video"
            assert not (m.get("risk") and m.get("default")), (pid, mid)
    assert {"runway", "minimax", "higgsfield", "gemini", "piapi", "luma"} <= set(reg["providers"])
    assert all(m["risk"] == "unofficial" for m in reg["providers"]["piapi"]["models"].values())
    assert {"minimax music", "gemini video (Veo)", "piapi music (Suno, Udio)"} <= set(reg["_rejected"]), "what was left out says why"
    # The validator refuses an entry without its docs or date, a prompt-only image-to-video model, and a text-to-video path.
    for change, words in ((lambda r: r["providers"]["runway"].pop("docs"), "docs must list"),
                          (lambda r: r["providers"]["runway"].update(asOf="last week"), "asOf must be"),
                          (lambda r: r["providers"]["runway"]["models"]["gen4_turbo"].pop("files"), "prompt-only mode is text-to-video"),
                          (lambda r: r["providers"]["runway"]["models"]["gen4_turbo"].update(path="/v1/text_to_video"), "text-to-video is never registered"),
                          (lambda r: r["providers"]["minimax"]["models"]["MiniMax-H3"]["input"].update(task_type="t2v"), "text-to-video is never registered"),
                          (lambda r: r["providers"]["piapi"]["models"]["kling-2.5-std"].update(risk="maybe"), "risk must be"),
                          (lambda r: r["providers"]["runway"]["models"]["gen4_turbo"]["input"].update(promptImage="{promptImage}"), "placeholders must be lowercase"),
                          (lambda r: r["providers"]["openrouter"]["models"]["elevenlabs/eleven-v3"].update(protocol="carrier_pigeon"), "protocol carrier_pigeon")):
        bad = copy.deepcopy(reg)
        change(bad)
        assert any(words in x for x in registry.validate(bad)), words


def test_no_img2video_model_runs_without_the_still(penv, monkeypatch):
    fake = use(monkeypatch, [])
    for pid, mid, _m in registry.models_for("img2video"):
        with pytest.raises(ai.AiError) as err:
            ai._generate({**ITEM, "provider": pid, "model": mid}, {"prompt": "a camera move", "seconds": 5})
        assert err.value.code == "bad_input" and "needs a image" in str(err.value), (pid, mid)
    assert fake.calls == [], "nothing was sent"


def test_runway_living_photo_end_to_end_with_its_version_header(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    jpeg(penv)  # the reel's photo shot is a real picture now
    fake = use(monkeypatch, [("POST", "api.dev.runwayml.com/v1/image_to_video", [(200, fx("runway/task_created.json"))]),
                             ("GET", "api.dev.runwayml.com/v1/tasks/497f6eca", [(200, fx("runway/task_running.json")), (200, fx("runway/task_succeeded.json"))]),
                             ("GET", "dnznrvs05pmza.cloudfront.net", [(200, b"MP4runway")])])
    ai.select({"capability": "img2video", "provider": "runway", "model": "gen4_turbo"})
    item = ai.plan("day-test", ["living"])[0]
    assert (item["provider"], item["model"], item["usd"]) == ("runway", "gen4_turbo", 0.25), "5 s at 5 credits a second, $0.01 a credit"
    ai.run({"slug": "day-test", "tools": ["living"]})
    sub = fake.find("image_to_video")[0]
    assert sub["headers"]["authorization"] == f"Bearer {RW}" and sub["headers"]["x-runway-version"] == "2024-11-06"
    body = sub["body"]
    assert body["model"] == "gen4_turbo" and body["ratio"] == "720:1280" and body["duration"] == 5 and body["promptText"] == ai.LIVING_PROMPT
    assert body["promptImage"].startswith("data:image/jpeg;base64,"), "the real still goes inline (Runway takes data URIs up to 5 MB)"
    polls = fake.find("/v1/tasks/")
    assert len(polls) == 2 and all(c["headers"]["x-runway-version"] == "2024-11-06" for c in polls)
    assert rows()[-1]["provider"] == "runway" and rows()[-1]["usd"] == 0.25 and rows()[-1]["purpose"] == "ai-living"
    assert [n["label_required"] for n in projects.load("day-test")["ai"] if n["tool"] == "living"] == [True]
    use(monkeypatch, [("POST", "image_to_video", [(200, fx("runway/task_created.json"))]), ("GET", "/v1/tasks/", [(200, fx("runway/task_failed.json"))])])
    with pytest.raises(ai.AiError, match="did not pass moderation") as err:
        ai._generate({**ITEM, "provider": "runway", "model": "gen4.5"}, {"prompt": "p", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    assert err.value.charged is False


def test_minimax_h3_sends_a_first_frame_and_reads_the_v2_task(penv, monkeypatch):
    fake = use(monkeypatch, [("POST", "api.minimax.io/v2/video_generation", [(200, fx("minimax/video_created.json"))]),
                             ("GET", "api.minimax.io/v2/query/video_generation/424010985738629", [(200, fx("minimax/video_running.json")),
                                                                                               (200, fx("minimax/video_succeeded.json"))])])
    gen = ai._generate({**ITEM, "provider": "minimax", "model": "MiniMax-H3"}, {"prompt": "slow push-in", "seconds": 5},
                       {"image": (jpeg(penv), "image/jpeg")})
    assert gen["url"] == "https://video-product.cdn.minimax.io/inference_output/example/output.mp4"
    body = fake.find("v2/video_generation")[0]["body"]
    assert body["model"] == "MiniMax-H3" and body["resolution"] == "768P" and body["duration"] == 5
    text, image = body["content"]
    assert text == {"type": "text", "text": "slow push-in"} and image["role"] == "first_frame" and image["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert fake.find("v2/video_generation")[0]["headers"]["authorization"] == f"Bearer {MM}"
    use(monkeypatch, [("POST", "v2/video_generation", [(200, fx("minimax/video_created.json"))]), ("GET", "query/video_generation", [(200, fx("minimax/video_failed.json"))])])
    with pytest.raises(ai.AiError, match="sensitive content") as err:
        ai._generate({**ITEM, "provider": "minimax", "model": "MiniMax-H3-Highspeed"}, {"prompt": "p", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    assert err.value.charged is False


def test_minimax_speech_reads_the_url_from_json_and_bills_its_usage_characters(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    fake = use(monkeypatch, [("POST", "api.minimax.io/v1/t2a_v2", [(200, fx("minimax/t2a_ok.json"))]),
                             ("GET", "minimax-algeng-chat-tts-us", [(200, b"ID3minimax")])])
    out = ai.select({"capability": "voice", "provider": "minimax", "model": "speech-2.8-hd"})
    assert out["block"]["voice"] == "Japanese_CalmLady", "a system voice from MiniMax's own list is the default"
    ai.run({"slug": "day-test", "tools": ["voice"]})
    call = fake.find("t2a_v2")[0]
    assert call["body"]["model"] == "speech-2.8-hd" and call["body"]["output_format"] == "url" and call["body"]["language_boost"] == "Japanese"
    assert call["body"]["voice_setting"]["voice_id"] == "Japanese_CalmLady" and call["body"]["audio_setting"]["sample_rate"] == 44100
    assert len(fake.find("t2a_v2")) == 2 and len(fake.find("minimax-algeng")) == 2, "one request and one download per line"
    assert rows()[-1]["usd"] == round(2 * 15 * 0.1 / 1000, 6) and rows()[-1]["note"].startswith("actual"), "extra_info.usage_characters at $100 per M"
    use(monkeypatch, [("POST", "api.minimax.io/v1/t2a_v2", [(200, fx("minimax/t2a_no_balance.json"))])])
    with pytest.raises(ai.AiError) as err:
        ai.run({"slug": "day-test", "tools": ["voice"]})
    assert err.value.code == "no_credits", "base_resp.status_code 1008 inside an HTTP 200 is read as out of credit"


def test_together_wan_video_takes_the_still_as_bare_base64(penv, monkeypatch):
    fake = use(monkeypatch, [("POST", "api.together.ai/v2/videos", [(200, fx("together/video_created.json"))]),
                             ("GET", "api.together.ai/v2/videos/vid_0123456789abcdef", [(200, fx("together/video_completed.json"))])])
    gen = ai._generate({**ITEM, "provider": "together", "model": "Wan-AI/wan2.7-i2v"}, {"prompt": "p", "negative_prompt": "n", "seconds": 5},
                       {"image": (jpeg(penv), "image/jpeg")})
    assert gen["url"] == "https://api.together.ai/shrt/example-video.mp4"
    body = fake.find("v2/videos")[0]["body"]
    frame = body["media"]["frame_images"][0]
    assert body["model"] == "Wan-AI/wan2.7-i2v" and body["seconds"] == "5" and body["ratio"] == "9:16" and frame["frame"] == "first"
    assert not frame["input_image"].startswith("data:") and len(frame["input_image"]) > 100, "Together's keyframes take bare base64"
    assert fake.find("v2/videos")[0]["headers"]["authorization"].startswith("Bearer tgp_")


def test_openrouter_video_is_downloaded_with_the_key_and_its_reported_cost_is_kept(penv, monkeypatch):
    vid = "gen-vid-1795000000-Ab3dEf9hIjKlMnOpQrSt"
    fake = use(monkeypatch, [("POST", "openrouter.ai/api/v1/videos", [(200, fx("openrouter/video_submitted.json"))]),
                             ("GET", f"openrouter.ai/api/v1/videos/{vid}/content", [(200, b"MP4or")]),
                             ("GET", f"openrouter.ai/api/v1/videos/{vid}", [(200, fx("openrouter/video_in_progress.json")), (200, fx("openrouter/video_completed.json"))])])
    item = {**ITEM, "provider": "openrouter", "model": "kwaivgi/kling-v3.0-std"}
    gen = ai._generate(item, {"prompt": "p", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    sub = fake.calls[0]
    assert sub["url"] == "https://openrouter.ai/api/v1/videos" and sub["body"]["generate_audio"] is False and sub["body"]["aspect_ratio"] == "9:16"
    frame = sub["body"]["frame_images"][0]
    assert frame["frame_type"] == "first_frame" and frame["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert gen["cost"] == 0.42 and ai._actual({"unitPrice": 0.084, "unit": "seconds"}, gen) == 0.42, "OpenRouter's usage.cost replaces the estimate"
    ai._save_output(item, gen, penv / "or.mp4")
    got = fake.find("/content?index=0")[0]
    assert got["headers"]["authorization"] == f"Bearer {OR}" and (penv / "or.mp4").read_bytes() == b"MP4or", "unsigned_urls need the key"


def test_openrouter_speech_is_one_request_under_the_chat_provider(penv, monkeypatch):
    fake = use(monkeypatch, [("POST", "openrouter.ai/api/v1/audio/speech", [(200, b"ID3or", {"Content-Type": "audio/mpeg"})])])
    gen = ai._generate({"tool": "voice", "provider": "openrouter", "model": "elevenlabs/eleven-v3"}, {"text": "こんにちは", "voice": "sarah"})
    assert gen["bytes"] == b"ID3or" and gen["type"] == "audio/mpeg"
    assert fake.calls[0]["body"] == {"model": "elevenlabs/eleven-v3", "input": "こんにちは", "voice": "sarah", "response_format": "mp3"}


def test_together_speech_reads_japanese_in_its_native_voice(penv, monkeypatch):
    """Together's /v1/audio/speech (docs.together.ai/docs/text-to-speech, read 2026-11-21): Qwen3 TTS with language ja and
    ono_anna, its native Japanese voice; one request under the chat provider, priced per 1000 characters."""
    from tests.test_ai import TG

    fake = use(monkeypatch, [("POST", "api.together.ai/v1/audio/speech", [(200, b"ID3tg", {"Content-Type": "audio/mpeg"})])])
    sel = ai.select({"capability": "voice", "provider": "together", "model": "Qwen/Qwen3-TTS-12Hz-1.7B"})
    assert sel["block"]["voice"] == "ono_anna" and not [w for w in sel["warnings"] if "key" in w], "the voice comes with the model; the key is saved"
    gen = ai._generate({"tool": "voice", "provider": "together", "model": "Qwen/Qwen3-TTS-12Hz-1.7B"}, {"text": "こんにちは", "voice": "ono_anna"})
    assert gen["bytes"] == b"ID3tg" and fake.calls[0]["headers"]["authorization"] == f"Bearer {TG}"
    assert fake.calls[0]["body"] == {"model": "Qwen/Qwen3-TTS-12Hz-1.7B", "input": "こんにちは", "voice": "ono_anna", "language": "ja",
                                     "response_format": "mp3", "stream": False}
    assert ai.list_price("together", "Qwen/Qwen3-TTS-12Hz-1.7B")["unit_price"] == 0.02


def test_a_job_can_be_pointed_at_stability_before_its_key_is_saved(penv, monkeypatch):
    """Switching off fal before the Stability key is pasted: the choice is kept and says the key is missing (never a key
    invented); the key page in the registry is the one Stability's docs name."""
    ai._upsert_env("STABILITY_API_KEY", None)
    sel = ai.select({"capability": "music", "provider": "stability", "model": "stable-audio-2.5"})
    assert sel["block"]["provider"] == "stability" and any("No Stability AI key yet" in w for w in sel["warnings"])
    p = registry.provider("stability")
    assert p["keyHint"].startswith("platform.stability.ai/dashboard/api-keys") and p["dashboard"] == "https://platform.stability.ai/dashboard/billing"


def test_higgsfield_uploads_to_a_presigned_url_without_the_key_and_a_moderated_request_costs_nothing(penv, monkeypatch):
    rid, hm = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff", "kling-video/v2.5-turbo/standard/image-to-video"
    fake = use(monkeypatch, [("POST", "api.higgsfield.ai/files/generate-upload-url", [(200, fx("higgsfield/upload_url.json"))]),
                             ("PUT", "storage.higgsfield.example/presigned-upload-url", [(200, b"")]),
                             ("POST", f"api.higgsfield.ai/{hm}", [(200, fx("higgsfield/submitted.json"))]),
                             ("GET", f"api.higgsfield.ai/requests/{rid}/status", [(200, fx("higgsfield/in_progress.json")), (200, fx("higgsfield/completed.json"))])])
    gen = ai._generate({**ITEM, "provider": "higgsfield", "model": hm}, {"prompt": "p", "negative_prompt": "n", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    assert gen["url"] == "https://cdn.higgsfield.example/video.mp4"
    ask, put, sub = fake.calls[0], fake.calls[1], fake.calls[2]
    assert ask["headers"]["authorization"] == f"Key {HF}" and ask["body"] == {"content_type": "image/jpeg"}
    assert "authorization" not in put["headers"] and put["headers"]["x-amz-tagging"] == "retention=temporary", "the key never goes to storage"
    assert sub["body"] == {"prompt": "p", "image_url": "https://cdn.higgsfield.example/input/still.jpeg", "negative_prompt": "n", "duration": 5, "cfg_scale": 0.5}
    use(monkeypatch, [("POST", "generate-upload-url", [(200, fx("higgsfield/upload_url.json"))]), ("PUT", "storage.higgsfield", [(200, b"")]),
                      ("POST", "image-to-video", [(200, fx("higgsfield/submitted.json"))]), ("GET", "/status", [(200, fx("higgsfield/nsfw.json"))])])
    with pytest.raises(ai.AiError, match="content moderation") as err:
        ai._generate({**ITEM, "provider": "higgsfield", "model": hm}, {"prompt": "p", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    assert err.value.charged is False, "Higgsfield does not charge failed or nsfw requests"
    # Its key check: an unknown request answers 404 to a good key, 401 to a bad one.
    use(monkeypatch, [("GET", "api.higgsfield.ai/requests/", [(404, {"detail": "not found"})])])
    assert ai.check_key({"provider": "higgsfield", "key": HF})["valid"]
    use(monkeypatch, [("GET", "api.higgsfield.ai/requests/", [(401, {"detail": "invalid credentials"})])])
    with pytest.raises(ai.AiError) as err:
        ai.check_key({"provider": "higgsfield", "key": HF})
    assert err.value.code == "bad_key"


def test_piapi_kling_is_unofficial_and_its_capitalised_states_are_read(penv, monkeypatch):
    with pytest.raises(ai.AiError) as err:
        ai.select({"capability": "img2video", "provider": "piapi", "model": "kling-2.5-std"})
    assert err.value.code == "risk" and "accounts" in str(err.value)
    assert ai.select({"capability": "img2video", "provider": "piapi", "model": "kling-2.5-std", "acceptRisk": True})["block"]["provider"] == "piapi"
    tid = "b2a1c9e0-1111-4222-8333-444455556666"
    fake = use(monkeypatch, [("POST", "upload.theapi.app/api/ephemeral_resource", [(200, fx("piapi/upload_ok.json"))]),
                             ("POST", "api.piapi.ai/api/v1/task", [(200, fx("piapi/task_created.json"))]),
                             ("GET", f"api.piapi.ai/api/v1/task/{tid}", [(200, fx("piapi/task_completed.json"))])])
    gen = ai._generate({**ITEM, "provider": "piapi", "model": "kling-2.5-std"}, {"prompt": "p", "negative_prompt": "n", "seconds": 5},
                       {"image": (jpeg(penv), "image/jpeg")})
    assert gen["url"] == "https://storage.theapi.app/videos/example.mp4", "status 'Completed' ends the wait like 'completed'"
    up, sub = fake.calls[0], fake.calls[1]
    assert up["headers"]["x-api-key"] == PI and up["body"]["file_name"] == "still.jpg" and len(up["body"]["file_data"]) > 100
    assert sub["body"] == {"model": "kling", "task_type": "video_generation",
                           "input": {"prompt": "p", "negative_prompt": "n", "image_url": "https://img.theapi.app/ephemeral/still.jpg", "duration": 5,
                                     "aspect_ratio": "9:16", "mode": "std", "version": "2.5"}}


def test_luma_has_no_list_price_so_living_is_refused_until_you_enter_one(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    out = ai.select({"capability": "img2video", "provider": "luma", "model": "ray-3.2"})
    assert any("No price is known" in w for w in out["warnings"])
    with pytest.raises(ai.AiError) as err:
        ai.plan("day-test", ["living"])
    assert err.value.code == "no_price"
    ai.save_price({"provider": "luma", "model": "ray-3.2", "usd": 1.0, "unit": "videos"})
    assert ai.plan("day-test", ["living"])[0]["usd"] == 1.0
    fake = use(monkeypatch, [("POST", "agents.lumalabs.ai/v1/generations", [(201, fx("luma/created.json"))]),
                             ("GET", "agents.lumalabs.ai/v1/generations/d290f1ee", [(200, fx("luma/completed.json"))]),
                             ("GET", "agents.lumalabs.ai/v1/credits", [(200, fx("luma/credits.json"))])])
    gen = ai._generate({**ITEM, "provider": "luma", "model": "ray-3.2"}, {"prompt": "p", "seconds": 5}, {"image": (jpeg(penv), "image/jpeg")})
    assert gen["url"].startswith("https://storage.example.com/generations/d290f1ee/output.mp4")
    video = fake.calls[0]["body"]["video"]
    assert fake.calls[0]["body"]["type"] == "video" and video["duration"] == "5s" and video["start_frame"]["media_type"] == "image/jpeg"
    assert not video["start_frame"]["data"].startswith("data:"), "Luma's ImageRef takes base64 data with its media_type"
    assert ai._balance("luma", LU) == {"left": 49512, "unit": "credits"}


def test_runway_balance_and_elevenlabs_music_in_milliseconds(penv, monkeypatch):
    use(monkeypatch, [("GET", "api.dev.runwayml.com/v1/organization", [(200, fx("runway/organization.json"))])])
    assert ai._balance("runway", RW) == {"left": 1250, "unit": "credits"}
    fake = use(monkeypatch, [("POST", "api.elevenlabs.io/v1/music", [(200, b"ID3music", {"Content-Type": "audio/mpeg"})])])
    gen = ai._generate({"tool": "music", "provider": "elevenlabs", "model": "music_v2_5"}, {"prompt": "calm guitar", "seconds": 11})
    call = fake.calls[0]
    assert call["url"].endswith("/v1/music?output_format=mp3_44100_128") and gen["bytes"] == b"ID3music"
    assert call["body"] == {"prompt": "calm guitar", "music_length_ms": 11000, "model_id": "music_v2_5", "force_instrumental": True}


def test_research_writing_goes_to_the_picked_llm_provider_priced_and_charged(penv, monkeypatch):
    from studio import research

    monkeypatch.setattr(research, "HOME", penv / "research")
    monkeypatch.setattr(research, "daily_budget", lambda: 5.0)
    monkeypatch.setattr(research, "openrouter_key", lambda: "")
    calls = []

    def http(method, url, *, data=None, headers=None, timeout=60):
        calls.append({"url": url, "body": json.loads(data), "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        return 200, {}, json.dumps(fx("gemini/chat_angles.json")).encode()
    monkeypatch.setattr(research, "_call", http)
    ai.select({"capability": "llm", "provider": "gemini", "model": "gemini-3.8-flash"})
    got = research._llm("system", "user", purpose="research")
    assert got == {"angles": [{"title": "紅葉の嬬恋", "why": "Autumn pages", "sources": ["https://news.example.jp/a"]}]}, "a fenced JSON answer is read"
    c = calls[0]
    assert c["url"] == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" and c["headers"]["authorization"] == f"Bearer {GM}"
    assert c["body"]["model"] == "gemini-3.8-flash" and c["body"]["reasoning_effort"] == "low" and "response_format" not in c["body"]
    r = rows()[-1]
    assert (r["provider"], r["purpose"], r["slug"]) == ("gemini", "research", None)
    assert r["usd"] == round(1000 * 0.00000075 + 200 * 0.00000375, 6), "tokens x the registry's list price"
    assert research._llm("system", "user") == got and len(calls) == 1, "the same question is answered from the cache"
    ai.select({"capability": "llm", "on": False})
    assert research._llm("other", "question") is None and len(calls) == 1, "switched off: nothing asked"
    # Gemini's Flash price holds until 2026-12-31; after that the list price carries a warning.
    m = registry.model("gemini", "gemini-3.8-flash")
    monkeypatch.setitem(m, "price", {**m["price"], "validUntil": "2026-01-01"})
    assert "held until 2026-01-01" in ai.list_price("gemini", "gemini-3.8-flash")["warning"]


def test_picture_questions_go_to_the_vision_model_picked_for_the_project(penv, monkeypatch):
    from studio import config

    monkeypatch.setattr(config, "own_llm", lambda vision=False: None)
    answer = {"choices": [{"message": {"content": "{\"title\": \"浅間山\"}"}}], "usage": {"prompt_tokens": 2000, "completion_tokens": 100}}
    fake = use(monkeypatch, [("POST", "api.together.xyz/v1/chat/completions", [(200, answer)])])
    ai.select({"capability": "vision", "provider": "together", "model": "moonshotai/Kimi-K3"})
    assert ai.vision_json([jpeg(penv)], "sys", "what is this", "reel-a") == {"title": "浅間山"}
    body = fake.calls[0]["body"]
    assert body["model"] == "moonshotai/Kimi-K3" and "response_format" not in body
    assert body["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    r = rows()[-1]
    assert (r["provider"], r["purpose"], r["slug"]) == ("together", "ai-vision", "reel-a") and r["usd"] == round(2000 * 0.000003 + 100 * 0.000015, 6)
