"""Per-network cuts and texts: the long explainer's length and words, which channels get which cut,
and each network's own post text (docs/research/2026-11-08-networks-variants.md)."""
import os

os.environ.setdefault("STUDIO_DATA", os.environ.get("STUDIO_DATA", str(__import__("pathlib").Path(__import__("tempfile").gettempdir()) / "studio-test-data")))

import pytest  # noqa: E402

from studio.assemble import LONG_RHYTHM, THEMES, long_theme
from studio.guard import assert_copy
from studio.reels import CHANNELS, LENGTH_RULE, _post_text, check_reel, wants


def test_long_theme_fills_every_slot_and_passes_the_copy_guard():
    for key, theme in THEMES.items():
        lt = long_theme(theme)
        assert len(lt["slots"]) == len(LONG_RHYTHM), key
        assert sum(LONG_RHYTHM) >= 40
        assert 4 <= len(lt["beats"]) <= 8, key
        assert lt["cues"] == []  # lines are spread evenly over the longer cut
        for _, ja, en in lt["beats"]:
            assert_copy(ja)
            assert_copy(en)


def test_long_cut_goes_only_to_explainer_channels():
    reel = {"slug": "x", "variant": "b-explainer", "shots": [{"sec": 3.0}] * 14}
    got = sorted(c for c, spec in CHANNELS.items() if wants(reel, spec))
    assert got == sorted(c for c, spec in CHANNELS.items() if spec.get("variant") == "b-explainer" and not spec.get("off"))
    assert "tiktok" not in got and "linkedin" in got


def test_short_cut_skips_channels_switched_off_or_too_short():
    reel = {"slug": "x", "shots": [{"sec": 1.5}] * 10}
    assert not wants(reel, CHANNELS["instagram"])  # "off": the owner does not post there
    assert wants(reel, CHANNELS["tiktok"])
    long_reel = {"slug": "x", "shots": [{"sec": 4.0}] * 9}  # 36 s: too long for Google Maps (30 s)
    assert not wants(long_reel, CHANNELS["gbp"])


def test_length_rule_depends_on_the_cut():
    assert LENGTH_RULE[None] == (8, 25)
    assert LENGTH_RULE["b-explainer"] == (30, 60)
    beats = [{"kind": "hook", "ja": "a", "en": "a", "startSec": 0.1, "endSec": 3.0}, {"kind": "end", "ja": "b", "en": "b", "startSec": 3.0, "endSec": 40.0}]
    shots = [{"src": f"a{i}.mp4", "sec": 4.0} for i in range(10)]
    assert not any("length" in p for p in check_reel({"slug": "l", "variant": "b-explainer", "shots": shots, "beats": beats}))
    assert any("length" in p for p in check_reel({"slug": "s", "shots": shots, "beats": beats}))


REEL = {"slug": "unit-variants", "tags": ["#a", "#b", "#c", "#d", "#e", "#f"], "yt_title": "t", "title_ja": "t",
        "posts": {"ja": "日本語の文。", "en": "English.", "price_ja": "料金。", "path": "reserve", "linkedin": "L"}}

# The per-network texts below are the ranch's own (its overlay's words: search line, link, taglines); a project made in
# the studio gets its own texts (studio.reels._own_post_text, test_brand.py).


@pytest.mark.ranch
def test_threads_ends_on_a_question_and_moves_the_link_to_the_first_reply():
    text = _post_text(REEL, "threads")
    head, _, reply = text.partition("最初の返信")
    assert "？" in head and "https://" not in head
    assert "utm_source=threads" in reply


def test_facebook_has_no_link_and_at_most_five_hashtags():
    text = _post_text(REEL, "facebook")
    assert "https://" not in text
    assert text.count("#") <= 5


@pytest.mark.ranch
def test_tiktok_sends_people_to_search_not_a_bio_link():
    text = _post_text(REEL, "tiktok")
    assert "プロフィールのリンク" not in text and "検索" in text


@pytest.mark.ranch
def test_tiktok_caption_is_short_japanese_with_no_price_list():
    """16 Nov: every TikTok post sat at 0 views with ~400-character captions (JA + EN + prices) that read like ads;
    the playbook's own ideal is about 150 characters."""
    text = _post_text(REEL, "tiktok")
    assert REEL["posts"]["price_ja"] not in text and REEL["posts"]["en"] not in text
    assert text.startswith(REEL["posts"]["ja"].split("\n")[0])
    assert len(text) <= 220, len(text)


@pytest.mark.ranch
def test_new_networks_have_their_own_text():
    assert "utm_source=gbp" in _post_text(REEL, "gbp")
    assert "utm_source=line-voom" in _post_text(REEL, "line-voom")


def test_a_borrowed_theme_gets_its_own_linkedin_text():
    from studio.assemble import posts_for

    for key, theme in THEMES.items():
        if theme.get("posts") or not theme.get("post") or "linkedin" in theme["post"]:
            continue
        li = posts_for(theme)["linkedin"]
        assert li.startswith(theme["post"]["ja"]), key  # not the house reel it borrowed from
        assert "¥120,000" in li.split("\n\n")[0], key  # the numbers in the first lines


def test_link_can_be_added_after_posting():
    from studio import posting

    pid = posting.plan("unit-link", "youtube", "2026-11-20T19:00+09:00")
    posting.done(pid, "")
    posting.link(pid, "https://youtube.com/shorts/abc")
    row = next(p for p in posting.posts() if p["id"] == pid)
    assert row["status"] == "posted" and row["url"] == "https://youtube.com/shorts/abc"
    import pytest
    with pytest.raises(ValueError):
        posting.link(pid, "http://not-https")


@pytest.mark.ranch
def test_a_long_xiaohongshu_title_is_flagged():
    long = {**REEL, "posts": {**REEL["posts"], "zh": "正因为没有划分营位，可以在喜欢的地方搭帐篷。\n正文"}}
    assert "20字以内" in _post_text(long, "xiaohongshu")
    short = {**REEL, "posts": {**REEL["posts"], "zh": "海拔1444米的营地\n正文"}}
    assert "20字以内" not in _post_text(short, "xiaohongshu")


def test_x_length_counts_cjk_as_two_and_a_url_as_23():
    from studio.reels import x_length

    assert x_length("abc") == 3
    assert x_length("雲上") == 4
    assert x_length("見て https://cafe-kumo.example/reserve?utm_source=x&utm_medium=social") == 4 + 1 + 23
    assert x_length("“quote” — ok…") == 13 - 1 + 2  # curly quotes and the em dash are 1; the ellipsis is 2
