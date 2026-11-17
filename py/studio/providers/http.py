"""
FILE: py/studio/providers/http.py
PURPOSE: The one HTTP layer every AI provider goes through: a request, its errors in plain words, a download.
OVERVIEW: _call is the raw transport (an HTTP error status is an answer, not an exception). _http turns a network
          failure into an AiError (timeout 504, network 503). _provider_error turns a provider's error status or body
          into one plain sentence with a short code (bad_key, no_credits, rate_limited, timeout, bad_input, upstream).
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
import socket
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


class AiError(RuntimeError):
    """A plain sentence for a person, a short code for the page, and the HTTP status the studio answers with.
    `charged`: the provider billed the call even though it failed (keep the estimate in the ledger)."""

    def __init__(self, message: str, code: str, status: int = 400, charged: bool = False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.charged = charged


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


def _said(body, scrub=lambda s: s) -> str:
    """The provider's own words from an error body ({detail}, {error}, {message}, {msg}), scrubbed and short."""
    if isinstance(body, dict):
        d = body.get("detail") or body.get("error") or body.get("message") or body.get("msg") or ""
        if isinstance(d, list):
            d = "; ".join(str(x.get("msg") if isinstance(x, dict) else x) for x in d[:3])
        if isinstance(d, dict):
            d = d.get("message") or json.dumps(d)[:200]
        return scrub(str(d))[:240]
    return ""


def _provider_error(name: str, status: int, body, headers: dict | None = None, scrub=lambda s: s) -> AiError:
    """A provider's error answer as one plain sentence. `name`: the provider's display name (fal.ai, ElevenLabs …)."""
    said = _said(body, scrub)
    low = said.lower()
    if status in (401, 403) and not ("balance" in low or "credit" in low):
        return AiError(f"{name} did not accept the key. Paste a fresh key in Settings › AI.", "bad_key", 400)
    if status == 402 or "exhausted balance" in low or "insufficient" in low and ("credit" in low or "balance" in low):
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
