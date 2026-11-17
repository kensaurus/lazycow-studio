"""The Workflow page's data (studio.workflow): the templates in shared/workflows are valid (registered models only, never
text-to-video, both languages), a preview changes nothing, Apply needs an explicit confirm and keeps a backup that Undo
puts back (also when there was no workflow.json), "@cheapest" prefers a service you have a key for, "@own" follows your
own model server, every block has a cost per reel, no key ever appears, and this month's spend is read from the ledger
charge() writes, by capability and by provider."""
import json
from datetime import date

import pytest

from studio import ai, config, workflow
from studio.db import connect
from studio.providers import registry
from tests.test_ai import FAL, env  # noqa: F401 - the shared fixture (temp .env with keys, empty ledger)

NEEDED = {"local-free", "voice-storyteller", "music-first", "low-cost-cloud", "pro-polish"}


@pytest.fixture
def wenv(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(ai, "WORKFLOW", env / "workflow.json")
    monkeypatch.setattr(ai, "_cached_fal_prices", lambda: {})
    for k in ("STUDIO_LLM_BASE_URL", "STUDIO_LLM_MODEL", "STUDIO_LLM_VISION_MODEL", "STUDIO_LLM_API_KEY", "STUDIO_AI_REVIEW_LOCAL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(config, "_llm_file", lambda: {})
    return env


def own_server(monkeypatch, vision=True):
    monkeypatch.setenv("STUDIO_LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("STUDIO_LLM_MODEL", "qwen3:8b")
    if vision:
        monkeypatch.setenv("STUDIO_LLM_VISION_MODEL", "qwen3-vl:8b")


def test_every_template_file_is_valid_and_the_five_asked_for_exist():
    files = sorted(workflow.TEMPLATES.glob("*.json"))
    assert len(files) >= 5
    for f in files:
        t = json.loads(f.read_text(encoding="utf-8"))
        assert workflow.check_template(t) == [], f.name
        assert f.stem == t["id"], f"{f.name}: the file is named after its id"
        assert not registry.FORBIDDEN.search(f.read_text(encoding="utf-8")), f"{f.name} mentions text-to-video"
    ids = [t["id"] for t in workflow.templates()]
    assert len(ids) == len(set(ids)) and NEEDED <= set(ids)


def test_a_template_with_text_to_video_or_an_unknown_model_is_refused():
    t = {"id": "bad", "name": {"en": "a", "ja": "あ"}, "summary": {"en": "a", "ja": "あ"},
         "blocks": {"img2video": {"provider": "fal", "model": "fal-ai/some-text-to-video"}}}
    errs = workflow.check_template(t)
    assert any("text-to-video" in e for e in errs) and any("not a registered" in e for e in errs)
    risky = {**t, "blocks": {"music": {"provider": "kie", "model": "ai-music-api/generate"}}}
    assert any("never picks it" in e for e in workflow.check_template(risky))
    novoice = {**t, "blocks": {"voice": {"provider": "elevenlabs", "model": "eleven_v3"}}}
    assert any("needs a voice" in e for e in workflow.check_template(novoice))


def test_view_has_every_block_with_a_cost_per_reel_and_never_a_key(wenv):
    v = workflow.view({})
    assert set(v["capabilities"]) == set(registry.CAPABILITIES)
    for cap in ("voice", "music", "sfx", "upscale", "slowmo", "img2video", "bg-cut", "vision"):
        c = v["capabilities"][cap]
        assert c["on"] and c["provider"] and isinstance(c["perReel"]["usd"], float), cap
        assert c["choices"] and all(not registry.FORBIDDEN.search(x["model"]) for x in c["choices"])
    assert v["perReel"] > 0 and not v["undo"]["can"]
    assert FAL not in json.dumps(v), "a key is never part of the view"
    assert {t["id"] for t in v["templates"]} >= NEEDED


def test_preview_shows_the_diff_and_cost_without_writing(wenv):
    v = workflow.view({})
    t = next(t for t in v["templates"] if t["id"] == "voice-storyteller")
    changed = {d["capability"]: d for d in t["diff"]}
    assert set(changed) == {"upscale", "slowmo", "img2video"} and not any(d["after"]["on"] for d in changed.values())
    assert t["perReel"] < t["perReelNow"]
    assert not ai.WORKFLOW.exists(), "a preview writes nothing"


def test_apply_needs_confirm_then_backs_up_and_undo_puts_it_back(wenv):
    with pytest.raises(ai.AiError, match="confirm"):
        workflow.apply({"template": "music-first"})
    assert not ai.WORKFLOW.exists()
    out = workflow.apply({"template": "music-first", "confirm": True})
    w = json.loads(ai.WORKFLOW.read_text(encoding="utf-8"))
    assert w["template"] == "music-first" and w["blocks"]["voice"] == {"on": False}
    assert w["blocks"]["slowmo"]["provider"] == "fal" and out["undo"]["can"] and out["undo"]["template"] == "music-first"
    assert ai.block("voice")["on"] is False and ai.block("img2video")["on"] is True
    undone = workflow.undo({})
    assert undone["undone"] == "music-first" and not ai.WORKFLOW.exists(), "there was no workflow.json before: it is gone again"
    with pytest.raises(ai.AiError, match="nothing to undo"):
        workflow.undo({})


def test_undo_restores_the_earlier_file_and_keeps_entered_prices(wenv):
    ai.save_price({"provider": "fal", "model": "fal-ai/rife/video", "usd": 0.002, "unit": "seconds"})
    ai.select({"capability": "music", "provider": "stability", "model": "stable-audio-2.5"})
    before = ai.WORKFLOW.read_text(encoding="utf-8")
    workflow.apply({"template": "studio-defaults", "confirm": True})
    w = json.loads(ai.WORKFLOW.read_text(encoding="utf-8"))
    assert "music" not in w["blocks"] and w["prices"], "defaults drop the choice, keep the prices you entered"
    workflow.undo({})
    assert json.loads(ai.WORKFLOW.read_text(encoding="utf-8")) == json.loads(before)


def test_local_and_free_uses_your_own_server_and_pays_for_nothing(wenv, monkeypatch):
    t = next(t for t in workflow.view({})["templates"] if t["id"] == "local-free")
    assert len(t["notes"]) == 2 and t["perReel"] == 0.0, "no own server yet: writing and review stay off, with a note each"
    own_server(monkeypatch)
    workflow.apply({"template": "local-free", "confirm": True})
    v = workflow.view({})
    paid = [c for c, b in v["capabilities"].items() if b["on"] and not b["local"]]
    assert paid == [] and v["perReel"] == 0.0
    assert v["capabilities"]["llm"]["provider"] == "own" and v["capabilities"]["llm"]["model"] == "qwen3:8b"
    assert v["capabilities"]["vision"]["provider"] == "own" and v["reviewBasis"] == "frames"


def test_cheapest_prefers_a_service_you_have_a_key_for(wenv):
    pid, mid = workflow._cheapest("voice", {})
    assert ai.key_for(pid), "fal's key is in the test .env; Replicate's cheaper voice has no key here"
    with ai.ENV_FILE.open("a", encoding="utf-8") as f:
        f.write("REPLICATE_API_TOKEN=r8_0123456789abcdefABCDEF0123456789abcdef\n")
    assert workflow._cheapest("voice", {}) == ("replicate", "minimax/speech-2.8-turbo")
    assert workflow._cheapest("music", {})[1] != "ai-music-api/generate", "a model marked risky is never picked by itself"


def test_this_months_spend_by_capability_and_provider(wenv):
    month = date.today().strftime("%Y-%m")
    with connect() as con:
        for ts, model, purpose, usd, provider in [(f"{month}-02T10:00:00", "fal-ai/stable-audio-25/text-to-audio", "ai-music", 0.2, "fal"),
                                                   (f"{month}-03T10:00:00", "fal-ai/stable-audio-25/text-to-audio", "ai-music", 0.2, "fal"),
                                                   (f"{month}-03T11:00:00", "google/gemini-3.8-flash", "ai-review", 0.015, "openrouter"),
                                                   (f"{month}-04T09:00:00", "google/gemini-2.5-flash", "tagcheck", 0.003, None),
                                                   ("2020-01-05T09:00:00", "fal-ai/rife/video", "ai-slowmo", 9.0, "fal")]:
            con.execute("INSERT INTO spend (ts, model, purpose, usd, tokens_in, tokens_out, note, provider, slug) VALUES (?, ?, ?, ?, 0, 0, '', ?, 'x')",
                        (ts, model, purpose, usd, provider))
    s = workflow.spend_month({})
    assert s["month"] == month and s["total"] == pytest.approx(0.418) and s["calls"] == 4
    caps = {x["capability"]: x["usd"] for x in s["byCapability"]}
    assert caps == {"music": pytest.approx(0.4), "vision": pytest.approx(0.018)}
    provs = {x["provider"]: x["usd"] for x in s["byProvider"]}
    assert provs == {"fal": pytest.approx(0.4), "openrouter": pytest.approx(0.018)}
    assert s["budget"]["aiCap"] == ai.caps()["total"] and s["budget"]["days"] >= 28
    assert workflow.spend_month({"month": "2020-01"})["total"] == pytest.approx(9.0)
    with pytest.raises(ai.AiError):
        workflow.spend_month({"month": "last"})


def test_the_actions_go_through_studio_ai(wenv):
    assert set(ai.call("workflow", {})["capabilities"]) == set(registry.CAPABILITIES)
    assert ai.call("spend-month", {})["total"] == 0.0
    with pytest.raises(ai.AiError, match="template"):
        ai.call("workflow-apply", {"template": "nope", "confirm": True})


def test_choices_carry_docs_date_risk_and_price_needed_and_the_rejected_list(wenv):
    v = workflow.view({})
    every = [x for c in v["capabilities"].values() for x in c["choices"]]
    for x in every:
        assert x["asOf"], f"{x['provider']}: no date"
        assert x["docs"] is None or x["docs"].startswith("https://")
    risky = [x for x in every if x.get("risk")]
    assert risky and all(not x["default"] for x in risky), "a model with a risk mark is never the default"
    for x in every:
        if x["perReel"].get("code") == "no_price":
            assert x["priceNeeded"]
    assert isinstance(v["rejected"], list) and all(r["what"] and r["why"] for r in v["rejected"])
    assert "seconds" in v["units"]
