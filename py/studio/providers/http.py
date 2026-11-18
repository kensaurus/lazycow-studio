"""
FILE: py/studio/providers/http.py
PURPOSE: The one HTTP layer every AI provider goes through: a request, its errors in plain words, a download.
OVERVIEW: _call is the raw transport (an HTTP error status is an answer, not an exception). _http turns a network
          failure into an AiError (timeout 504, network 503). _provider_error turns a provider's error status or body
          into one plain sentence with a short code (bad_key, no_credits, rate_limited, timeout, bad_input, refused,
          upstream), and every AiError carries `kind`, one word of the shared vocabulary (KINDS: out_of_credit, auth,
          rate_limited, unavailable, refused, bad_input) that the automatic switch to a backup service reads.
          send() adds the retry rule: only 429 and 503 are retried, honouring Retry-After, and a timeout is never
          retried (a submit that timed out may have been accepted and billed). download() saves an output at once
          (Replicate's URLs expire within the hour).
DEPENDENCIES: Python stdlib (certifi when installed).
USAGE: studio.ai re-exports _call, _http, _provider_error and download and passes its own _http into every adapter, so
       a test that patches ai._call (py/tests/test_ai.py) answers every provider's calls.
NOTES: Nothing here reads a key or the .env; the caller passes `scrub`, which removes every key from a message.
"""
from __future__ import annotations

import json
import re
import socket
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

# One error vocabulary for every provider (docs/ai-api.md, "When a service runs out"): what kind of failure it was,
# whoever answered. The automatic switch to a backup service reads only this, never a provider's own words.
#   out_of_credit  402, a balance / quota / credits message (also inside an HTTP 200: kie.ai, MiniMax)
#   auth           a missing, refused or expired key
#   rate_limited   429 after the retries
#   unavailable    5xx, a timeout, no connection
#   refused        a content or safety refusal (never worked around by asking another service)
#   bad_input      anything else the provider could not use
KINDS = ("out_of_credit", "auth", "rate_limited", "unavailable", "refused", "bad_input")
CODE_KIND = {"no_credits": "out_of_credit", "bad_key": "auth", "no_key": "auth", "rate_limited": "rate_limited",
             "timeout": "unavailable", "network": "unavailable", "upstream": "unavailable", "refused": "refused", "bad_input": "bad_input"}
KIND_CODE = {"out_of_credit": "no_credits", "auth": "bad_key", "rate_limited": "rate_limited", "unavailable": "upstream",
             "refused": "refused", "bad_input": "bad_input"}
KIND_STATUS = {"out_of_credit": 402, "auth": 401, "rate_limited": 429, "unavailable": 503, "refused": 422, "bad_input": 400}
# A provider's words that mean the account has no money left (fal's "Exhausted balance", OpenRouter's "Insufficient
# credits", Runway's "You do not have enough credits", OpenAI-style "insufficient_quota", Gemini's "exceeded your current
# quota … billing", ElevenLabs' "quota_exceeded").
CREDIT_RX = re.compile(r"insufficient[ _-]?(credit|balance|quota|fund)|exhausted balance|out of credit|not (have )?enough (credit|balance)"
                       r"|no (remaining )?credits|quota[_ ]exceeded|exceeds? your (current )?(character )?quota|exceeded your current quota"
                       r"|payment[ _]required|balance (is )?(too low|insufficient)|credit balance|top up your|billing (details|hard limit)", re.I)
# A per-minute limit says "quota" too (Gemini): that is a wait, not an empty account.
RATE_RX = re.compile(r"per[ _-]?(minute|second)|rate[ _-]?limit|too many requests|requests per|\brpm\b|\btpm\b", re.I)
# A content or safety refusal (Higgsfield nsfw, Runway SAFETY.*, Replicate "flagged", MiniMax "sensitive content").
REFUSED_RX = re.compile(r"moderat|nsfw|\bsafety\b|safety[._]|flagged|sensitive content|content[ _-]?(policy|filter|violation)|inappropriate"
                        r"|prohibited content|responsible ai", re.I)


def kind_of(code: str | None) -> str | None:
    """The vocabulary word for one of the studio's codes; None for the studio's own refusals (cap, no_price, off …),
    which are never a reason to try another service."""
    return CODE_KIND.get(str(code or ""))


class AiError(RuntimeError):
    """A plain sentence for a person, a short code for the page, and the HTTP status the studio answers with.
    `charged`: the provider billed the call even though it failed (keep the estimate in the ledger).
    `kind`: the shared error vocabulary (KINDS), read by the automatic switch to a backup service."""

    def __init__(self, message: str, code: str, status: int = 400, charged: bool = False, kind: str | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.charged = charged
        self.kind = kind or kind_of(code)


RETRY_STATUS = (429, 503)
RETRIES = 3               # a 429 or 503 is tried at most this many more times
RETRY_CAP = 60.0          # never wait longer than this for one Retry-After


def _tls():
    try:
        import ssl

        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return None


def _call(method: str, url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: int = 60):
    """One HTTP request -> (status, headers, body). An HTTP error status is an answer, not an exception."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls()) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers or {}), err.read()


def _http(method: str, url: str, who: str = "the AI service", *, transport=None, **kw):
    """One request through `transport` (default _call); a network failure becomes an AiError in plain words."""
    try:
        return (transport or _call)(method, url, **kw)
    except (socket.timeout, TimeoutError) as err:
        raise AiError(f"{who} took too long to answer. Try again in a minute.", "timeout", 504) from err
    except OSError as err:
        if "timed out" in str(getattr(err, "reason", err)):
            raise AiError(f"{who} took too long to answer. Try again in a minute.", "timeout", 504) from err
        raise AiError(f"Could not reach {who}. Check the internet connection, then try again.", "network", 503) from err


def retry_after(headers: dict | None, default: float) -> float:
    """Seconds to wait from a Retry-After header (seconds only; a date is treated as the default), capped."""
    h = {str(k).lower(): v for k, v in (headers or {}).items()}
    try:
        return max(0.0, min(RETRY_CAP, float(h.get("retry-after"))))
    except (TypeError, ValueError):
        return default


def send(http, method: str, url: str, who: str, *, sleep=time.sleep, wait: float = 2.0, **kw):
    """http(...) with the retry rule: a 429 or 503 answer is asked again (Retry-After honoured), up to RETRIES times.
    A timeout or network failure is raised at once: the request may have reached the provider (never sent twice)."""
    for attempt in range(RETRIES + 1):
        status, headers, raw = http(method, url, who, **kw)
        if status not in RETRY_STATUS or attempt == RETRIES:
            return status, headers, raw
        sleep(retry_after(headers, wait * (attempt + 1)))
    return status, headers, raw  # pragma: no cover - the loop always returns


def _json(body: bytes):
    try:
        return json.loads(body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError, AttributeError):
        return {}


def _one(body):
    """An error body that comes as a list of one error (Gemini's OpenAI-compatible endpoint: [{"error": {…}}])."""
    return body[0] if isinstance(body, list) and body and isinstance(body[0], dict) else body


def _said(body, scrub=lambda s: s) -> str:
    """The provider's own words from an error body ({detail}, {error}, {message}, {msg}, Stability's {errors: […]}),
    scrubbed and short."""
    body = _one(body)
    if isinstance(body, dict):
        d = body.get("detail") or body.get("error") or body.get("message") or body.get("msg") or body.get("errors") or ""
        if isinstance(d, dict) and not (d.get("message") or d.get("msg")) and isinstance(d.get("error"), dict):
            d = d["error"]
        if isinstance(d, list):
            d = "; ".join(str(x.get("msg") if isinstance(x, dict) else x) for x in d[:3])
        if isinstance(d, dict):
            d = d.get("message") or json.dumps(d)[:200]
        return scrub(str(d))[:240]
    return ""


def _signals(body) -> str:
    """The machine words around a provider's message (OpenAI's error.type "insufficient_quota", ElevenLabs'
    detail.status "quota_exceeded", Google's error.status "RESOURCE_EXHAUSTED", Runway's failureCode "SAFETY.INPUT…"),
    so the kind of failure is read from them as well as from the sentence."""
    out = []

    def walk(d, depth=0):
        if not isinstance(d, dict) or depth > 2:
            return
        for k in ("code", "type", "status", "failureCode", "error_code", "name", "reason"):
            v = d.get(k)
            if isinstance(v, (str, int)) and not isinstance(v, bool):
                out.append(str(v))
        for k in ("error", "detail"):
            walk(d.get(k), depth + 1)
    walk(_one(body))
    return " ".join(out)


# A refused key said with a 400 (Google: "API key not valid", INVALID_ARGUMENT).
AUTH_RX = re.compile(r"api[ _-]?key (is )?(not valid|invalid|missing|expired|revoked)|invalid[ _-]?api[ _-]?key|incorrect api key|invalid credentials"
                     r"|unauthori[sz]ed|authentication (failed|required|credentials)|login fail", re.I)


def classify(status: int, said: str, signals: str = "") -> str:
    """The vocabulary word for a provider's error answer (status, its message, its machine words)."""
    text = f"{said} {signals}"
    if REFUSED_RX.search(text) and status not in (401, 402, 429) and not CREDIT_RX.search(text):
        return "refused"
    if status == 402 or (CREDIT_RX.search(text) and not (status == 429 and RATE_RX.search(text))):
        return "out_of_credit"
    if status in (401, 403) or (status == 400 and AUTH_RX.search(text)):
        return "auth"
    if status == 429:
        return "rate_limited"
    if status in (408, 504) or status >= 500:
        return "unavailable"
    return "bad_input"


def _provider_error(name: str, status: int, body, headers: dict | None = None, scrub=lambda s: s) -> AiError:
    """A provider's error answer as one plain sentence. `name`: the provider's display name (fal.ai, ElevenLabs …)."""
    said = _said(body, scrub)
    kind = classify(status, said, _signals(body))
    if kind == "refused":
        return AiError(f"{name} refused this request on content or safety grounds: {said or f'HTTP {status}'}. Another service is not "
                       "asked in its place; change the input instead.", "refused", 422, kind="refused")
    if kind == "auth":
        return AiError(f"{name} did not accept the key. Paste a fresh key in Settings › AI.", "bad_key", 400)
    if kind == "out_of_credit":
        return AiError(f"{name} says the account is out of credit. Top it up on {name}'s billing page, then try again.", "no_credits", 402)
    if status == 429:
        wait = (headers or {}).get("Retry-After") or (headers or {}).get("retry-after")
        return AiError(f"{name} says too many requests right now. Wait {wait or 'a minute'}{' seconds' if wait else ''}, then try again.", "rate_limited", 429)
    if status in (408, 504):
        return AiError(f"{name} took too long to answer. Try again in a minute.", "timeout", 504)
    if 400 <= status < 500:
        return AiError(f"{name} could not use that request: {said or f'HTTP {status}'}.", "bad_input", 400)
    return AiError(f"{name} had a problem on its side ({said or f'HTTP {status}'}). Try again in a few minutes.", "upstream", 502)


def download(url: str, dest: Path, who: str = "fal.ai", *, http=None, headers: dict | None = None) -> Path:
    """Save one output at once (written to a .part file, then moved). Only https addresses are fetched. It was paid
    for, so a failed download is `charged`."""
    if not str(url).startswith("https://"):
        raise AiError(f"{who} sent back an address the studio will not download.", "upstream", 502)
    status, _, raw = (http or _http)("GET", url, who, timeout=300, **({"headers": headers} if headers else {}))
    if status >= 400 or not raw:
        raise AiError(f"Could not download the result from {who} (HTTP {status}). It was paid for; run the tool again to retry the download.", "upstream", 502, charged=True)
    return write(raw, dest)


def write(raw: bytes, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(raw)
    tmp.replace(dest)
    return dest


def multipart(fields: dict, files: dict | None = None) -> tuple[bytes, str]:
    """A multipart/form-data body -> (bytes, content type). fields: {name: value}; files: {name: (Path, content type)}."""
    boundary = "lazycow" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        if v is None:
            continue
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n".encode()
        out += (v if isinstance(v, bytes) else str(v).encode("utf-8")) + b"\r\n"
    for k, (path, ctype) in (files or {}).items():
        p = Path(path)
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{p.name}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode()
        out += p.read_bytes() + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"
