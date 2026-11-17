"""
FILE: py/studio/providers/async_task.py
PURPOSE: One adapter for every "submit a task, poll it, fetch the output" API, configured by the registry, not code:
         Replicate, kie.ai, Runway, MiniMax, Together video, OpenRouter video, Higgsfield, Luma and PiAPI.
OVERVIEW: The provider's registry entry (or a model's own, merged over it) has a `task` block:
            submit      {method, path, body}: path and body are templates ({model}, {input} = the model's filled input;
                        a body of just "{input}" sends the input as the whole body)
            id          where the task id is in the submit answer ("id", "data.taskId", "request_id")
            pollUrl     where a ready-made status URL is in the submit answer ("urls.get", "status_url"), or
            poll        a status path template ("/api/v1/jobs/recordInfo?taskId={id}", "/v1/tasks/{id}")
            status      where the state is; done / failed: the state values that end it (compared without case)
            output      where the result is (a model may override it); error: where the failure message is
            outputAuth  true when the result URL needs the key too (OpenRouter's unsigned_urls)
            cost        where the provider reports what it charged (costUnit "usd" or "credits", creditUsd per credit)
            bodyCode    for a service that answers HTTP 200 with its error in the body (kie.ai): the body's code, okCodes
          The submit is sent once (429/503 asked again; a timeout never resent: it may have been billed). Polling waits
          3 s growing to 15 s until the capability's deadline. Outputs are downloaded at once by the caller (Replicate's
          URLs expire within 1 h).
          `upload` (registry) is how a local file reaches the model, one of:
            multipart    POST the file as form data, read its URL from the answer (Replicate, kie.ai)
            data_uri     no upload: the file goes inline as data:<type>;base64,… (Runway, MiniMax, OpenRouter; maxBytes)
            base64       no upload: the bare base64 text (Together's frame_images)
            json_base64  POST {file_name, file_data: base64} as JSON, read the URL (PiAPI's ephemeral upload)
            presigned    POST {content_type} for an upload URL, PUT the bytes there with the headers it gives, then use
                         its public URL (Higgsfield); the key is never sent to the storage URL
DEPENDENCIES: studio.providers.base, studio.providers.http.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

from studio.providers.base import SUBMIT_TIMEOUT, Ctx, backoff, body_error, dig, fill, first_url
from studio.providers.http import AiError, _json, multipart, send

UPLOAD_KINDS = ("multipart", "data_uri", "base64", "json_base64", "presigned")


def _answer(ctx: Ctx, status: int, headers: dict, raw: bytes, spec: dict) -> dict:
    got = _json(raw)
    if status >= 400:
        raise ctx.error(status, got, headers)
    bad = body_error(ctx, got, spec)
    if bad:
        raise bad
    return got


def upload(ctx: Ctx, path: Path, content_type: str) -> str:
    """A local file -> what the model reads in its place: a URL from the provider's upload API, or the file inline."""
    up = ctx.provider.get("upload") or {}
    kind = up.get("kind")
    path = Path(path)
    if kind in ("data_uri", "base64"):
        raw = path.read_bytes()
        limit = int(up.get("maxBytes") or 0)
        b64 = base64.b64encode(raw).decode("ascii")
        if limit and len(b64) > limit:
            raise AiError(f"{path.name} is too large for {ctx.name} ({len(raw) // 1024} KB); it takes files up to {limit * 3 // 4 // 1024} KB.",
                          "bad_input", 400)
        return f"data:{content_type};base64,{b64}" if kind == "data_uri" else b64
    if kind == "multipart":
        body, ctype = multipart(dict(up.get("fields") or {}), {up.get("field") or "file": (path, content_type)})
        status, headers, raw = send(ctx.http, "POST", ctx.url(up["url"]), ctx.name, sleep=ctx.sleep, data=body,
                                    headers={**ctx.auth(), "Content-Type": ctype}, timeout=300)
        got = _answer(ctx, status, headers, raw, ctx.provider.get("task") or {})
    elif kind == "json_base64":
        body = {up.get("nameField") or "file_name": path.name, up.get("dataField") or "file_data": base64.b64encode(path.read_bytes()).decode("ascii")}
        status, headers, raw = send(ctx.http, "POST", ctx.url(up["url"]), ctx.name, sleep=ctx.sleep, data=json.dumps(body).encode("utf-8"),
                                    headers={**ctx.auth(), "Content-Type": "application/json"}, timeout=300)
        got = _answer(ctx, status, headers, raw, up)
    elif kind == "presigned":
        ask = fill(up.get("body") or {"content_type": "{content_type}"}, {"content_type": content_type, "name": path.name})
        status, headers, raw = send(ctx.http, "POST", ctx.url(up["url"]), ctx.name, sleep=ctx.sleep, data=json.dumps(ask).encode("utf-8"),
                                    headers={**ctx.auth(), "Content-Type": "application/json"}, timeout=60)
        slot = _answer(ctx, status, headers, raw, up)
        put_url, put_headers = dig(slot, up.get("uploadUrl") or "upload_url"), dig(slot, up.get("uploadHeaders") or "upload_headers") or {}
        if not isinstance(put_url, str) or not put_url.startswith("https://"):
            raise AiError(f"{ctx.name} did not give an upload address.", "upstream", 502)
        # The storage URL is presigned: the provider's key must never go there.
        status, headers, raw = send(ctx.http, up.get("method") or "PUT", put_url, ctx.name, sleep=ctx.sleep, data=path.read_bytes(),
                                    headers={"Content-Type": content_type, **{str(k): str(v) for k, v in put_headers.items()}}, timeout=300)
        if status >= 400:
            raise ctx.error(status, _json(raw), headers)
        got = slot
    else:
        raise AiError(f"{ctx.name} takes no files from the studio yet; pick another provider for this step.", "bad_input", 400)
    url = dig(got, up.get("result"))
    if not url:
        raise AiError(f"{ctx.name} did not say where the uploaded file is.", "upstream", 502)
    return url


def _states(values, default) -> set[str]:
    return {str(v).lower() for v in (values or default)}


def run(ctx: Ctx, model_id: str, model: dict, payload: dict, deadline: float) -> dict:
    """Submit, wait, return {"output": the result (a URL or a list), "cost": what the provider says it charged
    (in USD) or None, "headers": what the result's download needs (the key, when outputAuth), "raw": the last answer}."""
    if not ctx.key:
        raise AiError(f"Add your {ctx.name} key in Settings › AI.", "no_key", 400)
    t = {**(ctx.provider.get("task") or {}), **(model.get("task") or {})}
    sub = t.get("submit") or {}
    values = {"model": model_id, "input": payload, **(model.get("values") or {})}
    body = fill(sub.get("body") or {"input": "{input}"}, values)
    url = ctx.url(model.get("submitPath") or sub.get("path") or "", values)
    try:
        status, headers, raw = send(ctx.http, sub.get("method", "POST"), url, ctx.name, sleep=ctx.sleep, data=json.dumps(body).encode("utf-8"),
                                    headers={**ctx.auth(), "Content-Type": "application/json", **(t.get("headers") or {})}, timeout=SUBMIT_TIMEOUT)
    except AiError as err:
        if err.code == "timeout":
            err.charged = True  # it may have been accepted (and billed): never sent again
        raise
    got = _answer(ctx, status, headers, raw, t)
    task_id = dig(got, t.get("id") or "id")
    if not task_id:
        raise AiError(f"{ctx.name} accepted the request but sent no task id.", "upstream", 502)
    poll_url = dig(got, t.get("pollUrl")) if t.get("pollUrl") else None
    poll_url = poll_url if isinstance(poll_url, str) and poll_url.startswith("https://") else ctx.url(t.get("poll") or "", {"id": task_id})
    stop = ctx.clock() + deadline
    waits = backoff(ctx)
    done, failed = _states(t.get("done"), ["succeeded"]), _states(t.get("failed"), ["failed", "canceled"])
    state = str(dig(got, t.get("status") or "status") or "").lower()
    while state not in done:
        if state in failed:
            break
        if ctx.clock() > stop:
            raise AiError(f"{ctx.name} did not finish within {int(deadline // 60)} minutes. Try again later.", "timeout", 504, charged=True)
        ctx.sleep(next(waits))
        try:
            status, headers, raw = ctx.http("GET", poll_url, ctx.name, headers=ctx.auth(), timeout=30)
        except AiError as err:
            if err.code not in ("timeout", "network"):
                raise
            continue  # a status check that did not get through: check again later, never resubmit
        if status in (429, 503):
            continue
        got = _answer(ctx, status, headers, raw, t)
        state = str(dig(got, t.get("status") or "status") or "").lower()
    if state in failed:
        why = dig(got, t.get("error") or "error") or f"the task ended as {state}"
        err = ctx.error(422, {"detail": str(why if not isinstance(why, dict) else why.get("message") or why)})
        err.charged = False
        raise err
    out = dig(got, model.get("output") or t.get("output") or "output")
    if out is None or (isinstance(out, (list, str, dict)) and not first_url(out)):
        raise AiError(f"{ctx.name} finished but sent back no result.", "upstream", 502, charged=True)
    cost = dig(got, t.get("cost")) if t.get("cost") else None
    if isinstance(cost, str):
        try:
            cost = float(cost)
        except ValueError:
            cost = None
    if isinstance(cost, (int, float)) and t.get("costUnit") == "credits":
        cost = float(cost) * float(ctx.provider.get("creditUsd") or 0) if ctx.provider.get("creditUsd") else None
    return {"output": out, "cost": float(cost) if isinstance(cost, (int, float)) else None,
            "headers": ctx.auth() if t.get("outputAuth") else None, "raw": got}
