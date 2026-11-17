"""
FILE: py/studio/providers/fal_queue.py
PURPOSE: The fal-style queue protocol (fal.ai; any service with the same submit / status_url / response_url shape).
OVERVIEW: upload(): a file to fal's storage (a short-lived token, then the bytes) -> a public URL the model reads.
          run(): POST <base>/<endpoint> -> {request_id, status_url, response_url}; GET status_url until COMPLETED,
          waiting 3 s growing to 15 s; GET response_url -> the output. The submit is sent once: a 429 or 503 is asked
          again (it was not accepted), but a submit that timed out is never sent again, since it may have been
          accepted and billed. A status check that times out or answers 429/503 is simply checked again later, until
          the capability's deadline. An answer after the deadline: the job may still finish at fal, so it counts as billed.
DEPENDENCIES: studio.providers.base, studio.providers.http.
TECHNICAL DETAILS (fal docs, read 2026-11-09): queue POST https://queue.fal.run/<endpoint> (Authorization: Key <key>);
       upload POST https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3 {} -> {token, token_type, base_url},
       then POST <base_url>/files/upload (raw bytes) -> {access_url}.
"""
from __future__ import annotations

import json
from pathlib import Path

from studio.providers.base import SUBMIT_TIMEOUT, Ctx, backoff
from studio.providers.http import AiError, _json, send


def upload(ctx: Ctx, path: Path, content_type: str) -> str:
    up = ctx.provider.get("upload") or {}
    status, headers, raw = ctx.http("POST", up["token"], ctx.name, data=b"{}",
                                    headers={**ctx.auth(), "Content-Type": "application/json", "Accept": "application/json"}, timeout=30)
    tok = _json(raw)
    if status >= 400 or not tok.get("token"):
        raise ctx.error(status, tok, headers)
    base = str(tok.get("base_url") or "https://v3.fal.media").rstrip("/")
    status, headers, raw = ctx.http("POST", f"{base}/files/upload", ctx.name, data=Path(path).read_bytes(),
                                    headers={"Authorization": f"{tok.get('token_type') or 'Bearer'} {tok['token']}", "Content-Type": content_type,
                                             "X-Fal-File-Name": Path(path).name}, timeout=300)
    got = _json(raw)
    if status >= 400 or not got.get("access_url"):
        raise ctx.error(status, got, headers)
    return got["access_url"]


def run(ctx: Ctx, endpoint: str, payload: dict, deadline: float) -> dict:
    """Submit once, wait, return the output. Raises AiError in plain words."""
    if not ctx.key:
        raise AiError(f"Add your {ctx.name} key in Settings › AI.", "no_key", 400)
    base = str(ctx.provider.get("base") or "https://queue.fal.run").rstrip("/")
    try:
        status, headers, raw = send(ctx.http, "POST", f"{base}/{endpoint}", ctx.name, sleep=ctx.sleep, data=json.dumps(payload).encode("utf-8"),
                                    headers={**ctx.auth(), "Content-Type": "application/json"}, timeout=SUBMIT_TIMEOUT)
    except AiError as err:
        if err.code == "timeout":
            err.charged = True  # it may have been accepted (and billed): never sent again
        raise
    sub = _json(raw)
    if status >= 400 or not sub.get("status_url"):
        raise ctx.error(status, sub, headers)
    stop = ctx.clock() + deadline
    waits = backoff(ctx)
    st: dict = {}
    while True:
        try:
            status, headers, raw = ctx.http("GET", sub["status_url"], ctx.name, headers=ctx.auth(), timeout=30)
        except AiError as err:
            if err.code not in ("timeout", "network"):
                raise
            status, headers, raw = 503, {}, b"{}"   # a status check that did not get through: check again later
        if status in (429, 503):
            st = {}
        else:
            st = _json(raw)
            if status >= 400:
                raise ctx.error(status, st, headers)
            if st.get("status") == "COMPLETED":
                break
        if ctx.clock() > stop:
            raise AiError(f"{ctx.name} did not finish within {int(deadline // 60)} minutes. Try again later.", "timeout", 504, charged=True)
        ctx.sleep(next(waits))
    status, headers, raw = ctx.http("GET", sub["response_url"], ctx.name, headers=ctx.auth(), timeout=60)
    out = _json(raw)
    if status >= 400 or st.get("error"):
        err = ctx.error(status if status >= 400 else 422, out if status >= 400 else {"detail": st.get("error")}, headers)
        err.charged = False
        raise err
    return out
