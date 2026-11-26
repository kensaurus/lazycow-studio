"""
FILE: py/studio/providers/sync_http.py
PURPOSE: The simplest protocol: one request, one answer (ElevenLabs text to speech, sound effects and music, Stability's
         Stable Audio 2.5 and 3.0, OpenRouter's /audio/speech, MiniMax's /v1/t2a_v2).
OVERVIEW: The model's registry entry gives `path` (a template: "/v1/text-to-speech/{voice}?output_format=mp3_44100_128"),
          `input` (the body template), `body` ("json", the default, or "multipart" for form fields), `accept` (the
          Accept header) and optionally `timeout` (seconds, default 180).
          Usually the answer's body is the file; a JSON answer is then the provider's error. A model with `result`
          (a path, e.g. MiniMax's "data.audio" with output_format "url") answers in JSON instead, and the file's URL is
          read from there; `bodyCode` / `okCodes` / `bodyMessage` read an error a provider puts inside an HTTP 200
          (MiniMax's base_resp.status_code). A 429 or 503 is asked again; a request that timed out is never sent again
          (the provider may have made, and billed, the file), so it is reported as charged.
          `quantityHeader` names a response header with what was billed (ElevenLabs' character count) and
          `quantityField` a field of a JSON answer (MiniMax's extra_info.usage_characters), so the cost can be worked
          out from what was really used.
          A model with `poll` ({path, id}: Stability's Stable Audio 3.0) answers HTTP 202 and a generation id first;
          the file is then fetched from poll.path ("/v2beta/audio/results/{id}") with the same Accept header, asked
          again (3 s growing to 15 s) while it answers 202, until the capability's deadline. The request is never sent
          twice; a failed generation is not charged by the provider.
DEPENDENCIES: studio.providers.base, studio.providers.http.
"""
from __future__ import annotations

import json

from studio.providers.base import Ctx, backoff, body_error, dig, finish, first_url
from studio.providers.http import AiError, _json, multipart, send

TIMEOUT = 180


def _number(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _poll(ctx: Ctx, model: dict, raw: bytes, headers: dict, deadline: float | None):
    """(status, headers, body) of the finished file for a model that answered 202 and a generation id (`poll`)."""
    spec = model["poll"]
    gid = dig(_json(raw), spec.get("id") or "id")
    if not gid:
        raise AiError(f"{ctx.name} accepted the request but sent no generation id.", "upstream", 502, charged=True)
    url = ctx.url(spec["path"], {"id": gid})
    stop = ctx.clock() + float(deadline or model.get("timeout") or 600)
    waits = backoff(ctx)
    while True:
        if ctx.clock() > stop:
            raise AiError(f"{ctx.name} did not finish within {int(float(deadline or 600) // 60)} minutes. Try again later.", "timeout", 504, charged=True)
        ctx.sleep(next(waits))
        try:
            status, rh, body = ctx.http("GET", url, ctx.name, headers={k: v for k, v in headers.items() if k != "Content-Type"}, timeout=60)
        except AiError as err:
            if err.code not in ("timeout", "network"):
                raise
            continue  # a check that did not get through: ask again later, never resubmit
        if status in (202, 429, 503):
            continue
        return status, rh, body


def run(ctx: Ctx, model_id: str, model: dict, values: dict, deadline: float | None = None) -> dict:
    """{"bytes": the file or None, "url": the file's URL or None, "type": its content type, "billed": the quantity the
    provider reported or None}. deadline: seconds a model that answers later (`poll`) may take."""
    if not ctx.key:
        raise AiError(f"Add your {ctx.name} key in Settings › AI.", "no_key", 400)
    values = {"model": model_id, **values}
    fields = finish(model.get("input") or {}, values)
    if model.get("body") == "multipart":
        data, ctype = multipart(fields)
    else:
        data, ctype = json.dumps(fields).encode("utf-8"), "application/json"
    headers = {**ctx.auth(), "Content-Type": ctype, "Accept": model.get("accept") or "audio/mpeg"}
    try:
        status, rh, raw = send(ctx.http, "POST", ctx.url(model.get("path") or "", values), ctx.name, sleep=ctx.sleep, data=data,
                               headers=headers, timeout=int(model.get("timeout") or TIMEOUT))
    except AiError as err:
        if err.code == "timeout":
            err.charged = True  # it may have been made and billed: never sent twice
        raise
    if model.get("poll") and status == 202:
        status, rh, raw = _poll(ctx, model, raw, headers, deadline)
    low = {str(k).lower(): v for k, v in (rh or {}).items()}
    rtype = str(low.get("content-type") or "")
    if status >= 400:
        raise ctx.error(status, _json(raw), rh)
    billed = _number(low.get(model["quantityHeader"].lower())) if model.get("quantityHeader") else None
    if model.get("result"):  # a JSON answer that says where the file is
        body = _json(raw)
        bad = body_error(ctx, body, model)
        if bad:
            raise bad
        url = first_url(dig(body, model["result"]))
        if not url:
            raise AiError(f"{ctx.name} sent back no file: {ctx.scrub(str(body)[:200]) or 'an empty answer'}.", "upstream", 502, charged=False)
        if model.get("quantityField"):
            billed = _number(dig(body, model["quantityField"]))
        return {"bytes": None, "url": url, "type": "", "billed": billed}
    if rtype.startswith("application/json") or not raw:
        body = _json(raw)
        raise AiError(f"{ctx.name} sent back no file: {ctx.scrub(str(body.get('message') or body.get('detail') or body)[:200]) or 'an empty answer'}.",
                      "upstream", 502, charged=False)
    return {"bytes": raw, "url": None, "type": rtype, "billed": billed}
