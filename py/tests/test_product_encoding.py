"""Product video encoding (studio.product_encoding, docs/product-kit.md › Encoding): each preset's defaults meet its store,
every field's range, the cross-field rules (CBR holds one rate, ceilings, the H.264 level), the store rules as errors
(required) or warnings (recommended), the layers (preset, kit, project, render), the encoder's arguments, and the
finished file's measured rates against the same rules."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio import product
from studio import product_encoding as pe
from studio.config import ROOT

SCHEMA = json.loads((ROOT / "docs" / "product-kit.schema.json").read_text(encoding="utf-8"))


@pytest.fixture
def project(tmp_path, monkeypatch):
    f = tmp_path / "product-encoding.json"
    monkeypatch.setattr(pe, "PROJECT_FILE", f)
    return f


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "product"
    monkeypatch.setattr(product, "HOME", h)
    return h


def _fields(issues) -> list[str]:
    return [i["field"] for i in issues]


def _text(issues) -> str:
    return " | ".join(i["text"] for i in issues)


# ---------- the preset compliance matrix ----------

@pytest.mark.parametrize("pid", list(pe.PRESETS))
def test_every_presets_defaults_meet_its_store_with_nothing_to_say(pid, project):
    r = pe.resolve(pid, render={})
    assert r["errors"] == [] and r["warnings"] == [], (pid, r["errors"], r["warnings"])
    s = r["settings"]
    assert s["level"] == "4.0" and s["profile"] == "high" and s["fps"] == pe.PRESETS[pid]["fps"]
    assert s["audioBed"] == {"kind": "dither"} and s["audioRate"] in (44100, 48000)
    assert set(r["sources"].values()) == {"preset"}
    # Each store's required rules hold on the defaults, field by field.
    for rule in pe.store_of(pid)["rules"]:
        if rule["level"] == "error" and rule["field"] in s:
            assert not pe._breaks(rule, s[rule["field"]]), (pid, rule)


@pytest.mark.parametrize("pid", ["appstore-iphone", "appstore-iphone-55", "appstore-ipad"])
def test_app_store_defaults_to_constrained_cbr_inside_apples_10_to_12_mbps(pid, project):
    s = pe.resolve(pid, render={})["settings"]
    assert s["rateControl"] == "cbr"
    assert 10000 <= s["videoKbps"] <= 12000 and s["minKbps"] == s["maxKbps"] == s["videoKbps"]
    assert s["audioKbps"] == 256 and s["fps"] == 30
    args = " ".join(pe.video_args(s))
    for part in (f"-b:v {s['videoKbps']}k", f"-minrate {s['videoKbps']}k", f"-maxrate {s['videoKbps']}k", "nal-hrd=cbr", "-level:v 4.0", "-profile:v high", "-g 60"):
        assert part in args, part


def test_google_play_defaults_follow_youtubes_recommendations(project):
    s = pe.resolve("play-promo", render={})["settings"]
    assert s["rateControl"] == "vbr" and s["videoKbps"] >= 8000 and s["minKbps"] == 8000
    assert s["audioKbps"] == 384 and s["audioRate"] == 48000 and s["keyframeSec"] == 0.5
    assert "-g 15" in " ".join(pe.video_args(s))  # a closed GOP of half the frame rate


MATRIX = [
    # (preset, render override, "error" | "warn" | None, field, words)
    ("appstore-iphone", {"fps": 60}, "error", "fps", "at most 30 fps"),
    ("appstore-iphone", {"fps": 24}, None, "", ""),
    ("appstore-iphone", {"audioKbps": 128}, "error", "audioKbps", "256 kbps AAC"),
    ("appstore-iphone", {"audioKbps": 320}, "warn", "audioKbps", "256 kbps AAC"),
    ("appstore-iphone", {"audioRate": 44100}, None, "", ""),
    ("appstore-iphone", {"videoKbps": 5000}, "warn", "videoKbps", "10-12 Mbps"),
    ("appstore-iphone", {"videoKbps": 12000}, None, "", ""),
    ("appstore-iphone", {"rateControl": "vbr", "videoKbps": 11000, "maxKbps": 30000}, "error", "maxKbps", "level 4.0 allows at most 25000 kbps"),
    ("appstore-ipad", {"bufsizeKbits": 40000}, "error", "bufsizeKbits", "buffer of at most 31250 kbit"),
    ("appstore-iphone", {"rateControl": "crf", "crf": 20}, "warn", "videoKbps", "CRF does not hold a bit rate"),
    ("appstore-iphone", {"rateControl": "crf", "crf": 20, "minKbps": 10000}, None, "", ""),
    ("appstore-iphone", {"rateControl": "crf", "crf": 20, "minKbps": 6000}, "warn", "videoKbps", "10-12 Mbps"),
    ("play-promo", {"audioKbps": 256}, "warn", "audioKbps", "384 kbps"),
    ("play-promo", {"keyframeSec": 2}, "warn", "keyframeSec", "half the frame rate"),
    ("play-promo", {"audioRate": 44100}, "warn", "audioRate", "48 kHz"),
    ("play-promo", {"fps": 60}, "warn", "videoKbps", "12 Mbps for 1080p at 48-60 fps"),
    ("play-promo", {"fps": 60, "videoKbps": 12000, "maxKbps": 14000}, None, "", ""),
    ("social-9x16", {"fps": 60}, None, "", ""),
    ("social-1x1", {"audioKbps": 96, "rateControl": "crf"}, None, "", ""),
]


@pytest.mark.parametrize("pid,over,level,field,words", MATRIX)
def test_the_store_rules_matrix(pid, over, level, field, words, project):
    r = pe.resolve(pid, render=over)
    if level is None:
        assert r["errors"] == [] and r["warnings"] == [], (r["errors"], r["warnings"])
        return
    hit, other = (r["errors"], r["warnings"]) if level == "error" else (r["warnings"], r["errors"])
    assert field in _fields(hit) and words in _text(hit), (r["errors"], r["warnings"])
    assert other == [] or level == "error", other


def test_60_fps_raises_the_h264_level_where_the_store_allows_it(project):
    assert pe.resolve("social-9x16", render={"fps": 60})["settings"]["level"] == "4.2"
    assert pe.resolve("play-promo", render={"fps": 60})["settings"]["level"] == "4.2"  # 1080p at 60 fps: the macroblock rate
    assert pe.resolve("play-promo", render={"videoKbps": 30000, "maxKbps": 40000})["settings"]["level"] == "4.1"  # the ceiling
    assert pe.level_for(886, 1920, 30, 11000, 11000) == "4.0"
    assert pe.level_for(1080, 1920, 60, 12000, 24000) == "4.2"
    assert pe.level_for(1080, 1920, 30, 26000, 30000) == "4.1"
    assert pe.level_for(3840, 2160, 30, 1, 1) == "5.1" and pe.level_for(3840, 2160, 60, 1, 1) == "5.2"
    assert pe.level_for(7680, 4320, 60, 1, 1) is None


# ---------- one field at a time ----------

RANGES = [
    ("videoKbps", 100, "300 kbps to 80000 kbps"), ("videoKbps", 90000, "300 kbps to 80000 kbps"), ("videoKbps", "fast", "a whole number"),
    ("videoKbps", True, "a whole number"), ("videoKbps", 11000.5, "a whole number"), ("maxKbps", 200000, "300 kbps to 100000 kbps"),
    ("bufsizeKbits", 10, "300 kbit"), ("crf", 60, "0 to 51"), ("crf", -1, "0 to 51"), ("fps", 59, "one of 24, 25, 30, 48, 50, 60"),
    ("keyframeSec", 0.1, "0.25 s to 10 s"), ("keyframeSec", float("nan"), "a number"), ("audioKbps", 32, "64 kbps to 512 kbps"),
    ("audioRate", 32000, "one of 44100, 48000"), ("rateControl", "abr", "one of cbr, vbr, crf"),
    ("audioBed", {"kind": "loud"}, "one of dither, music"), ("audioBed", {"kind": "music"}, "needs id"),
    ("audioBed", {"kind": "music", "id": "../../etc/passwd"}, "needs id"), ("audioBed", {"kind": "music", "id": "a.mp3", "volume": 2}, "0 to 1"),
    ("audioBed", {"kind": "dither", "gain": 3}, "kind, id and volume only"), ("audioBed", "music", "sound bed must be"),
    ("ffmpeg", "-vf drawtext", "is not an encoding setting"),
]


@pytest.mark.parametrize("field,value,words", RANGES)
def test_a_value_out_of_range_names_its_field(field, value, words, project):
    r = pe.resolve("social-9x16", render={field: value})
    assert field in _fields(r["errors"]) and words in _text(r["errors"]), r["errors"]
    # ... and the setting below stays (a bad value never reaches the encoder).
    assert r["settings"].get(field) != value or field == "ffmpeg"


def test_settings_that_are_not_an_object_are_refused(project):
    assert "must be an object" in _text(pe.resolve("social-9x16", render=["cbr"])["errors"])
    assert "must be an object" in _text(pe.resolve("social-9x16", render="cbr")["errors"])


def test_too_many_frames_for_the_app_store_is_said_once(project):
    errs = pe.resolve("appstore-iphone", render={"fps": 60})["errors"]
    assert _fields(errs) == ["fps"] and "at most 30 fps" in errs[0]["text"]


def test_null_keeps_the_layer_below(project):
    assert pe.resolve("appstore-iphone", render={"videoKbps": None})["settings"]["videoKbps"] == 11000


# ---------- fields together ----------

def test_constrained_cbr_holds_one_rate(project):
    r = pe.resolve("appstore-iphone", render={"maxKbps": 12000})
    assert "maxKbps" in _fields(r["errors"]) and "holds one rate" in _text(r["errors"])
    r = pe.resolve("social-9x16", render={"rateControl": "cbr", "videoKbps": 9000})
    assert r["errors"] == [] and r["settings"]["minKbps"] == r["settings"]["maxKbps"] == 9000 and r["settings"]["bufsizeKbits"] == 9000


def test_vbr_ceiling_and_floor_must_bracket_the_target(project):
    assert "maxKbps" in _fields(pe.resolve("social-9x16", render={"videoKbps": 10000, "maxKbps": 8000})["errors"])
    assert "minKbps" in _fields(pe.resolve("social-9x16", render={"videoKbps": 10000, "minKbps": 11000})["errors"])
    s = pe.resolve("social-9x16", render={"rateControl": "vbr", "videoKbps": 5000, "maxKbps": None})["settings"]
    assert s["maxKbps"] == 12000  # the preset's ceiling stays when only the target changes


def test_crf_caps_the_peak_where_the_store_caps_the_level(project):
    s = pe.resolve("appstore-iphone", render={"rateControl": "crf", "crf": 16})["settings"]
    assert (s["maxKbps"], s["bufsizeKbits"], s["level"]) == (25000, 31250, "4.0") and "videoKbps" not in s
    args = " ".join(pe.video_args(s))
    assert "-crf 16" in args and "-maxrate 25000k" in args and "-b:v" not in args
    s = pe.resolve("social-1x1", render={"rateControl": "crf"})["settings"]
    assert "maxKbps" not in s and "-maxrate" not in " ".join(pe.video_args(s))
    assert "bufsizeKbits" in _fields(pe.resolve("social-1x1", render={"rateControl": "crf", "bufsizeKbits": 5000})["errors"])


def test_a_buffer_too_small_for_its_ceiling_is_refused(project):
    assert "bufsizeKbits" in _fields(pe.resolve("social-9x16", render={"bufsizeKbits": 1000})["errors"])


def test_crf_with_a_target_says_the_target_is_ignored(project):
    r = pe.resolve("social-9x16", render={"rateControl": "crf", "videoKbps": 9000})
    assert r["errors"] == [] and "ignores the target" in _text(r["warnings"])


# ---------- the layers ----------

def test_layers_apply_in_order_preset_kit_project_render(project):
    kit = {"default": {"keyframeSec": 1, "audioKbps": 192}, "presets": {"social-9x16": {"videoKbps": 9000, "audioKbps": 224}}}
    proj = {"presets": {"social-9x16": {"videoKbps": 9500}}}
    r = pe.resolve("social-9x16", kit=kit, project=proj, render={"fps": 25})
    s = r["settings"]
    assert (s["keyframeSec"], s["audioKbps"], s["videoKbps"], s["fps"]) == (1, 224, 9500, 25)
    assert r["sources"]["keyframeSec"] == "kit" and r["sources"]["videoKbps"] == "project" and r["sources"]["fps"] == "render"
    assert r["sources"]["rateControl"] == "preset"
    assert pe.resolve("social-1x1", kit=kit, project=proj, render={})["settings"]["videoKbps"] == 8000  # another preset's layer does not apply


def test_changing_the_rate_control_drops_the_modes_fields_below(project):
    proj = {"presets": {"play-promo": {"maxKbps": 16000, "minKbps": 9000}}}
    s = pe.resolve("play-promo", project=proj, render={"rateControl": "cbr"})["settings"]
    assert s["rateControl"] == "cbr" and s["minKbps"] == s["maxKbps"] == s["videoKbps"] == 10000


def test_a_kits_bad_hint_is_a_warning_and_left_out_never_an_error(project):
    kit = {"default": {"fps": 120, "videoKbps": "lots", "x264": "--crf 0"}, "presets": {"appstore-iphone": {"fps": 60}}}
    r = pe.resolve("appstore-iphone", kit=kit, render={})
    assert all(f != "x264" for f in _fields(r["errors"]))
    assert "(left out)" in _text(r["warnings"]) and r["settings"]["videoKbps"] == 11000
    # fps 60 passes its range, so it is kept, and the store refuses it like any other value: the render must not
    # silently break Apple's 30 fps.
    assert "fps" in _fields(r["errors"])


def test_a_projects_saved_default_is_kept_cleared_and_checked(project):
    pe.save_project("play-promo", {"audioKbps": 448, "keyframeSec": 1})
    saved = json.loads(project.read_text(encoding="utf-8"))
    assert saved == {"presets": {"play-promo": {"audioKbps": 448, "keyframeSec": 1}}}
    r = pe.resolve("play-promo", render={})
    assert r["settings"]["audioKbps"] == 448 and r["sources"]["audioKbps"] == "project"
    with pytest.raises(ValueError, match="at most 30 fps"):
        pe.save_project("appstore-iphone", {"fps": 50})
    with pytest.raises(ValueError, match="preset"):
        pe.save_project("tiktok-8k", {"fps": 30})
    pe.save_project("play-promo", None)
    assert json.loads(project.read_text(encoding="utf-8")) == {"presets": {}}


# ---------- the sound bed ----------

def test_music_comes_from_the_audio_library_by_name(project, monkeypatch, tmp_path):
    from studio import sound

    track = tmp_path / "calm.mp3"
    track.write_bytes(b"ID3")
    lib = [{"id": "calm.mp3", "file": str(track), "kind": "music", "license": "CC0"}, {"id": "mine.mp3", "file": str(track), "kind": "music", "license": "UNKNOWN"}]
    monkeypatch.setattr(sound, "library", lambda: lib)
    r = pe.resolve("social-9x16", render={"audioBed": {"kind": "music", "id": "calm.mp3", "volume": 0.4}})
    assert r["errors"] == [] and r["warnings"] == [] and r["settings"]["audioBed"] == {"kind": "music", "id": "calm.mp3", "volume": 0.4}
    assert "licence UNKNOWN" in _text(pe.resolve("social-9x16", render={"audioBed": {"kind": "music", "id": "mine.mp3"}})["warnings"])
    assert "not in the audio library" in _text(pe.resolve("social-9x16", render={"audioBed": {"kind": "music", "id": "gone.mp3"}})["errors"])
    # A kit's music that is not here falls back to the quiet bed with a warning.
    r = pe.resolve("social-9x16", kit={"default": {"audioBed": {"kind": "music", "id": "gone.mp3"}}}, render={})
    assert r["errors"] == [] and r["settings"]["audioBed"] == {"kind": "dither"} and "quiet bed is used instead" in _text(r["warnings"])


def test_the_encoder_mixes_music_over_the_quiet_bed(project):
    s = pe.resolve("social-9x16", render={"fps": 25, "keyframeSec": 1, "audioKbps": 192, "audioRate": 44100}, music=False)["settings"]
    args = product.encode_args("social-9x16", Path("in.mp4"), Path("s.wav"), Path("out.mp4"), 20.0, s, {"file": "/lib/calm.mp3", "volume": 0.4})
    joined = " ".join(args)
    for part in ("-stream_loop -1 -i /lib/calm.mp3", "amix=inputs=2:duration=first:normalize=0", "volume=0.400", "afade=t=out:st=18.500",
                 "-map [a]", "-r 25", "-g 25", "-b:a 192k", "-ar 44100", "-aac_is 0", "-protocol_whitelist file"):
        assert part in joined, part
    plain = " ".join(product.encode_args("social-9x16", Path("in.mp4"), Path("s.wav"), Path("out.mp4"), 20.0, s))
    assert "-map 1:a:0" in plain and "amix" not in plain


# ---------- the finished file ----------

def _probe(vk=None, ak="253141", rate="48000", fps="30/1", level=40, w=886, h=1920):
    v = {"codec_type": "video", "codec_name": "h264", "profile": "High", "level": level, "pix_fmt": "yuv420p", "width": w, "height": h,
         "avg_frame_rate": fps, "duration": "24.000", **({"bit_rate": vk} if vk else {})}
    a = {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": rate, **({"bit_rate": ak} if ak is not None else {})}
    return {"streams": [v, a], "format": {"duration": "24.021"}}


def test_the_measured_rates_come_back_in_the_settings_units():
    m = pe.measure(_probe(vk="10912345"), 33 * 1024 * 1024)
    assert (m["videoKbps"], m["audioKbps"], m["audioRate"], m["channels"], m["fps"], m["level"], m["mb"]) == (10912.3, 253.1, 48000, 2, 30.0, 4.0, 33.0)


def test_verify_file_judges_the_file_by_its_stores_rules(project):
    s = pe.resolve("appstore-iphone", render={})["settings"]
    ok = product.verify_report("appstore-iphone", _probe(vk="10900000"), 30 * 1024 * 1024, s)
    assert ok["errors"] == [] and ok["warnings"] == [] and ok["measured"]["videoKbps"] == 10900.0
    # Apple's 10-12 Mbps is a target: a 5.5 Mbps file is a warning, not a refusal (0.31.0's demo render measured that).
    low = product.verify_report("appstore-iphone", _probe(vk="5500000"), 1, s)
    assert low["errors"] == [] and "10-12 Mbps" in " ".join(low["warnings"]) and "holds 5500 kbps" in " ".join(low["warnings"])
    # Apple's 256 kbps AAC is required: a silent track is refused.
    assert any("256 kbps AAC" in e for e in product.verify_file("appstore-iphone", _probe(ak="2275"), 1, s))
    assert product.verify_file("appstore-iphone", _probe(ak="240000"), 1, s) == []  # inside the encoder's own rate control
    # A file at another frame rate than it was set to.
    s24 = pe.resolve("appstore-iphone", render={"fps": 24})["settings"]
    assert any("24 fps" in e for e in product.verify_file("appstore-iphone", _probe(), 1, s24))
    assert product.verify_file("appstore-iphone", _probe(fps="24/1"), 1, s24) == []


def test_google_play_rules_on_the_file_are_warnings_only(project):
    s = pe.resolve("play-promo", render={})["settings"]
    rep = product.verify_report("play-promo", _probe(vk="6000000", ak="256000", w=1920, h=1080), 1, s)
    assert rep["errors"] == []
    text = " ".join(rep["warnings"])
    assert "8 Mbps" in text and "384 kbps" in text and "under the floor (8000 kbps)" in text


def test_a_social_cut_at_60_fps_is_checked_at_its_own_level(project):
    s = pe.resolve("social-9x16", render={"fps": 60})["settings"]
    assert product.verify_file("social-9x16", _probe(fps="60/1", level=42, w=1080, h=1920), 1, s) == []
    assert any("level must be 4.2" in e for e in product.verify_file("social-9x16", _probe(fps="60/1", level=50, w=1080, h=1920), 1, s))


def test_the_floor_re_encodes_as_constrained_cbr_at_the_floor(project):
    s = pe.resolve("play-promo", render={})["settings"]
    f = pe.floor_settings(s)
    assert (f["rateControl"], f["videoKbps"], f["minKbps"], f["maxKbps"], f["bufsizeKbits"]) == ("cbr", 8000, 8000, 8000, 8000)
    assert "nal-hrd=cbr" in " ".join(pe.video_args(f))


# ---------- through product: the kit, the queue, the CLI ----------

def _kit(home, name="demo", encoding=None):
    from tests.test_product import _kit as make, _shot

    kit = make([_shot("home"), _shot("search", before=False)])
    kit["name"] = name
    if encoding is not None:
        kit["encoding"] = encoding
    (home / name).mkdir(parents=True, exist_ok=True)
    (home / name / "kit.json").write_text(json.dumps(kit), encoding="utf-8")
    return kit


def test_prepare_keeps_the_renders_encoding_for_build_and_refuses_a_required_rule(home, project):
    _kit(home)
    r = product.prepare({"name": "demo", "preset": "appstore-iphone", "encoding": {"videoKbps": 12000, "fps": 24}})
    assert r["settings"]["videoKbps"] == 12000 and r["settings"]["fps"] == 24 and r["plan"]["scenes"] >= 1
    kept = json.loads((home / "demo" / "renders" / "appstore-iphone-encoding.json").read_text(encoding="utf-8"))
    assert kept == {"encoding": {"videoKbps": 12000, "fps": 24}}
    assert product.encoding_for("demo", "appstore-iphone")["settings"]["fps"] == 24  # what build reads
    with pytest.raises(product.KitError) as e:
        product.prepare({"name": "demo", "preset": "appstore-iphone", "encoding": {"fps": 60}})
    assert e.value.code == "bad_encoding" and e.value.status == 400 and "fps" in _fields(e.value.errors)
    # The kept encoding of the last good render stays.
    assert product.encoding_for("demo", "appstore-iphone")["settings"]["fps"] == 24
    # A render with no encoding clears the one kept before.
    product.prepare({"name": "demo", "preset": "appstore-iphone"})
    assert product.encoding_for("demo", "appstore-iphone")["settings"]["fps"] == 30
    # A finished render is listed by its preset only (never its props or its kept encoding).
    assert [k["rendered"] for k in product.list_kits()] == [[]]


def test_the_plan_runs_at_the_renders_frame_rate(home):
    kit = _kit(home)
    pl = product.plan(kit, "social-9x16", 60)
    assert pl["preset"]["fps"] == 60 and abs(pl["durationInFrames"] / 60 - pl["seconds"]) < 0.02
    assert product.plan(kit, "social-9x16")["preset"]["fps"] == 30


def test_the_cli_answers_with_the_fields_that_broke(home, project, monkeypatch, capsys):
    import io

    _kit(home)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"name": "demo", "preset": "appstore-iphone", "encoding": {"audioKbps": 96}})))
    product.main(["prepare"])
    out = json.loads(capsys.readouterr().out.strip()[len("RESULT "):])
    assert out["ok"] is False and out["status"] == 400 and out["code"] == "bad_encoding" and _fields(out["errors"]) == ["audioKbps"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"preset": "play-promo", "encoding": {"audioKbps": 256}})))
    product.main(["encoding"])
    out = json.loads(capsys.readouterr().out.strip()[len("RESULT "):])
    assert out["ok"] and out["data"]["errors"] == [] and _fields(out["data"]["warnings"]) == ["audioKbps"]
    monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
    product.main(["encoding-info"])
    info = json.loads(capsys.readouterr().out.strip()[len("RESULT "):])["data"]
    assert set(info["defaults"]) == set(pe.PRESETS) and info["fields"] == pe.FIELDS and "app-store" in info["stores"]


def test_a_kits_encoding_is_kept_by_shape_and_checked_at_render():
    from tests.test_product import EXAMPLE
    import copy

    m = copy.deepcopy(EXAMPLE)
    m["encoding"] = {"default": {"audioBed": {"kind": "dither"}}, "presets": {"play-promo": {"videoKbps": 12000}, "tiktok-8k": {"fps": 60}}}
    kit = product.validate_manifest(m)
    assert kit["encoding"] == {"default": {"audioBed": {"kind": "dither"}}, "presets": {"play-promo": {"videoKbps": 12000}}}
    assert any("tiktok-8k" in w for w in kit["warnings"])
    m["encoding"] = ["cbr"]
    kit = product.validate_manifest(m)
    assert "encoding" not in kit and any(w.startswith("encoding:") for w in kit["warnings"])


def test_check_spec_uses_the_renders_frame_rate():
    assert product.check_spec("social-9x16", 20.0, 60, 1080, 1920, 60) == []
    assert "plays at 60 fps" in product.check_spec("social-9x16", 20.0, 30, 1080, 1920, 60)[0]
    assert "at most 30" in product.check_spec("appstore-iphone", 20.0, 60, 886, 1920, 60)[0]


# ---------- one list everywhere ----------

def test_the_kit_schema_and_the_studio_agree_on_every_field():
    d = SCHEMA["$defs"]["encoding"]["properties"]
    assert set(d) == set(pe.FIELDS)
    for k, f in pe.FIELDS.items():
        if k == "audioBed":
            assert d[k]["properties"]["kind"]["enum"] == f["kind"]["enum"]
            assert (d[k]["properties"]["volume"]["minimum"], d[k]["properties"]["volume"]["maximum"]) == (f["volume"]["min"], f["volume"]["max"])
        elif "enum" in f:
            assert d[k]["enum"] == f["enum"], k
        else:
            assert (d[k]["minimum"], d[k]["maximum"], d[k]["type"]) == (f["min"], f["max"], f["type"]), k
    assert sorted(SCHEMA["properties"]["encoding"]["properties"]["presets"]["propertyNames"]["enum"]) == sorted(pe.PRESETS)


def test_every_store_rule_is_well_formed():
    for sid, st in pe.STORES.items():
        assert st["name"] and isinstance(st["rules"], list), sid
        for r in st["rules"]:
            assert r["field"] in pe.FIELDS and r["level"] in ("error", "warn") and r["why"], (sid, r)
            assert any(k in r for k in ("min", "max", "oneOf")), (sid, r)
        if st.get("levelMax"):
            assert st["levelMax"] in {x[0] for x in pe.LEVELS}
    assert {p["store"] for p in pe.PRESETS.values()} <= set(pe.STORES)
