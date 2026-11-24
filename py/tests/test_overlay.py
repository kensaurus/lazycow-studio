"""The ranch overlay (BL-117): the ranch workspace's own words live in shared/ranch/*.json, never in public code. The
ranch reads them exactly as before; any other project, run as its own process, gets none of them from any path that
used to carry them (themes, house posts, research briefs and searches, engage topics, playlists, brand, reviewer and
tagger briefs, line-writer brief, calendar and file names)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from studio import config

# One neutral process prints what every moved path gives a project that is not the ranch.
NEUTRAL = r"""
import json
from studio import ai, assemble, brand, config, engage, posting, reels, research, tag, wording, youtube
assemble.load_themes()
reel = {"slug": "lunch-1124", "title_ja": "静かだからこそ、よく話せる。", "yt_title": "静かだからこそ、よく話せる。",
        "tags": ["#lunch"], "posts": {"ja": "静かだからこそ、よく話せる。", "en": "Quiet, so you can talk."}, "beats": []}
out = {
    "ranch": [config.RANCH, brand.RANCH],
    "themes": [assemble.THEMES, assemble.RANCH_THEMES, assemble.TAG_POOL, assemble.VENUE_SLOTS, assemble.VENUE_LINES,
               assemble.CHARTER_LINE, assemble.EVENT_CAP_LINE],
    "posts": [reels.POSTS, reels.SHORT, reels.SITE, reels.ZH_TAGS, reels.SEARCH_WORDS_JA, list(reels.YT_SEARCH_TAGS),
              reels.YT_QUESTION, reels.file_prefix(), str(reels.DRAFTS), [reels._post_text(reel, c) for c in reels.CHANNELS]],
    "brand": [brand.brand(), brand.home_place(), brand.copy_rules(), brand.end_card()],
    "research": [research.default_topic(), research.angle_system(), research.SITE_DEFAULT, research.PLACES,
                 research.OWN_NAMES.pattern, research.site_url(), [t for _, t in research.approved_copy()]],
    "engage": [engage.TOPICS, list(engage.NICHE), engage._own_topics()],
    "youtube": [youtube.PLAYLISTS],
    "briefs": [ai._review_system(), tag.prompt(), wording.SUGGEST_SYSTEM, wording.suggest_system(), wording.SITE_LINES],
    "files": [config.STUDIO_NAME, str(config.READY)],
}
print(json.dumps(out, ensure_ascii=False))
"""


def _neutral(tmp_path) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("STUDIO_PROJECTS", "STUDIO_WORDS", "STUDIO_READY", "STUDIO_DRAFTS")}
    # A project named in its own env (as a second project is: STUDIO_WORKSPACE), never the .env of this checkout.
    env.update({"STUDIO_RANCH": "0", "STUDIO_DATA": str(tmp_path), "STUDIO_WORKSPACE": "Cafe Kumo", "PYTHONIOENCODING": "utf-8"})
    out = subprocess.run([sys.executable, "-c", NEUTRAL], cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True,
                         text=True, encoding="utf-8", timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_a_project_that_is_not_the_ranch_gets_no_ranch_words_from_any_moved_path(tmp_path, ranch_words):
    got = _neutral(tmp_path)
    assert got["ranch"] == [False, False]
    assert got["themes"][:5] == [{}, {}, [], [], []] and got["themes"][5:] == ["", ""]
    assert got["posts"][:7] == [{}, {}, "", "", "", [], ""] and got["engage"][:2] == [[], []] and got["youtube"] == [[]]
    assert got["research"][1].startswith("You suggest social video post angles for Cafe Kumo.")
    assert got["briefs"][2] == "" and got["briefs"][4] == [] and got["files"][0] == "Lazycow Studio"
    for part, value in got.items():
        text = json.dumps(value, ensure_ascii=False)
        for word in ranch_words:  # the overlay's markers (empty in a public clone, which has no ranch words at all)
            assert word not in text, (part, word)


def test_without_the_overlay_the_ranch_flag_alone_brings_no_ranch_words(monkeypatch):
    """A clone run with STUDIO_RANCH=1 (as the tests are) has no overlay: every ranch path falls back to neutral."""
    from studio import brand

    monkeypatch.setattr(brand, "RANCH_BRAND", {})
    monkeypatch.setattr(brand, "RANCH", True)
    assert brand.brand()["ranch"] is False and brand.home_place() is None
    assert brand.copy_rules() == {"banned": [], "noPrices": False, "registered": None, "bare": None}
    assert config.ranch_data("no-such-file", {"x": 1}) == {"x": 1}


@pytest.mark.ranch
def test_the_ranch_reads_its_words_from_its_overlay_exactly():
    from studio import assemble, brand, reels, research, wording, youtube

    themes = config.ranch_data("themes")["themes"]
    copy = config.ranch_data("copy")
    assert list(assemble.RANCH_THEMES) == list(themes)
    assert all(isinstance(b, tuple) for t in assemble.RANCH_THEMES.values() for b in t["beats"])
    assert {k: {**t, "beats": [list(b) for b in t["beats"]]} for k, t in assemble.RANCH_THEMES.items()} == themes
    assert reels.POSTS == copy["reels"]["posts"] and reels.SHORT == copy["reels"]["short"]
    assert youtube.PLAYLISTS == copy["youtube"]["playlists"] and wording.SITE_LINES == copy["wording"]["siteLines"]
    assert research.angle_system() == research.ANGLE_SYSTEM and copy["research"]["angleWho"] in research.ANGLE_SYSTEM
    b = config.RANCH_BRAND
    assert brand.brand() == {"name": b["name"], "nameEn": b["nameEn"], "link": b["link"], "tags": b["tags"], "handle": b["handle"],
                             "ranch": True}
    assert config.SPEC["ranch"] == b["place"] and config.SPEC["bannedSubstrings"] == b["bannedSubstrings"]
    assert brand.copy_rules()["registered"] == b["registered"] and brand.copy_rules()["bare"] == b["bareWord"]


@pytest.mark.ranch
def test_no_public_file_names_the_ranch():
    """Belt and braces for the export's forbid rules: the overlay's own name and handle appear in no public code file."""
    b = config.RANCH_BRAND
    words = [b["name"], b["nameEn"], b["handle"], b["tags"][0], b["filePrefix"] + "_"]
    for folder in ("py/studio", "server", "shared", "src"):
        for f in (config.ROOT / folder).rglob("*"):
            if not f.is_file() or f.suffix not in (".py", ".mjs", ".ts", ".tsx", ".json", ".html", ".js", ".css") or "ranch" in f.parts:
                continue
            if f.name in ("reel_specs.py", "reels.json", "words.json", "post-templates-ranch.json", "channels.json") or "profiles" in f.parts:
                continue  # the overlay's own files, and the owner's channels.json (the export ships the public copy)
            text = f.read_text(encoding="utf-8", errors="ignore")
            assert not [w for w in words if w in text], f
