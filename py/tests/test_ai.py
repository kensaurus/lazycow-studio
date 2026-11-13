"""AI assist (studio.ai) against a fake HTTP layer, no real network or spend: the one ledger and its caps
(per reel, total, daily), refusal before any call, ledger rows with provider / model / purpose / slug,
estimate math from fal's price table (and its cache), key check / save / removal in .env without echoing
the key, cap settings, the reviewer's parse and run, tools wired into the project, approved reels left
alone, the voice mixed under the music, and YouTube's synthetic-media flag."""
import json
import subprocess
from pathlib import Path

import pytest

from studio import ai, projects
from studio.db import connect

FAL = "0123abcd-0000-4000-8000-0123456789ab:0123456789abcdef0123456789abcdef"
OR = "sk-or-v1-0123456789abcdef0123456789abcdef"
TG = "tgp_v1_0123456789abcdefghijklmnop"
PRICES = {"prices": [
    {"endpoint_id": "fal-ai/rife/video", "unit_price": 0.0013, "unit": "seconds"},
    {"endpoint_id": "fal-ai/topaz/upscale/video", "unit_price": 0.01, "unit": "seconds"},
    {"endpoint_id": "fal-ai/stable-audio-25/text-to-audio", "unit_price": 0.2, "unit": "audios"},
    {"endpoint_id": "fal-ai/minimax/speech-02-hd", "unit_price": 0.1, "unit": "1000 characters"},
    {"endpoint_id": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", "unit_price": 0.07, "unit": "seconds"},
]}
MODELS = {"data": [{"id": ai.REVIEW_MODEL, "architecture": {"input_modalities": ["text", "image", "video"]},
                    "pricing": {"prompt": "0.000001", "completion": "0.000004"}}]}


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=60):
        body = None
        if data:
            try:
                body = json.loads(data)
            except (ValueError, UnicodeDecodeError):
                body = f"<{len(data)} bytes>"
        self.calls.append({"method": method, "url": url, "body": body, "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                reply = replies.pop(0) if len(replies) > 1 else replies[0]
                if isinstance(reply, BaseException):
                    raise reply
                status, payload = reply[0], reply[1]
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                return status, (reply[2] if len(reply) > 2 else {}), raw
        raise AssertionError(f"unexpected call {method} {url}")

    def find(self, part):
        return [c for c in self.calls if part in c["url"]]


def fal_routes(output_by_endpoint):
    """A fal queue that finishes at once; each endpoint returns its output."""
    routes = [("GET", "api.fal.ai/v1/models/pricing", [(200, PRICES)]),
              ("POST", "rest.fal.ai/storage/auth/token", [(200, {"token": "t", "token_type": "Bearer", "base_url": "https://v3.fal.media"})]),
              ("POST", "v3.fal.media/files/upload", [(200, {"access_url": "https://v3.fal.media/files/x/in.mp4"})]),
              ("GET", "https://cdn.example/", [(200, b"RESULTBYTES")])]
    for ep, out in output_by_endpoint.items():
        routes += [("POST", f"queue.fal.run/{ep}", [(200, {"request_id": "r1", "status_url": f"https://queue.fal.run/{ep}/requests/r1/status",
                                                          "response_url": f"https://queue.fal.run/{ep}/requests/r1"})]),
                   ("GET", f"queue.fal.run/{ep}/requests/r1/status", [(200, {"status": "COMPLETED"})]),
                   ("GET", f"queue.fal.run/{ep}/requests/r1", [(200, out)])]
    return routes


@pytest.fixture
def env(tmp_path, monkeypatch):
    envfile = tmp_path / ".env"
    envfile.write_text(f"# studio\nFAL_KEY={FAL}\nOPENROUTER_API_KEY_PARKED={OR}\nTOGETHER_API_KEY={TG}\nSTUDIO_DAILY_USD_BUDGET=50\n", encoding="utf-8")
    monkeypatch.setattr(ai, "ENV_FILE", envfile)
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    monkeypatch.setattr(ai, "POLL", 0)
    for k in ("FAL_KEY", "OPENROUTER_API_KEY_PARKED", "OPENROUTER_API_KEY", "TOGETHER_API_KEY", "STUDIO_AI_REEL_CAP_USD", "STUDIO_AI_TOTAL_CAP_USD",
              "STUDIO_DAILY_USD_BUDGET", "STUDIO_AI_REVIEW_MODEL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(projects, "DIR", tmp_path / "projects")
    monkeypatch.setattr(ai, "_mezz", lambda slug: tmp_path / "mezz" / slug)
    with connect() as con:
        con.execute("DELETE FROM spend")
        con.execute("DELETE FROM drafts")
    return tmp_path


def use(monkeypatch, routes):
    fake = Fake(routes)
    monkeypatch.setattr(ai, "_call", fake)
    return fake


def rows():
    with connect() as con:
        return [dict(r) for r in con.execute("SELECT model, purpose, usd, provider, slug, note FROM spend ORDER BY id")]


def add_spend(usd, slug="other", purpose="ai-music"):
    with connect() as con:
        con.execute("INSERT INTO spend (ts, model, purpose, usd, provider, slug) VALUES (datetime('now', 'localtime'), 'm', ?, ?, 'fal', ?)", (purpose, usd, slug))


# ---------- a small reel on disk ----------

def make_reel(root: Path, slug="day-test", monkeypatch=None):
    clip, still = root / "clip.mp4", root / "still.jpg"
    clip.write_bytes(b"v")
    still.write_bytes(b"p")
    project = {"slug": slug, "title_ja": "テスト", "bpm": 120, "theme": "field",
               "shots": [{"src": "a/clip.mp4", "sec": 3.0, "role": "auto: a tent glowing at night (match 0.2)"},
                         {"src": "a/still.jpg", "sec": 2.0, "role": "auto: coffee (match 0.2)"},
                         {"src": "a/small.mp4", "sec": 2.5, "role": "auto: fire (match 0.2)"}],
               "beats": [{"kind": "hook", "ja": "山にこもって、\nどこまで進むか。", "en": "Go up.", "startSec": 0.1, "endSec": 3.4},
                         {"kind": "line", "ja": "標高1,444m、\n100Mbpsの光回線。", "en": "Fibre.", "startSec": 3.7, "endSec": 7.4},
                         {"kind": "end", "ja": "嬬恋牧場Work&Camp", "en": "Tsumagoi Work&Camp", "startSec": 7.5, "endSec": 7.5}]}
    projects.save(project)
    picks = {"a/clip.mp4|3.0|None": {"start": 4.0, "is360": False}, "a/small.mp4|2.5|None": {"start": 1.0, "is360": False}}
    (root / "mezz" / slug).mkdir(parents=True, exist_ok=True)
    (root / "mezz" / slug / "picks.json").write_text(json.dumps(picks), encoding="utf-8")
    if monkeypatch:
        sizes = {"clip.mp4": {"width": 1920, "height": 1080, "fps": 60.0, "duration": 30.0},
                 "small.mp4": {"width": 720, "height": 1280, "fps": 30.0, "duration": 10.0}}
        monkeypatch.setattr(ai, "_resolve", lambda src: root / Path(src).name)
        monkeypatch.setattr(ai, "probe", lambda path: sizes[Path(path).name])
        monkeypatch.setattr(ai, "probe_audio", lambda path: 3.0)

        def fake_ffmpeg(args, timeout=600):
            Path(args[-1]).parent.mkdir(parents=True, exist_ok=True)
            Path(args[-1]).write_bytes(b"ffmpeg")
        monkeypatch.setattr(ai, "_ffmpeg", fake_ffmpeg)
        monkeypatch.setattr(ai, "cut_window", lambda src, start, seconds, dest, max_short=1440: (dest.write_bytes(b"seg"), dest)[1])
    return project


# ---------- the ledger and its caps ----------

def test_charge_records_the_actual_cost_with_provider_model_purpose_and_slug(env):
    out, usd = ai.charge("openrouter", "google/x", "review", "day-1", 0.05, lambda: ({"ok": 1, "_tokens": (100, 20)}, 0.0123))
    assert out["ok"] == 1 and usd == 0.0123
    out, usd = ai.charge("fal", "fal-ai/rife/video", "slowmo", "day-1", 0.004, lambda: ({"ok": 2}, None))
    assert usd == 0.004, "no actual from the provider: the estimate is recorded"
    r = rows()
    assert [(x["provider"], x["model"], x["purpose"], x["slug"], x["usd"]) for x in r] == [
        ("openrouter", "google/x", "ai-review", "day-1", 0.0123), ("fal", "fal-ai/rife/video", "ai-slowmo", "day-1", 0.004)]
    assert r[0]["note"].startswith("actual") and r[1]["note"].startswith("estimate")
    assert ai.spent("day-1") == {"reel": 0.0163, "total": 0.0163, "today": 0.0163}


def test_a_call_over_the_reel_cap_is_refused_before_it_runs(env):
    add_spend(1.90, slug="day-1")
    ran = []
    with pytest.raises(ai.AiError) as err:
        ai.charge("fal", "m", "living", "day-1", 0.35, lambda: (ran.append(1), None))
    assert err.value.code == "cap" and err.value.status == 402
    assert "already used $1.90 of its $2.00 AI limit" in str(err.value)
    assert not ran and len(rows()) == 1, "nothing called, nothing recorded"
    ai.charge("fal", "m", "music", "day-2", 0.35, lambda: ({}, None))  # another reel still has room


def test_the_total_cap_and_the_daily_budget_refuse_too(env):
    env.joinpath(".env").write_text(env.joinpath(".env").read_text() + "STUDIO_AI_TOTAL_CAP_USD=1\n", encoding="utf-8")
    add_spend(0.9, slug="a")
    with pytest.raises(ai.AiError, match=r"over the \$1.00 AI limit"):
        ai.charge("fal", "m", "music", "b", 0.2, lambda: ({}, None))
    env.joinpath(".env").write_text(f"FAL_KEY={FAL}\nSTUDIO_DAILY_USD_BUDGET=1\n", encoding="utf-8")
    with pytest.raises(ai.AiError, match="over the daily budget of \\$1.00"):
        ai.charge("fal", "m", "music", "b", 0.2, lambda: ({}, None))
    # Research's paid calls count against the daily budget too (it is one budget).
    with connect() as con:
        con.execute("DELETE FROM spend")
        con.execute("INSERT INTO spend (ts, model, purpose, usd) VALUES (datetime('now', 'localtime'), 'x', 'research', 0.95)")
    with pytest.raises(ai.AiError, match="daily budget"):
        ai.charge("fal", "m", "music", "b", 0.1, lambda: ({}, None))


def test_a_failed_call_costs_nothing_unless_the_provider_billed_it(env):
    def boom():
        raise ai.AiError("fal.ai had a problem", "upstream", 502)
    with pytest.raises(ai.AiError):
        ai.charge("fal", "m", "music", "s", 0.2, boom)

    def billed():
        raise ai.AiError("download failed", "upstream", 502, charged=True)
    with pytest.raises(ai.AiError):
        ai.charge("fal", "m", "music", "s", 0.2, billed)
    assert [r["usd"] for r in rows()] == [0.0, 0.2]
    assert all(r["note"].startswith("failed") for r in rows())


# ---------- estimate ----------

def test_estimate_prices_each_tool_from_the_fal_table_and_checks_the_caps(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, PRICES)]), ("GET", "openrouter.ai/api/v1/models", [(200, MODELS)])])
    e = ai.estimate({"slug": "day-test", "tools": ["review", "sharpen", "slowmo", "living", "music", "voice"], "options": {"into": "day-test-ai"}})
    by = {t["tool"]: t for t in e["tools"]}
    assert by["sharpen"]["usd"] == 0.025 and by["sharpen"]["items"][0]["target"] == 2, "the 720 px clip, 2.5 s x $0.01"
    assert "x1.5" in by["sharpen"]["items"][0]["what"]
    assert by["slowmo"]["usd"] == 0 and by["slowmo"]["note"], "the 60 fps clip is already smooth; the small one went to sharpen"
    assert by["living"]["usd"] == 0.35 and by["living"]["items"][0]["target"] == 1
    assert by["music"]["usd"] == 0.2
    chars = len("山にこもって、どこまで進むか。") + len("標高1,444m、100Mbpsの光回線。")
    assert by["voice"]["usd"] == round(chars / 1000 * 0.1, 4)
    review_usd = round((7.5 * 300 + 3500) * 0.000001 + 1800 * 0.000004, 4)
    assert by["review"]["usd"] == review_usd
    assert e["total"] == round(review_usd + 0.025 + 0.35 + 0.2 + by["voice"]["usd"], 4)
    assert e["fits"] and e["labelRequired"] and e["into"] == "day-test-ai"
    assert e["caps"] == {"reel": 2.0, "total": 20.0, "daily": 50.0}
    priced = fake.find("pricing")
    assert len(priced) == 1 and priced[0]["headers"]["authorization"] == f"Key {FAL}"
    ai.estimate({"slug": "day-test", "tools": ["music"]})
    assert len(fake.find("pricing")) == 1, "the price table is cached for 24 h"


def test_estimate_says_no_when_it_would_pass_a_cap_and_explicit_shots_are_checked(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, PRICES)])])
    add_spend(1.8, slug="day-test")
    e = ai.estimate({"slug": "day-test", "tools": ["living", "music"]})
    assert not e["fits"] and "AI limit" in e["refusal"] and e["room"]["reel"] == 0.2
    with pytest.raises(ai.AiError, match="still photos"):
        ai.plan("day-test", ["living"], {"shots": {"living": [0]}})
    with pytest.raises(ai.AiError, match="one AI change per shot"):
        ai.plan("day-test", ["sharpen", "slowmo"], {"shots": {"sharpen": [0], "slowmo": [0]}})
    with pytest.raises(ai.AiError, match="tools: one or more"):
        ai.plan("day-test", ["text-to-video"])


def test_fal_prices_fall_back_to_the_measured_table_when_the_api_fails(env, monkeypatch):
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(503, {"detail": "down"})])])
    p = ai.fal_prices(["fal-ai/kling-video/v2.5-turbo/pro/image-to-video"])
    assert p["fal-ai/kling-video/v2.5-turbo/pro/image-to-video"]["unit_price"] == 0.07
    assert "measured 2026-11-09" in p["fal-ai/kling-video/v2.5-turbo/pro/image-to-video"]["source"]
    assert ai.quantity("1000 characters", chars=250) == 0.25 and ai.quantity("seconds", seconds=3) == 3 and ai.quantity("audios") == 1


# ---------- keys and caps settings ----------

def test_save_key_checks_it_free_upserts_env_never_echoes_and_empty_removes(env, monkeypatch):
    new_fal = "fedcba98-0000-4000-8000-0123456789ab:fedcba9876543210fedcba9876543210"
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, PRICES)]), ("GET", "openrouter.ai/api/v1/key", [(200, {"data": {"label": "x"}})]),
                             ("GET", "api.together.xyz/v1/models", [(200, [])])])
    out = ai.save_key({"provider": "fal", "key": new_fal})
    assert out == {"provider": "fal", "saved": True, "removed": False, "present": True}
    assert new_fal not in json.dumps(out)
    text = env.joinpath(".env").read_text()
    assert f"FAL_KEY={new_fal}" in text and text.count("FAL_KEY=") == 1 and text.startswith("# studio")
    assert fake.calls[-1]["headers"]["authorization"] == f"Key {new_fal}"
    out = ai.save_key({"provider": "openrouter", "key": OR + "ff"})
    text = env.joinpath(".env").read_text()
    assert f"OPENROUTER_API_KEY_PARKED={OR}ff" in text and "\nOPENROUTER_API_KEY=" not in text, "saved where the reviewer reads; old tagging stays off"
    assert ai.save_key({"provider": "together", "key": ""}) == {"provider": "together", "saved": False, "removed": True, "present": False}
    assert "TOGETHER_API_KEY" not in env.joinpath(".env").read_text()


def test_a_wrong_key_is_a_plain_error_and_leaves_env_alone(env, monkeypatch):
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(401, {"detail": f"bad key {FAL}"})])])
    before = env.joinpath(".env").read_text()
    with pytest.raises(ai.AiError) as err:
        ai.save_key({"provider": "fal", "key": "aaaa1111-0000-4000-8000-0123456789ab:00000000000000000000000000000000"})
    assert err.value.code == "bad_key" and "fal.ai did not accept the key" in str(err.value)
    with pytest.raises(ai.AiError, match="start with sk-or-"):
        ai.save_key({"provider": "openrouter", "key": "not-an-openrouter-key-at-all"})
    assert env.joinpath(".env").read_text() == before
    assert FAL not in ai._scrub(f"Key {FAL} and {OR}")


def test_save_caps_validates_and_the_new_caps_apply_at_once(env):
    out = ai.save_caps({"ai_reel_cap_usd": 1.5, "ai_total_cap_usd": 12})
    assert out["saved"] == {"ai_reel_cap_usd": 1.5, "ai_total_cap_usd": 12.0}
    assert ai.caps()["reel"] == 1.5 and ai.caps()["total"] == 12.0
    assert "STUDIO_AI_REEL_CAP_USD=1.5" in env.joinpath(".env").read_text()
    for bad in (-1, "2", True, 5000):
        with pytest.raises(ai.AiError, match="a number of US dollars"):
            ai.save_caps({"ai_total_cap_usd": bad})


def test_status_reports_keys_as_booleans_caps_and_spend_per_reel(env, monkeypatch):
    add_spend(0.3, slug="day-1")
    add_spend(0.1, slug="day-2", purpose="ai-voice")
    s = ai.status()
    assert s["keys"] == {"fal": True, "openrouter": True, "together": True}
    assert FAL not in json.dumps(s) and OR not in json.dumps(s)
    assert s["spent"]["total"] == 0.4 and {r["slug"]: r["usd"] for r in s["spent"]["perReel"]} == {"day-1": 0.3, "day-2": 0.1}
    assert s["paidTagging"] is False


# ---------- the reviewer ----------

def test_parse_review_cleans_scores_lists_and_fixes():
    text = "```json\n" + json.dumps({"hook": {"score": 14, "notes": "strong"}, "look": {"score": "6.5"},
                                     "mismatches": [{"line": "星空", "at": 4.2, "shows": "a daytime tent", "why": "no stars in daylight"}],
                                     "claims": [{"text": "温泉あり", "why": "not an approved fact"}],
                                     "fixes": [{"action": "swap clip", "detail": f"fix {i}"} for i in range(5)], "summary": "ok"}) + "\n```"
    r = ai.parse_review(text)
    assert r["hook"]["score"] == 10.0 and r["look"]["score"] == 6.5
    assert r["mismatches"][0]["shows"] == "a daytime tent" and r["mismatches"][0]["at"] == 4.2
    assert len(r["fixes"]) == 3 and r["claims"][0]["text"] == "温泉あり"
    with pytest.raises(ai.AiError, match="not readable"):
        ai.parse_review("I think the reel is nice.")


def test_review_sends_the_video_records_the_actual_cost_and_caches_per_render(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    mp4 = env / "master.mp4"
    mp4.write_bytes(b"x" * 100)
    monkeypatch.setattr(ai, "master", lambda slug: mp4)
    answer = {"hook": {"score": 7, "notes": "moves at once"}, "look": {"score": 8, "notes": "clean"}, "mismatches": [], "claims": [],
              "fixes": [{"action": "move line", "detail": "move line 2 to shot 3"}], "summary": "Good."}
    fake = use(monkeypatch, [("GET", "openrouter.ai/api/v1/models", [(200, MODELS)]),
                             ("POST", "openrouter.ai/api/v1/chat/completions", [(200, {"choices": [{"message": {"content": json.dumps(answer)}}],
                                                                                         "usage": {"prompt_tokens": 9000, "completion_tokens": 400, "cost": 0.0111}})])])
    r = ai.review({"slug": "day-test"})
    assert r["hook"]["score"] == 7 and r["fixes"][0]["detail"] == "move line 2 to shot 3" and r["usd"] == 0.0111 and not r["cached"]
    sent = fake.find("chat/completions")[0]
    parts = sent["body"]["messages"][1]["content"]
    assert parts[1]["type"] == "video_url" and parts[1]["video_url"]["url"].startswith("data:video/mp4;base64,")
    data = json.loads(parts[0]["text"].split("Data:\n", 1)[1])
    assert data["captions"][1]["ja"].startswith("標高1,444m") and data["shots"][1]["kind"] == "photo"
    assert data["shots"][0]["searched_for"] == "a tent glowing at night"
    assert sent["headers"]["authorization"] == f"Bearer {OR}"
    assert rows()[-1]["usd"] == 0.0111 and rows()[-1]["purpose"] == "ai-review" and rows()[-1]["slug"] == "day-test"
    again = ai.review({"slug": "day-test"})
    assert again["cached"] and len(fake.find("chat/completions")) == 1, "the same render is reviewed once"
    note = projects.load("day-test")["ai"][-1]
    assert note["tool"] == "review" and note["label_required"] is False and "hook 7.0/10" in note["what"]
    assert ai.last_review({"slug": "day-test"})["review"]["current"] is True


# ---------- run ----------

def test_run_makes_an_ai_copy_wires_the_outputs_and_leaves_the_original(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    from studio import sound
    monkeypatch.setattr(sound, "LIB", env / "audio")
    fake = use(monkeypatch, fal_routes({
        "fal-ai/topaz/upscale/video": {"video": {"url": "https://cdn.example/up.mp4"}},
        "fal-ai/stable-audio-25/text-to-audio": {"audio": {"url": "https://cdn.example/bed.wav"}, "seed": 7},
        "fal-ai/minimax/speech-02-hd": {"audio": {"url": "https://cdn.example/line.mp3"}, "duration_ms": 5200},
    }))
    original = json.dumps(projects.load("day-test"), sort_keys=True)
    out = ai.run({"slug": "day-test", "tools": ["sharpen", "music", "voice"], "options": {"into": "day-test-ai"}})
    assert out["slug"] == "day-test-ai" and out["aiLabel"] is True and out["labelNote"]
    assert json.dumps(projects.load("day-test"), sort_keys=True) == original, "the original is untouched"
    p = projects.load("day-test-ai")
    assert p["ai_of"] == "day-test" and (env / "mezz" / "day-test-ai" / "picks.json").exists(), "same windows as the original"
    clip = p["shots"][2]["ai_clip"]
    assert clip["tool"] == "sharpen" and Path(clip["file"]).exists() and clip["speed"] == 1.0
    assert "ai_clip" not in p["shots"][0]
    assert p["music"]["id"].startswith("ai_day-test-ai_") and p["music"]["id"].endswith(".wav")
    side = json.loads((env / "audio" / "music" / (p["music"]["id"] + ".json")).read_text(encoding="utf-8"))
    assert side["license"] == "AI-GENERATED" and side["ai"] is True and "commercial use" in side["licenceNote"]
    assert len(p["voice"]["lines"]) == 2 and p["voice"]["lines"][1]["tempo"] > 1.0, "a long line is sped up a little to fit its caption"
    tools = {n["tool"]: n for n in p["ai"]}
    assert set(tools) == {"sharpen", "music", "voice"} and tools["voice"]["label_required"] and not tools["music"]["label_required"]
    assert all({"tool", "model", "usd", "at", "what", "label_required"} <= set(n) for n in p["ai"])
    spend = rows()
    assert {r["purpose"] for r in spend} == {"ai-sharpen", "ai-music", "ai-voice"} and all(r["slug"] == "day-test-ai" for r in spend)
    up = fake.find("queue.fal.run/fal-ai/topaz/upscale/video")[0]["body"]
    assert up["H264_output"] is True and up["upscale_factor"] == 1.5
    tts = fake.find("queue.fal.run/fal-ai/minimax/speech-02-hd")[0]["body"]
    assert tts["text"] == "山にこもって、どこまで進むか。" and tts["voice_setting"]["voice_id"].startswith("Japanese_")
    # The sharpened clip is cached per source window: a second copy pays nothing for it.
    again = ai.estimate({"slug": "day-test", "tools": ["sharpen"], "options": {"into": "day-test-ai2"}})
    assert again["tools"][0]["items"][0]["cached"] and again["total"] == 0


def test_run_refuses_over_a_cap_with_nothing_spent(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    fake = use(monkeypatch, fal_routes({}))
    add_spend(1.9, slug="day-test-ai")
    with pytest.raises(ai.AiError) as err:
        ai.run({"slug": "day-test", "tools": ["living", "music"], "options": {"into": "day-test-ai"}})
    assert err.value.code == "cap"
    assert not fake.find("queue.fal.run") and projects.load("day-test-ai") is None


def test_an_approved_reel_is_never_changed(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    with connect() as con:
        con.execute("INSERT INTO drafts (slug, status) VALUES ('story-day-test', 'approved')")
    use(monkeypatch, fal_routes({}))
    with pytest.raises(ai.AiError) as err:
        ai.run({"slug": "day-test", "tools": ["music"]})
    assert err.value.code == "locked" and "options.into" in str(err.value)
    e = ai.estimate({"slug": "day-test", "tools": ["music"]})
    assert not e["fits"] and "approved" in e["refusal"]


def test_slow_motion_stays_within_fals_1080p_limit(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    big = {"clip.mp4": {"width": 5472, "height": 3078, "fps": 30.0, "duration": 30.0}, "small.mp4": {"width": 720, "height": 1280, "fps": 30.0, "duration": 10.0}}
    monkeypatch.setattr(ai, "probe", lambda path: big[Path(path).name])
    use(monkeypatch, [("GET", "api.fal.ai/v1/models/pricing", [(200, PRICES)])])
    auto = ai.plan("day-test", ["slowmo"])
    assert [i["target"] for i in auto] == [2], "the 5.4K clip is not picked by itself (it would lose resolution)"
    asked = ai.plan("day-test", ["slowmo"], {"shots": {"slowmo": [0]}})
    assert "downscaled from 5472x3078 to 1080p" in asked[0]["what"]


def test_a_tool_that_finished_keeps_its_note_when_a_later_one_fails(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    routes = fal_routes({"fal-ai/topaz/upscale/video": {"video": {"url": "https://cdn.example/up.mp4"}}})
    routes = [("POST", "queue.fal.run/fal-ai/stable-audio-25", [(422, {"detail": "prompt too long"})])] + routes
    use(monkeypatch, routes)
    with pytest.raises(ai.AiError, match="prompt too long"):
        ai.run({"slug": "day-test", "tools": ["sharpen", "music"], "options": {"into": "day-test-ai"}})
    p = projects.load("day-test-ai")
    assert p["shots"][2]["ai_clip"]["tool"] == "sharpen" and [n["tool"] for n in p["ai"]] == ["sharpen"]
    # Run again: the copy is priced as it is now, so the sharpened shot is not done twice.
    e = ai.estimate({"slug": "day-test", "tools": ["sharpen", "music"], "options": {"into": "day-test-ai"}})
    assert {t["tool"]: t["usd"] for t in e["tools"]} == {"sharpen": 0, "music": 0.2}


def test_a_fal_failure_is_one_plain_sentence_without_the_key(env, monkeypatch):
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    routes = fal_routes({}) + [("POST", "queue.fal.run/fal-ai/stable-audio-25", [(403, {"detail": f"User is locked. Reason: Exhausted balance. key {FAL}"})])]
    use(monkeypatch, routes)
    with pytest.raises(ai.AiError) as err:
        ai.run({"slug": "day-test", "tools": ["music"], "options": {"into": "day-test-ai"}})
    assert err.value.code == "no_credits" and "out of credit" in str(err.value) and FAL not in str(err.value)
    assert rows()[-1]["usd"] == 0.0


# ---------- the render side ----------

def test_the_voice_is_mixed_over_ducked_music_and_no_voice_keeps_the_old_graph(tmp_path, monkeypatch):
    from studio import sound
    from studio.config import ffmpeg_bin, ffprobe_bin

    clip, music, line = tmp_path / "clip.mp4", tmp_path / "bed.wav", tmp_path / "line.mp3"
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=200:duration=4",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)], check=True, capture_output=True, timeout=60)
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-ac", "2", str(music)], check=True, capture_output=True, timeout=60)
    subprocess.run([str(ffmpeg_bin()), "-y", "-f", "lavfi", "-i", "sine=frequency=600:duration=1.5", str(line)], check=True, capture_output=True, timeout=60)
    seen = []
    real = subprocess.run

    def spy(cmd, *a, **k):
        if "-filter_complex" in cmd:
            seen.append(cmd[cmd.index("-filter_complex") + 1])
        return real(cmd, *a, **k)
    monkeypatch.setattr(sound.subprocess, "run", spy)
    bed = {"file": str(music), "start": 0, "volume": 1.0}
    sound.mix(clip, tmp_path / "plain.mp4", 4.0, bed, [])
    plain = seen[-1]
    assert "[mus][key]sidechaincompress=threshold=0.05:ratio=4:attack=60:release=450[duck]" in plain and "[vo]" not in plain and "vokey" not in plain
    sound.mix(clip, tmp_path / "again.mp4", 4.0, bed, [], voice=None)
    assert seen[-1] == plain, "without a voice the graph is exactly the old one"
    rec = sound.mix(clip, tmp_path / "voiced.mp4", 4.0, bed, [], voice={"lines": [{"file": str(line), "at": 0.5, "tempo": 1.2}], "gain": 1.0,
                                                                         "model": "fal-ai/minimax/speech-02-hd", "voiceId": "Japanese_CalmLady"})
    g = seen[-1]
    assert "atempo=1.200" in g and "adelay=500|500" in g and "[mus][key2]sidechaincompress" in g and "[clipv][vokey2]sidechaincompress" in g
    assert rec["voice"]["ai"] is True and rec["voice"]["lines"] == 1
    probe = json.loads(real([str(ffprobe_bin()), "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(tmp_path / "voiced.mp4")],
                            capture_output=True, text=True, timeout=60).stdout)
    assert {s["codec_type"] for s in probe["streams"]} == {"video", "audio"}
    sound.mix(clip, tmp_path / "voice-only.mp4", 4.0, None, [], voice={"lines": [{"file": str(line), "at": 0.2}]})
    assert "anullsink" in seen[-1]
    text = sound.credits({"music": {"title": "Made for x", "creator": "Stable Audio 2.5 (AI, via fal.ai)", "license": "AI-GENERATED",
                                    "licenceNote": "Instrumental made for this reel."}, "voice": rec["voice"], "sfx": []})
    assert "AI-generated Japanese voice" in text and "Instrumental made for this reel." in text


def test_youtube_marks_synthetic_media_only_for_label_notes(tmp_path, monkeypatch):
    from studio import youtube

    monkeypatch.setattr(projects, "DIR", tmp_path)
    projects.save({"slug": "a", "ai": [{"tool": "music", "label_required": False}]})
    projects.save({"slug": "b", "ai": [{"tool": "voice", "label_required": True}]})
    projects.save({"slug": "c"})
    assert (youtube.synthetic("a"), youtube.synthetic("b"), youtube.synthetic("c"), youtube.synthetic("none")) == (False, True, False, False)


def test_saving_a_reviewer_key_does_not_switch_paid_tagging_on(tmp_path, monkeypatch):
    from studio import config

    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setattr(config, "WEBSITE_ENV", tmp_path / "none.env")
    (tmp_path / ".env").write_text(f"OPENROUTER_API_KEY_PARKED={OR}\n", encoding="utf-8")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("STUDIO_PAID_TAGGING", raising=False)
    assert config.openrouter_key() == ""
    monkeypatch.setenv("STUDIO_PAID_TAGGING", "on")
    assert config.openrouter_key() == OR


# ---------- credits: what the studio spent per provider and what each provider says is left ----------

def _no_firecrawl(monkeypatch):
    from studio import research
    monkeypatch.setattr(research, "api_key", lambda: "")


def test_credits_reports_spend_and_balances_without_echoing_keys(env, monkeypatch):
    _no_firecrawl(monkeypatch)
    with connect() as con:
        con.execute("INSERT INTO spend (ts, model, purpose, usd, provider) VALUES (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'), 'fal-ai/rife/video', 'ai-slowmo', 0.5, 'fal')")
        con.execute("INSERT INTO spend (ts, model, purpose, usd) VALUES ('2020-01-01T00:00:00', 'google/gemini-x', 'words-suggest', 0.25)")
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/account/billing", [(200, {"username": "me", "credits": {"current_balance": 12.5, "currency": "USD"}})]),
                             ("GET", "openrouter.ai/api/v1/key", [(200, {"data": {"usage": 140.0, "limit": 550, "limit_remaining": 410.0}})])])
    out = ai.credits({"fresh": True})["providers"]
    assert out["fal"]["left"] == 12.5 and out["fal"]["spent"] == {"total": 0.5, "today": 0.5, "calls": 1}
    # a row without a provider is attributed by its model: OpenRouter, and not today
    assert out["openrouter"]["left"] == 410.0 and out["openrouter"]["limit"] == 550 and out["openrouter"]["spent"]["total"] == 0.25
    assert out["openrouter"]["spent"]["today"] == 0
    assert "note" in out["together"] and out["firecrawl"]["key"] is False
    assert fake.find("api.fal.ai")[0]["headers"]["authorization"] == f"Key {FAL}"
    assert FAL not in json.dumps(out) and OR not in json.dumps(out)


def test_credits_are_cached_and_a_refused_balance_is_a_message(env, monkeypatch):
    _no_firecrawl(monkeypatch)
    fake = use(monkeypatch, [("GET", "api.fal.ai/v1/account/billing", [(403, {"detail": "forbidden"})]),
                             ("GET", "openrouter.ai/api/v1/key", [(200, {"data": {"usage": 1.0, "limit": None, "limit_remaining": None}})]),
                             ("GET", "openrouter.ai/api/v1/credits", [(200, {"data": {"total_credits": 20, "total_usage": 5.5}})])])
    first = ai.credits({"fresh": True})["providers"]
    assert "billing read access" in first["fal"]["error"] and first["fal"].get("left") is None
    assert first["openrouter"]["left"] == 14.5 and first["openrouter"]["limit"] == 20  # no key limit: the account's credits
    n = len(fake.calls)
    again = ai.credits({})["providers"]
    assert len(fake.calls) == n and again["openrouter"]["left"] == 14.5  # within 10 minutes nothing is asked again
    ai.credits({"fresh": True})
    assert len(fake.calls) > n


def test_credits_network_failure_stays_on_its_provider(env, monkeypatch):
    _no_firecrawl(monkeypatch)
    use(monkeypatch, [("GET", "api.fal.ai/v1/account/billing", [OSError("down")]),
                      ("GET", "openrouter.ai/api/v1/key", [(200, {"data": {"usage": 0, "limit": 5, "limit_remaining": 5}})])])
    out = ai.credits({"fresh": True})["providers"]
    assert "Could not reach" in out["fal"]["error"] and out["openrouter"]["left"] == 5
