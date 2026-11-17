"""
FILE: py/studio/providers/sync_http.py
PURPOSE: The simplest protocol: one request, and the answer's body is the file (ElevenLabs text to speech and sound
         effects, Stability's Stable Audio 2.5, OpenAI-style /audio/speech).
OVERVIEW: The model's registry entry gives `path` (a template: "/v1/text-to-speech/{voice}?output_format=mp3_44100_128"),
          `input` (the body template), `body` ("json", the default, or "multipart" for form fields), `accept` (the
          Accept header) and optionally `timeout` (seconds, default 180). The answer must be audio or video bytes; a
          JSON answer is the provider's error. A 429 or 503 is asked again; a request that timed out is never sent
          again (the provider may have made, and billed, the file), so it is reported as charged.
          `quantityHeader` names a response header with what was billed (ElevenLabs' character count), so the cost
          can be worked out from what was really used.
DEPENDENCIES: studio.providers.base, studio.providers.http.
"""
from __future__ import annotations

import json

from studio.providers.base import Ctx, finish
from studio.providers.http import AiError, _json, multipart, send

TIMEOUT = 180


def run(ctx: Ctx, model_id: str, model: dict, values: dict) -> dict:
    """{"bytes": the file, "type": its content type, "billed": the quantity header's value or None}."""
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
    low = {str(k).lower(): v for k, v in (rh or {}).items()}
    rtype = str(low.get("content-type") or "")
    if status >= 400:
        raise ctx.error(status, _json(raw), rh)
    if rtype.startswith("application/json") or not raw:
        body = _json(raw)
        raise AiError(f"{ctx.name} sent back no file: {ctx.scrub(str(body.get('message') or body.get('detail') or body)[:200]) or 'an empty answer'}.",
                      "upstream", 502, charged=False)
    billed = None
    if model.get("quantityHeader"):
        try:
            billed = float(low.get(model["quantityHeader"].lower()))
        except (TypeError, ValueError):
            billed = None
    return {"bytes": raw, "type": rtype, "billed": billed}
