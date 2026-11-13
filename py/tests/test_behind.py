"""The headline behind the opening shot's subject (studio.ai behind, BiRefNet v2 video on fal): when it is offered, how
it is priced, and that the build only uses a cut-out that still belongs to the opening shot (reels.behind_layer)."""
from pathlib import Path

import studio.ai as ai
import studio.reels as reels
from studio import projects
from tests.test_ai import env, make_reel, use, fal_routes  # noqa: F401 - the shared fixture and fakes

PRICE = {"unit_price": 0.000575, "unit": "compute seconds", "source": "test"}


def test_it_is_refused_plainly_when_the_cut_out_could_not_stay_on_the_subject(env, monkeypatch):  # noqa: F811
    p = make_reel(env, monkeypatch=monkeypatch)
    assert "Render the reel once" in ai.behind_refusal(p)
    (env / "mezz" / "day-test" / "00_t.mp4").write_bytes(b"mezz")
    assert ai.behind_refusal(p) is None
    assert "moves the opening shot" in ai.behind_refusal({**p, "look": "whip"})
    assert ai.behind_refusal({**p, "look": "ember"}) is None
    assert "no headline" in ai.behind_refusal({**p, "beats": [b for b in p["beats"] if b["kind"] != "hook"]})
    shots = [dict(s) for s in p["shots"]]
    shots[0]["ai_clip"] = {"tool": "slowmo"}
    assert "already has an AI clip" in ai.behind_refusal({**p, "shots": shots})


def test_priced_by_compute_seconds_and_stored_on_the_opening_shot(env, monkeypatch):  # noqa: F811
    make_reel(env, monkeypatch=monkeypatch)
    monkeypatch.setattr(ai, "locked", lambda slug: False)
    (env / "mezz" / "day-test" / "00_t.mp4").write_bytes(b"mezz")
    monkeypatch.setattr(ai, "fal_prices", lambda models: {m: PRICE for m in models})
    item = ai.plan("day-test", ["behind"])[0]
    assert item["quantity"] == 45.0 and item["usd"] == round(0.000575 * 45, 4)  # 3 s shot: 15 compute seconds a second
    fake = use(monkeypatch, fal_routes({"fal-ai/birefnet/v2/video": {"video": {"url": "https://cdn.example/fg.mp4"},
                                                                     "mask_video": {"url": "https://cdn.example/mask.mp4"}}}))
    ai.run({"slug": "day-test", "tools": ["behind"]})
    b = projects.load("day-test")["shots"][0]["ai_behind"]
    assert b["file"].endswith(".webm") and b["src"] == "a/clip.mp4" and b["sec"] == 3.0
    body = fake.find("queue.fal.run/fal-ai/birefnet/v2/video")[0]["body"]
    assert body["output_mask"] is True and body["model"] == "General Use (Light)"
    assert ai.estimate({"slug": "day-test", "tools": ["behind"]})["total"] == 0, "made once per rendered shot"


def test_the_build_uses_the_cut_out_only_while_it_matches(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "ROOT", tmp_path)
    fg = tmp_path / "fg.webm"
    fg.write_bytes(b"webm")
    reel = {"slug": "r-1", "shots": [{"src": "a.mp4", "sec": 2.0, "ai_behind": {"file": str(fg), "src": "a.mp4", "sec": 2.0}}]}
    assert reels.behind_layer(reel, None) == "mezz/r-1/00_fg.webm"
    assert (tmp_path / "public" / "mezz" / "r-1" / "00_fg.webm").read_bytes() == b"webm"
    assert reels.behind_layer(reel, "whip") is None
    moved = {**reel, "shots": [{**reel["shots"][0], "src": "b.mp4"}]}
    assert reels.behind_layer(moved, None) is None, "the opening shot changed: the old cut-out is not used"
    longer = {**reel, "shots": [{**reel["shots"][0], "sec": 3.0}]}
    assert reels.behind_layer(longer, None) is None
    assert reels.behind_layer({"slug": "r-2", "shots": [{"src": "a.mp4", "sec": 1}]}, None) is None
    assert Path(fg).exists()


def test_a_cut_out_from_an_older_render_of_the_shot_is_left_out(tmp_path, monkeypatch):
    monkeypatch.setattr(reels, "ROOT", tmp_path)
    fg = tmp_path / "fg.webm"
    fg.write_bytes(b"webm")
    shot = tmp_path / "public" / "mezz" / "r-1" / "00_t.mp4"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"render one")
    stamp = f"{shot.stat().st_size}-{int(shot.stat().st_mtime)}"
    reel = {"slug": "r-1", "shots": [{"src": "a.mp4", "sec": 2.0, "ai_behind": {"file": str(fg), "src": "a.mp4", "sec": 2.0, "stamp": stamp}}]}
    assert reels.behind_layer(reel, None) == "mezz/r-1/00_fg.webm"
    shot.write_bytes(b"render two, steadied")  # the opening shot was rendered again differently
    assert reels.behind_layer(reel, None) is None
