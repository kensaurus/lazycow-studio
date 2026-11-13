"""
FILE: py/studio/gphotos.py
PURPOSE: Bring footage in from Google Photos (library and albums) with the Photos Picker API.
OVERVIEW: Since 2025-03-31 an app cannot read a Google Photos library on its own. The Picker
          API lets the owner pick photos and videos (from the library or an album) in Google
          Photos; the studio then downloads exactly those, originals for photos (=d) and the
          high-quality transcode for videos (=dv), into <data>/imports/google-photos/<date>/,
          and runs the library ingest and tagging on them.
DEPENDENCIES: studio.youtube (OAuth helpers, OS key-store token storage), studio.config, studio.ingest,
              studio.library; Python stdlib only for HTTP.
USAGE: python -m studio gphotos status | auth-url | exchange --code C --state S | session |
       poll --id ID | import --id ID     (server/review.mjs: /api/gphotos/*)
TECHNICAL DETAILS: scope photospicker.mediaitems.readonly; POST /v1/sessions, GET
       /v1/sessions/{id} (mediaItemsSet, pollingConfig), GET /v1/mediaItems?sessionId=,
       baseUrl downloads with the bearer token (valid 60 minutes), DELETE the session after.
NOTES: The owner's pick is the trust signal: <data>/imports is a trusted folder (config), so
       picked items count as ranch footage even though Google removes GPS from downloads.
       Pick only ranch footage. Already-imported items (by Google id) are skipped.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.parse
from datetime import date, datetime
from pathlib import Path

from studio.config import DATA
from studio.youtube import SECRETS, _call, _email_from, _google_error, _json, _protect, _unprotect, _write_secret, client

# openid + email: only to show and check which Google account was connected (the email in the id_token).
SCOPE = "openid email https://www.googleapis.com/auth/photospicker.mediaitems.readonly"


def expected_account() -> str:
    """The Google account whose Photos the studio reads (STUDIO_GPHOTOS_ACCOUNT); empty = any."""
    return (os.environ.get("STUDIO_GPHOTOS_ACCOUNT") or "").strip().lower()
REDIRECT = "http://127.0.0.1:4317/oauth/gphotos"
API = "https://photospicker.googleapis.com/v1"
IMPORTS = DATA / "imports" / "google-photos"
INDEX = DATA / "imports" / "google-photos-index.json"


def _token_path() -> Path:
    return SECRETS / "gphotos_token.bin"


def _load() -> dict | None:
    p = _token_path()
    return json.loads(_unprotect(p.read_bytes()).decode("utf-8")) if p.exists() else None


def _save(tok: dict) -> None:
    _write_secret(_token_path(), _protect(json.dumps(tok).encode("utf-8"), "gphotos_token"))


def status() -> dict:
    tok = None
    try:
        tok = _load()
    except OSError:
        pass
    index = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else {}
    return {"app": bool(client()), "connected": bool(tok), "account": (tok or {}).get("account"), "expected": expected_account() or None,
            "imported": len(index)}


def auth_url() -> str:
    c = client()
    if not c:
        raise RuntimeError("no Google app yet: see README › Posting to YouTube, step 3")
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    SECRETS.mkdir(parents=True, exist_ok=True)
    # Every sign-in page opened in the last hour stays valid (a newer one must not void an older one the person is on).
    pend = [x for x in _pendings() if time.time() - x.get("at", 0) < 3600][-4:]
    pend.append({"state": state, "verifier": verifier, "at": time.time()})
    (SECRETS / "gphotos_pending.json").write_text(json.dumps(pend), encoding="utf-8")
    q = {"client_id": c[0], "redirect_uri": REDIRECT, "response_type": "code", "scope": SCOPE, "access_type": "offline",
         "prompt": "select_account consent", "state": state, "code_challenge": challenge, "code_challenge_method": "S256"}
    if expected_account():
        q["login_hint"] = expected_account()  # the chooser opens on the right account
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(q)


def _pendings() -> list[dict]:
    try:
        raw = json.loads((SECRETS / "gphotos_pending.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []


def exchange(code: str, state: str) -> dict:
    pend_path = SECRETS / "gphotos_pending.json"
    all_pend = _pendings()
    if not all_pend:
        raise RuntimeError("no sign-in was started from the studio")
    pend = next((x for x in all_pend if secrets.compare_digest(x.get("state", ""), state or "")), None)
    if pend is None or time.time() - pend.get("at", 0) > 3600:  # an hour to finish signing in
        raise RuntimeError("sign-in state did not match or expired; start again")
    rest = [x for x in all_pend if x is not pend]
    if rest:
        pend_path.write_text(json.dumps(rest), encoding="utf-8")
    else:
        pend_path.unlink(missing_ok=True)
    cid, sec = client() or ("", "")
    form = urllib.parse.urlencode({"code": code, "client_id": cid, "client_secret": sec, "redirect_uri": REDIRECT,
                                   "grant_type": "authorization_code", "code_verifier": pend["verifier"]}).encode()
    st, _, body = _call("POST", "https://oauth2.googleapis.com/token", data=form, headers={"content-type": "application/x-www-form-urlencoded"})
    if st != 200:
        raise RuntimeError(_google_error(st, body))
    j = _json(body)
    if not j.get("refresh_token"):
        raise RuntimeError("Google returned no refresh token; remove the studio's access in your Google account and connect again")
    account = (_email_from(j.get("id_token")) or "").lower() or None
    if expected_account() and account != expected_account():
        raise RuntimeError(f"that was {account or 'another account'}, not {expected_account()}: connect again and choose {expected_account()}")
    _save({"refresh_token": j["refresh_token"], "access_token": j["access_token"], "account": account,
           "expires": time.time() + int(j.get("expires_in", 3600)) - 60})
    return {"connected": True, "account": account}


import threading  # noqa: E402

_ACCESS = threading.Lock()


def _access() -> str:
    with _ACCESS:  # import workers share one refresh
        return _access_now()


def _access_now() -> str:
    tok = _load()
    if not tok:
        raise RuntimeError("Google Photos is not connected")
    if tok.get("expires", 0) > time.time():
        return tok["access_token"]
    cid, sec = client() or ("", "")
    form = urllib.parse.urlencode({"client_id": cid, "client_secret": sec, "refresh_token": tok["refresh_token"], "grant_type": "refresh_token"}).encode()
    st, _, body = _call("POST", "https://oauth2.googleapis.com/token", data=form, headers={"content-type": "application/x-www-form-urlencoded"})
    if st != 200:
        raise RuntimeError(_google_error(st, body) + " (connect Google Photos again)")
    j = _json(body)
    tok.update(access_token=j["access_token"], expires=time.time() + int(j.get("expires_in", 3600)) - 60)
    _save(tok)
    return tok["access_token"]


def _api(method: str, path: str, body: dict | None = None) -> dict:
    st, _, raw = _call(method, f"{API}/{path}", data=json.dumps(body).encode() if body is not None else None,
                       headers={"authorization": f"Bearer {_access()}", "content-type": "application/json"})
    if st not in (200, 204):
        raise RuntimeError(_google_error(st, raw))
    return _json(raw)


def session() -> dict:
    s = _api("POST", "sessions", {})
    return {"id": s["id"], "pickerUri": s["pickerUri"].rstrip("/") + "/autoclose", "mediaItemsSet": s.get("mediaItemsSet", False)}


def poll(session_id: str) -> dict:
    s = _api("GET", f"sessions/{session_id}")
    return {"id": session_id, "mediaItemsSet": bool(s.get("mediaItemsSet")), "pollingConfig": s.get("pollingConfig", {})}


def _safe_name(name: str) -> str:
    keep = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)
    return keep[:120] or "item"


def _fetch(url: str, dest: Path, timeout: int = 900) -> int:
    """Download to `dest` in 4 MB pieces (a trip's 4K clips run to gigabytes: never held in memory). The HTTP status."""
    import shutil
    import urllib.error
    import urllib.request

    from studio.youtube import _tls

    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {_access()}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls()) as r, open(part, "wb") as out:
            shutil.copyfileobj(r, out, 4 * 1024 * 1024)
            status = r.status
    except urllib.error.HTTPError as err:
        part.unlink(missing_ok=True)
        return err.code
    except Exception:
        part.unlink(missing_ok=True)
        raise
    part.replace(dest)
    return status


def import_session(session_id: str) -> dict:
    """Download every picked item once, then catalog and tag them."""
    items, token = [], ""
    while True:
        q = urllib.parse.urlencode({"sessionId": session_id, "pageSize": 100, **({"pageToken": token} if token else {})})
        page = _api("GET", f"mediaItems?{q}")
        items += page.get("mediaItems", [])
        token = page.get("nextPageToken", "")
        if not token:
            break
    index = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else {}
    folder = IMPORTS / date.today().strftime("%Y%m%d")
    folder.mkdir(parents=True, exist_ok=True)
    new_paths, skipped = [], 0
    print(f"STAGE 1/2 downloading {len(items)} picked items", flush=True)
    import threading
    from concurrent.futures import ThreadPoolExecutor

    lock = threading.Lock()
    taken: set[str] = set()
    done = [0]

    def one(it: dict) -> None:
        nonlocal skipped
        if it["id"] in index and Path(index[it["id"]]).exists():
            with lock:
                skipped += 1
            return
        mf = it.get("mediaFile", {})
        video = it.get("type") == "VIDEO" or mf.get("mimeType", "").startswith("video/")
        url = mf["baseUrl"] + ("=dv" if video else "=d")
        name = _safe_name(mf.get("filename") or it["id"])
        if video and not name.lower().endswith((".mp4", ".mov")):
            name += ".mp4"
        when = it.get("createTime")
        ts = datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() if when else None
        with lock:  # one file name per item, even with two cameras' IMG_0001
            dest = folder / name
            if dest.name.lower() in taken:
                dest = folder / f"{dest.stem}_{it['id'][-6:]}{dest.suffix}"
            taken.add(dest.name.lower())
        # An earlier, interrupted import left this very item (same name, its capture time as the file time): keep it.
        if dest.exists() and ts is not None and abs(dest.stat().st_mtime - ts) < 1 and dest.stat().st_size > 0:
            with lock:
                index[it["id"]] = str(dest)
                new_paths.append(dest)
            return
        try:
            st = _fetch(url, dest)
        except OSError as err:
            print(f"skip {mf.get('filename')}: {err}", file=sys.stderr)
            return
        if st != 200:
            print(f"skip {mf.get('filename')}: HTTP {st}", file=sys.stderr)
            return
        if ts is not None:
            os.utime(dest, (ts, ts))
        with lock:
            index[it["id"]] = str(dest)
            new_paths.append(dest)
            done[0] += 1
            print(f"PROGRESS {done[0] + skipped}/{len(items)} {name}", flush=True)

    _access()  # refresh the sign-in once, before the workers share it
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(one, items))
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(index, indent=1), encoding="utf-8")
    try:
        _api("DELETE", f"sessions/{session_id}")
    except RuntimeError:
        pass
    print("STAGE 2/2 tagging the new footage", flush=True)
    if new_paths:
        from studio import library
        from studio.ingest import ingest

        ingest(IMPORTS, do_hash=False, do_proxy=False, paths=new_paths)
        library.scan()
    return {"picked": len(items), "downloaded": len(new_paths), "skipped": skipped, "folder": str(folder)}
