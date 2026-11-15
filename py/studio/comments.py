"""Comments on the project's posts and videos, and replies to them (Results › Comments, /api/comments).

What people write under the reels on YouTube, Bluesky and the Facebook Page, in one list, with a reply ready where
the studio can answer from the owner's own words. Nothing here is generated: a reply is made only from "Your answers"
(one short answer per topic: price, booking, access, Wi-Fi, ...), seeded from the approved lines and the booking
link, and edited by the owner. A comment with no matching answer gets no draft; praise gets no canned thanks.

Sending is the owner's press of Send. "Answer questions by myself" (off until the owner turns it on) sends only a
reply that is entirely the owner's own answers, to a plain question on topics whose answers the owner has saved,
at least AUTO_WAIT after the comment, at most `cap` a day, once per comment and once per person a day; never to a
link, a reply between other people, or anything that looks like spam. Owner, 14 Nov 2026: "can we auto reply to
comments without ai slop?"

Networks
  YouTube   commentThreads.list (allThreadsRelatedToChannelId, part snippet,replies; 1 quota unit) and
            comments.insert (parentId; 50 units). Both need the youtube.force-ssl scope: a sign-in from before it
            was added says "press Connect YouTube again".
  Bluesky   app.bsky.notification.listNotifications (reasons reply, mention, quote) through the account's own
            server, and a reply post (com.atproto.repo.createRecord, record.reply = {root, parent}).
  Facebook  GET /{post-id}/comments on the Page's posts the studio made, POST /{comment-id}/comments to reply.
            Reading needs pages_read_user_content, replying pages_manage_engagement (Accounts › Facebook).
Others (TikTok, X, Instagram, LinkedIn, Pinterest, Google Maps, LINE) have no comment API the studio can use: the
page links to each post instead.

  python -m studio.comments view|check|reply|skip|answers|save-answers|settings   (JSON on stdin, RESULT line out)
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.config import DATA

STORE = DATA / "comments.json"
ANSWERS = DATA / "answers.json"
KEEP_DAYS = 120          # comments older than this leave the list
AUTO_WAIT = 20 * 60      # seconds a comment waits before an answer goes out by itself (the owner can answer first)
AUTO_MAX_AGE = 3 * 86400  # an old question is the owner's to answer, not the timer's
DEFAULT_CAP = 6          # answers sent by themselves in a day, all networks together
MAX_REPLY = 1000         # characters; Bluesky's own limit (300 graphemes) is checked when sending there
FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl"
YT_API = "https://www.googleapis.com/youtube/v3"
JST = timezone(timedelta(hours=9))

# What a question asks about: (Japanese words, English words). A comment matches a topic by any of them.
TOPICS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "price": (("料金", "値段", "いくら", "費用", "価格", "金額", "円"), ("price", "cost", "how much", "fee", "rate", "yen", "expensive")),
    "booking": (("予約", "申し込", "申込", "空き", "空いて"), ("book", "reserv", "availab", "vacanc")),
    "access": (("行き方", "アクセス", "最寄", "駅", "バス", "電車", "住所", "場所", "どこ"), ("where is", "where are", "access", "get there", "station", "bus", "train", "address", "location", "directions")),
    "work": (("wifi", "wi-fi", "ワイファイ", "ネット", "回線", "電源", "コンセント", "作業", "ワーケーション", "リモート"), ("wifi", "wi-fi", "internet", "signal", "outlet", "power", "remote work", "laptop", "workation")),
    "car": (("駐車", "車中泊", "キャンピングカー", "車で"), ("parking", "park my", "car ", "van", "camper", "rv ")),
    "facilities": (("トイレ", "シャワー", "風呂", "お風呂", "キッチン", "水道", "電気", "設備"), ("toilet", "shower", "bath", "kitchen", "water", "electric", "facilit")),
    "pets": (("犬", "ペット", "わんちゃん", "ワンちゃん", "猫"), ("dog", "pet", "cat")),
    "groups": (("団体", "貸切", "貸し切り", "合宿", "人数", "グループ", "イベント", "何人"), ("group", "private hire", "exclusive", "team", "event", "party", "how many people")),
    "night": (("夜", "星", "焚き火", "たき火", "騒", "音楽", "消灯"), ("night", "star", "campfire", "fire", "noise", "loud", "music")),
    "season": (("冬", "雪", "寒", "営業", "季節", "紅葉", "何月", "いつ"), ("winter", "snow", "cold", "open", "season", "autumn", "fall", "when")),
}
TOPIC_ORDER = list(TOPICS)
# Topics whose answer carries the booking link (the place to see dates and prices for yourself).
LINKED = {"price", "booking", "access", "groups"}

_URL = re.compile(r"https?://|www\.|\b[\w-]+\.(com|net|org|io|me|ly|gg|xyz|link|shop)\b", re.I)
_SPAM = re.compile(r"telegram|whats\s*app|crypto|bitcoin|forex|invest(ment)? plan|sub4sub|check (out )?my (channel|page|profile)|"
                   r"dm me|onlyfans|follow me|promo(tion)? (for|on) your|grow your channel|稼げ|副業|ライン追加|LINE追加", re.I)
_Q_JA = re.compile(r"[？?]|ですか|ますか|でしょうか|ません?か|かな|いくら|どこ|いつ|何(人|時|月|日|円)?|どう(やって|すれば)?|できる[？?]|可能")
_Q_EN = re.compile(r"\?|^(how|what|when|where|which|who|why|is|are|can|could|do|does|did|will|would)\b|\b(can i|can we|is there|are there|do you|how much|how many)\b", re.I)
_PRAISE = re.compile(r"きれい|綺麗|素敵|すてき|最高|いいね|良い|いい(です|な|ね)|行きたい|いきたい|癒|すごい|凄い|感動|美し|"
                     r"beautiful|amazing|love|lovely|nice|great|wow|stunning|gorgeous|awesome|peaceful|want to go|wish i", re.I)


class CommentsError(Exception):
    def __init__(self, message: str, code: str = "error", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _when(at: str | None) -> datetime | None:
    if not at:
        return None
    try:
        d = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=JST)


# ---------- reading a comment ----------

def lang_of(text: str) -> str:
    """"ja" when the comment has Japanese script, else "en"."""
    return "ja" if re.search(r"[぀-ヿ㐀-鿿]", text or "") else "en"


def _plain(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").strip()


def topics_in(text: str) -> list[str]:
    t = _plain(text)
    low = " " + t.lower() + " "
    return [k for k in TOPIC_ORDER if any(w in t for w in TOPICS[k][0]) or any(w in low for w in TOPICS[k][1])]


def classify(text: str) -> dict:
    """{kind: question | praise | spam | reaction | other, topics: [...], lang}. Spam and links are never answered;
    an emoji-only comment is a "reaction" (no words to answer)."""
    t = _plain(text)
    lang = lang_of(t)
    if not t:
        return {"kind": "reaction", "topics": [], "lang": lang}
    if _URL.search(t) or _SPAM.search(t):
        return {"kind": "spam", "topics": [], "lang": lang}
    words = re.sub(r"[\W_]+", "", t, flags=re.UNICODE)
    if not re.search(r"[A-Za-z぀-ヿ㐀-鿿0-9]", words):
        return {"kind": "reaction", "topics": [], "lang": lang}
    topics = topics_in(t)
    asks = bool(_Q_JA.search(t)) if lang == "ja" else bool(_Q_EN.search(t.strip()))
    if asks:
        return {"kind": "question", "topics": topics, "lang": lang}
    if _PRAISE.search(t):
        return {"kind": "praise", "topics": topics, "lang": lang}
    return {"kind": "other", "topics": topics, "lang": lang}


# ---------- Your answers ----------

def _booking() -> str:
    try:
        from studio.research import approved_facts

        link = str(approved_facts().get("booking") or "")
        return link if re.match(r"https?://", link) else ""  # a brand-neutral project's facts said just "reserve"
    except Exception:  # noqa: BLE001 - no site set up yet: answers without a link
        return ""


def _line(row_ja: str, rows: list[dict]) -> tuple[str, str] | None:
    from studio.wording import _key

    for r in rows:
        if _key(r["ja"]) == _key(row_ja) and r.get("status") == "approved":
            return r["ja"].replace("\n", ""), (r.get("en") or "").strip()
    return None


# The approved lines each topic starts from (verbatim from the word bank; a line that is not there is left out).
SEED_LINES = {
    "work": ["標高1,444m、100Mbpsの光回線。", "中のラウンジは、こたつと光回線。"],
    "car": ["駐車場は、1晩に5台まで。"],
    "facilities": ["トイレ・共用キッチン・Wi-Fi込み。", "共用キッチンで作って、デッキの焚き火台へ。"],
    "night": ["22:00までは、笑い声も気にせずに。", "夜のフィールドに照明はありません。"],
    "groups": ["イベントは、50名まで。"],
    "season": ["冬の夜は、氷点下まで下がります。"],
}


def seed_answers() -> dict:
    """First answers: the approved lines for each topic, and the booking link for dates and prices. Every one is
    marked "saved": false until the owner reads and saves it (only saved answers go out by themselves)."""
    try:
        from studio.wording import bank

        rows = bank()
    except Exception:  # noqa: BLE001 - a project without the word bank starts empty
        rows = []
    link = _booking()
    out: dict = {}
    for topic in TOPIC_ORDER:
        ja, en = [], []
        for want in SEED_LINES.get(topic, []):
            got = _line(want, rows)
            if got:
                ja.append(got[0])
                if got[1]:
                    en.append(got[1].rstrip(",") + ("" if got[1].rstrip().endswith((".", "!", "?")) else "."))
        if topic in ("price", "booking") and link:
            ja.append("空き状況と料金は、予約ページでご覧いただけます。")
            en.append("Dates and prices are on the booking page.")
        out[topic] = {"ja": "".join(ja), "en": " ".join(en), "saved": False}  # Japanese sentences run on without a space
    return {"topics": out, "link": link}


def answers() -> dict:
    try:
        data = json.loads(ANSWERS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict) or "topics" not in data:
        return seed_answers()
    seeded = seed_answers()
    for k in TOPIC_ORDER:  # a topic added later starts from its seed
        data["topics"].setdefault(k, seeded["topics"][k])
    data.setdefault("link", seeded["link"])
    return data


def save_answers(req: dict) -> dict:
    """{topics: {topic: {ja, en}}, link}: the owner's answers. Saving a topic marks it read and saved."""
    from studio.guard import assert_copy

    cur = answers()
    topics = req.get("topics") or {}
    if not isinstance(topics, dict):
        raise CommentsError("topics: an object of {topic: {ja, en}}", "bad_input")
    for k, v in topics.items():
        if k not in TOPICS or not isinstance(v, dict):
            raise CommentsError(f"unknown topic {k!r}", "bad_input")
        ja, en = _plain(str(v.get("ja") or ""))[:MAX_REPLY], _plain(str(v.get("en") or ""))[:MAX_REPLY]
        for text in (ja, en):
            if text:
                try:
                    assert_copy(text)  # a number that contradicts the approved facts (a price, the altitude) is refused
                except ValueError as err:
                    raise CommentsError(f"{k}: {err}", "unapproved") from None
        cur["topics"][k] = {"ja": ja, "en": en, "saved": True, "at": _iso(_now())}
    if "link" in req:
        link = str(req.get("link") or "").strip()
        if link and not re.match(r"^https://[^\s]+$", link):
            raise CommentsError("link: an https:// address", "bad_input")
        cur["link"] = link
    ANSWERS.parent.mkdir(parents=True, exist_ok=True)
    ANSWERS.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return cur


def draft(item: dict, ans: dict | None = None) -> dict:
    """{text, from: [topics], missing: [topics], auto: bool}. A reply made only of the owner's answers; nothing for
    praise, spam or a comment on no known topic (the owner writes those, or leaves them)."""
    ans = ans or answers()
    kind, lang, topics = item.get("kind"), item.get("lang") or "en", list(item.get("topics") or [])[:2]
    if kind != "question" or not topics:
        return {"text": "", "from": [], "missing": [], "auto": False}
    parts, used, missing = [], [], []
    for t in topics:
        a = (ans["topics"].get(t) or {}).get(lang) or ""
        if a:
            parts.append(a)
            used.append(t)
        else:
            missing.append(t)
    if not parts:
        return {"text": "", "from": [], "missing": missing, "auto": False}
    link = ans.get("link") or ""
    text = (" " if lang == "en" else "").join(parts)
    if link and any(t in LINKED for t in used) and link not in text:
        text = f"{text}\n{link}"
    saved = all((ans["topics"].get(t) or {}).get("saved") for t in used)
    return {"text": text[:MAX_REPLY], "from": used, "missing": missing, "auto": saved and not missing}


# ---------- the store ----------

def _load() -> dict:
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.setdefault("items", {})
    data.setdefault("settings", {"auto": False, "cap": DEFAULT_CAP})
    data.setdefault("networks", {})
    data.setdefault("sent", [])  # [{at, id, auto}]: the day's count for the cap
    return data


def _save(data: dict) -> None:
    cut = _now() - timedelta(days=KEEP_DAYS)
    data["items"] = {k: v for k, v in data["items"].items() if (_when(v.get("at")) or _now()) >= cut}
    data["sent"] = [s for s in data["sent"] if (_when(s.get("at")) or _now()) >= _now() - timedelta(days=2)]
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STORE)


def _merge(data: dict, found: list[dict]) -> int:
    """New comments in; a comment seen before keeps the owner's state (sent, skipped) and takes the fresh counts."""
    new = 0
    for c in found:
        old = data["items"].get(c["id"])
        if old:
            for k in ("likes", "replies", "answered", "canReply", "video", "url"):
                if c.get(k) is not None:
                    old[k] = c[k] if k != "answered" else (old.get("answered") or c[k])
            continue
        c.update(classify(c.get("text") or ""))
        c.setdefault("answered", False)
        data["items"][c["id"]] = c
        new += 1
    return new


# ---------- YouTube ----------

def _yt_posts() -> dict[str, str]:
    """videoId -> the studio reel it is (from the posting log)."""
    out: dict[str, str] = {}
    try:
        from studio import posting
        from studio.perf import youtube_id

        for p in posting.posts():
            if p.get("network") == "youtube":
                vid = youtube_id(p)
                if vid:
                    out[vid] = p["slug"]
    except Exception:  # noqa: BLE001 - no posting log: titles only
        pass
    return out


def _yt_get(path: str, **params) -> tuple[int, dict]:
    from studio import youtube as y

    status, _, body = y._call("GET", f"{YT_API}/{path}?{urllib.parse.urlencode(params)}",
                              headers={"authorization": f"Bearer {y.access_token()}"})
    try:
        return status, json.loads(body or b"{}")
    except ValueError:
        return status, {}


def youtube_fetch() -> tuple[list[dict], dict]:
    from studio import youtube as y

    accts = [a for a in y.accounts() if not a.get("error")]
    if not accts:
        return [], {"ok": False, "need": "connect", "say": "YouTube is not connected (Accounts › Connect YouTube)."}
    reels = _yt_posts()
    out, problems, keep = [], [], y.ACCOUNT
    try:
        for a in accts:
            y.use(a["id"])
            tok = y._load_token() or {}
            if FORCE_SSL not in (tok.get("scopes") or []):
                problems.append({"account": a["id"], "need": "scope"})
                continue
            me = a.get("channelId") or (tok.get("channel") or {}).get("id")
            if not me:
                continue
            status, j = _yt_get("commentThreads", part="snippet,replies", allThreadsRelatedToChannelId=me, maxResults=100,
                                order="time", textFormat="plainText")
            if status != 200:
                msg = ((j.get("error") or {}).get("message") or f"YouTube {status}") if isinstance(j.get("error"), dict) else f"YouTube {status}"
                if status == 403 and "insufficient" in msg.lower():
                    problems.append({"account": a["id"], "need": "scope"})
                else:
                    problems.append({"account": a["id"], "error": msg[:200]})
                continue
            titles = {}
            for t in j.get("items", []):
                s = t.get("snippet") or {}
                top = (s.get("topLevelComment") or {})
                ts = top.get("snippet") or {}
                author = (ts.get("authorChannelId") or {}).get("value")
                vid = s.get("videoId") or ts.get("videoId") or ""
                titles.setdefault(vid, None)
                if author == me:
                    continue  # the channel's own comment (the series' "next part" note)
                replies = (t.get("replies") or {}).get("comments") or []
                ours = any(((r.get("snippet") or {}).get("authorChannelId") or {}).get("value") == me for r in replies)
                out.append({"id": f"youtube:{top.get('id')}", "network": "youtube", "native": top.get("id"), "account": a["id"],
                            "author": ts.get("authorDisplayName") or "", "authorUrl": ts.get("authorChannelUrl") or "",
                            "text": ts.get("textOriginal") or ts.get("textDisplay") or "", "at": ts.get("publishedAt") or "",
                            "likes": int(ts.get("likeCount") or 0), "replies": int(s.get("totalReplyCount") or 0),
                            "canReply": bool(s.get("canReply", True)), "answered": ours,
                            "video": {"id": vid, "slug": reels.get(vid)},
                            "url": f"https://www.youtube.com/watch?v={vid}&lc={top.get('id')}"})
            want = [v for v in titles if v]
            for k in range(0, len(want), 50):
                st, vj = _yt_get("videos", part="snippet", id=",".join(want[k:k + 50]))
                if st == 200:
                    for v in vj.get("items", []):
                        titles[v["id"]] = (v.get("snippet") or {}).get("title")
            for c in out:
                if c["network"] == "youtube" and c["account"] == a["id"]:
                    c["video"]["title"] = titles.get(c["video"]["id"])
    finally:
        y.use(keep)
    if problems and not out and all(p.get("need") == "scope" for p in problems):
        return [], {"ok": False, "need": "scope",
                    "say": "YouTube needs one more permission to read and answer comments: Accounts › YouTube › Connect again, and allow managing your videos' comments."}
    errs = [p["error"] for p in problems if p.get("error")]
    return out, {"ok": not errs, "say": "; ".join(errs) if errs else "", "need": "scope" if any(p.get("need") == "scope" for p in problems) else None}


def youtube_reply(item: dict, text: str) -> dict:
    from studio import youtube as y

    keep = y.ACCOUNT
    try:
        y.use(item.get("account") or "main")
        tok = y._load_token() or {}
        if FORCE_SSL not in (tok.get("scopes") or []):
            raise CommentsError("YouTube needs one more permission to answer comments: Accounts › YouTube › Connect again.", "scope", 409)
        made = y._post("comments", {"snippet": {"parentId": item["native"], "textOriginal": text}}, part="snippet")
    finally:
        y.use(keep)
    return {"id": made.get("id")}


# ---------- Bluesky ----------

def _bsky_web(uri: str, handle: str) -> str:
    m = re.match(r"^at://([^/]+)/app\.bsky\.feed\.post/([\w]+)$", uri or "")
    return f"https://bsky.app/profile/{handle or (m.group(1) if m else '')}/post/{m.group(2)}" if m else ""


def bluesky_fetch() -> tuple[list[dict], dict]:
    from studio.connectors import bluesky as b

    if not b.status().get("connected"):
        return [], {"ok": False, "need": "connect", "say": "Bluesky is not connected (Accounts › Bluesky)."}
    try:
        did, pds, _handle, call = b.account()
    except RuntimeError as err:
        return [], {"ok": False, "say": str(err)[:200]}
    q = urllib.parse.urlencode([("limit", "50"), ("reasons", "reply"), ("reasons", "mention"), ("reasons", "quote")])
    status, _, body = call("GET", f"{pds}/xrpc/app.bsky.notification.listNotifications?{q}")
    if status != 200:
        return [], {"ok": False, "say": b._xrpc_error(status, body)[:200]}
    j = json.loads(body or b"{}")
    out = []
    for n in j.get("notifications", []):
        author = n.get("author") or {}
        if author.get("did") == did:
            continue
        rec = n.get("record") or {}
        parent = {"uri": n.get("uri"), "cid": n.get("cid")}
        root = ((rec.get("reply") or {}).get("root")) or parent
        replying_to = ((rec.get("reply") or {}).get("parent") or {}).get("uri") or ""
        out.append({"id": f"bluesky:{n.get('uri')}", "network": "bluesky", "native": n.get("uri"),
                    "author": author.get("displayName") or author.get("handle") or "", "authorUrl": f"https://bsky.app/profile/{author.get('handle')}",
                    "text": rec.get("text") or "", "at": rec.get("createdAt") or n.get("indexedAt") or "", "reason": n.get("reason"),
                    "likes": None, "replies": None, "canReply": True, "answered": False,
                    # a reply to someone else's reply under the post is a conversation between them: shown, never answered by itself
                    "toUs": n.get("reason") != "reply" or replying_to.startswith(f"at://{did}/"),
                    "target": {"root": root, "parent": parent},
                    "video": {"id": root.get("uri"), "slug": None}, "url": _bsky_web(n.get("uri"), author.get("handle"))})
    return out, {"ok": True, "say": ""}


def bluesky_reply(item: dict, text: str) -> dict:
    from studio.connectors import bluesky as b

    try:
        b.check_text(text)
    except (ValueError, RuntimeError) as err:
        raise CommentsError(f"Bluesky: {err}", "too_long") from None
    did, pds, _handle, call = b.account()
    record = {"$type": "app.bsky.feed.post", "text": text, "createdAt": _now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
              "langs": b._langs(text), "reply": {"root": item["target"]["root"], "parent": item["target"]["parent"]}}
    f = b.facets(text)
    if f:
        record["facets"] = f
    status, _, body = call("POST", f"{pds}/xrpc/com.atproto.repo.createRecord",
                           data=json.dumps({"repo": did, "collection": "app.bsky.feed.post", "record": record}).encode("utf-8"),
                           headers={"content-type": "application/json"})
    if status != 200:
        raise CommentsError(f"Bluesky did not take the reply: {b._xrpc_error(status, body)}", "network", 502)
    return {"id": json.loads(body or b"{}").get("uri")}


# ---------- Facebook Page ----------

def _fb_perm_error(j: dict) -> bool:
    e = j.get("error") if isinstance(j.get("error"), dict) else {}
    return e.get("code") in (10, 200, 190) or "permission" in str(e.get("message", "")).lower()


def facebook_fetch() -> tuple[list[dict], dict]:
    from studio.connectors import facebook as f

    try:
        creds = f._load()
    except Exception:  # noqa: BLE001
        creds = None
    if not creds or not creds.get("token"):
        return [], {"ok": False, "need": "connect", "say": "Facebook is not connected (Accounts › Facebook)."}
    from studio import posting
    from studio.perf import facebook_id

    page, token = str(creds.get("page_id") or ""), creds["token"]
    out, errors = [], []
    posts = [p for p in posting.posts() if p.get("network") == "facebook" and p.get("status") == "posted"]
    for p in posts[-40:]:
        oid = facebook_id(p)
        if not oid:
            continue
        status, _, body = f._get(f"{oid}/comments", token, fields="id,message,from{id,name},created_time,like_count,comment_count,can_comment,parent{id}",
                                 filter="stream", order="reverse_chronological", limit="50")
        j = json.loads(body or b"{}") if body else {}
        if status != 200:
            if _fb_perm_error(j):
                return [], {"ok": False, "need": "scope",
                            "say": "Facebook needs two more permissions to read and answer comments (pages_read_user_content, pages_manage_engagement): Accounts › Facebook › Connect again."}
            errors.append(f"Facebook {status}")
            continue
        rows = j.get("data") or []
        answered = {((r.get("parent") or {}).get("id")) for r in rows if str((r.get("from") or {}).get("id")) == page}
        for r in rows:
            frm = r.get("from") or {}
            if str(frm.get("id")) == page or (r.get("parent") or {}).get("id"):
                continue  # the Page's own words, and replies inside a thread
            out.append({"id": f"facebook:{r.get('id')}", "network": "facebook", "native": r.get("id"),
                        "author": frm.get("name") or "", "authorUrl": "", "text": r.get("message") or "", "at": r.get("created_time") or "",
                        "likes": r.get("like_count"), "replies": r.get("comment_count"), "canReply": bool(r.get("can_comment", True)),
                        "answered": r.get("id") in answered, "video": {"id": oid, "slug": p.get("slug")},
                        "url": f"https://www.facebook.com/{r.get('id')}"})
    return out, {"ok": not errors, "say": "; ".join(sorted(set(errors)))}


def facebook_reply(item: dict, text: str) -> dict:
    from studio.connectors import facebook as f

    creds = f._load() or {}
    status, _, body = f._post_form(f"{item['native']}/comments", creds.get("token") or "", {"message": text})
    j = json.loads(body or b"{}") if body else {}
    if status != 200:
        if _fb_perm_error(j):
            raise CommentsError("Facebook needs permission to answer comments (pages_manage_engagement): Accounts › Facebook › Connect again.", "scope", 409)
        raise CommentsError(f"Facebook did not take the reply ({status}).", "network", 502)
    return {"id": j.get("id")}


FETCH = {"youtube": youtube_fetch, "bluesky": bluesky_fetch, "facebook": facebook_fetch}
REPLY = {"youtube": youtube_reply, "bluesky": bluesky_reply, "facebook": facebook_reply}


# ---------- actions ----------

def check(req: dict | None = None) -> dict:
    """Read every network's new comments, then (when the owner turned it on) answer the plain questions."""
    req = req or {}
    data = _load()
    found_total = new_total = 0
    for net, fetch in FETCH.items():
        try:
            found, state = fetch()
        except CommentsError as err:
            found, state = [], {"ok": False, "say": str(err)}
        except Exception as err:  # noqa: BLE001 - one network down never stops the others
            found, state = [], {"ok": False, "say": f"{type(err).__name__}: {str(err)[:160]}"}
        new_total += _merge(data, found)
        found_total += len(found)
        # what the list keeps (the last KEEP_DAYS): "100 comments" read on old videos showed beside an empty list
        cut = _now() - timedelta(days=KEEP_DAYS)
        kept = sum(1 for c in found if (_when(c.get("at")) or _now()) >= cut)
        data["networks"][net] = {**state, "checked": _iso(_now()), "count": kept, "older": len(found) - kept}
    data["checked"] = _iso(_now())
    _save(data)
    sent = auto_answer() if data["settings"].get("auto") else []
    out = view()
    out["new"] = new_total
    out["autoSent"] = sent
    return out


def _sent_today(data: dict) -> list[dict]:
    day = _now().astimezone(JST).date()
    return [s for s in data["sent"] if s.get("auto") and (_when(s.get("at")) or _now()).astimezone(JST).date() == day]


def auto_ok(item: dict, d: dict, data: dict, now: datetime | None = None) -> str | None:
    """Why this comment is not answered by itself (None: it may be). The rules in the module note."""
    now = now or _now()
    at = _when(item.get("at"))
    if item.get("answered") or item.get("skipped") or item.get("reply"):
        return "answered"
    if item.get("kind") != "question":
        return "not a question"
    if not d.get("auto") or not d.get("text"):
        return "no saved answer for this"
    if item.get("toUs") is False:
        return "a conversation between other people"
    if not item.get("canReply", True):
        return "replies are closed"
    if not at or (now - at).total_seconds() < AUTO_WAIT:
        return "too new"
    if (now - at).total_seconds() > AUTO_MAX_AGE:
        return "too old"
    today = _sent_today(data)
    if len(today) >= int(data["settings"].get("cap") or DEFAULT_CAP):
        return "today's limit"
    who = item.get("author") or ""
    if who and any(s.get("author") == who and s.get("network") == item.get("network") for s in today):
        return "already answered this person today"
    # The same words twice in a day reads as a template (YouTube's spam policy: "repetitive or templated" comments):
    # the second one waits for the owner, who can say it differently.
    day_ago = now - timedelta(hours=24)
    if any(s.get("text") == d["text"] for s in data["sent"] if s.get("auto") and (_when(s.get("at")) or now) >= day_ago):
        return "the same answer went out in the last day"
    return None


def auto_answer(now: datetime | None = None) -> list[dict]:
    data = _load()
    ans = answers()
    sent = []
    for item in sorted(data["items"].values(), key=lambda x: x.get("at") or ""):
        d = draft(item, ans)
        if auto_ok(item, d, data, now):
            continue
        try:
            got = REPLY[item["network"]](item, d["text"])
        except Exception as err:  # noqa: BLE001 - leave it for the owner, say why
            item["autoError"] = str(err)[:200]
            continue
        item["reply"] = {"text": d["text"], "at": _iso(_now()), "auto": True, "id": got.get("id")}
        item["answered"] = True
        data["sent"].append({"at": _iso(_now()), "id": item["id"], "auto": True, "author": item.get("author"), "network": item["network"], "text": d["text"]})
        sent.append({"id": item["id"], "network": item["network"], "text": d["text"]})
        _save(data)  # one at a time: a crash never sends the same answer twice
    return sent


def reply(req: dict) -> dict:
    data = _load()
    item = data["items"].get(str(req.get("id") or ""))
    if not item:
        raise CommentsError("no such comment; check again", "not_found", 404)
    text = _plain(str(req.get("text") or ""))
    if not text:
        raise CommentsError("text: the reply is empty", "bad_input")
    if len(text) > MAX_REPLY:
        raise CommentsError(f"text: at most {MAX_REPLY} characters", "bad_input")
    if item.get("reply"):
        raise CommentsError("this comment has a reply from the studio already", "answered", 409)
    if item["network"] not in REPLY:
        raise CommentsError(f"{item['network']}: answer on the network itself", "unsupported")
    got = REPLY[item["network"]](item, text)
    item["reply"] = {"text": text, "at": _iso(_now()), "auto": False, "id": got.get("id")}
    item["answered"] = True
    data["sent"].append({"at": _iso(_now()), "id": item["id"], "auto": False, "author": item.get("author"), "network": item["network"]})
    _save(data)
    return {"ok": True, "item": _item_view(item, answers())}


def skip(req: dict) -> dict:
    data = _load()
    item = data["items"].get(str(req.get("id") or ""))
    if not item:
        raise CommentsError("no such comment", "not_found", 404)
    item["skipped"] = req.get("on") is not False
    _save(data)
    return {"ok": True, "item": _item_view(item, answers())}


def settings(req: dict) -> dict:
    data = _load()
    if "auto" in req:
        data["settings"]["auto"] = req.get("auto") is True
    if "cap" in req:
        try:
            cap = int(req.get("cap"))
        except (TypeError, ValueError):
            raise CommentsError("cap: a whole number from 1 to 30", "bad_input") from None
        if not 1 <= cap <= 30:
            raise CommentsError("cap: a whole number from 1 to 30", "bad_input")
        data["settings"]["cap"] = cap
    _save(data)
    return view()


def _state(item: dict) -> str:
    if item.get("reply") or item.get("answered"):
        return "answered"
    if item.get("skipped"):
        return "skipped"
    if item.get("kind") in ("spam", "reaction"):
        return "quiet"
    return "open"


def _item_view(item: dict, ans: dict) -> dict:
    v = {k: item.get(k) for k in ("id", "network", "author", "authorUrl", "text", "at", "likes", "replies", "kind", "topics",
                                  "lang", "url", "video", "reply", "skipped", "answered", "canReply", "toUs", "autoError", "reason")}
    v["state"] = _state(item)
    v["draft"] = draft(item, ans) if v["state"] == "open" else None
    return v


def view(req: dict | None = None) -> dict:
    data = _load()
    ans = answers()
    items = [_item_view(i, ans) for i in data["items"].values()]
    order = {"open": 0, "answered": 1, "skipped": 2, "quiet": 3}
    items.sort(key=lambda x: (order[x["state"]], -(_when(x.get("at")) or _now()).timestamp()))
    counts = {s: sum(1 for x in items if x["state"] == s) for s in order}
    counts["questions"] = sum(1 for x in items if x["state"] == "open" and x["kind"] == "question")
    return {"items": items, "counts": counts, "networks": data["networks"], "checked": data.get("checked"),
            "settings": {**data["settings"], "sentToday": len(_sent_today(data)), "wait": AUTO_WAIT // 60},
            "answers": ans, "topics": TOPIC_ORDER,
            "unsupported": ["tiktok", "x", "instagram", "linkedin", "pinterest", "gbp", "line-oa"]}


def run(action: str, req: dict) -> object:
    if action == "view":
        return view(req)
    if action == "check":
        return check(req)
    if action == "reply":
        return reply(req)
    if action == "skip":
        return skip(req)
    if action == "answers":
        return answers()
    if action == "save-answers":
        return save_answers(req)
    if action == "settings":
        return settings(req)
    raise CommentsError(f"unknown action {action!r}", "bad_input")


def main(argv: list[str] | None = None) -> int:
    from studio.perf import _scrub

    argv = sys.argv[1:] if argv is None else argv
    action = argv[0] if argv else ""
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            req = json.loads(raw or "{}")
        except ValueError:
            raise CommentsError("The request was not valid JSON.", "bad_input") from None
        if not isinstance(req, dict):
            raise CommentsError("The request must be a JSON object.", "bad_input")
        out = {"ok": True, "data": run(action, req)}
    except CommentsError as err:
        out = {"ok": False, "error": _scrub(str(err)), "code": err.code, "status": err.status}
    except RuntimeError as err:  # a network said no in its own words (sign-in ran out, quota)
        out = {"ok": False, "error": _scrub(str(err)), "code": "network", "status": 502}
    except Exception as err:  # noqa: BLE001 - a bug: keep the type and place, never a token
        import traceback

        where = traceback.extract_tb(err.__traceback__)[-1]
        out = {"ok": False, "error": _scrub(f"Comments stopped on a problem in the studio: {type(err).__name__}: {err} ({Path(where.filename).name}:{where.lineno})"),
               "code": "bug", "status": 500}
    sys.stdout.write("RESULT " + json.dumps(out, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
