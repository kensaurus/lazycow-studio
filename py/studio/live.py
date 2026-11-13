"""
FILE: py/studio/live.py
PURPOSE: Did every booked post really go out? Confirm it, flag the ones that never appeared, send late ones the
         studio holds itself after a restart, tidy failures a newer booking replaced, and check sign-ins before a
         post fails. The settings the person controls on Posting › Runs by itself live here too.
OVERVIEW: A post is "scheduled" (a network holds it) or "queued" (the studio sends it) until it is seen live:
          - seen(): a reading of its numbers (studio.perf.store), or the network's own API (check_api: YouTube's
            privacyStatus turns public; Facebook's publishing_phase.publish_status turns "published", per Meta's Reels
            publishing guide) marks it "posted" with its link and seen_at. The browser reader (server/helper.mjs)
            reports X, TikTok, Google Maps, LinkedIn and LINE posts it finds the same way.
          - missing(): still not seen `missing_after_h` hours after its time (default 6) -> "missing", with why.
            A person can then book it again or say it is out (posting.done).
          - catch_up(): after the PC was off, a queued post at most `grace_h` late is sent; an older one is "missed".
          - tidy(): a failed row whose network and day hold a newer booking is "replaced" (it is history, not a gap).
          - health(): the API sign-ins (Facebook token expiry, YouTube refresh, Bluesky session) a day ahead.
DEPENDENCIES: studio.posting, studio.config (DATA); studio.youtube, studio.connectors.* only when asked
USAGE: python -m studio live check|catch-up|tidy|health|settings
NOTES: Nothing here posts or books: it only reads, and changes the studio's own record. Every change has a note
       saying what was seen and when, so the Posting page can show it.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from studio import posting
from studio.config import DATA

SETTINGS_FILE = DATA / "autopost.json"
# What runs by itself, and how. Every key can be changed on Posting › Runs by itself (POST /api/autopost).
DEFAULTS: dict = {
    "plan": {"on": True, "networks": [], "aheadDays": 14, "tiktokAheadDays": 9, "hour": 9},
    "verify": {"on": True, "missingAfterH": 6},
    "catchUp": {"on": True, "graceH": 2},
    "tidy": {"on": True},
    "health": {"on": True, "warnDays": 3},
}
HOLDS = ("scheduled", "queued")


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _when(at: str | None) -> datetime | None:
    if not at:
        return None
    try:
        t = datetime.fromisoformat(at)
    except ValueError:
        return None
    return t if t.tzinfo else t.astimezone()


# ---------- settings ----------

def settings() -> dict:
    """The saved settings over the defaults, one level deep (so a new default key appears by itself)."""
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    out = {}
    for k, v in DEFAULTS.items():
        mine = saved.get(k) if isinstance(saved.get(k), dict) else {}
        out[k] = {**v, **{kk: vv for kk, vv in mine.items() if kk in v}}
    return out


def save_settings(fields: dict) -> dict:
    """Change some settings: {plan: {on: false}, verify: {missingAfterH: 8}, ...}. Unknown keys are refused."""
    cur = settings()
    for k, v in (fields or {}).items():
        if k not in DEFAULTS or not isinstance(v, dict):
            raise ValueError(f"{k}: one of {', '.join(DEFAULTS)}")
        for kk, vv in v.items():
            if kk not in DEFAULTS[k]:
                raise ValueError(f"{k}.{kk}: not a setting")
            want = DEFAULTS[k][kk]
            if isinstance(want, bool):
                vv = bool(vv)
            elif isinstance(want, int):
                try:
                    vv = int(vv)
                except (TypeError, ValueError):
                    raise ValueError(f"{k}.{kk}: a whole number") from None
                lo, hi = {"aheadDays": (1, 60), "tiktokAheadDays": (1, 10), "hour": (0, 23), "missingAfterH": (1, 72),
                          "graceH": (0, 48), "warnDays": (1, 30)}.get(kk, (0, 10_000))
                if not lo <= vv <= hi:
                    raise ValueError(f"{k}.{kk}: from {lo} to {hi}")
            elif isinstance(want, list):
                if not isinstance(vv, list) or not all(isinstance(x, str) and x in posting.NETWORKS for x in vv):
                    raise ValueError(f"{k}.{kk}: a list of networks")
            cur[k][kk] = vv
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
    return cur


# ---------- the record ----------

def _note(old: str | None, add: str) -> str:
    old = (old or "").strip()
    return f"{old} · {add}" if old else add


def seen(post_id: int, url: str = "", source: str = "", when: datetime | None = None) -> bool:
    """The post is out: "posted", its own link if this is one, and when it was seen. True if that changed anything."""
    when = when or _now()
    with posting.connect() as con:
        posting._ready(con)
        row = con.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            return False
        if row["status"] == "posted" and row["seen_at"]:
            return False
        if row["status"] not in (*HOLDS, "missing", "posted"):
            return False
        link = url if url.startswith("https://") else ""
        con.execute("UPDATE posts SET status = 'posted', url = COALESCE(NULLIF(?, ''), url), seen_at = ?, note = ? WHERE id = ?",
                    (link, when.isoformat(timespec="minutes"), _note(row["note"], f"seen live {when:%m/%d %H:%M}" + (f" ({source})" if source else "")), post_id))
    return True


def missing(post_id: int, why: str, now: datetime | None = None) -> bool:
    """Not seen although it should be out: "missing" once `missingAfterH` hours have passed since its time."""
    now = now or _now()
    st = settings()["verify"]
    if not st["on"]:
        return False
    after = timedelta(hours=st["missingAfterH"])
    with posting.connect() as con:
        posting._ready(con)
        row = con.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row or row["status"] not in HOLDS:
            return False
        at = _when(row["at"])
        if not at or now - at < after:
            return False
        con.execute("UPDATE posts SET status = 'missing', note = ? WHERE id = ?", (_note(row["note"], f"not found {now:%m/%d %H:%M}: {why}"), post_id))
    return True


def aside(post_id: int) -> bool:
    """A person set a missing or failed post aside: "replaced" (history; never deleted, never booked again by this)."""
    with posting.connect() as con:
        posting._ready(con)
        row = con.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row or row["status"] not in ("missing", "failed"):
            return False
        con.execute("UPDATE posts SET status = 'replaced', note = ? WHERE id = ?", (_note(row["note"], f"set aside by you {_now():%m/%d %H:%M}"), post_id))
    return True


def waiting(now: datetime | None = None) -> list[dict]:
    """Booked posts whose time has passed and that nobody has seen yet: what the checks look for."""
    now = now or _now()
    out = []
    for r in posting.posts():
        at = _when(r["at"])
        if r["status"] in HOLDS and at and at <= now:
            out.append({**r, "late_h": round((now - at).total_seconds() / 3600, 2)})
    return out


# ---------- the networks' own APIs ----------

def _youtube_state(video_id: str) -> tuple[str, str]:
    """('public'|'private'|'unlisted'|'gone'|'unknown', why)."""
    from studio.youtube import _get

    try:
        j = _get("videos", part="status", id=video_id)
    except Exception as err:  # not connected, quota, network: say so, never mark anything
        return "unknown", str(err)[:160]
    items = j.get("items") or []
    if not items:
        return "gone", "YouTube has no video with this id (deleted, or another channel's)"
    return str(items[0].get("status", {}).get("privacyStatus") or "unknown"), ""


def _facebook_state(video_id: str) -> tuple[str, str]:
    """('published'|'scheduled'|'error'|'unknown', why) from GET /{video-id}?fields=status (Meta Reels guide)."""
    try:
        from studio.connectors.facebook import _get, _load

        token = (_load() or {}).get("token")
    except Exception as err:
        return "unknown", str(err)[:160]
    if not token:
        return "unknown", "Facebook is not connected"
    code, j, _ = _get(video_id, token, fields="status,permalink_url")
    if code != 200:
        err = (j.get("error") or {}) if isinstance(j, dict) else {}
        return "unknown", f"Facebook {code}: {err.get('message', '')}"[:200]
    st = j.get("status") or {}
    pub = (st.get("publishing_phase") or {})
    if st.get("video_status") in ("error", "upload_failed", "expired") or pub.get("status") == "error" or pub.get("publish_status") == "error":
        why = ((pub.get("error") or {}).get("message") or (st.get("processing_phase") or {}).get("error", {}).get("message")
               or st.get("video_status") or "error")
        return "error", f"Facebook: {why}"[:200]
    state = str(pub.get("publish_status") or "unknown")
    link = j.get("permalink_url") or ""
    if link and link.startswith("/"):
        link = "https://www.facebook.com" + link
    return state, link


def check_api(now: datetime | None = None) -> dict:
    """Ask YouTube and Facebook about every post of theirs that should be out. Returns what changed."""
    from studio.perf import facebook_id, youtube_id

    now = now or _now()
    out = {"seen": [], "missing": [], "failed": [], "unknown": []}
    if not settings()["verify"]["on"]:
        return {**out, "off": True}
    # A post whose numbers were already read after its time is out (read before these checks existed, or by hand).
    with posting.connect() as con:
        has = con.execute("SELECT 1 FROM sqlite_master WHERE name = 'metrics'").fetchone()
        read = {int(r[0]): r[1] for r in con.execute("SELECT post_id, MAX(fetched_at) FROM metrics GROUP BY post_id")} if has else {}
    # Posts marked missing in the last 72 hours are asked about again: one that went out late is confirmed.
    recheck = [{**r, "late_h": round((now - _when(r["at"])).total_seconds() / 3600, 2)} for r in posting.posts()
               if r["status"] == "missing" and r["network"] in ("youtube", "facebook") and _when(r["at"]) and now - _when(r["at"]) <= timedelta(hours=72)]
    for r in waiting(now):
        when = _when(read.get(r["id"]))
        if when and _when(r["at"]) and when >= _when(r["at"]):
            seen(r["id"], "", "its numbers were read", when) and out["seen"].append(r["id"])
    for r in [*waiting(now), *recheck]:
        if r["network"] == "youtube" and (vid := youtube_id(r)):
            state, why = _youtube_state(vid)
            if state == "public":
                seen(r["id"], f"https://youtube.com/shorts/{vid}", "YouTube API", now) and out["seen"].append(r["id"])
            elif state == "gone":
                missing(r["id"], why, now) and out["missing"].append(r["id"])
            elif state in ("private", "unlisted") and r["late_h"] >= 1:
                missing(r["id"], f"YouTube still shows it {state} {r['late_h']:.0f} h after its time", now) and out["missing"].append(r["id"])
            elif state == "unknown":
                out["unknown"].append({"id": r["id"], "why": why})
        elif r["network"] == "facebook" and (vid := facebook_id(r)):
            state, info = _facebook_state(vid)
            if state == "published":
                seen(r["id"], info, "Facebook API", now) and out["seen"].append(r["id"])
            elif state == "error":
                posting.settle(r["id"], "failed", note=_note(r["note"], info))
                out["failed"].append(r["id"])
            elif state == "scheduled" and r["late_h"] >= 1:
                missing(r["id"], f"Facebook still holds it as scheduled {r['late_h']:.0f} h after its time", now) and out["missing"].append(r["id"])
            elif state == "unknown":
                out["unknown"].append({"id": r["id"], "why": info})
    return out


# ---------- after the PC was off ----------

def catch_up(now: datetime | None = None) -> dict:
    """Queued posts (the studio sends them itself) that came due while the studio was not running: at most `graceH`
    late they are left to the normal sender (publish --due) right away; older ones are "missing" (missed), so they are
    never sent days late by surprise. Returns {send: [ids], missed: [ids]}."""
    now = now or _now()
    st = settings()["catchUp"]
    # Off: nothing is sent late; only the minute ticker's own delay (15 min) still counts as on time.
    grace = timedelta(hours=st["graceH"]) if st["on"] else timedelta(minutes=15)
    send, missed = [], []
    for r in waiting(now):
        if r["status"] != "queued":
            continue
        late = timedelta(hours=r["late_h"])
        if late <= grace:
            send.append(r["id"])
            continue
        with posting.connect() as con:
            con.execute("UPDATE posts SET status = 'missing', note = ? WHERE id = ?",
                        (_note(r["note"], f"missed: the studio was not running at {r['at']} ({r['late_h']:.0f} h late); book it again"), r["id"]))
        missed.append(r["id"])
    return {"send": send, "missed": missed}


# ---------- tidy ----------

def tidy() -> dict:
    """A failed row whose network and day already hold a newer booking or post is history: "replaced"."""
    if not settings()["tidy"]["on"]:
        return {"replaced": [], "off": True}
    rows = posting.posts()
    holds = {(r["network"], (r["at"] or "")[:10]) for r in rows if r["status"] in (*HOLDS, "posted")}
    done = []
    with posting.connect() as con:
        for r in rows:
            if r["status"] == "failed" and r["at"] and (r["network"], r["at"][:10]) in holds:
                con.execute("UPDATE posts SET status = 'replaced', note = ? WHERE id = ?",
                            (_note(r["note"], "replaced: the same day was booked again"), r["id"]))
                done.append(r["id"])
    return {"replaced": done}


# ---------- sign-ins ----------

def health(now: datetime | None = None) -> dict:
    """The API connections a booked post depends on, checked ahead: [{network, level: ok|warn|bad, found, fix}]."""
    now = now or _now()
    warn = timedelta(days=settings()["health"]["warnDays"])
    out = []
    try:
        from studio.connectors.facebook import _get, _load

        creds = _load() or {}
        token = creds.get("token")
        if token:
            code, j, _ = _get("debug_token", token, input_token=token)
            d = (j.get("data") or {}) if code == 200 else {}
            exp = int(d.get("expires_at") or 0)
            data_exp = int(d.get("data_access_expires_at") or 0)
            if code != 200 or d.get("is_valid") is False:
                out.append({"network": "facebook", "level": "bad", "found": "the token no longer works", "fix": "Settings › Accounts › Facebook: connect again"})
            else:
                soon = [datetime.fromtimestamp(t, timezone.utc) for t in (exp, data_exp) if t]
                first = min(soon) if soon else None
                if first and first - now < warn:
                    out.append({"network": "facebook", "level": "warn", "found": f"the token stops working {first.astimezone():%m/%d %H:%M}",
                                "fix": "Settings › Accounts › Facebook: connect again before then"})
                else:
                    out.append({"network": "facebook", "level": "ok", "found": "token valid" + (f" until {first.astimezone():%m/%d}" if first else ", no expiry"), "fix": ""})
    except Exception as err:  # noqa: BLE001 - a check never breaks the page
        out.append({"network": "facebook", "level": "warn", "found": f"could not check ({type(err).__name__})", "fix": ""})
    try:
        from studio.youtube import _load_token, access_token

        if _load_token():
            access_token()  # refreshes; raises when Google refuses the refresh token
            out.append({"network": "youtube", "level": "ok", "found": "signed in", "fix": ""})
    except Exception as err:  # noqa: BLE001
        out.append({"network": "youtube", "level": "bad", "found": f"sign-in refused: {str(err)[:120]}", "fix": "Settings › Keys & AI › YouTube: switch Google account / connect again"})
    try:
        from studio.connectors import bluesky

        st = bluesky.status()
        until = _when(st.get("until")) if isinstance(st.get("until"), str) else None
        if st.get("connected") and until and until - now < warn:
            out.append({"network": "bluesky", "level": "warn", "found": f"the sign-in ends {until:%m/%d %H:%M}", "fix": "Settings › Accounts › Bluesky: sign in again before then"})
        elif st.get("connected"):
            out.append({"network": "bluesky", "level": "ok", "found": "signed in" + (f" until {until:%m/%d}" if until else ""), "fix": ""})
        elif st.get("account") or st.get("error"):
            out.append({"network": "bluesky", "level": "bad", "found": st.get("error") or "signed out", "fix": "Settings › Accounts › Bluesky: sign in again"})
    except Exception as err:  # noqa: BLE001
        out.append({"network": "bluesky", "level": "warn", "found": f"could not check ({type(err).__name__})", "fix": ""})
    return {"checked": now.isoformat(timespec="minutes"), "items": out}


def run(action: str, req: dict | None = None) -> object:
    req = req or {}
    if action == "check":
        return check_api()
    if action == "catch-up":
        return catch_up()
    if action == "tidy":
        return tidy()
    if action == "health":
        return health()
    if action == "settings":
        return save_settings(req["set"]) if req.get("set") else settings()
    if action == "seen":
        return {"changed": seen(int(req["id"]), str(req.get("url") or ""), str(req.get("source") or "browser"))}
    if action == "missing":
        return {"changed": missing(int(req["id"]), str(req.get("why") or "not found on the network"))}
    if action == "waiting":
        return waiting()
    if action == "aside":
        return {"changed": aside(int(req["id"]))}
    raise ValueError("action: check, catch-up, tidy, health, settings, seen, missing, aside or waiting")


__all__ = ["settings", "save_settings", "seen", "missing", "waiting", "check_api", "catch_up", "tidy", "health", "run"]
