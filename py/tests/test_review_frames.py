"""The AI reviewer on your own vision model (studio.ai review_basis / _review_frames): with a vision model set and no
OpenRouter key (or STUDIO_AI_REVIEW_LOCAL=1), the reel is reviewed from 12-16 still frames on contact sheets, free,
answered in the same shape as the video review and marked partial (no sound, no motion). With a key and no preference
the video review is unchanged, and a frames review is never returned from the cache as a video review."""
import json
import math
from pathlib import Path

import pytest
from PIL import Image

from studio import ai, config, projects

OR = "sk-or-v1-0123456789abcdef0123456789abcdef"
ANSWER = {"hook": {"score": 6, "notes": "a wide field, nothing moving yet"}, "look": {"score": 7, "notes": "sharp, well exposed"},
          "mismatches": [{"line": "星空", "at": 4.0, "shows": "a daytime tent", "why": "no stars in daylight"}], "claims": [],
          "fixes": [{"action": "swap clip", "detail": "swap shot 2 for a night shot"}], "summary": "Fine."}


@pytest.fixture
def studio(tmp_path, monkeypatch):
    """A reel on disk with a rendered master, no keys, no own model; `set_env(**names)` sets .env lines."""
    envfile = tmp_path / ".env"
    envfile.write_text("STUDIO_DAILY_USD_BUDGET=50\n", encoding="utf-8")
    monkeypatch.setattr(ai, "ENV_FILE", envfile)
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    for k in ("OPENROUTER_API_KEY_PARKED", "OPENROUTER_API_KEY", "STUDIO_AI_REVIEW_MODEL", "STUDIO_AI_REVIEW_LOCAL",
              "STUDIO_LLM_BASE_URL", "STUDIO_LLM_MODEL", "STUDIO_LLM_VISION_MODEL", "STUDIO_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(config, "_llm_file", lambda: {k: v for k, v in config._parse_env(envfile).items() if k.startswith("STUDIO_LLM_")})
    monkeypatch.setattr(projects, "DIR", tmp_path / "projects")
    projects.save({"slug": "day-test", "title_ja": "テスト",
                   "shots": [{"src": "a/clip.mp4", "sec": 3.0, "role": "auto: a tent at night (match 0.2)"},
                             {"src": "a/still.jpg", "sec": 2.0, "role": "coffee"},
                             {"src": "a/fire.mp4", "sec": 2.5, "role": "fire"}],
                   "beats": [{"kind": "hook", "ja": "山にこもって、\nどこまで進むか。", "en": "Go up.", "startSec": 0.1, "endSec": 3.4},
                             {"kind": "line", "ja": "星空の下で。", "en": "Under the stars.", "startSec": 3.7, "endSec": 7.4}]})
    mp4 = tmp_path / "master.mp4"
    mp4.write_bytes(b"x" * 100)
    monkeypatch.setattr(ai, "master", lambda slug: mp4)
    grabbed = []

    def fake_ffmpeg(args, timeout=600):  # a frame grab: a real 304x540 JPEG; anything else (the video proxy): bytes
        out = Path(args[-1])
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.suffix == ".jpg":
            grabbed.append(float(args[args.index("-ss") + 1]))
            Image.new("RGB", (304, 540), (40, 90, 40)).save(out)
        else:
            out.write_bytes(b"small video")
    monkeypatch.setattr(ai, "_ffmpeg", fake_ffmpeg)

    def set_env(**names):
        text = envfile.read_text(encoding="utf-8")
        envfile.write_text(text + "".join(f"{k}={v}\n" for k, v in names.items()), encoding="utf-8")
    return {"set": set_env, "grabbed": grabbed, "root": tmp_path}


def own_model(studio):
    studio["set"](STUDIO_LLM_BASE_URL="http://127.0.0.1:11434/v1", STUDIO_LLM_MODEL="qwen2.5:7b", STUDIO_LLM_VISION_MODEL="qwen2.5vl:7b")


def server(monkeypatch, answer=ANSWER):
    """Both the local server and OpenRouter, recorded."""
    sent = []

    def http(method, url, who="", data=None, headers=None, timeout=60):
        body = json.loads(data) if data else None
        sent.append({"url": url, "body": body, "headers": headers or {}})
        if "openrouter.ai" in url:
            return 200, {}, json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}],
                                       "usage": {"prompt_tokens": 9000, "completion_tokens": 400, "cost": 0.0111}}).encode()
        return 200, {}, json.dumps({"choices": [{"message": {"content": "Here you go: " + json.dumps(answer)}}]}).encode()
    monkeypatch.setattr(ai, "_http", http)
    monkeypatch.setattr(ai, "model_prices", lambda model: {"prompt": 0.000001, "completion": 0.000004})
    return sent


# ---------- which reviewer ----------

def test_the_basis_follows_the_key_the_vision_model_and_the_preference(studio):
    assert ai.review_basis() is None, "nothing set: no reviewer"
    studio["set"](OPENROUTER_API_KEY_PARKED=OR)
    assert ai.review_basis() == "video"
    own_model(studio)
    assert ai.review_basis() == "video", "a key and no preference: the video review, as before"
    studio["set"](STUDIO_AI_REVIEW_LOCAL="1")
    assert ai.review_basis() == "frames"


def test_a_vision_model_without_a_key_reviews_frames_but_a_text_model_alone_does_not(studio):
    studio["set"](STUDIO_LLM_BASE_URL="http://127.0.0.1:11434/v1", STUDIO_LLM_MODEL="qwen2.5:7b")
    assert ai.review_basis() is None, "a writing model cannot read pictures"
    studio["set"](STUDIO_LLM_VISION_MODEL="qwen2.5vl:7b")
    assert ai.review_basis() == "frames"


# ---------- which frames ----------

def test_frames_cover_the_opening_every_shot_and_the_whole_reel():
    shots = [{"sec": 3.0}, {"sec": 2.0}, {"sec": 2.5}]
    f = ai.frame_times({"shots": shots})
    at = [x["at"] for x in f]
    assert ai.REVIEW_FRAMES[0] <= len(f) <= ai.REVIEW_FRAMES[1]
    assert at == sorted(at) and at[0] == 0.3, "the hook frame first"
    assert {1.5, 4.0, 6.25} <= set(at), "every shot's middle"
    assert [x["frame"] for x in f] == list(range(1, len(f) + 1))
    assert [x["shot"] for x in f if x["at"] in (1.5, 4.0, 6.25)] == [1, 2, 3]
    assert max(at) < 7.5


def test_many_shots_are_capped_and_a_long_shot_still_gets_spread_frames():
    many = ai.frame_times({"shots": [{"sec": 1.0}] * 30})
    assert len(many) == ai.REVIEW_FRAMES[1] and many[0]["at"] == 0.3 and many[-1]["shot"] >= 28
    long = ai.frame_times({"shots": [{"sec": 40.0}, {"sec": 20.0}]})
    assert len(long) >= ai.REVIEW_FRAMES[0] and long[-1]["at"] > 50
    assert ai.frame_times({"shots": []}) == []


# ---------- the frames review ----------

def test_frames_review_sends_labelled_sheets_with_captions_charges_nothing_and_is_partial(studio, monkeypatch):
    own_model(studio)
    sent = server(monkeypatch)
    monkeypatch.setattr(ai, "charge", lambda *a, **k: pytest.fail("your own model is not charged"))
    r = ai.review({"slug": "day-test"})
    n = len(ai.frame_times(projects.load("day-test")))
    assert len(studio["grabbed"]) == n
    assert len(sent) == 1 and sent[0]["url"] == "http://127.0.0.1:11434/v1/chat/completions"
    body = sent[0]["body"]
    assert body["model"] == "qwen2.5vl:7b"
    system, content = body["messages"][0]["content"], body["messages"][1]["content"]
    assert "NO sound and NO motion" in system and "with its sound" not in system and '"hook":{"score"' in system
    pics = [c for c in content if c["type"] == "image_url"]
    assert len(pics) == math.ceil(n / ai.FRAMES_PER_SHEET), "the frames go as contact sheets"
    assert all(p["image_url"]["url"].startswith("data:image/jpeg;base64,") for p in pics)
    assert not any(c["type"] == "video_url" for c in content)
    data = json.loads(content[0]["text"].split("Data:\n", 1)[1])
    assert data["captions"][1]["ja"] == "星空の下で。" and data["captions"][1]["from"] == 3.7
    assert len(data["frames"]) == n and data["shots"][2]["from"] == 5.0
    assert r["partial"] is True and r["basis"] == "frames" and r["frames"] == n and r["usd"] == 0 and r["model"] == "qwen2.5vl:7b"
    assert r["hook"]["score"] == 6 and r["mismatches"][0]["shows"] == "a daytime tent" and r["fixes"][0]["detail"].startswith("swap shot 2")
    assert r["look"]["notes"].startswith("From still frames (no sound or motion judged)")
    assert "still frames" in r["note"]
    assert not (studio["root"] / "ai" / "reviews" / "day-test_frames").exists(), "the stills are not kept"
    note = projects.load("day-test")["ai"][-1]
    assert note["usd"] == 0 and "still frames, no sound" in note["what"]
    again = ai.review({"slug": "day-test"})
    assert again["cached"] and again["basis"] == "frames" and len(sent) == 1


def test_a_frames_review_never_answers_for_a_video_review(studio, monkeypatch):
    own_model(studio)
    sent = server(monkeypatch)
    ai.review({"slug": "day-test"})
    studio["set"](OPENROUTER_API_KEY_PARKED=OR)  # now a key and no preference: the video review
    charged = []

    def charge(provider, model, tool, slug, est, call, note=""):
        charged.append((provider, model, tool))
        out, _ = call()
        return out, 0.0111
    monkeypatch.setattr(ai, "charge", charge)
    r = ai.review({"slug": "day-test"})
    assert not r["cached"] and r["basis"] == "video" and r["partial"] is False and r["usd"] == 0.0111
    assert charged == [("openrouter", ai.REVIEW_MODEL, "review")]
    video = sent[-1]
    assert "openrouter.ai" in video["url"] and video["headers"]["Authorization"] == f"Bearer {OR}"
    parts = video["body"]["messages"][1]["content"]
    assert [p["type"] for p in parts] == ["text", "video_url"], "the video review is unchanged"
    assert "with its sound" in video["body"]["messages"][0]["content"]


def test_a_video_review_on_file_is_not_reused_once_frames_are_preferred(studio, monkeypatch):
    studio["set"](OPENROUTER_API_KEY_PARKED=OR)
    sent = server(monkeypatch)
    monkeypatch.setattr(ai, "charge", lambda provider, model, tool, slug, est, call, note="": (call()[0], 0.01))
    assert ai.review({"slug": "day-test"})["basis"] == "video"
    own_model(studio)
    studio["set"](STUDIO_AI_REVIEW_LOCAL="1")
    r = ai.review({"slug": "day-test"})
    assert r["basis"] == "frames" and not r["cached"] and "127.0.0.1" in sent[-1]["url"]


def test_an_unreadable_answer_from_your_model_is_an_error_that_cost_nothing(studio, monkeypatch):
    own_model(studio)
    monkeypatch.setattr(ai, "_http", lambda *a, **k: (200, {}, json.dumps({"choices": [{"message": {"content": "[1, 2]"}}]}).encode()))
    with pytest.raises(ai.AiError) as err:
        ai.review({"slug": "day-test"})
    assert err.value.charged is False


def test_the_estimate_and_status_show_a_free_frames_review(studio, monkeypatch):
    own_model(studio)
    e = ai.estimate({"slug": "day-test", "tools": ["review"]})
    row = e["tools"][0]
    assert row["usd"] == 0 and row["provider"] == "own" and row["model"] == "qwen2.5vl:7b" and e["fits"]
    assert row["items"][0]["unit"] == "frames" and "no sound" in row["items"][0]["what"]
    assert ai.status()["reviewBasis"] == "frames"


def test_scores_carry_the_reviews_basis():
    """The page marks hook and look scores that came from still frames (predict.score passes the basis through)."""
    from studio import predict

    s = predict.score({"slug": "x"}, 12.0, review={"hook": {"score": 7}, "look": {"score": 6}, "basis": "frames"})
    assert s["basis"] == "frames" and s["parts"]["hook"]["basis"] == "frames" and s["parts"]["look"]["basis"] == "frames"
    v = predict.score({"slug": "x"}, 12.0, review={"hook": {"score": 7}, "look": {"score": 6}})
    assert v["basis"] == "video" and v["parts"]["hook"]["basis"] == "video"
