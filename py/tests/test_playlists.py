"""Playlists: a reel goes by its theme, any other video by the words in its title; both languages count."""
from studio import posting
from studio.youtube import PLAYLISTS, playlist_keys


def test_every_playlist_title_is_bilingual():
    for p in PLAYLISTS:
        ja, en = p["title"].split(" | ")
        assert ja and en and not ja.isascii() and en.isascii()


def test_theme_first_then_title_words():
    assert playlist_keys("遠いからこそ、騒げる｜嬬恋牧場Work&Camp", "loud") == ["field"]
    assert playlist_keys("Autumn at 1,444 m: Tsumagoi Work&Camp from the air | 秋の嬬恋牧場Work&Camp 空撮", None) == ["aerial", "autumn"]
    assert playlist_keys("Lunch on the deck at 1,444 m | 標高1,444mのデッキでお昼のBBQ #shorts", None) == ["fire"]
    assert playlist_keys("雪の朝", None) == ["winter"]
    assert playlist_keys("Tsumagoi Work&Camp", None) == []


def test_not_to_be_posted_is_a_switch():
    posting.skip("skip-me", True)
    posting.skip("skip-me", True)
    rows = [p for p in posting.posts() if p["slug"] == "skip-me"]
    assert len(rows) == 1 and rows[0]["status"] == "skipped" and rows[0]["network"] == "all"
    posting.skip("skip-me", False)
    assert not [p for p in posting.posts() if p["slug"] == "skip-me"]
