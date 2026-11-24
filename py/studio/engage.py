"""
FILE: py/studio/engage.py
PURPOSE: "Reply to these today" (BL-100): a short list of recent Japanese Bluesky posts in the project's topics that
         are worth a real reply by hand, and a few accounts worth following. On Bluesky a new account is found by
         replying and following in its niche, not by posting more.
OVERVIEW: READ-ONLY. Nothing here posts, likes, follows or replies; the owner opens each post on Bluesky and answers it
          there. One refresh searches each topic once (app.bsky.feed.searchPosts, lang=ja, sort=latest, the last 48 h),
          keeps posts with real text, not replies, ads, announcements or off-topic fandom, not the project's own account,
          one post per author, from small and medium accounts (10-5,000 followers, app.bsky.actor.getProfiles) where a
          reply is seen, and ranks them by how many of the niche's words they use (NICHE), some engagement, freshness
          and how many topics they touch. Follow suggestions are other people in the niche (a reply in a thread counts
          too) not followed yet. The answer is cached for an hour in
          <STUDIO_DATA>/engage/bluesky.json; `fresh: true` reads again. When a refresh fails, the last list comes back
          marked stale.
DEPENDENCIES: Python stdlib, studio.config (DATA), studio.youtube (_call: HTTPS), studio.connectors.bluesky (the
              signed-in account, only when the public host refuses search)
USAGE: python -m studio.engage bluesky   (request JSON on stdin: {"fresh": true} or {})
       prints one line: RESULT {"ok": true, "data": {...}}
                     or RESULT {"ok": false, "error": "<one plain sentence>", "code": "...", "status": 4xx|5xx}
TECHNICAL DETAILS (read 2026-11-24, https://endpoints.bsky.app/openapi.bluesky-app.json; docs.bsky.app's API pages
  now redirect there):
  GET /xrpc/app.bsky.feed.searchPosts?q=&lang=ja&sort=latest|top&limit=1..100&since=<ISO datetime>
      -> {cursor?, hitsTotal?, posts: [postView]}. postView: {uri, cid, author: {did, handle, displayName, labels},
      record: {text, createdAt, langs, reply?}, replyCount, repostCount, likeCount, quoteCount, indexedAt, labels,
      viewer?: {replyDisabled}}. The spec says search "may require authentication for some service providers":
      public.api.bsky.app answers 403 to it without a session (probed 24 Nov), so the first 401/403 switches the
      rest of the refresh to the account's own server (the connector's session) with
      atproto-proxy: did:web:api.bsky.app#bsky_appview. Every request is a GET.
  GET /xrpc/app.bsky.actor.getProfiles?actors=<up to 25> -> {profiles: [{did, handle, displayName, description,
      followersCount, followsCount, postsCount, labels, viewer?: {following}}]}.
  Politeness: at most one probe of the public host, one search per topic, three profile reads (15 requests), 0.3 s apart, a plain
  User-Agent "LazycowStudio", and one refresh an hour unless a person asks for a fresh one.
NOTES: Web links are https://bsky.app/profile/<handle>/post/<rkey> (rkey = the last part of the at:// uri).
       Copy in this module never uses the word キャンプ場 (a brand rule); the topics are search words only.
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from studio.config import DATA, RANCH, ranch_data

PUBLIC = "https://public.api.bsky.app/xrpc"
APPVIEW = "did:web:api.bsky.app#bsky_appview"
UA = "LazycowStudio"
# What the ranch's audience talks about (shared/ranch/copy.json "engage", part of the ranch overlay). One search each
# per refresh. Plain words, not hashtags: a word also finds the
# hashtag, and Japanese Bluesky tags little (24 Nov: "#車中泊" found 0 posts in 48 h, "#キャンプ" 40, 37 of them one shop's ads).
# "#星空" stays a hashtag: the plain word is mostly illustrations and games, the tag is night-sky photographers.
# Any other project searches its own hashtags and place names (_own_topics).
_RANCH: dict = ((ranch_data("copy", {}) or {}).get("engage") or {}) if RANCH else {}
TOPICS: list[str] = list(_RANCH.get("topics") or [])
# Words of the ranch's world (an outdoor night, cold, mountains, working away). How many a post uses is its relevance:
# it counts for more than likes, so a family's first night in a tent beats a popular drawing that mentions a campfire.
# Any other project's niche is its own topic words.
NICHE: tuple = tuple(_RANCH.get("niche") or ())


def _own_topics() -> list[str]:
    """Another project's topics: its own hashtags (as plain words) and its home place's names (studio.brand)."""
    from studio.brand import brand, home_place

    words = [t.lstrip("#") for t in brand()["tags"]] + list((home_place() or {}).get("names") or [])
    return [w for w in dict.fromkeys(w.strip() for w in words) if w][:10]
# Not the niche even though a topic word is in it: drawings and AI pictures, games, pro sports camps, crowdfunding, a meme.
OFFTOPIC = re.compile(r"#(oc|AIイラスト|AIart|aiart|イラスト|お絵描き|息抜きお絵描き|絵描きさんと繋がりたい|VRChat|ポケ森|NIKKE)\b"
                      r"|AIイラスト|【GPT|CAMPFIRE|キャンプファイヤー|プロ野球|秋季キャンプ|春季キャンプ|球団|ここをキャンプ地"
                      r"|ホロライブ|VTuber|生誕祭|参戦", re.I)
# Profiles that are a business or a come-on, not a person to talk with.
SPAMMY = re.compile(r"風俗|ヘルス|デリヘル|ソープ|出会い|副業|稼げ|投資|FX|仮想通貨|アフィリエイト|楽天ROOM|セール情報|お得情報"
                    r"|相互支援|相互フォロー|フォロバ|SEO", re.I)
WINDOW_H = 48
FOLLOWERS = (10, 5000)          # small and medium accounts: a reply there is read
SWEET = (30, 1500)              # the best of them
REPLY_N, FOLLOW_N = 12, 6
PER_QUERY = 100                 # the most one search returns: still one request per topic
PROFILE_AUTHORS = 75            # three getProfiles calls
CACHE_TTL = 3600
PAUSE = 0.3
BOT_POSTS = 8                   # more matching posts than this in 48 h reads as a bot or a feed account
FOLLOW_NICHE = 3                # niche words (best post + profile) before an account is suggested as a follow
EXCERPT = 140
# "!no-unauthenticated" (hide me from logged-out viewers) is not skipped: the list is read signed in and opened by a
# signed-in owner. About a third of the Japanese authors carry it (24 Nov: 110 of 335 posts).
SKIP_LABELS = {"porn", "sexual", "nudity", "graphic-media", "gore", "spam", "!hide", "!warn", "bot"}
AD_TAGS = re.compile(r"#(PR|ad|ads|広告|プロモーション|アフィリエイト)(?![\w])", re.I)
JA = re.compile(r"[぀-ヿ㐀-鿿]")
URL_RX = re.compile(r"https?://\S+")
TAG_RX = re.compile(r"[#＃]\S+")
BOTISH = re.compile(r"bot\b|news|自動投稿|自動配信|ボット|ニュース配信", re.I)   # feeds and news accounts: nobody reads a reply
# Real people in the niche whose post is not a reply target (a reply in a thread, a closed thread): still worth a follow.
FOLLOW_ONLY = {"reply", "closed"}
URI_RX = re.compile(r"^at://([^/]+)/app\.bsky\.feed\.post/([A-Za-z0-9._~:-]+)$")


class EngageError(Exception):
    def __init__(self, message: str, code: str = "error", status: int = 500):
        super().__init__(message)
        self.code, self.status = code, status


# ---------- pure: filter and rank (tests feed searchPosts JSON straight in) ----------

def _when(s) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def post_url(uri: str, handle: str) -> str:
    m = URI_RX.match(uri or "")
    return f"https://bsky.app/profile/{handle or m.group(1)}/post/{m.group(2)}" if m else ""


def excerpt(text: str, n: int = EXCERPT) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def niche(text: str) -> int:
    """How many of the niche's words a text uses (each word once)."""
    return sum(1 for w in NICHE if w in (text or ""))


def _labels(obj: dict) -> set[str]:
    return {str(l.get("val", "")) for l in (obj or {}).get("labels") or [] if isinstance(l, dict)}


def _why_skip(p: dict, now: datetime, own: set[str]) -> str | None:
    """Why a search hit is not worth a reply (None: keep it)."""
    author, rec = p.get("author") or {}, p.get("record") or {}
    if (author.get("did") or "") in own or (author.get("handle") or "").lower() in own:
        return "own"
    text = rec.get("text") or ""
    if not text.strip():
        return "notext"
    langs = rec.get("langs") or []
    if (langs and "ja" not in langs) or not JA.search(text):
        return "lang"
    if (SKIP_LABELS & _labels(p)) or (SKIP_LABELS & _labels(author)):
        return "label"
    if AD_TAGS.search(text):
        return "ad"
    if OFFTOPIC.search(text):
        return "offtopic"
    if text.lstrip().startswith(("【", "[")):
        return "feed"             # 【募集】【公式】【PR】…: an announcement, not a person to talk with
    times =[t for t in (_when(rec.get("createdAt")), _when(p.get("indexedAt"))) if t]
    if not times:
        return "old"
    at = min(times)
    if now - at > timedelta(hours=WINDOW_H) or at - now > timedelta(minutes=10):
        return "old"
    # From here on the author is a real person in the niche (FOLLOW_ONLY): only this post is not a reply target.
    if rec.get("reply") or text.lstrip().startswith("@"):
        return "reply"            # a reply inside someone else's conversation, or a post aimed at one person
    if (p.get("viewer") or {}).get("replyDisabled"):
        return "closed"
    words = TAG_RX.sub(" ", URL_RX.sub(" ", text))
    if len(re.sub(r"\s+", "", words)) < 8:
        return "notext"           # only hashtags or a link: nothing to answer
    return None


def candidates(results: dict[str, dict], now: datetime, own: set[str]) -> tuple[list[dict], dict]:
    """Every search answer ({topic: searchPosts JSON}) flattened to one entry per post with the topics that found it,
    plus how many were skipped and why. `replyable` False: a real person's post that is not a reply target (FOLLOW_ONLY),
    kept so its author can still be suggested as a follow."""
    own = {o.lower() if not o.startswith("did:") else o for o in own if o}
    seen: dict[str, dict] = {}
    skipped: dict[str, int] = {}
    for topic, body in results.items():
        for p in (body or {}).get("posts") or []:
            uri = p.get("uri") or ""
            if not uri:
                continue
            if uri in seen:
                if topic not in seen[uri]["topics"]:
                    seen[uri]["topics"].append(topic)
                continue
            why = _why_skip(p, now, own)
            if why:
                skipped[why] = skipped.get(why, 0) + 1
            if why and why not in FOLLOW_ONLY:
                seen[uri] = {"skip": True, "topics": [topic]}
                continue
            author, rec = p.get("author") or {}, p.get("record") or {}
            at = min(t for t in (_when(rec.get("createdAt")), _when(p.get("indexedAt"))) if t)
            seen[uri] = {
                "uri": uri, "did": author.get("did") or "", "handle": author.get("handle") or "",
                "name": (author.get("displayName") or "").strip(), "url": post_url(uri, author.get("handle") or ""),
                "text": excerpt(rec.get("text") or ""), "at": at.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "ageH": round((now - at).total_seconds() / 3600, 1),
                "likes": int(p.get("likeCount") or 0), "replies": int(p.get("replyCount") or 0),
                "reposts": int(p.get("repostCount") or 0), "quotes": int(p.get("quoteCount") or 0),
                "topics": [topic], "followers": None, "replyable": not why,
                "niche": niche(rec.get("text") or ""), "link": bool(URL_RX.search(rec.get("text") or "") or (p.get("embed") or {}).get("external")),
            }
    return [v for v in seen.values() if not v.get("skip")], skipped


def score(c: dict) -> float:
    """Higher is a better reply target: about the niche (its words count most), some engagement but not a crowded
    thread, a person's own words rather than a shared link, fresh, on several topics, from an account where a reply is
    read."""
    eng = c["likes"] + 2 * c["replies"] + c["reposts"] + c["quotes"]
    s = 0.5 * min(math.log1p(eng), 3.0)   # some engagement helps; a viral post is not more worth a reply
    if eng == 0:
        s -= 0.3
    if c["replies"] >= 15:
        s -= 1.5              # a reply there is lost in the crowd
    s += 0.6 * min(c.get("niche", 1), 5)
    if c.get("link"):
        s -= 0.6              # mostly a shared article or a shop page
    s += 0.35 * (len(c["topics"]) - 1)
    s += 0.8 * max(0.0, 1 - c["ageH"] / WINDOW_H)
    f = c.get("followers")
    if f is not None and SWEET[0] <= f <= SWEET[1]:
        s += 0.4
    return round(s, 3)


def authors_to_look_up(cands: list[dict], n: int = PROFILE_AUTHORS) -> list[str]:
    """The authors worth a profile read (followers, already followed): the best-ranked first, at most n."""
    out: list[str] = []
    for c in sorted(cands, key=lambda c: (c.get("replyable", True), score(c)), reverse=True):
        if c["did"] and c["did"] not in out:
            out.append(c["did"])
        if len(out) >= n:
            break
    return out


def _botlike(profile: dict) -> bool:
    """A feed, a bot, a business or a come-on rather than a person to talk with."""
    who = f"{profile.get('displayName') or ''} {profile.get('handle') or ''} {profile.get('description') or ''}"
    return bool(BOTISH.search(who) or SPAMMY.search(who))


def rank(cands: list[dict], profiles: dict[str, dict], reply_n: int = REPLY_N, follow_n: int = FOLLOW_N) -> dict:
    """The reply list (one post per author) and the accounts to follow, from the candidates and the authors' profiles
    ({did: getProfiles entry}). Without any profile (the read failed) the band cannot be checked: posts stay, unsized."""
    known = bool(profiles)
    per_author: dict[str, list[dict]] = {}
    for c in cands:
        per_author.setdefault(c["did"], []).append(c)
    kept: list[dict] = []
    for c in cands:
        if not c.get("replyable", True):
            continue
        prof = profiles.get(c["did"])
        if prof is not None:
            c["followers"] = int(prof.get("followersCount") or 0)
            if not FOLLOWERS[0] <= c["followers"] <= FOLLOWERS[1] or _botlike(prof) or (SKIP_LABELS & _labels(prof)):
                continue
        elif known:
            continue              # an author outside the looked-up best: not shown without a follower count
        if len(per_author[c["did"]]) > BOT_POSTS:
            continue
        c["score"] = score(c)
        kept.append(c)
    kept.sort(key=lambda c: (c["score"], -c["ageH"]), reverse=True)
    reply, used = [], set()
    for c in kept:
        if c["did"] in used:
            continue
        used.add(c["did"])
        reply.append({k: v for k, v in c.items() if k != "replyable"})
        if len(reply) >= reply_n:
            break
    follow = []
    for did, posts in per_author.items():
        prof = profiles.get(did)
        if not prof or did in used or (prof.get("viewer") or {}).get("following") or len(posts) > BOT_POSTS:
            continue
        f = int(prof.get("followersCount") or 0)
        if not FOLLOWERS[0] <= f <= FOLLOWERS[1] or _botlike(prof) or (SKIP_LABELS & _labels(prof)):
            continue
        words = max(p.get("niche", 1) for p in posts) + niche(prof.get("description") or "")
        if words < FOLLOW_NICHE:
            continue              # one passing mention of a topic word is not someone in the niche
        topics = sorted({t for p in posts for t in p["topics"]})
        eng = sum(p["likes"] + 2 * p["replies"] + p["reposts"] for p in posts)
        s = (min(len(posts), 4) + 0.5 * len(topics) + 0.4 * min(words, 5) + (0.4 if SWEET[0] <= f <= SWEET[1] else 0)
             + 0.3 * math.log1p(eng))
        follow.append({"did": did, "handle": prof.get("handle") or posts[0]["handle"],
                       "name": (prof.get("displayName") or "").strip(), "followers": f, "posts": len(posts),
                       "topics": topics, "about": excerpt(prof.get("description") or "", 80),
                       "url": f"https://bsky.app/profile/{prof.get('handle') or did}", "score": round(s, 3)})
    follow.sort(key=lambda a: a["score"], reverse=True)
    return {"posts": reply, "follow": follow[:follow_n]}


# ---------- network (tests replace _http and _account) ----------

def _http(method: str, url: str, *, headers: dict | None = None, timeout: int = 20):
    from studio.youtube import _call

    try:
        return _call(method, url, headers=headers, timeout=timeout)
    except OSError as err:
        raise EngageError(f"could not reach Bluesky ({getattr(err, 'reason', err)}); check the internet connection", "offline", 502) from None


def _account():
    """(did, pds, handle, call) of the connected Bluesky account, or None when it is not connected."""
    from studio.connectors import bluesky as b

    if not b.status().get("connected"):
        return None
    try:
        return b.account()
    except RuntimeError as err:
        raise EngageError(f"the Bluesky sign-in could not be used ({err})", "connect", 409) from None


def _own_handle() -> str:
    try:
        from studio.connectors import bluesky as b

        return (b.status().get("account") or "").lstrip("@").lower()
    except Exception:
        return ""


class Reader:
    """GETs to the AppView: the public host first; after a 401/403 there, the signed-in account's own server."""

    def __init__(self):
        self.via = "public"
        self.acct = None
        self.calls = 0

    def get(self, method: str, params: list[tuple[str, str]]) -> dict:
        q = urllib.parse.urlencode(params)
        if self.calls:
            time.sleep(PAUSE)
        self.calls += 1
        if self.via == "public":
            status, _, body = _http("GET", f"{PUBLIC}/{method}?{q}", headers={"user-agent": UA, "accept": "application/json"})
            if status not in (401, 403):
                return self._read(status, body)
            self.acct = _account()
            if not self.acct:
                raise EngageError("Bluesky's search now needs a signed-in account. Connect Bluesky in Accounts "
                                  "(the studio only reads; nothing is posted, liked or followed).", "connect", 409)
            self.via = "session"
            time.sleep(PAUSE)
            self.calls += 1
        _did, pds, _handle, call = self.acct
        status, _, body = call("GET", f"{pds}/xrpc/{method}?{q}",
                               headers={"user-agent": UA, "accept": "application/json", "atproto-proxy": APPVIEW}, timeout=20)
        return self._read(status, body)

    @staticmethod
    def _read(status: int, body: bytes) -> dict:
        try:
            j = json.loads((body or b"{}").decode("utf-8") or "{}")
        except ValueError:
            j = {}
        if status == 429:
            raise EngageError("Bluesky asked the studio to slow down; try again in a few minutes.", "rate", 429)
        if status != 200:
            msg = j.get("message") or j.get("error") or f"HTTP {status}"
            raise EngageError(f"Bluesky answered {status}: {msg}"[:200], "upstream", 502)
        return j


def _cache_file() -> Path:
    return DATA / "engage" / "bluesky.json"


def _cache_read() -> dict | None:
    try:
        return json.loads(_cache_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _cache_write(data: dict) -> None:
    f = _cache_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps({"at": time.time(), "data": data}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(f)


def gather(now: datetime | None = None, topics: list[str] | None = None) -> dict:
    """One refresh: search each topic, read the best authors' profiles, filter and rank."""
    now = now or datetime.now(timezone.utc)
    topics = topics or TOPICS or _own_topics()
    r = Reader()
    since = (now - timedelta(hours=WINDOW_H)).isoformat(timespec="seconds").replace("+00:00", "Z")
    results: dict[str, dict] = {}
    failed: list[str] = []
    for t in topics:
        try:
            results[t] = r.get("app.bsky.feed.searchPosts", [("q", t), ("lang", "ja"), ("sort", "latest"),
                                                              ("limit", str(PER_QUERY)), ("since", since)])
        except EngageError as err:
            if err.code in ("connect", "rate", "offline") and not results:
                raise
            failed.append(t)
            if err.code == "rate":
                break
    own = {_own_handle()}
    if r.acct:
        own |= {r.acct[0], (r.acct[2] or "").lower()}
    cands, skipped = candidates(results, now, own)
    profiles: dict[str, dict] = {}
    dids = authors_to_look_up(cands)
    for i in range(0, len(dids), 25):
        try:
            got = r.get("app.bsky.actor.getProfiles", [("actors", d) for d in dids[i:i + 25]])
        except EngageError:
            break                 # the list still comes back, without follower counts
        for p in got.get("profiles") or []:
            profiles[p.get("did")] = p
    out = rank(cands, profiles)
    seen = sum(len((b or {}).get("posts") or []) for b in results.values())
    return {**out, "generatedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"), "via": r.via,
            "account": ("@" + (r.acct[2] if r.acct else _own_handle())).rstrip("@"), "topics": topics,
            "searched": len(results), "failed": failed, "seen": seen, "candidates": len(cands), "skipped": skipped,
            "requests": r.calls, "windowHours": WINDOW_H, "followers": list(FOLLOWERS)}


def bluesky(req: dict | None = None) -> dict:
    req = req or {}
    hit = _cache_read()
    if hit and not req.get("fresh") and time.time() - float(hit.get("at", 0)) < CACHE_TTL:
        return {**hit["data"], "cached": True, "ageMin": round((time.time() - float(hit["at"])) / 60)}
    try:
        data = gather()
    except EngageError as err:
        if hit:   # the last list, marked stale, beats an empty page
            return {**hit["data"], "cached": True, "stale": True, "ageMin": round((time.time() - float(hit.get("at", 0))) / 60),
                    "note": str(err), "code": err.code}
        raise
    _cache_write(data)
    return {**data, "cached": False, "ageMin": 0}


ACTIONS = {"bluesky": bluesky}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    action = argv[0] if argv else ""
    try:
        if action not in ACTIONS:
            raise EngageError(f"unknown engage action {action}", "bad_input", 400)
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            req = json.loads(raw or "{}")
        except ValueError:
            raise EngageError("The request was not valid JSON.", "bad_input", 400) from None
        out = {"ok": True, "data": ACTIONS[action](req if isinstance(req, dict) else {})}
    except EngageError as err:
        out = {"ok": False, "error": str(err), "code": err.code, "status": err.status}
    except Exception as err:  # a bug: keep the type and place so it can be fixed
        import traceback

        where = traceback.extract_tb(err.__traceback__)[-1]
        out = {"ok": False, "error": f"Reply list stopped on a problem in the studio: {type(err).__name__}: {err} ({Path(where.filename).name}:{where.lineno})",
               "code": "bug", "status": 500}
    sys.stdout.write("RESULT " + json.dumps(out, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
