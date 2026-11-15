"""Editing devices of a long video (studio.devices, studio.devices_build): joins, layers, their sounds, ambience."""
from studio import devices, devices_build


def _seq(n, kind="video", sec=5.0, t0="2025-05-02T10:00:00+00:00", device="cam-a"):
    return [{"path": f"/f/{device}-{i}.mp4", "kind": kind, "sec": sec, "captured": t0, "device": device, "duration": 20} for i in range(n)]


def _starts(seq, fade=0.4):
    out, t = [], 0.0
    for k, s in enumerate(seq):
        st = max(0.0, t - fade) if k else 0.0
        out.append(st)
        t = st + s["sec"]
    return out


def test_transitions_first_is_a_cut_chapters_take_chapter_joins_and_motion_is_spaced():
    seq = _seq(40)
    starts = _starts(seq)
    roles = ["body"] * 40
    chapters = [starts[0], starts[10], starts[20], starts[30]]
    tins = devices.transitions(roles, starts, chapters, "roadmovie", seed=3)
    assert tins[0] == "cut"
    for k in (10, 20, 30):
        assert tins[k] in devices.TRANSITIONS["roadmovie"]["chapter"] + ["dissolve"]
    moving = [starts[k] for k, t in enumerate(tins) if t in devices.MOTION]
    assert all(b - a >= devices.MOTION_GAP for a, b in zip(moving, moving[1:]))
    assert all(a != b or a == "dissolve" for a, b in zip(tins, tins[1:]))


def test_a_hard_cut_look_only_cuts_and_flashes():
    seq = _seq(30)
    starts = _starts(seq, 0)
    tins = devices.transitions(["body"] * 30, starts, [0, starts[10], starts[20]], "energetic", seed=1, overlap=False)
    assert set(tins) <= {"cut", "flash"}


def test_whooshes_only_on_moving_joins():
    assert devices.whooshes(["cut", "whip", "dissolve", "zoom", "iris"], [0, 5, 10, 15, 20]) == [4.75, 14.75]


def test_multicam_finds_another_camera_at_the_same_minute_and_not_the_same_camera():
    me = {"path": "/a.mp4", "kind": "video", "captured": "2025-05-02T10:00:00+00:00", "device": "cam-a", "duration": 10}
    lib = [
        {"path": "/b.mp4", "kind": "video", "captured": "2025-05-02T10:00:40+00:00", "device": "cam-b", "duration": 12},
        {"path": "/c.mp4", "kind": "video", "captured": "2025-05-02T10:00:20+00:00", "device": "cam-a", "duration": 12},
        {"path": "/d.mp4", "kind": "video", "captured": "2025-05-02T11:30:00+00:00", "device": "cam-c", "duration": 12},
        {"path": "/e.mp4", "kind": "video", "captured": "2025-05-02T10:01:00+00:00", "device": "cam-d", "duration": 12, "is360": True},
    ]
    got = devices.multicam([me], 0, lib, used={"/a.mp4"})
    assert [r["path"] for r in got] == ["/b.mp4"]


def test_plan_keeps_layers_off_words_apart_and_within_the_chapter_budget():
    seq = _seq(30, sec=6.0)
    for i, s in enumerate(seq):  # every shot has a partner from another camera a few seconds away
        s["captured"] = f"2025-05-02T10:{i:02d}:00+00:00"
    lib = [{"path": f"/other-{i}.mp4", "kind": "video", "captured": f"2025-05-02T10:{i:02d}:20+00:00", "device": "cam-b", "duration": 15}
           for i in range(30)]
    lib += [{"path": f"/p-{i}.jpg", "kind": "photo", "captured": "2025-05-02T09:00:00+00:00", "aesthetic": i} for i in range(6)]
    starts = _starts(seq)
    roles = ["cold"] * 3 + ["body"] * 27
    chapters = [starts[3], starts[12], starts[21]]
    blocked = [(0.0, starts[3] + 5.0)] + [(a, a + 5.6) for a in chapters]
    d = devices.plan(seq, starts, roles, chapters, blocked, "documentary", lib, seed=5)
    picture = [l for l in d["layers"] if l["kind"] != "leak"]
    assert picture, "expected at least one layer"
    for l in picture:
        a, b = l["atSec"], l["atSec"] + l["sec"]
        assert not any(a < y and b > x for x, y in blocked), l
    spans = sorted((l["atSec"], l["atSec"] + l["sec"]) for l in picture)
    assert all(b2 - a1 >= 0 and a2 - b1 >= devices.GAP for (a1, b1), (a2, b2) in zip(spans, spans[1:]))
    per = {}
    for l in picture:
        c = max(i for i, a in enumerate(chapters) if l["atSec"] >= a) if l["atSec"] >= chapters[0] else 0
        per[c] = per.get(c, 0) + 1
    assert max(per.values()) <= devices.MAX_PER_CHAPTER
    assert sum(1 for l in d["layers"] if l["kind"] == "leak") == len(chapters) - 1


def test_the_slow_look_has_no_layers():
    seq = _seq(20)
    starts = _starts(seq)
    d = devices.plan(seq, starts, ["body"] * 20, [0.0], [], "slow", [], seed=1)
    assert d["layers"] == [] and set(d["tins"]) <= {"cut", "dissolve"}


def test_snapshot_sits_on_the_named_animal():
    seq = _seq(10, sec=6.0)
    starts = _starts(seq)
    d = devices.plan(seq, starts, ["body"] * 10, [0.0], [], "fieldguide", [], seed=2, subjects=[(starts[4] + 1.0, 4)])
    snaps = [l for l in d["layers"] if l["kind"] == "snapshot"]
    assert len(snaps) == 1 and snaps[0]["k"] == 4 and abs(snaps[0]["offset"] - 1.0) < 0.01


def test_ticks_and_effects():
    layers = [{"kind": "snapshot", "atSec": 10.0, "sec": 3.2}, {"kind": "prints", "atSec": 30.0, "sec": 4.0, "with": ["a", "b"]},
              {"kind": "split", "atSec": 50.0, "sec": 4.0}]
    names = [n for n, _ in devices.ticks(layers)]
    assert names == ["tick", "paper", "paper", "swish"]
    have = {"whoosh_1": "w1", "whoosh_2": "w2", "tick": "t", "paper": "p", "swish": "s"}
    fx = devices_build.effects([5.0, 19.55], layers, [20.0], have)
    assert [f["name"] for f in fx].count("whoosh") == 1  # the one at 19.55 is the chapter's own whoosh (20 - 0.45)


def test_ambience_runs_cover_photo_stretches_inside_one_chapter():
    seq = _seq(2) + _seq(3, kind="photo", sec=3.4) + _seq(1) + _seq(1, kind="photo", sec=3.4)
    starts = _starts(seq)
    runs = devices.ambience_runs(seq, starts, ["body"] * len(seq), [0.0])
    assert len(runs) == 1 and runs[0]["atSec"] == round(starts[2], 2) and runs[0]["sec"] >= 9.0


def test_same_moment_lines_two_cameras_up_by_capture_time():
    base = {"captured": "2025-05-02T10:00:00+00:00"}
    other = {"captured": "2025-05-02T10:00:05+00:00", "duration": 30}
    assert devices_build.same_moment(base, 12.0, other, 4.0) == 7.0
    assert devices_build.same_moment(base, 12.0, {"duration": 30}, 4.0) == 13.0  # unknown time: the middle


def test_a_360_shot_hands_its_whip_on_and_enters_on_a_cut():
    seq = _seq(4)
    seq[1].update({"is360": True, "move": ["drone", 1, "whip", "whip"]})
    seq[2].update({"is360": True, "move": ["roll", -1, None, "rollx"]})
    tins = devices.sphere_handoffs(seq, ["cut", "dissolve", "iris", "wipe"])
    assert tins == ["cut", "cut", "whip", "cut"]
    starts = _starts(seq)
    d = devices.plan(seq, starts, ["body"] * 4, [0.0], [], "documentary", [], seed=1)
    assert round(starts[1] - 0.1, 2) in d["whooshes"]
