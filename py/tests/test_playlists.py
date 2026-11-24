"""Playlists: a reel goes by its theme, any other video by the words in its title; both languages count.
The ranch workspace's own playlists are checked in test_ranch_playlists.py."""
from studio import posting, youtube
from studio.youtube import PLAYLISTS, playlist_keys

CAFE_PLAYLISTS = [
    {"key": "lunch", "title": "お昼 | Lunch", "themes": ["warm"], "words": ["lunch", "お昼", "ランチ"]},
    {"key": "rain", "title": "雨の日 | Rainy days", "themes": [], "words": ["rain", "雨"]},
]


def test_every_playlist_title_is_bilingual():
    for p in PLAYLISTS:
        ja, en = p["title"].split(" | ")
        assert ja and en and not ja.isascii() and en.isascii()


def test_theme_first_then_title_words_for_any_workspace(monkeypatch):
    monkeypatch.setattr(youtube, "PLAYLISTS", CAFE_PLAYLISTS)
    assert playlist_keys("静かだからこそ、よく話せる。｜Cafe Kumo", "warm") == ["lunch"]
    assert playlist_keys("Rainy lunch at Cafe Kumo | 雨の日のランチ", None) == ["lunch", "rain"]
    assert playlist_keys("雨の朝", None) == ["rain"]
    assert playlist_keys("Cafe Kumo", None) == []


def test_not_to_be_posted_is_a_switch():
    posting.skip("skip-me", True)
    posting.skip("skip-me", True)
    rows = [p for p in posting.posts() if p["slug"] == "skip-me"]
    assert len(rows) == 1 and rows[0]["status"] == "skipped" and rows[0]["network"] == "all"
    posting.skip("skip-me", False)
    assert not [p for p in posting.posts() if p["slug"] == "skip-me"]
