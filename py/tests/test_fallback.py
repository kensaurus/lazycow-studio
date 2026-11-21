"""Automatic switch to another AI service (studio.fallback, docs/ai-api.md "When a service runs out"), offline:
every provider's error answers read into one vocabulary (py/tests/fixtures/providers/errors/http_errors.json and the
recorded fixtures beside it), the backup list (keys, unofficial routes, Luma's missing price, the max price rise), no
switch on a refusal or a bad request, the shared "out" memory and its cooldowns across capabilities, the caps held per
attempt with nothing paid twice, voice off by default, the ledger's fellBackFrom, the health view's problems, the
settings route and a whole run of `music` that lands on a backup."""
import json
import time
from pathlib import Path

import pytest

from studio import ai, fallback
from studio.providers import async_task, base
from studio.providers.http import KIND_CODE, AiError
from tests.test_ai import Fake, env, make_reel  # noqa: F401 - the shared fixture
from tests.test_providers import FIX, fx, penv  # noqa: F401 - every provider's key, a workflow file per test

CASES = json.loads((FIX / "errors" / "http_errors.json").read_text(encoding="utf-8"))
MUSIC = ("fal", "fal-ai/stable-audio-25/text-to-audio")


def ok(provider, usd=0.1):
    """A call that worked: (result, actual)."""
    return lambda: ({"provider": provider}, usd)


def fails(kind, charged=False):
    def call():
        raise AiError(f"it failed ({kind})", KIND_CODE[kind], 400, charged=charged)
    return call


def spend_rows():
    from studio.db import connect

    with connect() as con:
        return [dict(r) for r in con.execute("SELECT provider, model, usd, note, fell_back_from, fallback_reason FROM spend ORDER BY id")]


class Backups:
    """The `backup` charge() takes: each provider answers with its own call, at its own estimate; asked ones are kept."""

    def __init__(self, calls: dict, est: dict | None = None):
        self.calls, self.est, self.asked = calls, est or {}, []

    def __call__(self, provider, model, voice=None):
        self.asked.append(provider)
        if provider not in self.calls:
            return None
        return self.est.get(provider, 0.1), self.calls[provider]


# ---------- one vocabulary for every provider ----------

@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: f"{c['provider']}-{c['status']}-{c['kind']}")
def test_every_providers_http_errors_read_as_one_vocabulary(case, penv):
    body = case["body"]
    err_body = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else body
    err = ai._provider_error(case["provider"], case["status"], err_body)
    assert err.kind == case["kind"], f"{case['provider']} {case['status']} {body}: {err.code} / {err}"


@pytest.mark.parametrize("case", CASES["body_codes"], ids=lambda c: f"{c['provider']}-{c['kind']}")
def test_errors_inside_an_http_200_read_as_one_vocabulary(case, penv):
    body = fx(case["file"]) if case.get("file") else case["body"]
    ctx = ai._ctx(case["provider"], "k" * 20)
    spec = (ai._model(case["provider"], case["model"]) if case.get("model") else ctx.provider["task"])
    err = base.body_error(ctx, body, spec)
    assert err is not None and err.kind == case["kind"], f"{case['provider']} {body}: {err and err.code}"


SUBMIT = {"runway": {"id": "t1"}, "replicate": {"id": "p1", "status": "starting", "urls": {"get": "https://api.replicate.com/v1/predictions/p1"}},
          "minimax": {"task_id": "t1", "base_resp": {"status_code": 0}},
          "higgsfield": {"request_id": "r1", "status_url": "https://api.higgsfield.ai/requests/r1/status", "status": "queued"},
          "kie": {"code": 200, "msg": "success", "data": {"taskId": "k1"}}}


@pytest.mark.parametrize("case", CASES["failed_tasks"], ids=lambda c: f"{c['provider']}-{c['kind']}")
def test_a_failed_task_reads_its_failure_as_one_vocabulary(case, penv):
    pid = case["provider"]
    failed = fx(case["file"]) if case.get("file") else case["body"]

    def http(method, url, who, **kw):
        return (200, {}, json.dumps(SUBMIT[pid] if method == "POST" else failed).encode())
    ctx = base.Ctx(pid=pid, provider=ai.registry.provider(pid), http=http, key="k" * 20, sleep=lambda s: None, poll=0)
    with pytest.raises(AiError) as err:
        async_task.run(ctx, "m", {}, {"prompt": "p"}, 60)
    assert err.value.kind == case["kind"] and err.value.charged is False


# ---------- the backup list ----------

def test_the_automatic_list_has_keyed_priced_official_services_default_first_then_cheapest(penv, monkeypatch):
    items = fallback.chain("img2video", ("fal", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"))["items"]
    pids = [x["provider"] for x in items]
    assert "fal" not in pids, "the same service is out with it"
    assert "piapi" not in pids and "luma" not in pids, "never an unofficial route, never a model without a price"
    usable = [x for x in items if not x["skip"]]
    costs = [x["perReel"] for x in usable]
    assert costs == sorted(costs) and usable[0]["provider"] == "higgsfield", "cheapest for one reel first"
    assert all(x["docs"].startswith("https://") for x in usable)
    # No Runway key: it is listed with the reason, after every usable one.
    env_file = ai.ENV_FILE
    env_file.write_text("\n".join(ln for ln in env_file.read_text(encoding="utf-8").splitlines() if not ln.startswith("RUNWAY_API_KEY")) + "\n", encoding="utf-8")
    items = fallback.chain("img2video", ("fal", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"))["items"]
    rw = [x for x in items if x["provider"] == "runway"]
    assert rw and all(x["skip"] == "no key saved" for x in rw) and items.index(rw[0]) > max(i for i, x in enumerate(items) if not x["skip"])
    # A capability whose default is not the first choice: the registry's default comes first.
    first = fallback.chain("music", ("elevenlabs", "music_v2_5"))["items"]
    assert (first[0]["provider"], first[0]["model"]) == MUSIC


def test_your_own_list_wins_unofficial_needs_your_word_and_luma_needs_a_price(penv):
    with pytest.raises(AiError) as err:
        fallback.save({"capability": "img2video", "chain": [{"provider": "piapi", "model": "kling-2.5-std"}]})
    assert err.value.code == "risk"
    out = fallback.save({"capability": "img2video", "chain": [{"provider": "luma", "model": "ray-3.2"}, {"provider": "piapi", "model": "kling-2.5-std", "acceptRisk": True},
                                                               {"provider": "runway", "model": "gen4_turbo"}]})
    assert any("no price yet" in w for w in out["warnings"])
    ch = fallback.chain("img2video")
    assert ch["source"] == "yours" and [x["provider"] for x in ch["items"]] == ["luma", "piapi", "runway"], "your order, as you set it"
    assert ch["items"][0]["skip"].startswith("no price") and ch["items"][1]["skip"] is None
    ai.save_price({"provider": "luma", "model": "ray-3.2", "usd": 1.0, "unit": "videos"})
    assert fallback.chain("img2video")["items"][0]["skip"] is None
    with pytest.raises(AiError):
        fallback.save({"capability": "img2video", "chain": [{"provider": "fal", "model": "fal-ai/stable-audio-25/text-to-audio"}]})
    fallback.save({"capability": "img2video", "chain": None})
    assert fallback.chain("img2video")["source"] == "auto"
    w = json.loads(ai.WORKFLOW.read_text(encoding="utf-8"))
    assert "img2video" not in w.get("fallback", {}) and not w.get("autoSwitch"), "nothing left over: the file is as before"


def test_a_backup_dearer_than_the_max_price_rise_is_passed_over_with_the_reason(penv):
    b = Backups({"elevenlabs": ok("elevenlabs"), "stability": ok("stability")}, {"elevenlabs": 0.5, "stability": 0.3})
    fallback.save({"capability": "music", "chain": [{"provider": "elevenlabs", "model": "music_v2_5"}, {"provider": "stability", "model": "stable-audio-2.5"}]})
    got, usd = ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=b)
    assert got == {"provider": "stability"} and b.asked == ["elevenlabs", "stability"], "$0.50 is over 2x $0.20; $0.30 is not"
    fallback.save({"maxRise": 1.2})
    fallback.reset({"all": True})
    with pytest.raises(AiError) as err:
        ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=b)
    assert "over 1.2x" in str(err.value) and err.value.kind == "out_of_credit"
    with pytest.raises(AiError):
        fallback.save({"maxRise": 0.5})


# ---------- never on a refusal or a bad request ----------

@pytest.mark.parametrize("kind", ["refused", "bad_input"])
def test_a_refusal_or_a_bad_request_never_goes_to_another_service(kind, penv):
    b = Backups({"elevenlabs": ok("elevenlabs")})
    with pytest.raises(AiError) as err:
        ai.charge(*MUSIC, "music", "reel-a", 0.2, fails(kind), cap="music", backup=b)
    assert err.value.kind == kind and b.asked == [], "another service must not be used to get around a refusal"
    assert fallback.state("fal") is None, "a refusal says nothing about the service"


def test_a_failure_the_provider_may_have_billed_is_never_paid_for_twice(penv):
    b = Backups({"elevenlabs": ok("elevenlabs")})
    with pytest.raises(AiError):
        ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("unavailable", charged=True), cap="music", backup=b)
    assert b.asked == [] and [r["usd"] for r in spend_rows()] == [0.2], "the timed-out submit keeps its estimate; nothing else is bought"


# ---------- the shared "out" memory ----------

def test_out_of_credit_marks_the_service_for_every_block_until_the_cooldown_or_try_again(penv, monkeypatch):
    b = Backups({"elevenlabs": ok("elevenlabs"), "replicate": ok("replicate")})
    got, _ = ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=b)
    assert got == {"provider": "elevenlabs"} and fallback.state("fal")["kind"] == "out_of_credit"
    # Another block on fal (slow motion) goes straight to its backup: fal is not asked.
    asked = []
    up = Backups({"replicate": ok("replicate")})
    got, _ = ai.charge("fal", "topaz/upscale/video/precision", "sharpen", "reel-a", 0.2, lambda: asked.append("fal") or ({}, 0), cap="upscale", backup=up)
    assert got == {"provider": "replicate"} and asked == [] and up.asked == ["replicate"]
    h = json.loads(fallback.health_file().read_text(encoding="utf-8"))
    assert [(s["cap"], s["from"], s["to"], s["kind"]) for s in h["switches"]] == [("music", "fal", "elevenlabs", "out_of_credit"), ("upscale", "fal", "replicate", "out_of_credit")]
    # Six hours later fal is asked first again.
    now = time.time()
    monkeypatch.setattr(fallback.time, "time", lambda: now + 6 * 3600 + 5)
    assert fallback.state("fal") is None
    got, _ = ai.charge("fal", "topaz/upscale/video/precision", "sharpen", "reel-a", 0.2, ok("fal"), cap="upscale", backup=up)
    assert got == {"provider": "fal"}
    monkeypatch.setattr(fallback.time, "time", lambda: now)
    assert fallback.state("fal") is not None
    view = fallback.reset({"provider": "fal"})
    assert fallback.state("fal") is None and next(p for p in view["providers"] if p["id"] == "fal")["state"] == "ok"


def test_rate_limits_and_outages_rest_ten_minutes_and_a_key_problem_lasts_until_the_key_changes(penv, monkeypatch):
    fallback.mark("fal", "rate_limited", "429")
    e = fallback.state("fal")
    assert e["kind"] == "rate_limited" and 590 <= e["until"] - e["at"] <= 610
    fallback.mark("fal", "out_of_credit", "402")
    fallback.mark("fal", "unavailable", "503")
    assert fallback.state("fal")["kind"] == "out_of_credit", "a milder mark never hides an empty account"
    fallback.reset({"all": True})
    fallback.mark("runway", "auth", "401")
    now = time.time()
    monkeypatch.setattr(fallback.time, "time", lambda: now + 30 * 86400)
    assert fallback.state("runway")["kind"] == "auth", "a refused key stays refused, however long"
    with ai.ENV_FILE.open("a", encoding="utf-8") as f:
        f.write("RUNWAY_API_KEY=key_fresh0123456789abcdef0123456789abcdef\n")
    assert fallback.state("runway") is None, "a new key: asked again"
    raw = fallback.health_file().read_text(encoding="utf-8")
    assert "key_fresh" not in raw and "key_0123" not in raw, "never the key, only a hash of it"


def test_a_key_never_saved_switches_but_is_not_remembered_as_a_problem(penv):
    b = Backups({"elevenlabs": ok("elevenlabs")})
    def no_key():
        raise AiError("Add your fal.ai key in Settings › AI.", "no_key", 400)
    got, _ = ai.charge(*MUSIC, "music", "reel-a", 0.2, no_key, cap="music", backup=b)
    assert got == {"provider": "elevenlabs"} and fallback.state("fal") is None


# ---------- the caps, per attempt; nothing paid twice; the ledger ----------

def test_every_attempt_is_held_to_the_caps_at_its_own_price_and_only_the_result_is_paid(penv, monkeypatch):
    monkeypatch.setenv("STUDIO_AI_REEL_CAP_USD", "0.5")
    b = Backups({"elevenlabs": ok("elevenlabs", 0.33), "stability": ok("stability", 0.12)}, {"elevenlabs": 0.6, "stability": 0.15})
    fallback.save({"capability": "music", "chain": [{"provider": "elevenlabs", "model": "music_v2_5"}, {"provider": "stability", "model": "stable-audio-2.5"}],
                   "maxRise": 10})
    got, usd = ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=b)
    assert got == {"provider": "stability"} and usd == 0.12
    rows = spend_rows()
    assert [(r["provider"], r["usd"]) for r in rows] == [("fal", 0.0), ("stability", 0.12)], "ElevenLabs ($0.60) was over the reel's $0.50: never reserved"
    assert rows[0]["note"].startswith("failed: no_credits")
    assert (rows[1]["fell_back_from"], rows[1]["fallback_reason"]) == ("fal", "out_of_credit")
    assert sum(r["usd"] for r in rows) == 0.12, "one result, paid once"


def test_without_backups_the_error_says_so_and_nothing_is_spent(penv):
    with pytest.raises(AiError) as err:
        ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=Backups({}))
    assert "Backups tried or passed over" in str(err.value) and err.value.kind == "out_of_credit"
    assert [r["usd"] for r in spend_rows()] == [0.0]


# ---------- voice, and the switches ----------

def test_voice_is_off_by_default_and_the_owner_can_turn_it_on(penv):
    assert fallback.settings()["caps"]["voice"] is False and fallback.settings()["caps"]["music"] is True
    b = Backups({"together": ok("together"), "minimax": ok("minimax"), "elevenlabs": ok("elevenlabs")})
    with pytest.raises(AiError):
        ai.charge("fal", "fal-ai/minimax/speech-02-hd", "voice", "reel-a", 0.1, fails("out_of_credit"), cap="voice", backup=b)
    assert b.asked == [] and fallback.state("fal")["kind"] == "out_of_credit", "no switch, but the others still learn fal is out"
    fallback.reset({"all": True})
    fallback.save({"capability": "voice", "auto": True})
    got, _ = ai.charge("fal", "fal-ai/minimax/speech-02-hd", "voice", "reel-a", 0.1, fails("out_of_credit"), cap="voice", backup=b)
    assert got == {"provider": "together"}, "ElevenLabs' own voices need one picked first, so the cheapest ready one (Together's Qwen3 TTS) stands in"
    fallback.reset({"all": True})
    fallback.save({"on": False})
    with pytest.raises(AiError):
        ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=b)
    assert b.asked == ["together"], "the master switch off: nothing switches"


# ---------- the page: health and the Needs-you problems ----------

def test_the_health_view_says_what_runs_where_and_which_blocks_have_no_backup(penv):
    v = fallback.view({})
    assert v["capabilities"]["music"]["backup"] and v["capabilities"]["music"]["using"] is None and v["problems"] == []
    ai.charge(*MUSIC, "music", "reel-a", 0.2, fails("out_of_credit"), cap="music", backup=Backups({"elevenlabs": ok("elevenlabs")}))
    v = fallback.view({})
    m = v["capabilities"]["music"]["using"]
    assert (m["from"], m["provider"], m["kind"]) == ("fal", "elevenlabs", "out_of_credit") and m["since"]
    p = next(x for x in v["problems"] if x["provider"] == "fal")
    assert p["switched"] == [{"provider": "elevenlabs", "name": "ElevenLabs", "n": 1}] and p["billing"] == "https://fal.ai/dashboard/billing"
    assert p["level"] == "red" and "voice" in p["noBackup"], "voice switches only when you turn it on"
    fallback.save({"capability": "voice", "auto": True})
    p = next(x for x in fallback.view({})["problems"] if x["provider"] == "fal")
    assert "voice" not in p["noBackup"]
    fal = next(x for x in v["providers"] if x["id"] == "fal")
    assert fal["state"] == "out_of_credit" and fal["until"] and "music" in fal["caps"]


def test_out_of_credit_said_by_hand_marks_the_service_out_until_try_again(penv):
    """fal's key cannot read its balance, so the owner says it is empty: every block on fal shows it at once, the mark
    lasts as a failed call's would (6 h), and "Try again" clears it. A made-up provider is refused."""
    v = fallback.mark_out({"provider": "fal"})
    fal = next(x for x in v["providers"] if x["id"] == "fal")
    assert fal["state"] == "out_of_credit" and fal["until"] - time.time() == pytest.approx(fallback.COOLDOWN["out_of_credit"], abs=60)
    p = next(x for x in v["problems"] if x["provider"] == "fal")
    assert "music" in p["caps"] and "upscale" in p["caps"]
    with pytest.raises(AiError):
        fallback.mark_out({"provider": "nobody"})
    with pytest.raises(AiError):
        fallback.mark_out({"provider": "own"})
    assert next(x for x in fallback.reset({"provider": "fal"})["providers"] if x["id"] == "fal")["state"] == "ok"


def test_the_cli_routes_answer(penv, capsys):
    import io
    import sys

    for action, req in (("health", {}), ("fallback", {"capability": "sfx", "auto": False}), ("health-reset", {"all": True})):
        sys.stdin = io.StringIO(json.dumps(req))
        try:
            ai.main([action])
        finally:
            sys.stdin = sys.__stdin__
        out = json.loads(capsys.readouterr().out.split("RESULT ", 1)[1])
        assert out["ok"], out
    assert fallback.settings()["caps"]["sfx"] is False


def test_a_template_carries_its_backups_and_undo_puts_the_old_list_back(penv):
    from studio import workflow as wf

    t = next(x for x in wf.templates() if x["id"] == "pro-polish")
    assert wf.check_template(t) == [] and wf.preview(t)["fallback"]["img2video"] == ["Runway", "kie.ai"]
    assert wf.check_template({**t, "fallback": {"img2video": [{"provider": "piapi", "model": "kling-2.5-std"}]}}), "a template never lists an unofficial route"
    wf.apply({"template": "pro-polish", "confirm": True})
    assert [x["provider"] for x in fallback.chain("img2video")["items"]] == ["runway", "kie"]
    wf.undo({})
    assert fallback.chain("img2video")["source"] == "auto"


# ---------- a whole run lands on a backup ----------

def test_a_music_run_on_an_empty_fal_account_is_made_by_the_backup_and_credited_to_it(penv, monkeypatch):
    make_reel(penv, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    from studio import sound

    monkeypatch.setattr(sound, "LIB", penv / "lib")
    fake = Fake([("GET", "api.fal.ai/v1/models/pricing", [(200, {"prices": []})]),
                 ("POST", "queue.fal.run/fal-ai/stable-audio-25", [(403, {"detail": "User is locked. Reason: Exhausted balance."})]),
                 ("POST", "api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio", [(200, b"RIFFWAVE", {"content-type": "audio/wav"})])])
    monkeypatch.setattr(ai, "_call", fake)
    monkeypatch.setattr(ai, "_ffmpeg", lambda args, timeout=600: Path(args[-1]).write_bytes(b"WAV"))
    monkeypatch.setattr(ai, "probe_audio", lambda p: 18.0)
    fallback.save({"capability": "music", "chain": [{"provider": "stability", "model": "stable-audio-2.5"}]})
    out = ai.run({"slug": "day-test", "tools": ["music"]})
    note = out["notes"][0]
    assert note["model"] == "stable-audio-2.5" and "made by Stability AI" in note["what"] and "Stability" in note["licence"] + json.dumps(note)
    rows = spend_rows()
    assert [(r["provider"], r["usd"] > 0) for r in rows] == [("fal", False), ("stability", True)]
    assert rows[-1]["fell_back_from"] == "fal" and rows[-1]["fallback_reason"] == "out_of_credit"
    side = json.loads(next((penv / "lib" / "music").glob("*.json")).read_text(encoding="utf-8"))
    assert "Stability" in side["creator"], "the music's credit names who really made it"
