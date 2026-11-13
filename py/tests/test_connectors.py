"""The Bluesky and Facebook connectors against a fake HTTP layer: credentials are checked and
stored encrypted, bad ones are refused in plain words, Bluesky walks upload -> poll -> post with
clickable links, and Facebook schedules on its own side only when the time is far enough ahead."""
import base64
import json
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest

from studio import connectors
from studio.connectors import bluesky, facebook

PDS = "https://morel.us-east.host.bsky.network"


def _jwt(scope: str) -> str:
    seg = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{seg({'alg': 'ES256K'})}.{seg({'scope': scope, 'sub': 'did:plc:abc'})}.sig"


SESSION = {
    "accessJwt": _jwt("com.atproto.appPass"), "refreshJwt": "r", "handle": "tsumagoi.bsky.social", "did": "did:plc:abc",
    "didDoc": {"id": "did:plc:abc", "service": [{"id": "#atproto_pds", "type": "AtprotoPersonalDataServer", "serviceEndpoint": PDS}]},
}


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=120):
        self.calls.append({"method": method, "url": url, "data": data, "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                status, body = replies.pop(0) if len(replies) > 1 else replies[0]
                return status, {}, json.dumps(body).encode()
        raise AssertionError(f"unexpected call {method} {url}")

    def find(self, part):
        return [c for c in self.calls if part in c["url"]]


@pytest.fixture
def secrets(tmp_path, monkeypatch):
    monkeypatch.setattr(bluesky, "SECRETS", tmp_path)
    monkeypatch.setattr(facebook, "SECRETS", tmp_path)
    return tmp_path


@pytest.fixture
def reel(tmp_path):
    p = tmp_path / "reel_bluesky.mp4"
    p.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 64)
    return p


def test_registry_has_both_networks_and_refuses_unknown_ones():
    assert connectors.get("bluesky") is bluesky and connectors.get("facebook") is facebook
    for mod in connectors.REGISTRY.values():
        assert mod.NAME and mod.HOW and isinstance(mod.can_schedule, bool)
        assert all({"key", "label", "secret", "placeholder"} <= set(f) for f in mod.FIELDS)
        assert any(f["secret"] for f in mod.FIELDS)
    with pytest.raises(ValueError):
        connectors.get("myspace")


# ---------- Bluesky ----------

def test_bluesky_connect_stores_the_app_password_encrypted_and_reports_connected(secrets, monkeypatch):
    fake = Fake([("POST", "com.atproto.server.createSession", [(200, SESSION)])])
    monkeypatch.setattr(bluesky, "_call", fake)
    assert bluesky.status() == {"connected": False, "account": None, "error": None}

    out = bluesky.connect({"handle": "@Tsumagoi", "app_password": "abcd-efgh-ijkl-mnop"})

    assert out == {"connected": True, "account": "@tsumagoi.bsky.social", "error": None}
    sent = json.loads(fake.calls[0]["data"])
    assert fake.calls[0]["url"] == "https://bsky.social/xrpc/com.atproto.server.createSession"
    assert sent == {"identifier": "tsumagoi.bsky.social", "password": "abcd-efgh-ijkl-mnop"}
    raw = (secrets / "bluesky.bin").read_bytes()
    if sys.platform == "win32":
        assert b"abcd-efgh-ijkl-mnop" not in raw
    assert bluesky._load()["pds"] == PDS
    bluesky.disconnect()
    assert bluesky.status()["connected"] is False


def test_bluesky_bad_credentials_raise_value_error_and_store_nothing(secrets, monkeypatch):
    fake = Fake([("POST", "createSession", [(401, {"error": "AuthenticationRequired", "message": "Invalid identifier or password"})])])
    monkeypatch.setattr(bluesky, "_call", fake)
    with pytest.raises(ValueError, match="did not accept"):
        bluesky.connect({"handle": "tsumagoi.bsky.social", "app_password": "abcd-efgh-ijkl-mnop"})
    with pytest.raises(ValueError, match="not an app password"):
        bluesky.connect({"handle": "tsumagoi.bsky.social", "app_password": "my real password"})
    assert len(fake.calls) == 1  # the account-password shape never left the machine
    with pytest.raises(ValueError):
        bluesky.connect({"handle": "", "app_password": "abcd-efgh-ijkl-mnop"})

    full = dict(SESSION, accessJwt=_jwt("com.atproto.access"))
    monkeypatch.setattr(bluesky, "_call", Fake([("POST", "createSession", [(200, full)])]))
    with pytest.raises(ValueError, match="account password"):
        bluesky.connect({"handle": "tsumagoi.bsky.social", "app_password": "abcd-efgh-ijkl-mnop"})
    assert not (secrets / "bluesky.bin").exists()


def _connected_bluesky(monkeypatch):
    monkeypatch.setattr(bluesky, "_call", Fake([("POST", "createSession", [(200, SESSION)])]))
    bluesky.connect({"handle": "tsumagoi.bsky.social", "app_password": "abcd-efgh-ijkl-mnop"})


def test_bluesky_post_uploads_polls_then_creates_the_record(secrets, reel, monkeypatch):
    _connected_bluesky(monkeypatch)
    blob = {"$type": "blob", "ref": {"$link": "bafkreivideo"}, "mimeType": "video/mp4", "size": 72}
    fake = Fake([
        ("POST", "com.atproto.server.createSession", [(200, SESSION)]),
        ("GET", "com.atproto.server.getServiceAuth", [(200, {"token": "svc-limits"}), (200, {"token": "svc-upload"})]),
        ("GET", "app.bsky.video.getUploadLimits", [(200, {"canUpload": True, "remainingDailyVideos": 20})]),
        ("POST", "app.bsky.video.uploadVideo", [(200, {"jobStatus": {"jobId": "job-1", "did": "did:plc:abc", "state": "JOB_STATE_CREATED"}})]),
        ("GET", "app.bsky.video.getJobStatus", [
            (200, {"jobStatus": {"jobId": "job-1", "did": "did:plc:abc", "state": "JOB_STATE_ENCODING", "progress": 40}}),
            (200, {"jobStatus": {"jobId": "job-1", "did": "did:plc:abc", "state": "JOB_STATE_COMPLETED", "blob": blob}}),
        ]),
        ("POST", "com.atproto.repo.createRecord", [(200, {"uri": "at://did:plc:abc/app.bsky.feed.post/3lbsk2post", "cid": "bafyrec"})]),
    ])
    monkeypatch.setattr(bluesky, "_call", fake)
    monkeypatch.setattr(bluesky, "_wait", lambda s: None)
    monkeypatch.setattr(bluesky, "_aspect", lambda v: {"width": 1080, "height": 1920})
    text = "標高1,444mの草原で焚き火 https://tsumagoi.jp/reserve? #嬬恋 #camp"

    out = bluesky.post(reel, text)

    order = [c["url"].split("/xrpc/")[1].split("?")[0] for c in fake.calls]
    assert order == ["com.atproto.server.createSession", "com.atproto.server.getServiceAuth", "app.bsky.video.getUploadLimits",
                     "com.atproto.server.getServiceAuth", "app.bsky.video.uploadVideo", "app.bsky.video.getJobStatus",
                     "app.bsky.video.getJobStatus", "com.atproto.repo.createRecord"]
    auth = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(c["url"]).query)) for c in fake.find("getServiceAuth")]
    assert all(c["url"].startswith(PDS) for c in fake.find("getServiceAuth"))
    assert auth[0]["aud"] == "did:web:video.bsky.app" and auth[0]["lxm"] == "app.bsky.video.getUploadLimits"
    assert auth[1]["aud"] == "did:web:morel.us-east.host.bsky.network" and auth[1]["lxm"] == "com.atproto.repo.uploadBlob"

    up = fake.find("uploadVideo")[0]
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(up["url"]).query))
    assert up["url"].startswith("https://video.bsky.app/xrpc/") and q == {"did": "did:plc:abc", "name": reel.name}
    assert up["headers"]["authorization"] == "Bearer svc-upload" and up["headers"]["content-type"] == "video/mp4"
    assert up["data"] == reel.read_bytes()
    assert "jobId=job-1" in fake.find("getJobStatus")[0]["url"]

    cr = fake.find("createRecord")[0]
    assert cr["url"] == f"{PDS}/xrpc/com.atproto.repo.createRecord"
    body = json.loads(cr["data"])
    rec = body["record"]
    assert body["repo"] == "did:plc:abc" and body["collection"] == "app.bsky.feed.post"
    assert rec["text"] == text and rec["langs"][0] == "ja" and rec["createdAt"].endswith("Z")
    assert rec["embed"] == {"$type": "app.bsky.embed.video", "video": blob, "aspectRatio": {"width": 1080, "height": 1920}}
    raw = text.encode("utf-8")
    links = [f for f in rec["facets"] if f["features"][0]["$type"] == "app.bsky.richtext.facet#link"]
    tags = [f for f in rec["facets"] if f["features"][0]["$type"] == "app.bsky.richtext.facet#tag"]
    assert len(links) == 1 and links[0]["features"][0]["uri"] == "https://tsumagoi.jp/reserve"
    i = links[0]["index"]
    assert raw[i["byteStart"]:i["byteEnd"]].decode() == "https://tsumagoi.jp/reserve"  # trailing "?" left out
    assert [f["features"][0]["tag"] for f in tags] == ["嬬恋", "camp"]
    assert raw[tags[0]["index"]["byteStart"]:tags[0]["index"]["byteEnd"]].decode() == "#嬬恋"

    assert out == {"url": "https://bsky.app/profile/tsumagoi.bsky.social/post/3lbsk2post",
                   "remote_id": "at://did:plc:abc/app.bsky.feed.post/3lbsk2post", "scheduled": False}
    assert bluesky.can_schedule is False


def test_bluesky_failed_processing_is_a_plain_runtime_error(secrets, reel, monkeypatch):
    _connected_bluesky(monkeypatch)
    fake = Fake([
        ("POST", "createSession", [(200, SESSION)]),
        ("GET", "getServiceAuth", [(200, {"token": "svc"})]),
        ("GET", "getUploadLimits", [(200, {"canUpload": True})]),
        ("POST", "uploadVideo", [(200, {"jobStatus": {"jobId": "j", "did": "did:plc:abc", "state": "JOB_STATE_CREATED"}})]),
        ("GET", "getJobStatus", [(200, {"jobStatus": {"jobId": "j", "did": "did:plc:abc", "state": "JOB_STATE_FAILED", "message": "Video too long"}})]),
    ])
    monkeypatch.setattr(bluesky, "_call", fake)
    monkeypatch.setattr(bluesky, "_wait", lambda s: None)
    with pytest.raises(RuntimeError, match="Video too long"):
        bluesky.post(reel, "test")
    assert not fake.find("createRecord")


def test_bluesky_text_over_300_graphemes_raises_before_any_network_call(secrets, reel, monkeypatch):
    fake = Fake([])
    monkeypatch.setattr(bluesky, "_call", fake)
    with pytest.raises(RuntimeError, match="300"):
        bluesky.post(reel, "あ" * 301)
    assert fake.calls == []
    assert bluesky.graphemes("あ" * 300) == 300
    assert bluesky.graphemes("👨‍👩‍👧‍👦🇯🇵é") == 3  # one family, one flag, one accented e
    with pytest.raises(RuntimeError):
        bluesky.post(reel, "👍🏽" * 301)


def test_bluesky_will_not_post_hours_before_the_planned_time(secrets, reel, monkeypatch):
    fake = Fake([])
    monkeypatch.setattr(bluesky, "_call", fake)
    with pytest.raises(RuntimeError, match="cannot hold"):
        bluesky.post(reel, "test", at=datetime.now(timezone.utc) + timedelta(hours=3))
    assert fake.calls == []


# ---------- Facebook ----------

PAGE = {"id": "1234567890", "name": "嬬恋牧場Work&Camp", "access_token": "EAAGpagetoken", "tasks": ["CREATE_CONTENT", "MANAGE"]}
ALL_PERMS = {"data": [{"permission": p, "status": "granted"} for p in ("pages_show_list", "pages_read_engagement", "pages_manage_posts", "public_profile")]}
NOT_USER = {"error": {"message": "(#100) Tried accessing nonexisting field (accounts) on node type (Page)", "code": 100}}


def _user_token_routes(pages=(PAGE,), perms=ALL_PERMS):
    return [
        ("GET", "/v27.0/me/accounts?", [(200, {"data": list(pages)})]),
        ("GET", "/v27.0/me/permissions?", [(200, perms)]),
        ("GET", "/v27.0/me?", [(200, {"id": "999999999", "name": "Kenji"}), (200, {"id": PAGE["id"], "name": PAGE["name"]})]),
    ]


def test_facebook_connect_with_a_page_token_stores_it_encrypted(secrets, monkeypatch):
    fake = Fake([("GET", "/v27.0/me/accounts?", [(400, NOT_USER)]), ("GET", "/v27.0/me?", [(200, {"id": PAGE["id"], "name": PAGE["name"]})])])
    monkeypatch.setattr(facebook, "_call", fake)
    out = facebook.connect({"token": " EAAGsecretpagetoken ", "page_id": " 1234567890 "})
    assert out == {"connected": True, "account": "嬬恋牧場Work&Camp", "error": None}
    assert urllib.parse.urlsplit(fake.calls[0]["url"]).netloc == "graph.facebook.com"
    raw = (secrets / "facebook.bin").read_bytes()
    if sys.platform == "win32":
        assert b"EAAGsecretpagetoken" not in raw
    facebook.disconnect()
    assert facebook.status() == {"connected": False, "account": None, "error": None}


def test_facebook_finds_the_page_from_a_user_token_and_keeps_the_pages_own_token(secrets, monkeypatch):
    monkeypatch.setattr(facebook, "_call", Fake(_user_token_routes()))
    assert facebook.connect({"token": "EAAGusertoken"})["account"] == PAGE["name"]  # no Page ID typed
    saved = facebook._load()
    assert saved["token"] == "EAAGpagetoken" and saved["page_id"] == PAGE["id"]


def test_facebook_says_which_permission_is_missing(secrets, monkeypatch):
    two = {"data": [{"permission": p, "status": "granted"} for p in ("pages_show_list", "pages_read_engagement")]}
    monkeypatch.setattr(facebook, "_call", Fake(_user_token_routes(perms=two)))
    with pytest.raises(ValueError, match="missing pages_manage_posts"):
        facebook.connect({"token": "EAAGusertoken"})
    assert not (secrets / "facebook.bin").exists()


def test_facebook_explains_an_app_id_typed_as_the_page_id(secrets, monkeypatch):
    routes = _user_token_routes() + [("GET", "/v27.0/1000000000000001?", [(200, {"name": "Tsumagoi CAPI", "id": "1000000000000001", "metadata": {"type": "application"}})])]
    monkeypatch.setattr(facebook, "_call", Fake(routes))
    with pytest.raises(ValueError) as err:
        facebook.connect({"token": "EAAGusertoken", "page_id": "1000000000000001"})
    assert "is your Meta app (Tsumagoi CAPI), not a Page" in str(err.value) and "1234567890" in str(err.value)


def test_facebook_asks_which_page_when_there_are_several(secrets, monkeypatch):
    other = {**PAGE, "id": "555", "name": "Other Page"}
    monkeypatch.setattr(facebook, "_call", Fake(_user_token_routes(pages=(PAGE, other))))
    with pytest.raises(ValueError, match="several Pages"):
        facebook.connect({"token": "EAAGusertoken"})
    assert facebook.connect({"token": "EAAGusertoken", "page_id": "1234567890"})["connected"] is True


def test_facebook_bad_input_and_bad_tokens_say_what_to_do(secrets, monkeypatch):
    bad = {"error": {"message": "Invalid OAuth access token - Cannot parse access token", "type": "OAuthException", "code": 190}}
    monkeypatch.setattr(facebook, "_call", Fake([("GET", "/v27.0/me?", [(400, bad)])]))
    with pytest.raises(ValueError, match="did not accept that token.*Generate Access Token again"):
        facebook.connect({"token": "EAAGbad"})
    with pytest.raises(ValueError, match="only digits"):
        facebook.connect({"token": "EAAG", "page_id": "tsumagoi"})
    with pytest.raises(ValueError, match="starts with EAA"):
        facebook.connect({"token": ""})
    with pytest.raises(ValueError, match="32 letters"):
        facebook.connect({"token": "EAAG", "app_secret": "nope"})
    assert not (secrets / "facebook.bin").exists()


def test_facebook_app_secret_makes_the_token_last(secrets, monkeypatch):
    fake = Fake(_user_token_routes() + [
        ("GET", "/v27.0/app?", [(200, {"id": "1000000000000001", "name": "Tsumagoi CAPI"})]),
        ("GET", "/v27.0/oauth/access_token?", [(200, {"access_token": "EAAGlonglived", "token_type": "bearer"})]),
    ])
    monkeypatch.setattr(facebook, "_call", fake)
    assert facebook.connect({"token": "EAAGusertoken", "app_secret": "0123456789abcdef0123456789abcdef"})["connected"] is True
    swap = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(fake.find("/oauth/access_token")[0]["url"]).query))
    assert swap["grant_type"] == "fb_exchange_token" and swap["client_id"] == "1000000000000001" and swap["fb_exchange_token"] == "EAAGusertoken"
    later = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(c["url"]).query)) for c in fake.find("/me/accounts")]
    assert later[-1]["access_token"] == "EAAGlonglived"  # the Page token comes from the 60-day user token
    assert facebook._load()["lasting"] is True


def _fb_post_fake():
    return Fake([
        ("POST", "/1234567890/video_reels", [
            (200, {"video_id": "777000111", "upload_url": "https://rupload.facebook.com/video-upload/v27.0/777000111"}),
            (200, {"success": True}),
        ]),
        ("POST", "rupload.facebook.com", [(200, {"success": True})]),
        ("GET", "/v27.0/777000111?", [(200, {"status": {"video_status": "processing"}, "id": "777000111"})]),
    ])


def _forms(fake):
    return [dict(urllib.parse.parse_qsl(c["data"].decode())) for c in fake.find("/video_reels")]


def _connected_facebook(monkeypatch):
    monkeypatch.setattr(facebook, "_call", Fake([("GET", "/v27.0/me/accounts?", [(400, NOT_USER)]), ("GET", "/v27.0/me?", [(200, {"id": PAGE["id"], "name": PAGE["name"]})])]))
    facebook.connect({"page_id": "1234567890", "token": "EAAGpagetoken"})


def test_facebook_post_schedules_on_facebook_when_at_is_given(secrets, reel, monkeypatch):
    _connected_facebook(monkeypatch)
    fake = _fb_post_fake()
    monkeypatch.setattr(facebook, "_call", fake)
    at = (datetime.now() + timedelta(days=1)).replace(microsecond=0)

    out = facebook.post(reel, "焚き火の夜 #嬬恋", at=at)

    start, finish = _forms(fake)
    assert start == {"upload_phase": "start", "access_token": "EAAGpagetoken"}
    up = fake.find("rupload.facebook.com")[0]
    assert up["headers"]["authorization"] == "OAuth EAAGpagetoken"
    assert up["headers"]["offset"] == "0" and up["headers"]["file_size"] == str(reel.stat().st_size)
    assert up["data"] == reel.read_bytes()
    assert finish["upload_phase"] == "finish" and finish["video_id"] == "777000111"
    assert finish["video_state"] == "SCHEDULED"
    assert finish["scheduled_publish_time"] == str(int(at.astimezone().timestamp()))
    assert finish["description"] == "焚き火の夜 #嬬恋"
    assert all("EAAG" not in c["url"] for c in fake.calls if c["method"] == "POST")  # token never in a POST URL
    assert out == {"url": "https://www.facebook.com/reel/777000111", "remote_id": "777000111", "scheduled": True}


@pytest.mark.parametrize("at", [None, "soon"])
def test_facebook_post_publishes_now_without_a_far_enough_time(secrets, reel, monkeypatch, at):
    _connected_facebook(monkeypatch)
    fake = _fb_post_fake()
    monkeypatch.setattr(facebook, "_call", fake)
    when = datetime.now(timezone.utc) + timedelta(minutes=5) if at == "soon" else None

    out = facebook.post(reel, "test", at=when)

    finish = _forms(fake)[1]
    assert finish["video_state"] == "PUBLISHED" and "scheduled_publish_time" not in finish
    assert out["scheduled"] is False and out["url"] == "https://www.facebook.com/reel/777000111"


def test_facebook_refuses_a_time_more_than_29_days_ahead(secrets, reel, monkeypatch):
    _connected_facebook(monkeypatch)
    fake = _fb_post_fake()
    monkeypatch.setattr(facebook, "_call", fake)
    with pytest.raises(RuntimeError, match="29 days"):
        facebook.post(reel, "test", at=datetime.now() + timedelta(days=40))
    assert fake.calls == []
