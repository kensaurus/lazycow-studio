"""A Short already scheduled on YouTube (studio.youtube), against a fake YouTube: it moves to another time or gets a new
title with videos.update, every other field of the part sent back as YouTube holds it; the posting-log row follows
only once YouTube holds the change, and a refusal leaves both as they were."""
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from studio import posting, youtube

VID = "abcDEF12345"
STATUS = {"privacyStatus": "private", "publishAt": "2026-12-30T10:00:00Z", "selfDeclaredMadeForKids": False, "embeddable": True,
          "license": "youtube", "publicStatsViewable": True, "containsSyntheticMedia": False, "uploadStatus": "processed", "madeForKids": False}
SNIPPET = {"title": "雨だからこそ、窓際が空いている。｜Cafe Kumo", "description": "lines\n\n#cafekumo", "tags": ["cafekumo", "lunch"],
           "categoryId": "19", "defaultLanguage": "ja", "defaultAudioLanguage": "ja", "channelId": "UCx", "thumbnails": {}}


class FakeYouTube:
    def __init__(self, refuse: bool = False, vid: str = VID):
        self.vid = vid
        self.video = {"id": vid, "status": dict(STATUS), "snippet": dict(SNIPPET)}
        self.refuse, self.puts = refuse, []

    def __call__(self, method, url, *, data=None, headers=None, timeout=120):
        u = urlsplit(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if method == "GET" and u.path.endswith("/videos"):
            return 200, {}, json.dumps({"items": [{"id": self.vid, q["part"]: self.video[q["part"]]}] if q["id"] == self.vid else []}).encode()
        if method == "PUT" and u.path.endswith("/videos"):
            body = json.loads(data)
            self.puts.append((q["part"], body))
            if self.refuse:
                return 403, {}, json.dumps({"error": {"code": 403, "message": "quotaExceeded"}}).encode()
            self.video[q["part"]] = body[q["part"]]  # an update replaces the whole part
            return 200, {}, json.dumps({"id": self.vid, q["part"]: body[q["part"]]}).encode()
        raise AssertionError(f"unexpected {method} {url}")


@pytest.fixture
def yt(monkeypatch):
    def use(fake):
        monkeypatch.setattr(youtube, "_call", fake)
        monkeypatch.setattr(youtube, "access_token", lambda: "tok")
        return fake
    return use


def _in(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).replace(minute=0, second=0, microsecond=0)


def test_a_scheduled_short_moves_and_keeps_every_other_status_field(yt):
    fake = yt(FakeYouTube())
    to = _in(40).astimezone(timezone(timedelta(hours=9))).isoformat(timespec="minutes")
    out = youtube.reschedule(VID, to)
    part, body = fake.puts[0]
    assert part == "status" and body["id"] == VID
    assert datetime.fromisoformat(body["status"]["publishAt"].replace("Z", "+00:00")) == datetime.fromisoformat(to)
    for k in ("privacyStatus", "selfDeclaredMadeForKids", "embeddable", "license", "publicStatsViewable", "containsSyntheticMedia"):
        assert body["status"][k] == STATUS[k]
    assert "uploadStatus" not in body["status"] and "madeForKids" not in body["status"]  # read-only fields stay out
    assert out["was"] == STATUS["publishAt"]


def test_a_short_that_is_out_or_a_time_too_soon_does_not_move(yt):
    fake = yt(FakeYouTube())
    with pytest.raises(RuntimeError, match="15 minutes"):
        youtube.reschedule(VID, datetime.now(timezone.utc).isoformat(timespec="minutes"))
    fake.video["status"] = {**STATUS, "privacyStatus": "public", "publishAt": None}
    with pytest.raises(RuntimeError, match="only a Short still waiting"):
        youtube.reschedule(VID, _in(40).isoformat(timespec="minutes"))
    assert not fake.puts


def test_move_changes_youtube_then_the_same_log_row_with_its_offset(yt, monkeypatch):
    monkeypatch.setenv("STUDIO_TZ", "Asia/Tokyo")
    yt(FakeYouTube())
    pid = posting.record("yt-move-a", "youtube", "scheduled", _in(30).isoformat(timespec="minutes"), VID, f"https://youtube.com/shorts/{VID}", "private until x")
    to = _in(41).astimezone(timezone(timedelta(hours=9))).isoformat(timespec="minutes")
    out = youtube.move(pid, to)
    row = next(p for p in posting.posts() if p["id"] == pid)
    assert row["status"] == "scheduled" and row["remote_id"] == VID and row["url"].endswith(VID)
    assert row["at"] == to and row["at"].endswith("+09:00") and out["at"] == to
    assert "moved from" in row["note"]


def test_a_refused_move_leaves_the_log_as_it_was(yt):
    yt(FakeYouTube(refuse=True))
    at = _in(30).isoformat(timespec="minutes")
    pid = posting.record("yt-move-b", "youtube", "scheduled", at, VID, "", "private until x")
    before = next(p for p in posting.posts() if p["id"] == pid)
    with pytest.raises(RuntimeError, match="quotaExceeded"):
        youtube.move(pid, _in(41).isoformat(timespec="minutes"))
    assert next(p for p in posting.posts() if p["id"] == pid) == before


def test_move_takes_only_a_short_scheduled_on_youtube(yt):
    fake = yt(FakeYouTube())
    fb = posting.record("yt-move-c", "facebook", "scheduled", _in(30).isoformat(timespec="minutes"), "123", "")
    out = posting.record("yt-move-d", "youtube", "posted", _in(-1).isoformat(timespec="minutes"), VID, "")
    for pid in (fb, out):
        with pytest.raises(RuntimeError, match="not a Short scheduled"):
            youtube.move(pid, _in(41).isoformat(timespec="minutes"))
    assert not fake.puts


def test_a_new_title_keeps_description_tags_and_languages(yt):
    fake = yt(FakeYouTube())
    out = youtube.retitle(VID, "静かだからこそ、よく話せる。｜Cafe Kumo")
    part, body = fake.puts[0]
    assert part == "snippet" and body["snippet"]["title"].startswith("静かだからこそ")
    for k in ("description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"):
        assert body["snippet"][k] == SNIPPET[k]
    assert "channelId" not in body["snippet"] and out["was"] == SNIPPET["title"]


def test_a_title_that_breaks_the_copy_rules_or_youtubes_limits_is_never_sent(yt, monkeypatch):
    """Any workspace's copy rules (here Cafe Kumo's); the ranch workspace's own are in test_ranch_youtube_booking.py."""
    import studio.brand

    monkeypatch.setattr(studio.brand, "copy_rules", lambda: {"banned": ["最安値"], "noPrices": True, "registered": "Cafe Kumo", "bare": "Kumo"})
    fake = yt(FakeYouTube())
    for bad in ("最安値のランチ", "ランチ ¥1,200", "Kumoの朝", "", "x" * 101, "a <b> title"):
        with pytest.raises((ValueError, RuntimeError)):
            youtube.retitle(VID, bad)
    assert not fake.puts


def test_retitle_also_sets_the_reels_own_title_so_a_reupload_keeps_it(yt, monkeypatch, tmp_path):
    """21 Nov: 7 scheduled Shorts got new titles on YouTube while their projects and post.txt kept the old ones, so a
    swap to a new render (publish.replace -> upload -> metadata) would have brought the old titles back."""
    import studio.config
    import studio.projects
    import studio.reels

    slug, old, new = "yt-retitle-a", SNIPPET["title"], "静かだからこそ、よく話せる。｜Cafe Kumo"
    monkeypatch.setattr(studio.projects, "DIR", tmp_path / "projects")
    monkeypatch.setattr(studio.reels, "DRAFTS", tmp_path / "drafts")
    monkeypatch.setattr(studio.config, "READY", tmp_path / "ready")
    monkeypatch.setattr(youtube, "DATA", tmp_path / "data")
    studio.projects.save({"slug": slug, "yt_title": old, "tags": ["#cafekumo"], "beats": []})
    post = f"TITLE: {old}\n\nDESCRIPTION:\nlines\n"
    for folder in (tmp_path / "drafts" / slug, tmp_path / "ready" / f"20261110_{slug}"):
        (folder / "youtube-shorts").mkdir(parents=True)
        (folder / "youtube-shorts" / "post.txt").write_text(post, encoding="utf-8")
        (folder / "instagram").mkdir()
        (folder / "instagram" / "post.txt").write_text("instagram words\n", encoding="utf-8")
    other = tmp_path / "ready" / f"20261110_{slug}-b" / "youtube-shorts"  # another reel whose slug starts the same
    other.mkdir(parents=True)
    (other / "post.txt").write_text(post, encoding="utf-8")
    man = tmp_path / "data" / "renders" / f"story-{slug}" / "manifest.json"
    man.parent.mkdir(parents=True)
    man.write_text(json.dumps({"channels": [{"name": "youtube-shorts", "post": post}, {"name": "instagram", "post": "instagram words\n"}]}), encoding="utf-8")
    vid = "RetitleLoc1"
    posting.record(slug, "youtube", "scheduled", _in(30).isoformat(timespec="minutes"), vid, "")
    yt(FakeYouTube(vid=vid))

    out = youtube.retitle(vid, new)

    assert out["slug"] == slug and len(out["local"]) == 4  # project, drafts, one ready copy, manifest
    assert studio.projects.load(slug)["yt_title"] == new
    assert youtube.metadata(slug)["title"] == new  # what an upload sends
    for folder in (tmp_path / "drafts" / slug, tmp_path / "ready" / f"20261110_{slug}"):
        text = (folder / "youtube-shorts" / "post.txt").read_text(encoding="utf-8")
        assert text == post.replace(old, new)
        assert (folder / "instagram" / "post.txt").read_text(encoding="utf-8") == "instagram words\n"
    assert (other / "post.txt").read_text(encoding="utf-8") == post
    chans = {c["name"]: c["post"] for c in json.loads(man.read_text(encoding="utf-8"))["channels"]}
    assert chans["youtube-shorts"] == post.replace(old, new) and chans["instagram"] == "instagram words\n"


def test_a_video_the_studio_did_not_upload_changes_only_on_youtube(yt, monkeypatch, tmp_path):
    import studio.projects

    monkeypatch.setattr(studio.projects, "DIR", tmp_path / "projects")
    yt(FakeYouTube())
    monkeypatch.setattr(youtube, "posts", lambda: [])
    out = youtube.retitle(VID, "カフェの一日、約10時間を31秒で｜Cafe Kumo")
    assert out["slug"] is None and out["local"] == [] and not (tmp_path / "projects").exists()
