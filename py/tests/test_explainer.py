"""Explainers as a video type (studio.explainer): the script checks in plain words, library references, the draft that
rides the reel pipeline (build, package, review row, posting only once approved), each network's text, and the scene
kinds agreeing with the composition (src/Explainer.tsx). Neutral words only (Cafe Kumo): this file is exported."""
import json
import re
from pathlib import Path

import pytest

from studio import explainer as ex
from studio.config import ROOT


@pytest.fixture
def lib(tmp_path):
    files = {}
    for name in ("a.jpg", "b.mp4", "c.mp4"):
        files[name] = tmp_path / name
        files[name].write_bytes(b"x")
    return {
        101: {"id": 101, "path": str(files["a.jpg"]), "kind": "photo", "duration": None, "person": 0.0, "faces": 0},
        102: {"id": 102, "path": str(files["b.mp4"]), "kind": "video", "duration": 20.0, "person": 0.01, "faces": 0},
        103: {"id": 103, "path": str(files["c.mp4"]), "kind": "video", "duration": 5.0, "person": 0.2, "faces": 1},
    }


def script(**over):
    s = {
        "slug": "cafe-kumo-lunch", "title": "Cafe Kumo のランチ｜3つの数字 #Shorts", "accent": "#2f6b3f", "music": "off",
        "scenes": [
            {"kind": "cover", "sec": 4, "src": "lib:102@1+6", "kicker": "解説 · Explained", "ja": "ランチは\n*12時から*", "en": "Lunch from noon", "big": "12:00"},
            {"kind": "number", "sec": 5, "value": 30, "unit": "席", "ja": "席は*30*", "en": "30 seats", "source": "店のメモ / the shop"},
            {"kind": "icons", "sec": 5, "ja": "ここに*あるもの*", "en": "What is here",
             "items": [{"icon": "mug", "ja": "コーヒー", "en": "coffee"}, {"icon": "wifi", "ja": "Wi-Fi", "en": "wifi"}, {"icon": "sun", "ja": "テラス", "en": "terrace"}]},
            {"kind": "end", "sec": 4, "src": "lib:101", "mascot": "tr", "ja": "また*あした*", "en": "See you tomorrow", "lines": ["Cafe Kumo で検索"]},
        ],
        "yt": "Cafe Kumo のランチの話。", "ig": "Cafe Kumo のランチ。", "tags": ["カフェ", "#ランチ"],
    }
    s.update(over)
    return s


def errors_of(s, lib):
    return ex.check(s, lib=lib)["errors"]


def test_library_references_read_as_a_photo_or_a_clip():
    assert ex.parse_lib("lib:1246") == {"id": 1246}
    assert ex.parse_lib("lib:752@2+8") == {"id": 752, "start": 2.0, "len": 8.0}
    assert ex.parse_lib(" lib:7@1.5+4.25 ") == {"id": 7, "start": 1.5, "len": 4.25}
    for bad in ("lib:", "lib:12@3", "lib:x", "explainer/cover.mp4", "C:/footage/a.mp4", None, 12):
        assert ex.parse_lib(bad) is None


def test_a_good_script_passes_and_lists_its_pictures(lib):
    res = ex.check(script(), lib=lib)
    assert res["ok"], res["errors"]
    assert res["seconds"] == 18 and res["scenes"] == 4
    assert [(m["id"], m["shape"], m.get("start"), m.get("len")) for m in res["media"]] == [(102, "full", 1.0, 6.0), (101, "full", None, None)]


@pytest.mark.parametrize("change, said", [
    (lambda s: s["scenes"][1].update(kind="spiral"), "unknown kind"),
    (lambda s: s["scenes"][0].update(src="lib:999@0+5"), "999 is not in the library"),
    (lambda s: s["scenes"][3].update(src="lib:101@0+3"), "is a photo"),
    (lambda s: s["scenes"][0].update(src="lib:102@18+6"), "runs past the end"),
    (lambda s: s["scenes"][0].update(src="footage/cover.mp4"), "pictures come from the library"),
    (lambda s: s["scenes"][1].update(ja="とても長い見出しがここに入っていて一行には収まりません"), "too long for one line"),
    (lambda s: s["scenes"][1].update(ja="一行目\n二行目\n三行目"), "at most 2 fit"),
    (lambda s: s["scenes"][1].update(ja="*閉じていない"), "odd number of *"),
    (lambda s: s["scenes"][2]["items"][0].update(icon="rocket"), "one of tent"),
    (lambda s: s["scenes"][2].update(items=s["scenes"][2]["items"][:2]), "items has 2; 3 to 6 fit"),
    (lambda s: s["scenes"][1].update(kind="bars", bars=[{"value": -3, "ja": "冬"}, {"value": 2, "ja": "夏"}]), "grow up from zero"),
    (lambda s: s["scenes"][1].update(kind="clock", hours=[{"at": "25:00", "ja": "朝"}, {"at": "09:00", "ja": "昼"}, {"at": "12:00", "ja": "夜"}]), '"at": "07:00"'),
    (lambda s: s["scenes"][1].update(sec=14), "sec must be a number of seconds"),
    (lambda s: s.update(slug="Cafe Kumo"), "slug: lowercase"),
    (lambda s: s.pop("ig"), "ig: missing"),
    (lambda s: s.update(music={"id": "nope.mp3"}), "not a CC0 or public-domain track"),
    (lambda s: s["scenes"][0].update(mascot="middle"), "mascot is for the cover or end"),
])
def test_every_problem_is_said_in_plain_words(lib, change, said, monkeypatch):
    from studio import sound

    monkeypatch.setattr(sound, "library", lambda: [])
    s = script()
    change(s)
    errs = errors_of(s, lib)
    assert any(said in e for e in errs), errs


def test_a_too_short_or_too_long_film_is_refused(lib):
    s = script()
    s["scenes"] = s["scenes"][:3]
    for sc in s["scenes"]:
        sc["sec"] = 3
    assert any("length 9 s" in e for e in errors_of(s, lib))


def test_people_in_a_picture_are_a_warning_not_a_block(lib):
    s = script()
    s["scenes"][0]["src"] = "lib:103@0+5"
    res = ex.check(s, lib=lib)
    assert res["ok"], res["errors"]
    assert any("may show people" in w for w in res["warnings"])
    assert not any("last frame is held" in w for w in res["warnings"])  # 5 s of clip for a 4 s scene
    s["scenes"][0]["sec"] = 6
    res = ex.check(s, lib=lib)
    assert res["ok"] and any("its last frame is held" in w for w in res["warnings"])


def test_the_fact_guard_reads_every_word_shown_or_posted(lib, monkeypatch):
    from studio import brand

    monkeypatch.setattr(brand, "copy_rules", lambda: {"banned": ["forbidden", "cow"], "noPrices": True, "registered": None, "bare": None})
    s = script()
    s["scenes"][2]["items"][1]["en"] = "a forbidden word"
    s["ig"] = "ランチ ¥500"
    errs = errors_of(s, lib)
    assert any("items[2].en" in e and "forbidden" in e for e in errs)
    assert any(e.startswith("ig:") and "price" in e for e in errs)
    # Latin phrases count as whole words: a "coworking" lounge is not a cow.
    s = script()
    s["scenes"][2]["en"] = "In the coworking lounge"
    assert ex.check(s, lib=lib)["ok"]


def test_scene_kinds_and_icons_agree_with_the_composition():
    tsx = (ROOT / "src" / "Explainer.tsx").read_text(encoding="utf-8")
    union = tsx[tsx.index("export type ExplainerScene"):tsx.index("export type ExplainerProps")]
    assert set(re.findall(r'kind: "([a-z]+)"', union)) | {"nogo"} == set(ex.SCENES)
    icons = re.search(r"export const ICONS = \[([^\]]+)\]", tsx).group(1)
    assert re.findall(r'"([a-z]+)"', icons) == list(ex.ICONS)
    for kind in ex.SCENES:
        assert f'case "{kind}"' in tsx, kind


def test_text_width_is_measured_like_the_composition():
    assert ex.text_em("あいう") == 3 and ex.text_em("*あ*い") == 2
    assert abs(ex.text_em("abc") - 1.68) < 1e-9 and abs(ex.text_em("a b") - 1.42) < 1e-9


def test_a_draft_is_a_project_that_rides_the_reel_pipeline(lib, tmp_path, monkeypatch):
    from studio import projects

    monkeypatch.setattr(projects, "DIR", tmp_path / "projects")
    monkeypatch.setattr(ex, "SCRIPTS", tmp_path / "scripts")
    out = ex.draft(script(), lib=lib)
    assert out["ok"] and out["saved"]
    p = projects.load("cafe-kumo-lunch")
    assert p["kind"] == "explainer" and p["shots"] == [] and p["title_ja"].startswith("Cafe Kumo")
    assert p["tags"] == ["#カフェ", "#ランチ"]
    assert [b["kind"] for b in p["beats"]] == ["hook", "line", "line", "end"] and p["beats"][0]["startSec"] == 0
    assert p["beats"][-1]["endSec"] == 18 and "*" not in p["beats"][0]["ja"]
    assert json.loads((tmp_path / "scripts" / "cafe-kumo-lunch.json").read_text(encoding="utf-8"))["slug"] == "cafe-kumo-lunch"
    # A reel's slug is never taken over.
    projects.save({"slug": "cafe-reel", "shots": [], "beats": []})
    taken = ex.draft(script(slug="cafe-reel"), lib=lib)
    assert not taken["saved"] and "is a reel already" in taken["errors"][0]
    # A script that does not pass is not saved.
    bad = ex.draft(script(slug="cafe-bad", scenes=[]), lib=lib)
    assert not bad["saved"] and not projects.load("cafe-bad")


def test_a_folder_of_scripts_becomes_drafts_and_says_what_failed(lib, tmp_path, monkeypatch):
    from studio import projects

    monkeypatch.setattr(projects, "DIR", tmp_path / "projects")
    monkeypatch.setattr(ex, "SCRIPTS", tmp_path / "scripts")
    monkeypatch.setattr(ex, "lib_rows", lambda ids: lib)
    folder = tmp_path / "in"
    folder.mkdir()
    (folder / "a.json").write_text(json.dumps(script(), ensure_ascii=False), encoding="utf-8")
    (folder / "b.json").write_text("{ not json", encoding="utf-8")
    (folder / "c.json").write_text(json.dumps(script(slug="cafe-two", scenes=[{"kind": "spiral", "sec": 4, "ja": "x"}]), ensure_ascii=False), encoding="utf-8")
    out = ex.add(folder)
    assert out["made"] == ["cafe-kumo-lunch"]
    assert [f["file"] for f in out["failed"]] == ["b.json", "c.json"]
    assert "not valid JSON: line 1" in out["failed"][0]["errors"][0]
    with pytest.raises(FileNotFoundError):
        ex.add(tmp_path / "empty-nothing-here")


def test_a_render_package_and_remix_of_an_explainer_go_to_its_own_pipeline(monkeypatch):
    from studio import reels

    calls = []
    monkeypatch.setattr(reels, "get_reel", lambda slug: {"slug": slug, "kind": "explainer", "shots": [], "beats": []})
    monkeypatch.setattr(ex, "build", lambda slug: calls.append(("build", slug)) or {"slug": slug})
    monkeypatch.setattr(ex, "package", lambda slug, only=None: calls.append(("package", slug, only)) or ["instagram"])
    assert reels.build("cafe-x") == {"slug": "cafe-x"}
    assert reels.remix("cafe-x") == {"slug": "cafe-x"}
    assert reels.package("cafe-x", ["instagram"]) == ["instagram"]
    assert calls == [("build", "cafe-x"), ("build", "cafe-x"), ("package", "cafe-x", ["instagram"])]


def test_an_explainer_is_posted_only_once_a_person_approved_it(tmp_path):
    from studio import publish
    from studio.db import connect

    master = tmp_path / "m.mp4"
    master.write_bytes(b"x")
    ex._register("cafe-approve", master, tmp_path / "hook.jpg", 0, tmp_path / "post.txt")
    assert publish.review_status("cafe-approve") == "rendered"
    with pytest.raises(publish.NotApproved, match="approved"):
        publish.assert_approved("cafe-approve")
    with connect() as con:
        con.execute("UPDATE drafts SET status = 'approved' WHERE slug = 'story-cafe-approve'")
    publish.assert_approved("cafe-approve")  # no error
    ex._register("cafe-approve", master, tmp_path / "hook.jpg", 0, tmp_path / "post.txt")  # a new render: back to review
    assert publish.review_status("cafe-approve") == "rendered"
    with connect() as con:
        assert con.execute("SELECT recipe FROM drafts WHERE slug = 'story-cafe-approve'").fetchone()[0] == "explainer"


def test_the_networks_an_explainer_goes_to():
    spec = {c["id"]: c for c in json.loads((ROOT / "shared" / "channels.json").read_text(encoding="utf-8"))["channels"]}
    to = {k for k, c in spec.items() if ex.wants({**c, "off": False, "id": k}, 35)}
    assert {"youtube-shorts", "instagram", "facebook", "tiktok", "bluesky"} <= to
    assert not {"linkedin", "gbp", "zenn", "note", "xiaohongshu"} & to  # long cuts, a 30 s limit, articles, no Chinese words
    assert not ex.wants({**spec["instagram"], "id": "instagram", "off": True}, 35)


def test_each_network_gets_its_text_from_the_script(monkeypatch):
    from studio import brand

    monkeypatch.setattr(brand, "brand", lambda: {"link": "https://example.com/", "name": "Cafe Kumo", "nameEn": "Cafe Kumo", "handle": "@cafekumo", "tags": []})
    sc = script()
    reel = {"slug": sc["slug"], "explainer": sc, "tags": ex._tags(sc)}
    yt = ex.post_text(reel, "youtube-shorts")
    assert yt.startswith("TITLE: Cafe Kumo のランチ") and "DESCRIPTION:\nCafe Kumo のランチの話。" in yt
    ig = ex.post_text(reel, "instagram")
    assert ig.startswith("Cafe Kumo のランチ。") and "#カフェ #ランチ" in ig  # tags added when the caption has none
    sc2 = {**sc, "ig": "もう書いた #タグ"}
    assert ex.post_text({**reel, "explainer": sc2}, "instagram").count("#") == 1
    bs = ex.post_text({**reel, "explainer": {**sc, "title": "あ" * 400}}, "bluesky")
    assert len(bs.rstrip("\n")) <= 300 and "utm_source=bluesky" in ex.post_text(reel, "bluesky")


def test_the_overview_names_each_video_type():
    from studio.service import video_type

    assert video_type({"kind": "explainer"}) == "explainer"
    assert video_type({"variant": "site-walk"}) == "walk"
    assert video_type({"variant": "b-explainer"}) == "long"
    assert video_type({}) == "reel"
