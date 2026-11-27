"""Product videos from a release kit (studio.product, docs/product-kit.md): the manifest check, the safe download, the
preset spec checks before and after a render, and the timeline the ProductPreview composition draws."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import shutil
import struct
import wave
from pathlib import Path

import pytest

from studio import product
from studio.config import ROOT

SCHEMA = json.loads((ROOT / "docs" / "product-kit.schema.json").read_text(encoding="utf-8"))
EXAMPLE = SCHEMA["examples"][0]


def _err(m) -> product.KitError:
    with pytest.raises(product.KitError) as e:
        product.validate_manifest(m)
    return e.value


# ---------- the manifest ----------

def test_the_schema_example_is_a_valid_kit():
    kit = product.validate_manifest(copy.deepcopy(EXAMPLE))
    assert kit["app"]["name"] == "Quiet Notes" and kit["app"]["host"] == "quietnotes.example"
    assert kit["app"]["stores"] == ["app-store", "google-play"]
    assert [s["id"] for s in kit["screens"]] == ["home", "search", "web-home"]
    assert kit["screens"][0]["before"]["url"] == "home-before.png" and kit["screens"][1]["before"] is None
    assert kit["screens"][2]["viewport"]["device"] == "desktop"
    assert kit["recordings"][0]["file"]["url"] == "search.mp4"
    assert kit["changelog"][0] == {"text": "A calmer home screen", "surface": "Home"}
    assert kit["changelog"][1] == {"text": "Search finds notes in under a second", "surface": ""}
    assert kit["brand"]["colors"]["accent"] == "#7cf0c5"
    assert kit["labels"] == {"before": "Before", "after": "Now", "news": "What's new"}


def test_the_schema_and_the_check_agree_on_the_enums():
    d = SCHEMA["$defs"]
    assert set(d["viewport"]["properties"]["device"]["enum"]) == set(product.DEVICES)
    assert set(SCHEMA["properties"]["app"]["properties"]["stores"]["items"]["enum"]) == set(product.STORES)
    assert set(d["asset"]["properties"]["type"]["enum"]) == product.IMAGE_TYPES | product.VIDEO_TYPES | product.FONT_TYPES
    assert SCHEMA["properties"]["screens"]["maxItems"] == product.MAX_SCREENS
    assert SCHEMA["properties"]["recordings"]["maxItems"] == product.MAX_RECORDINGS
    assert SCHEMA["properties"]["changelog"]["maxItems"] == product.MAX_LINES
    assert SCHEMA["properties"]["version"]["const"] == product.MAJOR and SCHEMA["properties"]["schema"]["const"] == product.SCHEMA


def test_unknown_fields_are_ignored_and_text_is_cleaned():
    m = copy.deepcopy(EXAMPLE)
    m["somethingNew"] = {"x": 1}
    m["screens"][0]["extra"] = True
    m["screens"][0]["caption"] = "Calmer\u0000 home\n\n screen \u202e" + "x" * 300
    kit = product.validate_manifest(m)
    cap = kit["screens"][0]["caption"]
    assert cap.startswith("Calmer home screen") and len(cap) == product.CAPTION_MAX
    assert "\u0000" not in cap and "\u202e" not in cap and "\n" not in cap


def test_another_major_version_is_refused_with_a_way_out():
    m = copy.deepcopy(EXAMPLE)
    m["version"] = 2
    e = _err(m)
    assert e.code == "bad_version" and "version 2" in str(e) and "version 1" in str(e)


@pytest.mark.parametrize("change, words", [
    (lambda m: m.update(schema="something-else"), "schema"),
    (lambda m: m["app"].pop("name"), "app.name"),
    (lambda m: m["brand"]["colors"].update(accent="red; background:url(x)"), "brand.colors.accent"),
    (lambda m: m["brand"]["font"].update(family="Inter'); x"), "brand.font.family"),
    (lambda m: m["screens"][1].update(id="home"), 'is used twice'),
    (lambda m: m["screens"][0].update(id="Home Screen"), "screens[0].id"),
    (lambda m: m["screens"][0].update(viewport={"width": 10, "height": 844}), "screens[0].viewport"),
    (lambda m: m["screens"][0]["after"].update(type="image/svg+xml"), "screens[0].after.type"),
    (lambda m: m["brand"]["logo"].update(type="image/svg+xml"), "brand.logo.type"),
    (lambda m: m["screens"][0]["after"].update(sha256="abc"), "sha256"),
    (lambda m: m["recordings"][0].update(trim={"from": 5, "to": 2}), "trim"),
    (lambda m: m.update(screens=[], recordings=[]), "at least one screenshot or recording"),
    (lambda m: m.update(screens=[m["screens"][0]] * 30), f"at most {product.MAX_SCREENS}"),
    (lambda m: m.update(expiresAt="soon"), "expiresAt"),
])
def test_a_broken_kit_says_what_and_where(change, words):
    m = copy.deepcopy(EXAMPLE)
    change(m)
    e = _err(m)
    assert e.code == "bad_kit" and words in str(e), str(e)


def test_an_expired_kit_still_reads_with_a_warning():
    m = copy.deepcopy(EXAMPLE)
    m["expiresAt"] = "2020-01-01T00:00:00Z"
    assert any("expired" in w for w in product.validate_manifest(m)["warnings"])


def test_the_device_comes_from_the_shape_when_not_given():
    assert product.infer_device(393, 852) == "phone"
    assert product.infer_device(1440, 900) == "desktop"
    assert product.infer_device(820, 1180) == "tablet"


# ---------- names and ids ----------

def test_video_ids_round_trip_and_refuse_anything_else():
    vid = product.video_id("quiet-notes-1-4-0", "appstore-iphone")
    assert vid == "pv-quiet-notes-1-4-0--appstore-iphone"
    assert product.parse_video_id(vid) == ("quiet-notes-1-4-0", "appstore-iphone")
    for bad in ("pv-x--nope", "pv--x--social-1x1", "pv-a--b--social-1x1", "fire-1107", "pv-A--social-1x1", "", None):
        assert product.parse_video_id(bad) is None, bad
    with pytest.raises(product.KitError):
        product.kit_name("../etc")
    with pytest.raises(product.KitError):
        product.kit_name("a--b")
    assert product.default_name(product.validate_manifest(copy.deepcopy(EXAMPLE))) == "quiet-notes-1-4-0"


# ---------- what the bytes are, and where they may come from ----------

def _png(w=120, h=260, color=(40, 80, 200)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _jpeg_with_exif(w=120, h=260) -> bytes:
    from PIL import Image

    im = Image.new("RGB", (w, h), (200, 60, 60))
    exif = Image.Exif()
    exif[0x010F] = "TestCam"      # Make
    exif[0x0110] = "Secret 1"     # Model
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def test_sniff_reads_the_bytes_never_the_name():
    assert product.sniff(_png()) == "image/png"
    assert product.sniff(_jpeg_with_exif()) == "image/jpeg"
    assert product.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert product.sniff(b"\x00\x00\x00\x20ftypisom\x00\x00") == "video/mp4"
    assert product.sniff(b"\x00\x00\x00\x14ftypqt  ") == "video/quicktime"
    assert product.sniff(b"\x1a\x45\xdf\xa3\x01") == "video/webm"
    assert product.sniff(b"wOF2\x00\x01") == "font/woff2"
    for bad in (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", b"<!doctype html><html>", b"#!/bin/sh\nrm -rf /", b"MZ\x90\x00"):
        assert product.sniff(bad) is None


@pytest.mark.parametrize("url", ["http://kits.example/m.json", "ftp://kits.example/m.json", "https://localhost/m.json", "https://127.0.0.1/m.json",
                                 "https://10.0.0.8/m.json", "https://192.168.1.2/m.json", "https://[::1]/m.json", "https://169.254.169.254/latest/meta-data",
                                 "https://printer.local/m.json", "file:///etc/passwd"])
def test_kit_links_are_public_https_only(url):
    with pytest.raises(product.KitError) as e:
        product._public_https(url)
    assert e.value.code == "bad_url"


def test_a_signed_links_token_is_never_shown():
    assert product._shown("https://cdn.example/kits/a/manifest.json?token=SECRET&exp=1") == "https://cdn.example/kits/a/manifest.json"


def test_a_kit_folder_only_gives_files_inside_it(tmp_path):
    (tmp_path / "kit").mkdir()
    (tmp_path / "kit" / "a.png").write_bytes(_png())
    (tmp_path / "outside.png").write_bytes(_png())
    src = product._Source(folder=(tmp_path / "kit").resolve())
    assert src.read("a.png", 10**6, "a") == (tmp_path / "kit" / "a.png").read_bytes()
    for ref in ("../outside.png", str(tmp_path / "outside.png"), "file:///etc/passwd", "https://x.example/a.png", "C:/Windows/win.ini", "/etc/passwd"):
        with pytest.raises(product.KitError):
            src.read(ref, 10**6, "a")
    with pytest.raises(product.KitError) as e:
        src.read("a.png", 10, "a")
    assert e.value.code == "too_big"


# ---------- fetching a kit folder end to end (pictures only: no ffmpeg needed) ----------

def _kit_folder(tmp_path: Path, **over) -> Path:
    d = tmp_path / "kit"
    d.mkdir(exist_ok=True)
    (d / "home-before.png").write_bytes(_png(1179, 2556, (230, 230, 235)))
    (d / "home-after.png").write_bytes(_png(1179, 2556, (20, 30, 60)))
    (d / "search.jpg").write_bytes(_jpeg_with_exif(1179, 2556))
    (d / "web.png").write_bytes(_png(1440, 900, (250, 250, 250)))
    (d / "logo.png").write_bytes(_png(256, 256, (124, 240, 197)))
    m = {
        "schema": "lazycow.release-kit", "version": 1,
        "app": {"name": "Quiet Notes", "stores": ["app-store"]}, "release": {"version": "1.4.0"},
        "brand": {"colors": {"background": "#0f1115", "text": "#f4f5f7", "accent": "#7cf0c5"}, "logo": {"url": "logo.png"}},
        "screens": [
            {"id": "home", "surface": "Home", "viewport": {"width": 393, "height": 852, "platform": "ios"},
             "before": {"url": "home-before.png"}, "after": {"url": "home-after.png", "sha256": hashlib.sha256((d / "home-after.png").read_bytes()).hexdigest()}},
            {"id": "search", "surface": "Search", "viewport": {"width": 393, "height": 852}, "after": {"url": "search.jpg", "type": "image/jpeg"}},
            {"id": "web", "surface": "Web", "viewport": {"width": 1440, "height": 900}, "after": {"url": "web.png"}},
        ],
        "changelog": [{"text": "A calmer home", "surface": "Home"}, "Faster search", "Dark mode", "Widgets"],
    }
    m.update(over)
    (d / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    return d


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "product"
    monkeypatch.setattr(product, "HOME", h)
    return h


def test_fetch_keeps_clean_copies_under_names_the_studio_gives(tmp_path, home):
    d = _kit_folder(tmp_path)
    view = product.fetch({"kitPath": str(d)}, say=lambda *a, **k: None)
    assert view["name"] == "quiet-notes-1-4-0"
    files = home / "quiet-notes-1-4-0" / "files"
    assert sorted(p.name for p in files.iterdir()) == sorted([
        "s-home-before.png", "s-home-before.thumb.jpg", "s-home-after.png", "s-home-after.thumb.jpg",
        "s-search-after.png", "s-search-after.thumb.jpg", "s-web-after.png", "s-web-after.thumb.jpg", "logo.png"])
    from PIL import Image

    with Image.open(files / "s-search-after.png") as im:  # was a JPEG with camera tags
        assert im.format == "PNG" and not im.getexif() and "exif" not in im.info
        assert im.size == (1179, 2556)
    stored = json.loads((home / "quiet-notes-1-4-0" / "kit.json").read_text(encoding="utf-8"))
    assert stored["source"]["from"] == str(d / "manifest.json")
    assert stored["screens"][0]["after"] == {"file": "s-home-after.png", "thumb": "s-home-after.thumb.jpg", "width": 1179, "height": 2556}
    # Each preset says whether it fits, before anything renders.
    assert view["fits"]["social-9x16"]["ok"] and view["fits"]["play-promo"]["ok"]
    assert view["fits"]["appstore-iphone"]["ok"]
    assert not view["fits"]["appstore-ipad"]["ok"] and "tablet" in view["fits"]["appstore-ipad"]["why"]
    assert [k["name"] for k in product.list_kits()] == ["quiet-notes-1-4-0"]


def test_fetch_refuses_a_file_that_is_not_what_the_kit_says(tmp_path, home):
    d = _kit_folder(tmp_path)
    (d / "home-after.png").write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    with pytest.raises(product.KitError) as e:
        product.fetch({"kitPath": str(d)}, say=lambda *a, **k: None)
    assert e.value.code == "bad_file" and "Screen home (after)" in str(e.value)
    assert not (home / "quiet-notes-1-4-0" / "kit.json").exists() and not (home / "quiet-notes-1-4-0" / "files.new").exists()


def test_fetch_checks_the_hash_and_the_size(tmp_path, home):
    d = _kit_folder(tmp_path)
    m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    m["screens"][0]["after"]["sha256"] = "0" * 64
    (d / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    with pytest.raises(product.KitError) as e:
        product.fetch({"kitPath": str(d)}, say=lambda *a, **k: None)
    assert "sha256" in str(e.value)
    m["screens"][0]["after"].pop("sha256")
    m["screens"][0]["after"]["bytes"] = 12
    (d / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    with pytest.raises(product.KitError) as e:
        product.fetch({"kitPath": str(d)}, say=lambda *a, **k: None)
    assert "the kit says 12" in str(e.value)


def test_a_recording_that_is_a_picture_is_refused(tmp_path, home):
    d = _kit_folder(tmp_path, recordings=[{"id": "flow", "viewport": {"width": 393, "height": 852}, "file": {"url": "home-after.png"}}])
    with pytest.raises(product.KitError) as e:
        product.fetch({"kitPath": str(d)}, say=lambda *a, **k: None)
    assert e.value.code == "bad_file" and "Recording flow" in str(e.value)


def test_a_kit_being_rendered_is_not_replaced(tmp_path, home):
    d = _kit_folder(tmp_path)
    with pytest.raises(product.KitError) as e:
        product.fetch({"kitPath": str(d), "busy": ["quiet-notes-1-4-0"]}, say=lambda *a, **k: None)
    assert e.value.code == "busy" and e.value.status == 409


def test_a_picture_too_big_to_open_is_refused(tmp_path):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("1", (13000, 100)).save(buf, "PNG")
    with pytest.raises(product.KitError) as e:
        product._clean_image(buf.getvalue(), tmp_path / "x.png", "Screen big")
    assert e.value.code == "too_big"


# ---------- presets and their spec ----------

APPLE_PORTRAIT = {(886, 1920), (1080, 1920), (750, 1334), (1200, 1600), (900, 1200)}  # developer.apple.com, 27 Nov 2026


def test_every_preset_is_inside_its_store_and_h264_level_4():
    assert set(product.PRESETS) == {"appstore-iphone", "appstore-iphone-55", "appstore-ipad", "play-promo", "social-9x16", "social-1x1"}
    for pid, p in product.PRESETS.items():
        assert p["width"] % 2 == 0 and p["height"] % 2 == 0, pid
        assert p["fps"] <= 30 and p["minSec"] < p["targetSec"] < p["maxSec"], pid
        mbs = -(-p["width"] // 16) * -(-p["height"] // 16)
        assert mbs <= 8192 and mbs * p["fps"] <= 245760, f"{pid} needs more than H.264 level 4.0"
        assert p["encode"]["level"] == "4.0" and p["encode"]["audioRate"] in (44100, 48000)
        # Apple lists 256 kbps AAC; YouTube (the Play promo) recommends 384 kbps for stereo (test_product_encoding).
        assert p["encode"]["audioKbps"] == {"app-store": 256, "google-play": 384}.get(p["store"], 256), pid
        if p["store"] == "app-store":
            assert (p["width"], p["height"]) in APPLE_PORTRAIT and (p["minSec"], p["maxSec"]) == (15, 30), pid
            assert p["frame"] == "none" and p["compare"] is False and p["encode"]["maxMb"] <= 500, pid


def test_check_spec_says_what_breaks_the_preset():
    assert product.check_spec("appstore-iphone", 24.0, 30, 886, 1920) == []
    problems = product.check_spec("appstore-iphone", 31.2, 60, 1080, 1920)
    assert len(problems) == 3
    assert "15-30 s" in problems[0] and "31.2" in problems[0]
    assert "at most 30" in problems[1] and "886x1920" in problems[2]
    assert product.check_spec("social-1x1", 5.0, 30, 1080, 1080)[0].startswith("Social 1:1")
    with pytest.raises(product.KitError):
        product.check_spec("tiktok-8k", 10, 30, 1, 1)


def _probe(**over):
    v = {"codec_type": "video", "codec_name": "h264", "profile": "High", "level": 40, "pix_fmt": "yuv420p", "width": 886, "height": 1920,
         "avg_frame_rate": "30/1", "duration": "24.000"}
    a = {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000", "bit_rate": "253141"}
    v.update(over.pop("v", {}))
    a.update(over.pop("a", {}))
    streams = [v] + ([] if over.pop("no_audio", False) else [a])
    return {"streams": streams, "format": {"duration": "24.021"}}


def test_the_rendered_file_is_checked_against_the_preset():
    assert product.verify_file("appstore-iphone", _probe(), 30 * 1024 * 1024) == []
    bad = product.verify_file("appstore-iphone", _probe(v={"level": 51, "pix_fmt": "yuv444p", "avg_frame_rate": "60/1", "profile": "High 4:4:4 Predictive"},
                                                     a={"channels": 1}), 600 * 1024 * 1024)
    text = " | ".join(bad)
    for words in ("level must be 4.0", "yuv420p", "30 fps", "High or lower", "stereo AAC", "at most 500 MB"):
        assert words in text, words
    assert "stereo sound track" in " ".join(product.verify_file("appstore-iphone", _probe(no_audio=True), 1))


def test_a_silent_track_below_apples_256_kbps_is_refused():
    # Digital silence: ffmpeg's aac wrote 2275 bit/s for -b:a 256k (27 Nov 2026), which Apple's 256 kbps AAC does not allow.
    for rate in ("2275", "0", None):
        problems = product.verify_file("appstore-iphone", _probe(a={"bit_rate": rate}), 1)
        assert any("256 kbps AAC" in p for p in problems), rate
    assert product.verify_file("appstore-iphone", _probe(a={"bit_rate": "240000"}), 1) == []  # inside the encoder's own rate control


def test_the_encoder_is_told_the_presets_spec():
    args = product.encode_args("appstore-iphone", Path("in.mp4"), Path("s.wav"), Path("out.mp4"), 24.0)
    joined = " ".join(args)
    # Constrained CBR at 11 Mbps (product_encoding): target = min = max with x264's filler, so still screens keep the rate.
    for part in ("-profile:v high", "-level:v 4.0", "-r 30", "scale=886:1920", "format=yuv420p", "-b:v 11000k", "-minrate 11000k", "-maxrate 11000k",
                 "-bufsize 11000k", "nal-hrd=cbr", "-ac 2", "-b:a 256k", "-aac_is 0", "-aac_ms 0", "-ar 48000", "-map_metadata -1", "+faststart", "-t 24.000"):
        assert part in joined, part


def test_the_quiet_bed_is_stereo_long_enough_and_one_step_of_dither(tmp_path):
    f = tmp_path / "s.wav"
    product._silence(f, 2.5, 48000)
    with wave.open(str(f)) as w:
        assert w.getnchannels() == 2 and w.getframerate() == 48000 and w.getnframes() >= int(2.5 * 48000)
        raw = w.readframes(w.getnframes())
    samples = struct.unpack(f"<{len(raw) // 2}h", raw)
    assert set(samples) == {-1, 0, 1}  # never louder than one 16-bit step (about -90 dBFS), and never all zero
    left, right = samples[0::2], samples[1::2]
    assert left != right  # each channel its own, so the encoder cannot fold them into one
    g = tmp_path / "t.wav"
    product._silence(g, 2.5, 48000)
    assert g.read_bytes() == f.read_bytes()  # seeded: the same plan gives the same bytes


# ---------- the timeline ----------

def _shot(sid, w=1179, h=2556, device="phone", before=True, surface=None, vw=393, vh=852):
    pic = lambda side: {"file": f"s-{sid}-{side}.png", "thumb": f"s-{sid}-{side}.thumb.jpg", "width": w, "height": h}
    return {"id": sid, "surface": surface or sid.title(), "viewport": {"width": vw, "height": vh, "device": device, "platform": "ios"},
            "after": pic("after"), "before": pic("before") if before else None, "caption": "", "focus": {"x": 0.5, "y": 0.35}}


def _kit(screens, recordings=(), changelog=(), **brand):
    return {"name": "demo", "app": {"name": "Demo", "tagline": "", "host": "", "stores": ["app-store", "google-play"]}, "release": {"version": "2.0"},
            "brand": {"colors": brand.get("colors", {}), "font": {"family": "", "file": None}, "logo": None, "cta": ""},
            "labels": {"before": "Before", "after": "Now", "news": "What's new"}, "screens": list(screens), "recordings": list(recordings),
            "changelog": [{"text": t, "surface": s} for t, s in changelog]}


def test_a_social_cut_has_a_title_reveals_cards_and_an_end():
    kit = _kit([_shot("home"), _shot("search", before=False), _shot("web", 2880, 1800, "desktop", before=False, vw=1440, vh=900)],
               changelog=[("A calmer home", "Home"), ("Faster search", ""), ("Widgets", ""), ("Dark mode", "")])
    pl = product.plan(kit, "social-9x16")
    assert pl["preset"]["width"] == 1080 and pl["title"]["from"] == 0
    assert [s["kind"] for s in pl["scenes"]] == ["compare", "screen", "screen"]
    assert pl["scenes"][0]["caption"] == "A calmer home"  # its surface's line first
    assert pl["scenes"][1]["caption"] == "Faster search"  # then the next unused line
    assert pl["news"]["lines"] == ["Dark mode"] and pl["end"]["kind"] == "card"
    assert pl["scenes"][0]["before"].endswith("s-home-before.png") and pl["scenes"][0]["src"].startswith("product-kits/demo/files/")
    # Each scene starts one overlap before the last one ends; the video ends with the end card.
    ov = pl["overlap"]
    seq = [pl["title"]] + pl["scenes"] + [pl["news"], pl["end"]]
    for a, b in zip(seq, seq[1:]):
        assert b["from"] == a["from"] + a["dur"] - ov
    assert pl["durationInFrames"] == pl["end"]["from"] + pl["end"]["dur"]
    assert 6 <= pl["seconds"] <= 60 and pl["seconds"] >= 20 - 0.1  # held toward the 20 s target


def test_an_app_store_preview_shows_only_the_app_itself():
    kit = _kit([_shot("home"), _shot("web", 2880, 1800, "desktop", vw=1440, vh=900), _shot("ipad", 2048, 2732, "tablet", vw=1024, vh=1366)],
               changelog=[("A calmer home", "Home"), ("Faster search", "")])
    pl = product.plan(kit, "appstore-iphone")
    assert pl["title"] is None and pl["news"] is None and pl["end"]["kind"] == "overlay"
    assert [s["id"] for s in pl["scenes"]] == ["home"] and pl["scenes"][0]["kind"] == "screen" and pl["scenes"][0]["before"] is None
    assert 15 <= pl["seconds"] <= 30
    assert any("web" in w and "ipad" in w for w in pl["warnings"])
    assert any("2.3.4" in w for w in pl["warnings"])  # the leftover line stays out, and says why


def test_a_kit_with_nothing_of_the_right_shape_says_what_it_needs():
    kit = _kit([_shot("web", 2880, 1800, "desktop", vw=1440, vh=900)])
    with pytest.raises(product.KitError) as e:
        product.plan(kit, "appstore-iphone")
    assert e.value.code == "no_fit" and "phone" in str(e.value) and "886x1920" in str(e.value) and "web" in str(e.value)


def test_a_long_kit_leaves_out_its_last_screens_and_a_short_one_holds_longer():
    many = _kit([_shot(f"s{i}") for i in range(12)])
    pl = product.plan(many, "appstore-iphone")
    assert pl["seconds"] <= 30 and len(pl["scenes"]) < 12
    assert any("left out" in w for w in pl["warnings"])
    one = product.plan(_kit([_shot("only", before=False)]), "appstore-iphone")
    assert one["seconds"] >= 15 and product.check_spec("appstore-iphone", one["seconds"], 30, 886, 1920) == []


def test_a_recording_follows_its_surface_and_holds_its_last_frame():
    rec = {"id": "flow", "surface": "Search", "viewport": {"width": 393, "height": 852, "device": "phone", "platform": ""},
           "file": {"file": "r-flow.mp4", "thumb": "r-flow.thumb.jpg", "width": 886, "height": 1920, "seconds": 1.2}, "caption": "Results as you type"}
    kit = _kit([_shot("home", surface="Home"), _shot("search", surface="Search", before=False), _shot("settings", surface="Settings")], recordings=[rec])
    pl = product.plan(kit, "social-1x1")
    assert [s["id"] for s in pl["scenes"]] == ["home", "search", "flow", "settings"]
    flow = pl["scenes"][2]
    assert flow["kind"] == "recording" and flow["clipFrames"] == 36 and flow["dur"] >= flow["clipFrames"]  # 2.5 s at least


def test_words_stay_readable_on_the_brands_colours():
    pal = product.palette(_kit([], colors={"background": "#ffffff", "text": "#f8f8f8", "accent": "#ffe600"}))
    assert pal["text"] == "#111111" and pal["onAccent"] == "#111111"
    pal = product.palette(_kit([], colors={"background": "#101010", "primary": "#3355ff"}))
    assert pal["accent"] == "#3355ff" and pal["text"] == "#f5f6f8"


def test_fonts_a_kit_file_a_bundled_face_or_the_default():
    k = _kit([])
    assert product.fonts(k, "b")[0] == "DM Sans"
    k["brand"]["font"] = {"family": "Jost", "file": None}
    fam, faces = product.fonts(k, "b")
    assert fam == "Jost" and faces[0]["src"] == "fonts/Jost.ttf"
    k["brand"]["font"] = {"family": "Inter", "file": {"file": "brand-font.woff2"}}
    fam, faces = product.fonts(k, "base")
    assert fam == product.KIT_FAMILY and faces[0]["src"] == "base/brand-font.woff2"  # the kit's name never reaches CSS
    for f in faces[1:]:
        assert (ROOT / "public" / f["src"]).is_file(), f["src"]
    for fam, files in product.BUNDLED.items():
        for file, _, _ in files:
            assert (ROOT / "public" / "fonts" / file).is_file(), f"{fam}: {file}"


# ---------- the command line and the optional reviewer ----------

def test_the_cli_answers_with_one_result_line(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
    product.main(["presets"])
    out = capsys.readouterr().out.strip().splitlines()[-1]
    assert out.startswith("RESULT ")
    r = json.loads(out[7:])
    assert r["ok"] and set(r["data"]["presets"]) == set(product.PRESETS)
    monkeypatch.setattr("sys.stdin", io.StringIO('{"slug": "pv-nothing--social-1x1"}'))
    product.main(["review"])
    r = json.loads(capsys.readouterr().out.strip().splitlines()[-1][7:])
    assert not r["ok"] and r["code"] == "not_rendered" and r["status"] == 409


def test_the_reviewer_is_priced_inside_the_ai_limits(home, monkeypatch):
    from studio import ai

    (home / "demo" / "renders").mkdir(parents=True)
    pl = product.plan(_kit([_shot("home")]), "social-9x16")
    (home / "demo" / "renders" / "social-9x16-props.json").write_text(json.dumps(pl), encoding="utf-8")
    (home / "demo" / "renders" / "social-9x16.mp4").write_bytes(b"\x00\x00\x00\x20ftypisom")
    (home / "demo" / "kit.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(ai, "review_basis", lambda: None)
    monkeypatch.setattr(ai, "model_prices", lambda model: {"prompt": 1e-6, "completion": 4e-6, "video": True})  # no price-list download
    e = product.estimate({"slug": "pv-demo--social-9x16", "tools": ["review"]})
    assert e["total"] > 0 and e["fits"] in (True, False) and "caps" in e
    with pytest.raises(product.KitError):
        product.estimate({"slug": "pv-demo--social-9x16", "tools": ["music"]})
    proj = product.review_project(pl)
    assert proj["shots"][0]["role"] == "title card" and proj["shots"][-1]["role"] == "end card"
    assert abs(sum(s["sec"] for s in proj["shots"]) - pl["seconds"]) < 3  # the scenes overlap, so a little longer than the video
    assert product.is_product("pv-demo--social-9x16") and not product.is_product("pv-other--social-9x16")
    shutil.rmtree(home)


# ---------- a kit over https (the release-kit link path), with the network faked ----------

def test_an_https_kit_resolves_relative_files_and_never_stores_the_token(tmp_path, home, monkeypatch):
    d = _kit_folder(tmp_path)
    fetched = []

    def fake_download(url, limit, what):
        fetched.append(url)
        name = url.split("?")[0].rsplit("/", 1)[-1]
        return (d / name).read_bytes()

    monkeypatch.setattr(product, "_download", fake_download)
    view = product.fetch({"kitUrl": "https://kits.example/apps/qn/1.4.0/manifest.json?token=SECRET"}, say=lambda *a, **k: None)
    assert fetched[0] == "https://kits.example/apps/qn/1.4.0/manifest.json?token=SECRET"
    assert "https://kits.example/apps/qn/1.4.0/home-after.png" in fetched  # relative to the manifest, its query not inherited
    stored = (home / view["name"] / "kit.json").read_text(encoding="utf-8")
    assert "SECRET" not in stored and json.loads(stored)["source"]["from"] == "https://kits.example/apps/qn/1.4.0/manifest.json"


def test_a_second_kit_of_the_same_name_drops_the_old_renders(tmp_path, home):
    d = _kit_folder(tmp_path)
    product.fetch({"kitPath": str(d), "name": "qn"}, say=lambda *a, **k: None)
    (home / "qn" / "renders").mkdir()
    (home / "qn" / "renders" / "social-1x1.json").write_text("{}", encoding="utf-8")
    view = product.fetch({"kitPath": str(d), "name": "qn"}, say=lambda *a, **k: None)
    assert view["renders"] == {} and not (home / "qn" / "renders").exists()


def test_a_redirect_to_this_computer_is_refused():
    import urllib.request

    req = urllib.request.Request("https://kits.example/m.json")
    with pytest.raises(product.KitError) as e:
        product._Hop().redirect_request(req, None, 302, "Found", {}, "https://127.0.0.1/admin")
    assert e.value.code == "bad_url"
