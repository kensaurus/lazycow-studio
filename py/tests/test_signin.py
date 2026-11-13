"""One-click sign-in against a fake HTTP layer: "Sign in with Bluesky" (atproto OAuth for a local app:
DPoP proofs, PKCE, the pushed request with its nonce retry, the callback's state and issuer checks,
refresh running out in plain words, DPoP-signed posts) and "Connect with Facebook" (the owner's Meta
app, the login window's code traded for the Page's own token, Meta's errors in plain words)."""
import base64
import hashlib
import json
import time
import urllib.parse

import pytest

from studio import publish
from studio.connectors import bluesky, facebook
from studio.connectors import bluesky_oauth as oauth

PORT = 4317
DID = "did:plc:abc"
PDS = "https://morel.us-east.host.bsky.network"
ISS = "https://bsky.social"
META = {
    "issuer": ISS, "authorization_endpoint": f"{ISS}/oauth/authorize", "token_endpoint": f"{ISS}/oauth/token",
    "pushed_authorization_request_endpoint": f"{ISS}/oauth/par", "dpop_signing_alg_values_supported": ["ES256"],
    "authorization_response_iss_parameter_supported": True,
}
DOC = {"id": DID, "alsoKnownAs": ["at://kensaur.us"],
       "service": [{"id": "#atproto_pds", "type": "AtprotoPersonalDataServer", "serviceEndpoint": PDS}]}


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats.
    A reply is (status, body) or (status, body, headers)."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=120):
        self.calls.append({"method": method, "url": url, "data": data, "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                reply = replies.pop(0) if len(replies) > 1 else replies[0]
                status, body = reply[0], reply[1]
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                return status, (reply[2] if len(reply) > 2 else {}), raw
        raise AssertionError(f"unexpected call {method} {url}")

    def find(self, part):
        return [c for c in self.calls if part in c["url"]]


def _use(monkeypatch, fake):
    for mod in (oauth, bluesky, facebook):
        monkeypatch.setattr(mod, "_call", fake)
    return fake


@pytest.fixture
def store(tmp_path, monkeypatch):
    for mod in (oauth, bluesky, facebook):
        monkeypatch.setattr(mod, "SECRETS", tmp_path)
    monkeypatch.setattr(facebook, "CONFIG", tmp_path)
    monkeypatch.delenv("STUDIO_FB_APP_ID", raising=False)
    monkeypatch.delenv("STUDIO_FB_APP_SECRET", raising=False)
    return tmp_path


def _jwt_parts(token):
    h, c, s = token.split(".")
    return json.loads(oauth.unb64(h)), json.loads(oauth.unb64(c)), oauth.unb64(s), f"{h}.{c}".encode()


def _verify(token):
    """The proof's signature checks out against the public key in its own header."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    header, claims, sig, signed = _jwt_parts(token)
    jwk = header["jwk"]
    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(oauth.unb64(jwk["x"]), "big"), int.from_bytes(oauth.unb64(jwk["y"]), "big"),
                                        ec.SECP256R1()).public_key()
    assert len(sig) == 64  # raw r||s, not DER
    pub.verify(encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")), signed, ec.ECDSA(hashes.SHA256()))
    return header, claims


def _form(call):
    return dict(urllib.parse.parse_qsl(call["data"].decode()))


# ---------- DPoP, PKCE, client id ----------

def test_dpop_proof_has_the_right_header_and_claims_and_a_valid_es256_signature():
    key = oauth.new_key()
    token = oauth.proof(key, "post", f"{PDS}/xrpc/com.atproto.repo.createRecord?x=1#frag", nonce="n-1", access="acc.ess.token")
    header, claims = _verify(token)
    assert header["typ"] == "dpop+jwt" and header["alg"] == "ES256"
    assert set(header["jwk"]) == {"kty", "crv", "x", "y"} and "d" not in header["jwk"]  # public part only
    assert header["jwk"]["crv"] == "P-256" and header["jwk"]["kty"] == "EC"
    assert claims["htm"] == "POST" and claims["htu"] == f"{PDS}/xrpc/com.atproto.repo.createRecord"  # no query, no fragment
    assert claims["nonce"] == "n-1" and abs(claims["iat"] - time.time()) < 5 and len(claims["jti"]) >= 16
    assert claims["ath"] == base64.urlsafe_b64encode(hashlib.sha256(b"acc.ess.token").digest()).rstrip(b"=").decode()
    _, again = _verify(oauth.proof(key, "GET", PDS))
    assert again["jti"] != claims["jti"] and "nonce" not in again and "ath" not in again


def test_pkce_challenge_is_s256_of_the_verifier():
    verifier, challenge = oauth.pkce()
    assert 43 <= len(verifier) <= 128
    assert challenge == base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert oauth.pkce()[0] != verifier


def test_client_id_is_the_localhost_form_with_redirect_and_scope():
    cid = oauth.client_id(PORT)
    assert cid == ("http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A4317%2Foauth%2Fbluesky"
                   "&scope=atproto%20transition%3Ageneric")
    parts = urllib.parse.urlsplit(cid)
    assert parts.scheme == "http" and parts.netloc == "localhost" and parts.path == ""


# ---------- Sign in with Bluesky: start ----------

def _start_routes(par):
    return [
        ("GET", "resolveHandle", [(200, {"did": DID})]),
        ("GET", "plc.directory", [(200, DOC)]),
        ("GET", "oauth-protected-resource", [(200, {"resource": PDS, "authorization_servers": [ISS]})]),
        ("GET", "oauth-authorization-server", [(200, META)]),
        ("POST", "/oauth/par", par),
    ]


def test_start_resolves_the_handle_and_retries_par_once_with_the_servers_nonce(store, monkeypatch):
    fake = _use(monkeypatch, Fake(_start_routes([
        (400, {"error": "use_dpop_nonce", "error_description": "Authorization server requires nonce in DPoP proof"}, {"DPoP-Nonce": "nonce-A"}),
        (201, {"request_uri": "urn:ietf:params:oauth:request_uri:req-1", "expires_in": 299}, {"DPoP-Nonce": "nonce-B"}),
    ])))

    out = oauth.start("@Kensaur.us", PORT)

    pars = fake.find("/oauth/par")
    assert len(pars) == 2
    _, first = _verify(pars[0]["headers"]["dpop"])
    _, second = _verify(pars[1]["headers"]["dpop"])
    assert "nonce" not in first and second["nonce"] == "nonce-A" and "ath" not in second
    assert second["htm"] == "POST" and second["htu"] == f"{ISS}/oauth/par"
    form = _form(pars[1])
    assert form["client_id"] == oauth.client_id(PORT) and form["redirect_uri"] == "http://127.0.0.1:4317/oauth/bluesky"
    assert form["response_type"] == "code" and form["code_challenge_method"] == "S256" and form["scope"] == "atproto transition:generic"
    assert form["login_hint"] == "kensaur.us" and form["state"]
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(out["url"]).query))
    assert out["url"].startswith(f"{ISS}/oauth/authorize?")
    assert q == {"client_id": oauth.client_id(PORT), "request_uri": "urn:ietf:params:oauth:request_uri:req-1"}
    pend = oauth._pending()[form["state"]]
    assert pend["nonce"] == "nonce-B" and pend["issuer"] == ISS and pend["did"] == DID and pend["pds"] == PDS
    assert base64.urlsafe_b64encode(hashlib.sha256(pend["verifier"].encode()).digest()).rstrip(b"=").decode() == form["code_challenge"]
    assert b"verifier" not in (store / "bluesky_pending.bin").read_bytes() or __import__("sys").platform != "win32"


def test_start_with_an_unknown_handle_says_so_plainly(store, monkeypatch):
    _use(monkeypatch, Fake([("GET", "resolveHandle", [(400, {"error": "InvalidRequest", "message": "Unable to resolve handle"})]),
                            ("GET", "/.well-known/atproto-did", [(404, b"not found")])]))
    with pytest.raises(ValueError, match="no account called @nobody-here.bsky.social"):
        oauth.start("nobody-here", PORT)
    with pytest.raises(ValueError, match="not your email"):
        oauth.start("me@example.com", PORT)


def test_start_stops_when_par_is_refused_even_after_the_nonce(store, monkeypatch):
    _use(monkeypatch, Fake(_start_routes([(400, {"error": "invalid_request", "error_description": "Invalid redirect_uri"}, {"DPoP-Nonce": "n"})])))
    with pytest.raises(RuntimeError, match="Invalid redirect_uri"):
        oauth.start("kensaur.us", PORT)
    assert oauth._pending() == {}


# ---------- Sign in with Bluesky: the callback ----------

def _started(store, monkeypatch):
    fake = _use(monkeypatch, Fake(_start_routes([(201, {"request_uri": "urn:r"}, {"DPoP-Nonce": "nonce-B"})])))
    oauth.start("kensaur.us", PORT)
    return _form(fake.find("/oauth/par")[0])["state"]


TOKENS = {"access_token": "at-1", "token_type": "DPoP", "refresh_token": "rt-1", "expires_in": 3600,
          "scope": "atproto transition:generic", "sub": DID}


def test_callback_refuses_an_unknown_state_and_a_foreign_issuer(store, monkeypatch):
    state = _started(store, monkeypatch)
    with pytest.raises(ValueError, match="too old or was already used"):
        oauth.finish({"code": "c", "state": "forged", "iss": ISS}, PORT)
    assert state in oauth._pending()  # a wrong state does not spend the real one
    with pytest.raises(ValueError, match="different sign-in service"):
        oauth.finish({"code": "c", "state": state, "iss": "https://evil.example"}, PORT)
    with pytest.raises(ValueError, match="too old or was already used"):  # used up by the attempt above
        oauth.finish({"code": "c", "state": state, "iss": ISS}, PORT)


def test_callback_without_iss_or_after_cancel_is_explained(store, monkeypatch):
    state = _started(store, monkeypatch)
    with pytest.raises(ValueError, match="did not say who sent it"):
        oauth.finish({"code": "c", "state": state}, PORT)
    state = _started(store, monkeypatch)
    with pytest.raises(ValueError, match="did not allow Lazycow Studio"):
        oauth.finish({"error": "access_denied", "state": state, "iss": ISS}, PORT)


def test_callback_trades_the_code_with_dpop_and_stores_the_session(store, monkeypatch):
    state = _started(store, monkeypatch)
    fake = _use(monkeypatch, Fake([
        ("POST", "/oauth/token", [(200, TOKENS, {"DPoP-Nonce": "nonce-C"})]),
        ("GET", "plc.directory", [(200, DOC)]),
    ]))
    out = bluesky.finish_signin({"code": "code-1", "state": state, "iss": ISS}, PORT)

    tok = fake.find("/oauth/token")[0]
    form = _form(tok)
    assert form["grant_type"] == "authorization_code" and form["code"] == "code-1" and form["code_verifier"]
    assert form["redirect_uri"] == "http://127.0.0.1:4317/oauth/bluesky" and form["client_id"] == oauth.client_id(PORT)
    _, claims = _verify(tok["headers"]["dpop"])
    assert claims["nonce"] == "nonce-B" and claims["htu"] == f"{ISS}/oauth/token"
    assert out["connected"] is True and out["account"] == "@kensaur.us" and out["via"] == "signin" and out["until"]
    sess = bluesky._load()
    assert sess["kind"] == "oauth" and sess["did"] == DID and sess["pds"] == PDS and sess["auth_nonce"] == "nonce-C"
    raw = (store / "bluesky.bin").read_bytes()
    if __import__("sys").platform == "win32":
        assert b"at-1" not in raw and b"rt-1" not in raw


def test_callback_refuses_a_different_account_than_the_handle(store, monkeypatch):
    state = _started(store, monkeypatch)
    _use(monkeypatch, Fake([("POST", "/oauth/token", [(200, dict(TOKENS, sub="did:plc:someoneelse"), {"DPoP-Nonce": "n"})])]))
    with pytest.raises(ValueError, match="different Bluesky account than @kensaur.us"):
        oauth.finish({"code": "c", "state": state, "iss": ISS}, PORT)


# ---------- using the session ----------

def _signed_in(store, monkeypatch, **over):
    state = _started(store, monkeypatch)
    _use(monkeypatch, Fake([("POST", "/oauth/token", [(200, TOKENS, {"DPoP-Nonce": "nonce-C"})]), ("GET", "plc.directory", [(200, DOC)])]))
    bluesky.finish_signin({"code": "c", "state": state, "iss": ISS}, PORT)
    if over:
        sess = bluesky._load()
        sess.update(over)
        bluesky._save(sess)
    return bluesky._load()


def test_a_failed_refresh_says_in_plain_words_to_sign_in_again(store, monkeypatch, tmp_path):
    _signed_in(store, monkeypatch, expires=0)
    fake = _use(monkeypatch, Fake([("POST", "/oauth/token", [(400, {"error": "invalid_grant", "error_description": "refresh token expired"}, {"DPoP-Nonce": "n2"})])]))
    reel = tmp_path / "r.mp4"
    reel.write_bytes(b"x" * 64)
    with pytest.raises(RuntimeError, match="Bluesky sign-in ran out; press Sign in with Bluesky again"):
        bluesky.post(reel, "hello")
    form = _form(fake.find("/oauth/token")[0])
    assert form["grant_type"] == "refresh_token" and form["refresh_token"] == "rt-1"
    st = bluesky.status()
    assert st["connected"] is False and st["error"].startswith("Bluesky sign-in ran out; press Sign in with Bluesky again")
    assert publish.connections()["bluesky"]["signin"] == {"ready": True, "handle": True}


def test_a_session_older_than_two_weeks_has_run_out_without_asking_the_network(store, monkeypatch):
    _signed_in(store, monkeypatch, started=time.time() - 15 * 24 * 3600)
    _use(monkeypatch, Fake([]))
    assert bluesky.status()["error"].startswith("Bluesky sign-in ran out")


def test_refresh_keeps_the_new_single_use_refresh_token(store, monkeypatch):
    sess = _signed_in(store, monkeypatch, expires=0)
    _use(monkeypatch, Fake([("POST", "/oauth/token", [(200, dict(TOKENS, access_token="at-2", refresh_token="rt-2"), {"DPoP-Nonce": "n3"})])]))
    oauth.fresh(sess, bluesky._save)
    saved = bluesky._load()
    assert saved["access"] == "at-2" and saved["refresh"] == "rt-2" and saved["expires"] > time.time() and saved["auth_nonce"] == "n3"


def test_pds_requests_carry_dpop_with_ath_and_retry_once_on_a_new_nonce(store, monkeypatch):
    sess = _signed_in(store, monkeypatch)
    fake = _use(monkeypatch, Fake([("GET", "getServiceAuth", [
        (401, {"error": "use_dpop_nonce"}, {"WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "pds-1"}),
        (200, {"token": "svc"}, {"DPoP-Nonce": "pds-1"}),
    ])]))
    status, _, body = oauth.pds_request(sess, "GET", f"{PDS}/xrpc/com.atproto.server.getServiceAuth?aud=x", save=bluesky._save)
    assert status == 200 and json.loads(body) == {"token": "svc"}
    first, second = fake.calls
    assert second["headers"]["authorization"] == "DPoP at-1"
    _, claims = _verify(second["headers"]["dpop"])
    assert claims["nonce"] == "pds-1" and claims["ath"] == oauth.ath("at-1") and claims["htm"] == "GET"
    assert claims["htu"] == f"{PDS}/xrpc/com.atproto.server.getServiceAuth"
    assert "nonce" not in _verify(first["headers"]["dpop"])[1]
    assert bluesky._load()["pds_nonce"] == "pds-1"


def test_post_with_a_signed_in_session_uses_dpop_for_the_server_and_a_permit_for_video(store, monkeypatch, tmp_path):
    _signed_in(store, monkeypatch)
    blob = {"$type": "blob", "ref": {"$link": "bafkreivideo"}, "mimeType": "video/mp4", "size": 64}
    fake = _use(monkeypatch, Fake([
        ("GET", "com.atproto.server.getServiceAuth", [(200, {"token": "svc-limits"}, {"DPoP-Nonce": "p"}), (200, {"token": "svc-upload"}, {"DPoP-Nonce": "p"})]),
        ("GET", "app.bsky.video.getUploadLimits", [(200, {"canUpload": True})]),
        ("POST", "app.bsky.video.uploadVideo", [(200, {"jobStatus": {"jobId": "j", "state": "JOB_STATE_COMPLETED", "blob": blob}})]),
        ("POST", "com.atproto.repo.createRecord", [(200, {"uri": f"at://{DID}/app.bsky.feed.post/3abc"}, {"DPoP-Nonce": "p"})]),
    ]))
    monkeypatch.setattr(bluesky, "_aspect", lambda v: None)
    reel = tmp_path / "r.mp4"
    reel.write_bytes(b"x" * 64)

    out = bluesky.post(reel, "嬬恋 #camp")

    assert not fake.find("createSession")  # no app password involved
    for c in fake.find("getServiceAuth") + fake.find("createRecord"):
        assert c["headers"]["authorization"] == "DPoP at-1" and c["headers"]["dpop"].count(".") == 2
    assert fake.find("uploadVideo")[0]["headers"]["authorization"] == "Bearer svc-upload"
    assert json.loads(fake.find("createRecord")[0]["data"])["repo"] == DID
    assert out["url"] == "https://bsky.app/profile/kensaur.us/post/3abc"


# ---------- Connect with Facebook ----------

APP_ID, APP_SECRET = "1234567890123456", "0123456789abcdef0123456789abcdef"
PAGE = {"id": "998877665544", "name": "嬬恋牧場Work&Camp", "access_token": "EAAGpage", "tasks": ["CREATE_CONTENT"]}
PERMS = {"data": [{"permission": p, "status": "granted"} for p in facebook.NEEDED]}


def test_facebook_card_asks_for_setup_until_the_app_is_saved(store, monkeypatch):
    assert facebook.signin(PORT)["ready"] is False
    with pytest.raises(ValueError, match="App ID and App secret"):
        facebook.start_signin({}, PORT)
    with pytest.raises(ValueError, match="only digits"):
        facebook.setup({"app_id": "my app", "app_secret": APP_SECRET})
    _use(monkeypatch, Fake([("GET", "grant_type=client_credentials", [(400, {"error": {"message": "Error validating client secret.", "code": 1}})])]))
    with pytest.raises(ValueError, match="do not belong together"):
        facebook.setup({"app_id": APP_ID, "app_secret": APP_SECRET})
    _use(monkeypatch, Fake([("GET", "grant_type=client_credentials", [(200, {"access_token": "app|tok"})])]))
    assert facebook.setup({"app_id": APP_ID, "app_secret": APP_SECRET.upper()}) == {"ready": True, "app": APP_ID}
    assert json.loads((store / "facebook_app.json").read_text()) == {"app_id": APP_ID}  # plain: the ID is not a secret
    if __import__("sys").platform == "win32":
        assert APP_SECRET.encode() not in (store / "facebook_app.bin").read_bytes()
    assert facebook.app() == (APP_ID, APP_SECRET)
    one = publish.connections(PORT)["facebook"]["signin"]
    assert one["ready"] is True and one["redirect"] == "http://localhost:4317/oauth/facebook" and APP_SECRET not in json.dumps(one)


def _fb_ready(store, monkeypatch):
    _use(monkeypatch, Fake([("GET", "grant_type=client_credentials", [(200, {"access_token": "app|tok"})])]))
    facebook.setup({"app_id": APP_ID, "app_secret": APP_SECRET})
    url = facebook.start_signin({}, PORT)["url"]
    return url, dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


def test_facebook_login_link_asks_for_the_page_permissions_and_business_on_localhost(store, monkeypatch):
    url, q = _fb_ready(store, monkeypatch)
    assert url.startswith(f"https://www.facebook.com/{facebook.VERSION}/dialog/oauth?")
    assert q["client_id"] == APP_ID and q["redirect_uri"] == "http://localhost:4317/oauth/facebook" and q["response_type"] == "code"
    # business_management too: a Page kept in a business portfolio is not listed without it;
    # read_insights so studio.perf can read each reel's plays and watch time.
    assert q["scope"] == "pages_show_list,pages_read_engagement,pages_manage_posts,business_management,read_insights" and len(q["state"]) > 20


BIZ_PERMS = {"data": [{"permission": p, "status": "granted"} for p in facebook.NEEDED + facebook.OPTIONAL]}


def test_facebook_finds_a_page_kept_in_a_business_portfolio(store, monkeypatch):
    # me/accounts is empty for a Page reached through Business Suite; the business's own Pages list has it.
    _use(monkeypatch, Fake([
        ("GET", "/me/accounts?", [(200, {"data": []})]),
        ("GET", "/me/permissions?", [(200, BIZ_PERMS)]),
        ("GET", "/me/businesses?", [(200, {"data": [{"id": "b1", "name": "kensaurus"}]})]),
        ("GET", "/b1/owned_pages?", [(200, {"data": [{k: PAGE[k] for k in ("id", "name", "access_token")}]})]),
        ("GET", "/b1/client_pages?", [(200, {"data": []})]),
        ("GET", "/me?", [(200, {"id": "u1", "name": "Kenji"}), (200, {"id": PAGE["id"], "name": PAGE["name"]})]),
    ]))
    out = facebook.connect({"token": "EAAuser"})
    assert out["connected"] and out["account"] == PAGE["name"]
    assert facebook._load()["page_id"] == PAGE["id"]


def test_facebook_no_page_says_to_add_business_management(store, monkeypatch):
    _use(monkeypatch, Fake([
        ("GET", "/me/accounts?", [(200, {"data": []})]),
        ("GET", "/me/permissions?", [(200, PERMS)]),
        ("GET", "/me?", [(200, {"id": "u1", "name": "Kenji"})]),
    ]))
    with pytest.raises(ValueError, match="business_management"):
        facebook.connect({"token": "EAAuser"})


def test_facebook_code_exchange_keeps_the_pages_own_token(store, monkeypatch):
    _, q = _fb_ready(store, monkeypatch)
    fake = _use(monkeypatch, Fake([
        ("GET", "/oauth/access_token?client_id", [(200, {"access_token": "EAAshort", "token_type": "bearer", "expires_in": 5000})]),
        ("GET", "/oauth/access_token?grant_type=fb_exchange_token", [(200, {"access_token": "EAAlong"})]),
        ("GET", "/me/accounts?", [(200, {"data": [PAGE]})]),
        ("GET", "/me/permissions?", [(200, PERMS)]),
        ("GET", f"/{facebook.VERSION}/app?", [(200, {"id": APP_ID, "name": "Lazycow"})]),
        ("GET", "/me?", [(200, {"id": "u1", "name": "Kenji"}), (200, {"id": PAGE["id"], "name": PAGE["name"]})]),  # the user, then the Page
    ]))
    out = facebook.finish_signin({"code": "fb-code", "state": q["state"]}, PORT)

    ex = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(fake.find("/oauth/access_token?client_id")[0]["url"]).query))
    assert ex == {"client_id": APP_ID, "redirect_uri": "http://localhost:4317/oauth/facebook", "client_secret": APP_SECRET, "code": "fb-code"}
    assert fake.find("fb_exchange_token")  # made long-lived with the secret, so the Page token never expires
    assert out == {"connected": True, "account": PAGE["name"], "error": None}
    creds = facebook._load()
    assert creds["token"] == "EAAGpage" and creds["page_id"] == PAGE["id"] and creds["lasting"] is True and creds["via"] == "login"
    with pytest.raises(ValueError, match="already used"):  # the state is spent
        facebook.finish_signin({"code": "fb-code", "state": q["state"]}, PORT)


def test_facebook_cancel_and_meta_errors_are_plain_sentences_with_the_fix(store, monkeypatch):
    _, q = _fb_ready(store, monkeypatch)
    with pytest.raises(ValueError, match="pressed Cancel"):
        facebook.finish_signin({"error": "access_denied", "error_reason": "user_denied", "state": q["state"]}, PORT)

    _, q = _fb_ready(store, monkeypatch)
    _use(monkeypatch, Fake([("GET", "/oauth/access_token?client_id", [(400, {"error": {
        "message": "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request",
        "code": 100, "error_subcode": 36008}})])]))
    with pytest.raises(RuntimeError, match=r"Valid OAuth Redirect URIs.*Connect with Facebook again"):
        facebook.finish_signin({"code": "c", "state": q["state"]}, PORT)

    _, q = _fb_ready(store, monkeypatch)
    _use(monkeypatch, Fake([
        ("GET", "/oauth/access_token?client_id", [(200, {"access_token": "EAAshort"})]),
        ("GET", "/me?", [(200, {"id": "u1", "name": "Kenji"})]),
        ("GET", "/me/accounts?", [(200, {"data": [PAGE]})]),
        ("GET", "/me/permissions?", [(200, {"data": [{"permission": "pages_show_list", "status": "granted"}]})]),
    ]))
    with pytest.raises(ValueError, match="permission to read your Page and post on your Page.*Connect with Facebook again"):
        facebook.finish_signin({"code": "c", "state": q["state"]}, PORT)
    assert facebook._load() is None

    with pytest.raises(ValueError, match="not started from the studio"):
        facebook.finish_signin({"code": "c", "state": "forged"}, PORT)
