"""A series on YouTube (studio.youtube), against a fake YouTube: each episode uploads once per build with the links it
can already carry and its captions; the link pass makes the playlist in order and rewrites only this build's videos'
descriptions, sending their whole snippet back; an earlier film's video in the same folder is never touched."""
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from studio import youtube

OLD = "d1tMeoodsAg"  # an earlier plan's part 1, uploaded from the same folder (vlog-1)


class FakeYouTube:
    def __init__(self, manual_sort: bool = True):
        self.calls, self.manual_sort, self.playlists, self.items = [], manual_sort, {}, {}

    def __call__(self, method, url, *, data=None, headers=None, timeout=120):
        u = urlsplit(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = json.loads(data) if data and (headers or {}).get("content-type", "").startswith("application/json") else data
        self.calls.append((method, u.path.rsplit("/", 1)[-1], q, body))
        path = u.path.rsplit("/", 1)[-1]
        if method == "GET" and path == "playlists":
            return 200, {}, json.dumps({"items": [{"id": i, "snippet": {"title": t}, "contentDetails": {"itemCount": 0}} for t, i in self.playlists.items()]}).encode()
        if method == "POST" and path == "playlists":
            self.playlists[body["snippet"]["title"]] = "PLSERIES"
            return 200, {}, json.dumps({"id": "PLSERIES"}).encode()
        if method == "GET" and path == "playlistItems":
            return 200, {}, json.dumps({"items": [{"contentDetails": {"videoId": v}} for v in self.items.get(q["playlistId"], [])]}).encode()
        if method == "POST" and path == "playlistItems":
            if "position" in body["snippet"] and not self.manual_sort:
                return 400, {}, json.dumps({"error": {"message": "sorted", "errors": [{"reason": "manualSortRequired"}]}}).encode()
            self.items.setdefault(body["snippet"]["playlistId"], []).append(body["snippet"]["resourceId"]["videoId"])
            return 200, {}, b"{}"
        if method == "GET" and path == "videos":
            return 200, {}, json.dumps({"items": [{"id": q["id"], "snippet": {"title": f"title of {q['id']}", "categoryId": "19", "description": "old",
                                                                               "tags": ["safari"], "defaultLanguage": "en", "defaultAudioLanguage": "en"}}]}).encode()
        if method == "PUT" and path == "videos":
            return 200, {}, json.dumps(body).encode()
        if method == "POST" and path == "captions":
            return 200, {}, json.dumps({"id": "CAP1"}).encode()
        if method == "POST" and path == "commentThreads":
            return 200, {}, json.dumps({"id": "C-" + body["snippet"]["videoId"]}).encode()
        raise AssertionError(f"unexpected call {method} {url}")


@pytest.fixture
def studio(tmp_path, monkeypatch):
    fake = FakeYouTube()
    monkeypatch.setattr(youtube, "DATA", tmp_path)
    monkeypatch.setattr(youtube, "_call", fake)
    monkeypatch.setattr(youtube, "access_token", lambda: "tok")
    monkeypatch.setattr(youtube, "record", lambda *a, **k: None)
    monkeypatch.setattr(youtube, "posts", lambda: [{"slug": "vlog-1", "network": "youtube", "status": "posted", "url": f"https://youtu.be/{OLD}"}])
    monkeypatch.setattr(youtube, "_set_thumbnail", lambda vid, img: None)
    uploads = iter(["NEW1", "NEW2"])
    monkeypatch.setattr(youtube, "_resumable", lambda video, resource: (fake.calls.append(("UPLOAD", "videos", {}, resource)), {"id": next(uploads), "status": {"privacyStatus": "private"}})[1])
    plan = {"name": "Highlands & Coast", "videos": [
        {"n": 1, "title": "Highlands & Coast · Part 1 of 2: A Leopard in a Tree", "episode": "A Leopard in a Tree", "series": {"n": 1, "of": 2}},
        {"n": 2, "title": "Highlands & Coast · Part 2 of 2: The River Crossing and a Birthday", "episode": "The River Crossing and a Birthday", "series": {"n": 2, "of": 2}}]}
    (tmp_path / "vlog-plan.json").write_text(json.dumps(plan), encoding="utf-8")
    for n, v in ((1, plan["videos"][0]), (2, plan["videos"][1])):
        d = tmp_path / "renders" / "vlogs" / f"vlog-{n}"
        d.mkdir(parents=True)
        (d / "master.mp4").write_bytes(b"film")
        template = "Hook.\n\nPart {n} of 2\n" + ("◀ Previous: Part 1  {prev}\n" if n == 2 else "▶ Next: Part 2  {next}\n") + "☰ Whole series: {playlist}\n\nChapters\n0:00 x"
        (d / "youtube.json").write_text(json.dumps({"made": f"2026-11-14T0{n}:00:00", "youtube": {
            "title": v["title"], "description": "Hook.", "template": template.replace("{n}", str(n)), "tags": ["safari"], "series": v["series"]}}), encoding="utf-8")
        (d / "subtitles.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nLook, a leopard.\n", encoding="utf-8")
    (tmp_path / "renders" / "vlogs" / "vlog-1" / "uploaded.json").write_text(json.dumps({"id": OLD, "url": f"https://youtu.be/{OLD}"}), encoding="utf-8")
    return tmp_path, fake


def test_an_episode_uploads_once_per_build_and_an_earlier_films_record_is_kept_aside(studio):
    data, fake = studio
    up1 = youtube.upload_vlog(1, privacy="private")
    d1 = data / "renders" / "vlogs" / "vlog-1"
    assert up1["id"] == "NEW1" and up1["made"] == "2026-11-14T01:00:00" and up1["captions"] == "CAP1"
    assert json.loads((d1 / f"uploaded-{OLD}.json").read_text(encoding="utf-8"))["id"] == OLD, "the earlier film's record is kept beside"
    first = next(c for c in fake.calls if c[0] == "UPLOAD")[3]
    assert first["snippet"]["description"] == "Hook.\n\nPart 1 of 2\n\nChapters\n0:00 x", "no link line before its link exists"
    assert first["status"]["privacyStatus"] == "private"
    with pytest.raises(RuntimeError, match="already on YouTube"):
        youtube.upload_vlog(1, privacy="private")
    youtube.upload_vlog(2, privacy="private")
    second = [c for c in fake.calls if c[0] == "UPLOAD"][1][3]
    assert "◀ Previous: Part 1  https://youtu.be/NEW1" in second["snippet"]["description"], "part 1 is up: part 2 links back to it"
    cap = next(c for c in fake.calls if c[1] == "captions")
    assert b"Look, a leopard." in cap[3] and b'"language": "en"' in cap[3], "the spoken words go up as English captions"
    assert all(OLD not in json.dumps(c[2]) + str(c[3]) for c in fake.calls), "the earlier film's video is never named in a call"


def test_the_link_pass_makes_the_playlist_in_order_and_sends_the_whole_snippet(studio):
    data, fake = studio
    with pytest.raises(RuntimeError, match="upload these parts"):
        youtube.link_series()
    youtube.upload_vlog(1, privacy="private")
    youtube.upload_vlog(2, privacy="private")
    dry = youtube.link_series(dry_run=True)
    assert dry["dryRun"] and "https://youtu.be/NEW2" in dry["descriptions"][1] and not [c for c in fake.calls if c[0] in ("PUT",) or c[1] == "playlists"]
    out = youtube.link_series()
    assert out["updated"] == [1, 2] and out["playlist"]["id"] == "PLSERIES" and out["playlist"]["positioned"]
    adds = [c[3]["snippet"] for c in fake.calls if c[0] == "POST" and c[1] == "playlistItems"]
    assert [(a["resourceId"]["videoId"], a["position"]) for a in adds] == [("NEW1", 0), ("NEW2", 1)], "in episode order"
    made = next(c for c in fake.calls if c[0] == "POST" and c[1] == "playlists")[3]
    assert made["snippet"]["title"] == "Highlands & Coast · the series" and "Part 2 of 2: The River Crossing and a Birthday" in made["snippet"]["description"]
    puts = [c[3] for c in fake.calls if c[0] == "PUT"]
    assert [p["id"] for p in puts] == ["NEW1", "NEW2"]
    s = puts[0]["snippet"]
    assert {k: s[k] for k in ("title", "categoryId", "tags", "defaultLanguage", "defaultAudioLanguage")} == {
        "title": "title of NEW1", "categoryId": "19", "tags": ["safari"], "defaultLanguage": "en", "defaultAudioLanguage": "en"}, "nothing else is cleared"
    assert "▶ Next: Part 2  https://youtu.be/NEW2" in s["description"] and "list=PLSERIES" in s["description"]
    assert json.loads((data / "vlog-series.json").read_text(encoding="utf-8"))["playlist"] == "PLSERIES"
    assert all(OLD not in json.dumps(c[2]) + str(c[3]) for c in fake.calls)


def test_a_playlist_youtube_sorts_itself_takes_the_rest_in_order(studio, monkeypatch):
    _, fake = studio
    fake.manual_sort = False
    pl = youtube.series_playlist("Trip · the series", ["A", "B", "C"])
    assert pl["positioned"] is False and fake.items["PLSERIES"] == ["A", "B", "C"]


def test_series_comments_say_where_each_part_sits(studio):
    youtube.upload_vlog(1, privacy="private")
    youtube.upload_vlog(2, privacy="private")
    texts = youtube.series_comments(dry_run=True)["comments"]
    assert texts[1] == "Part 1 of 2: A Leopard in a Tree. Next: Part 2, The River Crossing and a Birthday https://youtu.be/NEW2"
    assert texts[2].startswith("Part 2 of 2: The River Crossing and a Birthday. That's the whole series. Watch it from Part 1: https://youtu.be/NEW1")
    out = youtube.series_comments()
    assert out["commented"] == [1, 2] and youtube.series_comments()["commented"] == [], "each part's comment once"
