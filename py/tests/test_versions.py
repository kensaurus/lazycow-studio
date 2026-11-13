"""studio.versions: a re-cut swaps only shots the review found under the wrong caption, for clearly better ones, and
spreads its picks; a candidate never touches the live reel; keeping the live one discards the candidate."""
import json
from pathlib import Path

import numpy as np


def _setup(monkeypatch, tmp_path, reel, review, pool, embs):
    from studio import ai, assemble, library, projects, reels, versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    monkeypatch.setattr(versions, "_PICKED", {})
    monkeypatch.setattr(projects, "load", lambda slug: json.loads(json.dumps(reel)) if slug == reel["slug"] else None)
    monkeypatch.setattr(reels, "resolve", lambda rel: Path("C:/footage") / rel)
    monkeypatch.setattr(assemble, "_src", lambda p: Path(p).name)
    monkeypatch.setattr(library, "text_embedding", lambda q: np.array([1.0, 0.0], dtype="float32"))
    monkeypatch.setattr(library, "_base_items", lambda: [({"path": str(Path("C:/footage") / k)}, np.array(v, dtype="float32")) for k, v in embs.items()])
    monkeypatch.setattr(library, "items", lambda q, f, limit=400: [dict(p) for p in pool])
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    (tmp_path / "ai" / "reviews").mkdir(parents=True)
    (tmp_path / "ai" / "reviews" / f"{reel['slug']}.json").write_text(json.dumps(review), encoding="utf-8")
    return versions


REEL = {"slug": "deck-1", "season": "mixed", "shots": [{"src": "a.mp4", "sec": 2.0}, {"src": "b.mp4", "sec": 2.0}, {"src": "c.mp4", "sec": 2.0}],
        "beats": [{"kind": "hook", "en": "Morning", "startSec": 0.1, "endSec": 1.8}, {"kind": "line", "en": "In front of the deck: grassland", "startSec": 2.1, "endSec": 3.8},
                  {"kind": "end", "en": "x", "startSec": 4.1, "endSec": 6.0}]}


def _cand(name, match, used=0, kind="video"):
    return {"file": name, "path": f"C:/footage/{name}", "match": match, "kind": kind, "duration": 9.0, "top": ["field"], "junk": 0, "usedIn": ["r"] * used, "aesthetic": 6}


def test_a_shot_under_the_wrong_caption_is_swapped_for_a_clearly_better_one(monkeypatch, tmp_path):
    review = {"mismatches": [{"at": 3.0, "shows": "indoor kitchen"}], "hook": {"score": 6}}
    v = _setup(monkeypatch, tmp_path, REEL, review, [_cand("deck.mp4", 0.31), _cand("near.mp4", 0.16)], {"b.mp4": [0.15, 0.98]})
    new, changes = v.recut_plan("deck-1")
    assert [c["shot"] for c in changes] == [2] and changes[0]["to"] == "deck.mp4" and changes[0]["matchBefore"] == 0.15
    assert new["shots"][1]["src"] == "deck.mp4" and new["shots"][0]["src"] == "a.mp4", "only the shot under the caption changes"
    assert new["beats"] == REEL["beats"], "the words stay"


def test_nothing_clearly_better_means_no_recut(monkeypatch, tmp_path):
    review = {"mismatches": [{"at": 3.0, "shows": "x"}], "hook": {"score": 6}}
    v = _setup(monkeypatch, tmp_path, REEL, review, [_cand("near.mp4", 0.16)], {"b.mp4": [0.15, 0.98]})
    assert v.recut_plan("deck-1") == (None, [])


def test_a_clip_other_reels_use_loses_to_a_fresh_one_nearly_as_good(monkeypatch, tmp_path):
    review = {"mismatches": [{"at": 3.0, "shows": "x"}], "hook": {"score": 6}}
    v = _setup(monkeypatch, tmp_path, REEL, review, [_cand("everywhere.mp4", 0.31, used=3), _cand("fresh.mp4", 0.29)], {"b.mp4": [0.1, 0.99]})
    assert v.recut_plan("deck-1")[1][0]["to"] == "fresh.mp4"


def test_keeping_the_live_one_discards_the_candidate(monkeypatch, tmp_path):
    from studio import versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    d = tmp_path / "versions" / "deck-1" / "v2"
    d.mkdir(parents=True)
    (d / "deck-1_9x16.mp4").write_bytes(b"x")
    versions._write_meta("deck-1", 2, {"n": 2, "status": "candidate", "why": "w", "changes": []})
    versions._write_meta("deck-1", 1, {"n": 1, "status": "live", "why": "as approved", "changes": []})
    assert [m["n"] for m in versions.listing("deck-1")] == [2, 1]
    versions.discard("deck-1", 2)
    assert versions.listing("deck-1")[0]["status"] == "discarded" and not (d / "deck-1_9x16.mp4").exists()


def test_a_version_whose_maker_was_closed_mid_render_comes_back_to_be_recut(monkeypatch, tmp_path):
    from datetime import datetime, timedelta

    from studio import versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    old = (datetime.now().astimezone() - timedelta(hours=2)).isoformat(timespec="seconds")
    versions._write_meta("deck-1", 2, {"n": 2, "status": "making", "made": old})
    versions._write_meta("deck-2", 2, {"n": 2, "status": "making", "made": versions._now()})
    assert versions.listing("deck-1")[0]["status"] == "failed"  # its run is gone: todo lists the reel as open again
    assert versions.listing("deck-2")[0]["status"] == "making"  # still being made
    assert versions._next("deck-1") == 3


def test_a_search_that_finds_nothing_better_is_not_offered_again_until_the_review_changes(monkeypatch, tmp_path):
    import os
    import time

    from studio import ai, versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    monkeypatch.setattr(versions, "snapshot", lambda slug: (tmp_path / "versions" / slug).mkdir(parents=True, exist_ok=True))
    monkeypatch.setattr(versions, "recut_plan", lambda slug: (None, []))
    rv = tmp_path / "ai" / "reviews" / "deck-1.json"
    rv.parent.mkdir(parents=True)
    rv.write_text("{}", encoding="utf-8")
    os.utime(rv, (time.time() - 60, time.time() - 60))
    assert versions.make("deck-1") is None
    assert versions._searched("deck-1")  # the page lists it as staying as it is, with no "re-cut" button
    os.utime(rv, (time.time() + 60, time.time() + 60))  # reviewed again since: worth another search
    assert not versions._searched("deck-1")


def test_using_a_version_builds_it_and_approves_the_reels_draft(monkeypatch, tmp_path):
    """On 12 Nov every "Use the new version" failed at the end: it approved "aerial-1107", but the review record is
    "story-aerial-1107", so the reel was left unapproved."""
    from studio import ai, projects, reels, review_actions, versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    monkeypatch.setattr(versions, "snapshot", lambda slug: {"n": 1})
    versions._write_meta("deck-1", 1, {"n": 1, "status": "live"})
    versions._write_meta("deck-1", 2, {"n": 2, "status": "candidate"})
    (tmp_path / "versions" / "deck-1" / "v2" / "reel.json").write_text('{"slug": "deck-1"}', encoding="utf-8")
    done = []
    monkeypatch.setattr(projects, "save", lambda reel: done.append(("save", reel["slug"])))
    monkeypatch.setattr(reels, "build", lambda slug: done.append(("build", slug)))
    monkeypatch.setattr(review_actions, "approve", lambda slug: done.append(("approve", slug)))

    class Con:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, *a):
            class R:
                def fetchone(self): return (0,)
            return R()
    import studio.db
    monkeypatch.setattr(studio.db, "connect", lambda: Con())
    versions.use("deck-1", 2)
    assert done == [("save", "deck-1"), ("build", "deck-1"), ("approve", "story-deck-1")]
    assert versions.listing("deck-1")[0]["status"] == "live" and versions.listing("deck-1")[1]["status"] == "earlier"


def test_a_version_with_faces_is_refused_before_anything_changes_when_the_reel_has_no_consent(monkeypatch, tmp_path):
    """12 Nov, focus-1107: the build put the new files live, then the approval refused (faces, no consent tick), so the
    reel was left unapproved and its booking would not have posted. Now nothing is touched until consent is given."""
    import pytest

    from studio import ai, projects, reels, review_actions, versions

    monkeypatch.setattr(versions, "VERS", tmp_path / "versions")
    monkeypatch.setattr(ai, "HOME", tmp_path / "ai")
    monkeypatch.setattr(versions, "snapshot", lambda slug: {"n": 1})
    versions._write_meta("deck-1", 1, {"n": 1, "status": "live"})
    versions._write_meta("deck-1", 2, {"n": 2, "status": "candidate"})
    v2 = tmp_path / "versions" / "deck-1" / "v2"
    (v2 / "reel.json").write_text('{"slug": "deck-1"}', encoding="utf-8")
    (v2 / "manifest.json").write_text('{"stats": {"faces": 2}}', encoding="utf-8")
    done = []
    monkeypatch.setattr(projects, "save", lambda reel: done.append("save"))
    monkeypatch.setattr(reels, "build", lambda slug: done.append("build"))
    monkeypatch.setattr(review_actions, "approve", lambda slug: done.append("approve"))
    consent = [0]

    class Con:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, *a):
            class R:
                def fetchone(self): return (consent[0],)
            return R()
    import studio.db
    monkeypatch.setattr(studio.db, "connect", lambda: Con())
    with pytest.raises(ValueError, match="Consent OK"):
        versions.use("deck-1", 2)
    assert done == [] and versions.listing("deck-1")[1]["status"] == "live", "the live reel is untouched"
    consent[0] = 1  # a person gave consent for the people on camera: the version can be used
    versions.use("deck-1", 2)
    assert done == ["save", "build", "approve"]


def test_a_recut_the_reviewer_finds_worse_is_never_offered():
    from studio.versions import better_than

    live = {"mismatches": [1], "hook": 5, "look": 6}
    assert better_than(live, {"mismatches": [1, 2], "hook": 5, "look": 5}) == "worse", "autumn-1108-2: two on the wrong picture against one"
    assert better_than(live, {"mismatches": [], "hook": 5, "look": 5}) == "better"
    assert better_than(live, {"mismatches": [1], "hook": 5, "look": 6}) == "same"
    assert better_than(None, live) == "unknown"


def test_a_recut_whose_new_shot_shows_a_face_is_not_offered_for_a_reel_without_faces():
    """12 Nov: two re-cuts swapped in clips the library marked face-free; the build found a face at the moment used."""
    from studio.versions import adds_faces

    manifest = {"shots": [{"faces": 1}, {"faces": 0}, {"faces": 2}]}
    assert adds_faces({}, manifest, [{"shot": 1}])
    assert not adds_faces({}, manifest, [{"shot": 2}])  # the swapped shot has none; another shot's face was there before
    assert not adds_faces({"allowFaces": True}, manifest, [{"shot": 1}])
    assert not adds_faces({"blurFaces": True}, manifest, [{"shot": 3}])
