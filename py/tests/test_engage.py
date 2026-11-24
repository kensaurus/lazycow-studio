"""Reply to these today (studio.engage, BL-100): filtering and ranking of Bluesky search answers from a made-up fixture
(tests/fixtures/bluesky_search.json), and one refresh against a fake HTTP layer: the public host's 403 moves the reads
to the signed-in account's server, every request is a GET, the answer is cached for an hour, and a failed refresh
returns the last list marked stale. No network."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from studio import engage

NOW = datetime(2026, 11, 24, 9, 0, tzinfo=timezone.utc)
FIX = json.loads((Path(__file__).parent / "fixtures" / "bluesky_search.json").read_text(encoding="utf-8"))
OWN = {"did:plc:own"}
# A made-up camping niche for the fixture's posts (a project's own niche; the ranch workspace's is in its overlay and
# is empty in a public clone).
NICHE = ("キャンプ", "テント", "タープ", "焚き火", "焚火", "薪", "寝袋", "シュラフ", "車中泊", "デイキャンプ", "ソロ", "野営",
         "星空", "星", "夜空", "天の川", "流れ星", "冬", "雪", "霜", "氷点下", "寒", "山", "登山", "高原", "紅葉", "冠雪",
         "ワーケーション", "リモートワーク", "テレワーク", "在宅", "温泉", "ドライブ", "ツーリング", "アウトドア", "ギア", "ランタン",
         "コーヒー", "景色", "絶景", "草原", "キャンプ飯", "焼き芋", "朝焼け", "夕焼け", "湯たんぽ", "℃", "道具", "設営", "撤収",
         "サイト", "森", "湖", "自然", "釣り", "サウナ", "BBQ", "バーベキュー", "ハンモック")


@pytest.fixture(autouse=True)
def _camp_niche(monkeypatch):
    monkeypatch.setattr(engage, "NICHE", NICHE)


def _profiles():
    return {p["did"]: p for p in FIX["profiles"]["profiles"]}


def test_candidates_drop_what_is_not_worth_a_reply_and_merge_topics():
    cands, skipped = engage.candidates(FIX["search"], NOW, OWN)
    by = {c["uri"].rsplit("/", 1)[1]: c for c in cands}
    assert skipped == {"own": 1, "reply": 3, "ad": 1, "lang": 1, "old": 1, "notext": 1, "label": 1, "closed": 1,
                       "offtopic": 1, "feed": 1}
    # the same post found by two topics is one entry with both
    assert by["3aaa1"]["topics"] == ["キャンプ", "焚き火"]
    # replies, posts aimed at one person and closed threads stay only as follow suggestions
    assert by["3rrr1"]["replyable"] is False and by["3cle1"]["replyable"] is False and by["3mia1"]["replyable"] is False
    assert by["3aaa1"]["replyable"] is True
    # own, an ad, English, three days old, only tags and a link, a labelled post, an AI drawing, an announcement
    for gone in ("3own1", "3sss1", "3eee1", "3ooo1", "3ttt1", "3lll1", "3art1", "3nnn1"):
        assert gone not in by
    # "hide me from logged-out viewers" is not a reason to drop someone: the owner reads signed in
    assert by["3bea1"]["replyable"] is True
    # relevance: the niche's words in the text (高原, テント, 氷点下, 星)
    assert by["3aaa1"]["niche"] == 4 and by["3aaa1"]["link"] is False
    # a post without a language tag still counts when the text is Japanese
    assert "3ddd1" in by
    a = by["3aaa1"]
    assert a["url"] == "https://bsky.app/profile/alice.example.com/post/3aaa1"
    assert a["ageH"] == 5.0 and a["likes"] == 3 and a["replies"] == 1 and a["followers"] is None


def test_rank_one_post_per_author_in_the_follower_band_small_conversations_first():
    cands, _ = engage.candidates(FIX["search"], NOW, OWN)
    out = engage.rank(cands, _profiles())
    handles = [p["handle"] for p in out["posts"]]
    assert handles == ["alice.example.com", "dan.example.com", "crowd.example.com", "bea.example.com"]
    assert [p["uri"] for p in out["posts"] if p["handle"] == "alice.example.com"] == ["at://did:plc:alice/app.bsky.feed.post/3aaa1"]
    # 20,000 and 3 followers are outside 10-5,000; a news feed is not a person
    assert not {"big.example.com", "tiny.example.com", "campnews.example.com"} & set(handles)
    assert out["posts"][0]["followers"] == 240 and "replyable" not in out["posts"][0]
    # follow: real people in the niche not already in the reply list and not already followed (fred is); cleo's one
    # passing mention of a topic word is not enough, rita's reply and profile (冬, キャンプ, コーヒー) are
    assert [a["handle"] for a in out["follow"]] == ["rita.example.com"]
    assert out["follow"][0]["url"] == "https://bsky.app/profile/rita.example.com" and out["follow"][0]["followers"] == 610


def test_niche_words_outrank_likes():
    base = {"likes": 0, "replies": 0, "reposts": 0, "quotes": 0, "topics": ["キャンプ"], "ageH": 5.0, "followers": 200}
    popular_drawing = {**base, "likes": 200, "niche": 1}
    first_tent_night = {**base, "likes": 3, "niche": 3}
    assert engage.score(first_tent_night) > engage.score(popular_drawing)
    assert engage.score({**first_tent_night, "link": True}) < engage.score(first_tent_night)
    assert engage.score({**first_tent_night, "replies": 30}) < engage.score(first_tent_night)


def test_rank_caps_and_keeps_posts_when_profiles_could_not_be_read():
    cands, _ = engage.candidates(FIX["search"], NOW, OWN)
    out = engage.rank(cands, {}, reply_n=3)
    assert len(out["posts"]) == 3 and all(p["followers"] is None for p in out["posts"])
    assert out["follow"] == []


def test_profiles_are_read_for_the_best_authors_only():
    cands, _ = engage.candidates(FIX["search"], NOW, OWN)
    dids = engage.authors_to_look_up(cands, n=3)
    assert len(dids) == 3 and len(set(dids)) == 3
    assert "did:plc:rita" not in dids          # follow-only authors come after every reply target


def test_post_url_and_excerpt():
    assert engage.post_url("at://did:plc:x/app.bsky.feed.post/3abc", "") == "https://bsky.app/profile/did:plc:x/post/3abc"
    assert engage.post_url("not a uri", "a.b") == ""
    assert engage.excerpt("a  b\n c") == "a b c"
    assert engage.excerpt("あ" * 200, 10) == "あ" * 9 + "…"


class FakeNet:
    def __init__(self, public_status=403):
        self.public_status = public_status
        self.calls = []

    def public(self, method, url, *, headers=None, timeout=20):
        self.calls.append(("public", method, url, headers))
        return self.public_status, {}, b'{"error":"Forbidden"}'

    def session(self, method, url, *, data=None, headers=None, timeout=20):
        self.calls.append(("session", method, url, headers))
        if "searchPosts" in url:
            q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))
            from urllib.parse import unquote_plus
            body = FIX["search"].get(unquote_plus(q["q"]), {"posts": []})
        else:
            body = FIX["profiles"]
        return 200, {}, json.dumps(body, ensure_ascii=False).encode("utf-8")


@pytest.fixture
def net(monkeypatch, tmp_path):
    n = FakeNet()
    monkeypatch.setattr(engage, "_http", n.public)
    monkeypatch.setattr(engage, "_account", lambda: ("did:plc:own", "https://pds.example.com", "ranch.example.com", n.session))
    monkeypatch.setattr(engage, "_own_handle", lambda: "ranch.example.com")
    monkeypatch.setattr(engage, "_cache_file", lambda: tmp_path / "engage" / "bluesky.json")
    monkeypatch.setattr(engage, "PAUSE", 0)
    monkeypatch.setattr(engage, "TOPICS", ["キャンプ", "焚き火"])
    real = engage.gather
    monkeypatch.setattr(engage, "gather", lambda: real(now=NOW))
    return n


def test_refresh_falls_back_to_the_session_reads_only_and_caches(net, tmp_path):
    d = engage.bluesky({"fresh": True})
    assert d["via"] == "session" and d["cached"] is False and d["account"] == "@ranch.example.com"
    assert [p["handle"] for p in d["posts"]][:2] == ["alice.example.com", "dan.example.com"]
    assert d["searched"] == 2 and d["requests"] == len(net.calls) == 4   # one public probe, two searches, one profile read
    assert all(c[1] == "GET" for c in net.calls)
    assert all(c[3]["user-agent"] == "LazycowStudio" for c in net.calls)
    first, *rest = net.calls
    assert first[0] == "public" and "public.api.bsky.app" in first[2] and "lang=ja" in first[2] and "since=" in first[2]
    assert all(c[0] == "session" and c[2].startswith("https://pds.example.com/xrpc/") and c[3]["atproto-proxy"] for c in rest)
    assert (tmp_path / "engage" / "bluesky.json").exists()
    again = engage.bluesky({})
    assert again["cached"] is True and len(net.calls) == 4        # the hour's list, no request


def test_not_connected_says_connect(net, monkeypatch):
    monkeypatch.setattr(engage, "_account", lambda: None)
    with pytest.raises(engage.EngageError) as err:
        engage.bluesky({"fresh": True})
    assert err.value.code == "connect" and err.value.status == 409


def test_a_failed_refresh_returns_the_last_list_marked_stale(net, monkeypatch):
    engage.bluesky({"fresh": True})
    monkeypatch.setattr(engage, "_account", lambda: None)
    d = engage.bluesky({"fresh": True})
    assert d["stale"] is True and d["code"] == "connect" and d["posts"]


def test_cli_prints_one_result_line(net, capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO('{"fresh": true}'))
    assert engage.main(["bluesky"]) == 0
    line = capsys.readouterr().out.strip().splitlines()[-1]
    assert line.startswith("RESULT ") and json.loads(line[7:])["ok"] is True
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))
    engage.main(["post"])
    bad = json.loads(capsys.readouterr().out.strip().splitlines()[-1][7:])
    assert bad == {"ok": False, "error": "unknown engage action post", "code": "bad_input", "status": 400}
