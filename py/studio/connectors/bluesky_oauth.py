"""
FILE: py/studio/connectors/bluesky_oauth.py
PURPOSE: "Sign in with Bluesky": the atproto OAuth flow for the studio as a local (loopback) app,
         so the owner signs in on Bluesky's own page instead of making an app password.
OVERVIEW: start() finds the account's server from its handle, asks that server's sign-in service
          for a sign-in page (a pushed authorization request) and returns the page's address.
          finish() checks what the browser brings back (state, issuer), trades the code for a
          session and checks the account really lives on a server that uses that sign-in service.
          pds_request() signs every request to the account's server with the session's key
          (DPoP), refreshing the session when it is about to run out.
DEPENDENCIES: cryptography (ES256 keys and signatures), Python stdlib, studio.youtube (_call, _json)
USAGE: url = start("kensaur.us", 4317)["url"]; session = finish({"code", "state", "iss"}, 4317)
TECHNICAL DETAILS (read 2026-11-08, https://atproto.com/specs/oauth):
  client_id for a local app is "http://localhost" (no port, empty path) with redirect_uri and scope
  as query parameters; the redirect itself goes to http://127.0.0.1:<port>/oauth/bluesky (the port is
  ignored when matching, the path must match). It is a public client: the whole session and each
  refresh token last at most 2 weeks.
  Resolution: handle -> DID (com.atproto.identity.resolveHandle on public.api.bsky.app or bsky.social,
  else https://<handle>/.well-known/atproto-did) -> DID document (plc.directory or did:web) -> the
  "#atproto_pds" service -> <pds>/.well-known/oauth-protected-resource -> authorization_servers[0]
  -> <issuer>/.well-known/oauth-authorization-server (its "issuer" must match exactly).
  PAR (required) with PKCE S256, state, login_hint and a DPoP proof. DPoP proofs are ES256 JWTs
  (typ dpop+jwt, the public JWK in the header; jti, htm, htu without query, iat, nonce, and ath =
  base64url SHA-256 of the access token for requests to the PDS). Server nonces are mandatory and
  rotate within 5 minutes: a 400 (auth server) or 401 (PDS) "use_dpop_nonce" carries a new
  DPoP-Nonce header and the request is sent once more.
  Callback: state must be one the studio started (10 minutes), iss must be that flow's issuer.
  Token response: token_type DPoP, scope includes atproto, sub is a DID; it must be the DID asked
  for, or (no handle given) resolve to a PDS whose authorization server is this issuer.
NOTES: The session (tokens and the private key) is stored by bluesky.py with the encrypted secret
       helpers; nothing here prints a token. Pending sign-ins are kept encrypted in
       <data>/secrets/bluesky_pending.bin for 10 minutes.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import urllib.parse
from pathlib import Path

from studio.youtube import SECRETS, _call, _json, _protect, _unprotect, _write_secret

SCOPE = "atproto transition:generic"
PATH = "/oauth/bluesky"
APPVIEW = "https://public.api.bsky.app"
ENTRYWAY = "https://bsky.social"
PLC = "https://plc.directory"
PENDING_TTL = 10 * 60
LIFETIME = 14 * 24 * 3600  # a public client's whole session
EARLY = 60                  # refresh this long before the access token runs out

RAN_OUT = "Bluesky sign-in ran out; press Sign in with Bluesky again. (An app password, under Other way, never runs out.)"
AGAIN = "Press Sign in with Bluesky again."


# ---------- small helpers ----------

def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def redirect_uri(port: int) -> str:
    return f"http://127.0.0.1:{int(port)}{PATH}"


def client_id(port: int) -> str:
    q = urllib.parse.quote
    return f"http://localhost?redirect_uri={q(redirect_uri(port), safe='')}&scope={q(SCOPE, safe='')}"


def _header(headers: dict | None, name: str) -> str:
    for k, v in (headers or {}).items():
        if k.lower() == name:
            return str(v)
    return ""


def _http(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 60):
    try:
        return _call(method, url, data=data, headers=headers, timeout=timeout)
    except OSError as err:
        host = urllib.parse.urlsplit(url).netloc
        raise RuntimeError(f"could not reach {host} ({getattr(err, 'reason', err)}); check the internet connection") from err


def _get_json(url: str) -> tuple[int, dict]:
    status, _, body = _http("GET", url, headers={"accept": "application/json"})
    return status, _json(body)


def _said(j: dict) -> str:
    return str(j.get("error_description") or j.get("message") or j.get("error") or "").strip()


# ---------- PKCE and DPoP ----------

def pkce() -> tuple[str, str]:
    """(verifier, S256 challenge). The verifier is 64 URL-safe characters (43-128 allowed)."""
    verifier = secrets.token_urlsafe(48)
    return verifier, b64(hashlib.sha256(verifier.encode("ascii")).digest())


def new_key() -> dict:
    """A fresh P-256 key as a private JWK (one per sign-in; it is bound to the session's tokens)."""
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    n = key.private_numbers()
    return {"kty": "EC", "crv": "P-256",
            "x": b64(n.public_numbers.x.to_bytes(32, "big")), "y": b64(n.public_numbers.y.to_bytes(32, "big")),
            "d": b64(n.private_value.to_bytes(32, "big"))}


def public_jwk(jwk: dict) -> dict:
    return {k: jwk[k] for k in ("kty", "crv", "x", "y")}


def _htu(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    return f"{p.scheme}://{p.netloc}{p.path}"


def ath(access: str) -> str:
    return b64(hashlib.sha256(access.encode("ascii")).digest())


def proof(jwk: dict, method: str, url: str, nonce: str | None = None, access: str | None = None) -> str:
    """A DPoP proof JWT signed with ES256 (raw r||s signature, as JWS asks)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    header = {"typ": "dpop+jwt", "alg": "ES256", "jwk": public_jwk(jwk)}
    claims = {"jti": secrets.token_urlsafe(16), "htm": method.upper(), "htu": _htu(url), "iat": int(time.time())}
    if nonce:
        claims["nonce"] = nonce
    if access:
        claims["ath"] = ath(access)
    compact = lambda d: b64(json.dumps(d, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{compact(header)}.{compact(claims)}"
    key = ec.derive_private_key(int.from_bytes(unb64(jwk["d"]), "big"), ec.SECP256R1())
    r, s = decode_dss_signature(key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    return f"{signing_input}.{b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def _auth_post(url: str, form: dict, jwk: dict, nonce: str | None) -> tuple[int, dict, str | None]:
    """A form POST to the sign-in service with a DPoP proof; sent once more when it asks for its nonce."""
    for attempt in (0, 1):
        status, headers, body = _http("POST", url, data=urllib.parse.urlencode(form).encode("utf-8"), headers={
            "content-type": "application/x-www-form-urlencoded", "accept": "application/json", "dpop": proof(jwk, "POST", url, nonce)})
        j = _json(body)
        fresh = _header(headers, "dpop-nonce")
        asked = j.get("error") == "use_dpop_nonce"
        if fresh:
            nonce = fresh
        if asked and fresh and attempt == 0:
            continue
        return status, j, nonce
    return status, j, nonce  # pragma: no cover


# ---------- finding the account's server and its sign-in service ----------

def normal_handle(raw: str) -> str:
    h = (raw or "").strip().lstrip("@").strip()
    if h.lower().startswith(("https://bsky.app/profile/", "bsky.app/profile/")):
        h = h.rstrip("/").rsplit("/", 1)[-1]
    if "@" in h:
        raise ValueError("Type your Bluesky handle (like name.bsky.social), not your email address, or leave the box empty.")
    if h and "." not in h and not h.startswith("did:"):
        h += ".bsky.social"
    return h if h.startswith("did:") else h.lower()


def resolve_handle(handle: str) -> str:
    reached = False
    for base in (APPVIEW, ENTRYWAY):
        try:
            status, j = _get_json(f"{base}/xrpc/com.atproto.identity.resolveHandle?{urllib.parse.urlencode({'handle': handle})}")
        except RuntimeError:
            continue
        reached = True
        if status == 200 and str(j.get("did", "")).startswith("did:"):
            return j["did"]
    try:
        status, _, body = _http("GET", f"https://{handle}/.well-known/atproto-did")
        reached = True
        text = body.decode("utf-8", "replace").strip()
        if status == 200 and text.startswith("did:"):
            return text
    except RuntimeError:
        pass
    if not reached:
        raise RuntimeError("could not reach Bluesky; check the internet connection and try again")
    raise ValueError(f"Bluesky has no account called @{handle}. Check the spelling (it looks like name.bsky.social "
                     "or your own web address), or leave the box empty and pick the account on Bluesky's page.")


def did_doc(did: str) -> dict:
    if did.startswith("did:plc:"):
        url = f"{PLC}/{urllib.parse.quote(did)}"
    elif did.startswith("did:web:"):
        rest = did[len("did:web:"):]
        if ":" in rest:  # did:web with a path is not used for atproto accounts
            raise ValueError(f"{did} is not a kind of account Bluesky sign-in supports")
        host = urllib.parse.unquote(rest)
        url = f"https://{host}/.well-known/did.json"
    else:
        raise ValueError(f"{did} is not a Bluesky account")
    status, doc = _get_json(url)
    if status != 200 or doc.get("id") != did:
        raise RuntimeError(f"could not look up the account {did} (directory answered {status}); try again in a minute")
    return doc


def pds_of(doc: dict) -> str:
    for s in doc.get("service") or []:
        if str(s.get("id", "")).endswith("#atproto_pds") and str(s.get("serviceEndpoint", "")).startswith("https://"):
            return str(s["serviceEndpoint"]).rstrip("/")
    raise RuntimeError("this account has no Bluesky server listed; it may have been deleted or moved")


def handle_of(doc: dict) -> str | None:
    for aka in doc.get("alsoKnownAs") or []:
        if str(aka).startswith("at://"):
            return str(aka)[5:].lower()
    return None


def auth_server(pds: str) -> str:
    status, j = _get_json(f"{pds}/.well-known/oauth-protected-resource")
    servers = j.get("authorization_servers") or []
    if status != 200 or not servers:
        raise RuntimeError(f"the account's server ({urllib.parse.urlsplit(pds).netloc}) does not offer Bluesky sign-in; "
                           "use the Other way (an app password)")
    return str(servers[0]).rstrip("/")


def auth_meta(issuer: str) -> dict:
    status, meta = _get_json(f"{issuer}/.well-known/oauth-authorization-server")
    need = ("authorization_endpoint", "token_endpoint", "pushed_authorization_request_endpoint")
    if status != 200 or meta.get("issuer") != issuer or not all(meta.get(k) for k in need):
        raise RuntimeError(f"Bluesky's sign-in service at {urllib.parse.urlsplit(issuer).netloc} did not answer properly "
                           f"({status}); try again in a minute, or use the Other way (an app password)")
    if "ES256" not in (meta.get("dpop_signing_alg_values_supported") or ["ES256"]):
        raise RuntimeError("Bluesky's sign-in service does not accept the studio's key type; use the Other way (an app password)")
    return meta


# ---------- pending sign-ins (10 minutes, encrypted) ----------

def _pending_path() -> Path:
    return SECRETS / "bluesky_pending.bin"


def _pending() -> dict:
    p = _pending_path()
    if not p.exists():
        return {}
    try:
        rows = json.loads(_unprotect(p.read_bytes()).decode("utf-8"))
    except Exception:
        return {}
    return {k: v for k, v in rows.items() if time.time() - v.get("at", 0) < PENDING_TTL}


def _keep(rows: dict) -> None:
    if rows:
        _write_secret(_pending_path(), _protect(json.dumps(rows).encode("utf-8"), "bluesky_pending"))
    else:
        _pending_path().unlink(missing_ok=True)


def _take(state: str) -> dict | None:
    rows = _pending()
    hit = next((k for k in rows if secrets.compare_digest(k.encode(), (state or "").encode())), None)
    pend = rows.pop(hit) if hit else None
    _keep(rows)
    return pend


# ---------- the flow ----------

def start(raw_handle: str, port: int) -> dict:
    """Ask the account's sign-in service for a sign-in page; return its address for the browser."""
    handle = normal_handle(raw_handle)
    did = pds = None
    if handle:
        did = handle if handle.startswith("did:") else resolve_handle(handle)
        doc = did_doc(did)
        pds = pds_of(doc)
        issuer = auth_server(pds)
    else:  # no handle: Bluesky's own page asks which account
        try:
            issuer = auth_server(ENTRYWAY)
        except RuntimeError:
            issuer = ENTRYWAY
    meta = auth_meta(issuer)
    jwk = new_key()
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(24)
    cid = client_id(port)
    form = {"client_id": cid, "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
            "state": state, "redirect_uri": redirect_uri(port), "scope": SCOPE}
    if handle:
        form["login_hint"] = handle
    status, j, nonce = _auth_post(meta["pushed_authorization_request_endpoint"], form, jwk, None)
    if status not in (200, 201) or not j.get("request_uri"):
        raise RuntimeError(f"Bluesky did not open a sign-in page ({status}{': ' + _said(j) if _said(j) else ''}). "
                           "Try again in a minute, or use the Other way (an app password).")
    rows = _pending()
    rows[state] = {"at": time.time(), "verifier": verifier, "key": jwk, "nonce": nonce, "issuer": issuer,
                   "token_endpoint": meta["token_endpoint"], "did": did, "pds": pds, "handle": None if (handle or "").startswith("did:") else handle,
                   "client_id": cid, "redirect_uri": redirect_uri(port)}
    _keep(rows)
    url = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({"client_id": cid, "request_uri": j["request_uri"]})
    return {"url": url}


def _refused(error: str, description: str) -> str:
    if error == "access_denied":
        return "You did not allow Lazycow Studio on Bluesky, so nothing was connected. " + AGAIN + " when you are ready."
    said = description or error
    return f"Bluesky stopped the sign-in ({said}). {AGAIN}"


def finish(params: dict, port: int) -> dict:
    """Check the browser's return and trade the code for a session (the dict bluesky.py stores)."""
    p = {k: str(v or "") for k, v in (params or {}).items()}
    pend = _take(p.get("state", ""))
    if p.get("error"):
        raise ValueError(_refused(p["error"], p.get("error_description", "")))
    if pend is None:
        raise ValueError("This sign-in is too old or was already used (they last 10 minutes). " + AGAIN)
    if not p.get("iss"):
        raise ValueError("Bluesky's answer did not say who sent it, so the studio did not trust it. " + AGAIN)
    if p["iss"].rstrip("/") != pend["issuer"]:
        raise ValueError("The answer came from a different sign-in service than the one the studio asked, so it was ignored. " + AGAIN)
    if not p.get("code"):
        raise ValueError("Bluesky came back without a sign-in code. " + AGAIN)
    form = {"grant_type": "authorization_code", "code": p["code"], "redirect_uri": pend["redirect_uri"],
            "code_verifier": pend["verifier"], "client_id": pend["client_id"]}
    status, j, nonce = _auth_post(pend["token_endpoint"], form, pend["key"], pend.get("nonce"))
    if status != 200 or not j.get("access_token"):
        raise RuntimeError(f"Bluesky did not finish the sign-in ({status}{': ' + _said(j) if _said(j) else ''}). {AGAIN}")
    if str(j.get("token_type", "")).lower() != "dpop":
        raise RuntimeError("Bluesky answered with a kind of sign-in the studio cannot use. " + AGAIN)
    if "atproto" not in str(j.get("scope", "")).split():
        raise RuntimeError("Bluesky did not grant posting. " + AGAIN + " and press Allow.")
    sub = str(j.get("sub") or "")
    if not sub.startswith("did:"):
        raise RuntimeError("Bluesky did not say which account signed in. " + AGAIN)
    if pend.get("did") and sub != pend["did"]:
        want = pend.get("handle") or pend["did"]
        raise ValueError(f"You signed in to a different Bluesky account than @{want}. {AGAIN} and use @{want}, or empty the handle box.")
    doc = did_doc(sub)
    pds = pds_of(doc)
    if not pend.get("did") and auth_server(pds) != pend["issuer"]:
        raise RuntimeError("That account's server does not use this sign-in service, so the studio did not trust it. " + AGAIN)
    handle = handle_of(doc) or pend.get("handle") or sub
    now = time.time()
    return {"kind": "oauth", "did": sub, "handle": handle, "account": handle, "pds": pds, "issuer": pend["issuer"],
            "token_endpoint": pend["token_endpoint"], "client_id": pend["client_id"], "access": j["access_token"],
            "refresh": j.get("refresh_token"), "expires": now + int(j.get("expires_in") or 300) - EARLY,
            "scope": j.get("scope", ""), "key": pend["key"], "auth_nonce": nonce, "pds_nonce": None, "started": now}


# ---------- using the session ----------

def until(sess: dict) -> float:
    return float(sess.get("started") or 0) + LIFETIME


def ran_out(sess: dict) -> bool:
    return bool(sess.get("ran_out")) or time.time() > until(sess)


def fresh(sess: dict, save=None) -> dict:
    """The session with a usable access token (refreshed in place and saved when needed)."""
    if ran_out(sess) or not sess.get("refresh") and sess.get("expires", 0) <= time.time():
        if not sess.get("ran_out"):
            sess["ran_out"] = True
            save and save(sess)
        raise RuntimeError(RAN_OUT)
    if sess.get("expires", 0) > time.time():
        return sess
    form = {"grant_type": "refresh_token", "refresh_token": sess["refresh"], "client_id": sess["client_id"]}
    status, j, nonce = _auth_post(sess["token_endpoint"], form, sess["key"], sess.get("auth_nonce"))
    sess["auth_nonce"] = nonce
    if status != 200 or not j.get("access_token"):
        if status in (400, 401) and j.get("error") in ("invalid_grant", "invalid_token", "invalid_client", "unauthorized_client"):
            sess["ran_out"] = True
            save and save(sess)
            raise RuntimeError(RAN_OUT)
        raise RuntimeError(f"Bluesky's sign-in service did not answer ({status}{': ' + _said(j) if _said(j) else ''}); try again in a few minutes")
    if j.get("sub") and j["sub"] != sess["did"]:
        raise RuntimeError("Bluesky refreshed the sign-in for a different account. " + AGAIN)
    sess.update(access=j["access_token"], refresh=j.get("refresh_token") or sess["refresh"],
                expires=time.time() + int(j.get("expires_in") or 300) - EARLY)
    save and save(sess)
    return sess


def _wants_nonce(headers: dict, body: bytes) -> bool:
    return "use_dpop_nonce" in _header(headers, "www-authenticate") or _json(body).get("error") == "use_dpop_nonce"


def _token_dead(headers: dict, body: bytes) -> bool:
    j = _json(body)
    return 'error="invalid_token"' in _header(headers, "www-authenticate") or j.get("error") in ("invalid_token", "ExpiredToken", "InvalidToken")


def pds_request(sess: dict, method: str, url: str, *, data: bytes | None = None, headers: dict | None = None,
                timeout: int = 120, save=None):
    """One request to the account's server, signed for this session. Returns (status, headers, body)."""
    fresh(sess, save)
    nonce_before = sess.get("pds_nonce")
    retried_token = False
    for attempt in range(3):
        h = {**(headers or {}), "authorization": f"DPoP {sess['access']}",
             "dpop": proof(sess["key"], method, url, sess.get("pds_nonce"), sess["access"])}
        status, rh, body = _http(method, url, data=data, headers=h, timeout=timeout)
        new = _header(rh, "dpop-nonce")
        changed = bool(new) and new != sess.get("pds_nonce")
        if new:
            sess["pds_nonce"] = new
        if status in (400, 401) and _wants_nonce(rh, body) and changed and attempt < 2:
            continue
        if status == 401 and _token_dead(rh, body) and not retried_token and sess.get("refresh"):
            retried_token = True
            sess["expires"] = 0
            fresh(sess, save)
            continue
        break
    if save and sess.get("pds_nonce") != nonce_before:
        save(sess)
    return status, rh, body
