"""Results › Comments: read, sorted, answered only from the owner's own words (studio.comments)."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from studio import comments as c


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "STORE", tmp_path / "comments.json")
    monkeypatch.setattr(c, "ANSWERS", tmp_path / "answers.json")
    monkeypatch.setattr(c, "_booking", lambda: "https://example.test/reserve")
    monkeypatch.setattr(c, "seed_answers", lambda: {"topics": {k: {"ja": "", "en": "", "saved": False} for k in c.TOPIC_ORDER},
                                                    "link": "https://example.test/reserve"})
    yield


def _answers(**topics):
    a = c.seed_answers()
    for k, (ja, en, saved) in topics.items():
        a["topics"][k] = {"ja": ja, "en": en, "saved": saved}
    c.ANSWERS.write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
    return a


def test_classify_reads_questions_praise_spam_and_reactions():
    q = c.classify("1泊いくらですか？")
    assert q["kind"] == "question" and q["topics"] == ["price"] and q["lang"] == "ja"
    e = c.classify("Is there wifi? I need to work")
    assert e["kind"] == "question" and "work" in e["topics"] and e["lang"] == "en"
    assert c.classify("景色が最高！行きたい")["kind"] == "praise"
    assert c.classify("Great video! check my channel www.spam.example")["kind"] == "spam"
    assert c.classify("Earn with crypto, message me on telegram")["kind"] == "spam"
    assert c.classify("😍😍🔥")["kind"] == "reaction"


def test_a_draft_is_only_the_owners_answers_and_the_link():
    ans = _answers(price=("フィールドだけ：大人1人目¥4,400。", "Field only: ¥4,400 for the first adult.", True))
    d = c.draft({"kind": "question", "topics": ["price"], "lang": "ja"}, ans)
    assert d["text"] == "フィールドだけ：大人1人目¥4,400。\nhttps://example.test/reserve" and d["auto"] is True
    en = c.draft({"kind": "question", "topics": ["price"], "lang": "en"}, ans)
    assert en["text"].startswith("Field only") and en["text"].endswith("https://example.test/reserve")
    # praise and comments on no topic get nothing: no canned thanks
    assert c.draft({"kind": "praise", "topics": [], "lang": "ja"}, ans)["text"] == ""
    # a topic with no answer: nothing to send, and it says which answer is missing
    none = c.draft({"kind": "question", "topics": ["pets"], "lang": "ja"}, ans)
    assert none["text"] == "" and none["missing"] == ["pets"]


def test_an_answer_the_owner_never_saved_is_drafted_but_never_sent_by_itself():
    ans = _answers(work=("100Mbpsの光回線。", "Fibre, 100 Mbps.", False))
    d = c.draft({"kind": "question", "topics": ["work"], "lang": "ja"}, ans)
    assert d["text"] == "100Mbpsの光回線。" and d["auto"] is False


def _item(**kw):
    at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    return {"id": "youtube:1", "network": "youtube", "native": "1", "author": "A", "text": "Wi-Fiはありますか？", "at": at,
            "kind": "question", "topics": ["work"], "lang": "ja", "canReply": True, **kw}


def test_auto_answer_rules():
    data = c._load()
    ok = {"text": "100Mbpsの光回線。", "auto": True}
    assert c.auto_ok(_item(), ok, data) is None
    assert c.auto_ok(_item(at=datetime.now(timezone.utc).isoformat()), ok, data) == "too new"
    assert c.auto_ok(_item(at=(datetime.now(timezone.utc) - timedelta(days=5)).isoformat()), ok, data) == "too old"
    assert c.auto_ok(_item(kind="praise"), ok, data) == "not a question"
    assert c.auto_ok(_item(), {"text": "x", "auto": False}, data) == "no saved answer for this"
    assert c.auto_ok(_item(toUs=False), ok, data) == "a conversation between other people"
    assert c.auto_ok(_item(reply={"text": "x"}), ok, data) == "answered"
    now = datetime.now(timezone.utc).isoformat()
    data["sent"] = [{"at": now, "auto": True, "author": "A", "network": "youtube", "text": "other"}]
    assert c.auto_ok(_item(), ok, data) == "already answered this person today"
    data["sent"] = [{"at": now, "auto": True, "author": "B", "network": "youtube", "text": "100Mbpsの光回線。"}]
    assert c.auto_ok(_item(), ok, data) == "the same answer went out in the last day"
    data["sent"] = [{"at": now, "auto": True, "author": f"P{k}", "network": "x", "text": str(k)} for k in range(c.DEFAULT_CAP)]
    assert c.auto_ok(_item(), ok, data) == "today's limit"


def test_auto_answer_sends_once_and_records_it(monkeypatch):
    _answers(work=("100Mbpsの光回線。", "Fibre, 100 Mbps.", True))
    data = c._load()
    data["items"]["youtube:1"] = _item()
    data["settings"]["auto"] = True
    c._save(data)
    sent = []
    monkeypatch.setitem(c.REPLY, "youtube", lambda item, text: sent.append((item["native"], text)) or {"id": "r1"})
    assert [x["text"] for x in c.auto_answer()] == ["100Mbpsの光回線。"]
    assert c.auto_answer() == []  # never twice
    assert sent == [("1", "100Mbpsの光回線。")]
    v = c.view()
    assert v["items"][0]["state"] == "answered" and v["items"][0]["reply"]["auto"] is True and v["settings"]["sentToday"] == 1


def test_a_person_replies_once_and_a_spam_comment_stays_quiet(monkeypatch):
    data = c._load()
    data["items"]["youtube:1"] = _item()
    data["items"]["youtube:2"] = _item(id="youtube:2", native="2", kind="spam", text="www.spam.example")
    c._save(data)
    monkeypatch.setitem(c.REPLY, "youtube", lambda item, text: {"id": "r"})
    c.reply({"id": "youtube:1", "text": "あります。100Mbpsです。"})
    with pytest.raises(c.CommentsError):
        c.reply({"id": "youtube:1", "text": "again"})
    states = {x["id"]: x["state"] for x in c.view()["items"]}
    assert states == {"youtube:1": "answered", "youtube:2": "quiet"}


def test_bluesky_reply_points_at_the_thread_root_and_the_comment(monkeypatch):
    from studio.connectors import bluesky as b

    got = {}

    def call(method, url, data=None, headers=None):
        got["body"] = json.loads(data)
        return 200, {}, b'{"uri": "at://did:me/app.bsky.feed.post/r"}'

    monkeypatch.setattr(b, "account", lambda: ("did:me", "https://pds.example", "me.test", call))
    item = {"target": {"root": {"uri": "at://did:me/app.bsky.feed.post/root", "cid": "c0"}, "parent": {"uri": "at://did:x/app.bsky.feed.post/p", "cid": "c1"}}}
    assert c.bluesky_reply(item, "あります。")["id"].endswith("/r")
    rec = got["body"]["record"]
    assert rec["reply"] == item["target"] and rec["text"] == "あります。" and got["body"]["collection"] == "app.bsky.feed.post"


def test_bluesky_notifications_become_comments(monkeypatch):
    from studio.connectors import bluesky as b

    notes = {"notifications": [
        {"uri": "at://did:x/app.bsky.feed.post/1", "cid": "c1", "reason": "reply", "author": {"did": "did:x", "handle": "x.test"},
         "record": {"text": "Wi-Fiはありますか？", "createdAt": "2026-11-14T00:00:00Z",
                    "reply": {"root": {"uri": "at://did:me/app.bsky.feed.post/0", "cid": "c0"}, "parent": {"uri": "at://did:me/app.bsky.feed.post/0", "cid": "c0"}}}},
        {"uri": "at://did:me/app.bsky.feed.post/9", "cid": "c9", "reason": "reply", "author": {"did": "did:me"}, "record": {"text": "mine"}},
    ]}
    monkeypatch.setattr(b, "status", lambda: {"connected": True})
    monkeypatch.setattr(b, "account", lambda: ("did:me", "https://pds.example", "me.test", lambda *a, **k: (200, {}, json.dumps(notes).encode())))
    found, state = c.bluesky_fetch()
    assert state["ok"] and len(found) == 1
    f = found[0]
    assert f["target"]["root"]["uri"].endswith("/0") and f["target"]["parent"]["cid"] == "c1" and f["toUs"] is True
    assert f["url"] == "https://bsky.app/profile/x.test/post/1"


def test_settings_cap_is_checked():
    assert c.settings({"auto": True, "cap": 4})["settings"] == {"auto": True, "cap": 4, "sentToday": 0, "wait": c.AUTO_WAIT // 60}
    with pytest.raises(c.CommentsError):
        c.settings({"cap": 99})


def test_iso_durations_and_the_every_post_table(monkeypatch):
    from studio import perf, posting

    assert perf._iso_seconds("PT1M5S") == 65 and perf._iso_seconds("PT2H") == 7200 and perf._iso_seconds("P0D") == 0
    now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)
    monkeypatch.setattr(posting, "posts", lambda: [
        {"id": 1, "slug": "a", "network": "youtube", "status": "posted", "at": "2026-11-10T19:00+09:00", "url": "u1"},
        {"id": 2, "slug": "b", "network": "youtube", "status": "posted", "at": "2026-11-11T19:00+09:00", "url": "u2"},
        {"id": 3, "slug": "c", "network": "x", "status": "scheduled", "at": "2026-11-20T19:00+09:00"},
    ])
    monkeypatch.setattr(perf, "readings", lambda: [{"post_id": 1, "views": 50, "likes": 1, "extra": {}}, {"post_id": 2, "views": 900, "likes": 4, "extra": {"engaged_views": 80}}])
    t = perf.table(30, now=now)
    assert [r["slug"] for r in t["rows"]] == ["b", "a"] and t["rows"][0]["best"] and not t["rows"][1].get("best")
    assert t["rows"][0]["engaged"] == 80 and t["rows"][0]["reactions"] == 4


def test_youtube_sign_in_asks_for_the_comment_permission():
    from studio import youtube

    assert c.FORCE_SSL in youtube.SCOPES.split()  # commentThreads.list and comments.insert accept only youtube.force-ssl


def test_replaced_and_removed_posts_leave_the_results():
    """A series built again showed every episode three times (15 Nov): an older upload of the same video is
    "replaced", a video the channel no longer lists is "removed", and one uploaded after the channel was read is neither."""
    from studio import perf

    read = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
    posts = [
        {"id": 1, "slug": "vlog-1", "network": "youtube", "status": "posted", "at": "2026-11-13T11:22+08:00", "url": "https://youtu.be/AAAAAAAAAAA"},
        {"id": 2, "slug": "vlog-1", "network": "youtube", "status": "posted", "at": "2026-11-15T07:00+08:00", "url": "https://youtu.be/BBBBBBBBBBB"},
        {"id": 3, "slug": "vlog-10", "network": "youtube", "status": "posted", "at": "2026-11-12T20:02+08:00", "url": "https://youtu.be/CCCCCCCCCCC"},
        {"id": 4, "slug": "vlog-2", "network": "youtube", "status": "posted", "at": "2026-11-15T21:00+08:00", "url": "https://youtu.be/DDDDDDDDDDD"},
        {"id": 5, "slug": "aerial-1108", "network": "x", "status": "posted", "at": "2026-11-10T19:00+09:00", "url": "https://x.com/a/status/1"},
    ]
    idx = {"titles": {"BBBBBBBBBBB": "Part 1 of 5"}, "since": None, "read": read}
    assert perf.retired(posts, idx) == {1: "replaced", 3: "removed"}
    # a list that stops at its newest 200 cannot say anything about older posts
    assert perf.retired(posts, {**idx, "since": datetime(2026, 11, 14, tzinfo=timezone.utc)}) == {1: "replaced"}


def test_a_video_youtube_has_not_processed_is_not_a_short():
    from studio import perf

    assert perf._iso_seconds("P0D") == 0  # what YouTube says for a file it is still processing


def test_a_long_video_uploaded_since_the_channel_read_keeps_its_title(tmp_path, monkeypatch):
    from studio import config, perf

    monkeypatch.setattr(config, "DATA", tmp_path)
    d = tmp_path / "renders" / "vlogs" / "vlog-4"
    d.mkdir(parents=True)
    (d / "uploaded.json").write_text(json.dumps({"id": "Vid4Part0Ok", "title": "Part 4 of 5: Wildebeest River Crossing"}), encoding="utf-8")
    assert perf._upload_title("vlog-4", "Vid4Part0Ok") == "Part 4 of 5: Wildebeest River Crossing"
    assert perf._upload_title("vlog-4", "AAAAAAAAAAA") is None  # an older upload of the same part keeps no borrowed title
