"""
FILE: py/studio/providers/async_task.py
PURPOSE: One adapter for every "submit a task, poll it, fetch the output" API, configured by the registry, not code:
         Replicate and kie.ai now; Runway, MiniMax, Together video, OpenRouter video, Luma and PiAPI are entries later.
OVERVIEW: The provider's registry entry has a `task` block:
            submit      {method, path, body}: path and body are templates ({model}, {input} = the model's filled input)
            id          where the task id is in the submit answer ("id", "data.taskId")
            pollUrl     where a ready-made status URL is in the submit answer ("urls.get"), or
            poll        a status path template ("/api/v1/jobs/recordInfo?taskId={id}")
            status      where the state is; done / failed: the state values that end it
            output      where the result is (a model may override it); error: where the failure message is
            cost        where the provider reports what it charged (costUnit "usd" or "credits", creditUsd per credit)
            bodyCode    for a service that answers HTTP 200 with its error in the body (kie.ai): the body's code, okCodes
          The submit is sent once (429/503 asked again; a timeout never resent: it may have been billed). Polling waits
          3 s growing to 15 s until the capability's deadline. `upload` sends a file as multipart form data and reads
          its URL from the answer. Outputs are downloaded at once by the caller (Replicate's URLs expire within 1 h).
DEPENDENCIES: studio.providers.base, studio.providers.http.
"""
from __future__ import annotations

import json
from pathlib import Path

from studio.providers.base import SUBMIT_TIMEOUT, Ctx, backoff, body_error, dig, fill, first_url
from studio.providers.http import AiError, _json, multipart, send


def upload(ctx: Ctx, path: Path, content_type: str) -> str:
    """A local file -> a URL the model can read, by the provider's own upload API (registry `upload`)."""
    up = ctx.provider.get("upload") or {}
    if up.get("kind") != "multipart":
        raise AiError(f"{ctx.name} takes no files from the studio yet; pick another provider for this step.", "bad_input", 400)
    body, ctype = multipart(dict(up.get("fields") or {}), {up.get("field") or "file": (Path(path), content_type)})
    status, headers, raw = send(ctx.http, "POST", ctx.url(up["url"]), ctx.name, sleep=ctx.sleep, data=body,
                                headers={**ctx.auth(), "Content-Type": ctype}, timeout=300)
    got = _json(raw)
    if status >= 400:
        raise ctx.error(status, got, headers)
    bad = body_error(ctx, got, ctx.provider.get("task") or {})
    if bad:
        raise bad
    url = dig(got, up.get("result"))
    if not url:
        raise AiError(f"{ctx.name} did not say where the uploaded file is.", "upstream", 502)
    return url


def run(ctx: Ctx, model_id: str, model: dict, payload: dict, deadline: float) -> dict:
    """Submit, wait, return {"output": the result (a URL or a list), "cost": what the provider says it charged
    (in USD) or None, "raw": the last answer}."""
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
    got = _json(raw)
    if status >= 400:
        raise ctx.error(status, got, headers)
    bad = body_error(ctx, got, t)
    if bad:
        raise bad
    task_id = dig(got, t.get("id") or "id")
    if not task_id:
        raise AiError(f"{ctx.name} accepted the request but sent no task id.", "upstream", 502)
    poll_url = dig(got, t.get("pollUrl")) if t.get("pollUrl") else None
    poll_url = poll_url or ctx.url(t.get("poll") or "", {"id": task_id})
    stop = ctx.clock() + deadline
    waits = backoff(ctx)
    done, failed = set(t.get("done") or ["succeeded"]), set(t.get("failed") or ["failed", "canceled"])
    state = dig(got, t.get("status") or "status")
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
        got = _json(raw)
        if status >= 400:
            raise ctx.error(status, got, headers)
        bad = body_error(ctx, got, t)
        if bad:
            raise bad
        state = dig(got, t.get("status") or "status")
    if state in failed:
        why = dig(got, t.get("error") or "error") or f"the task ended as {state}"
        err = ctx.error(422, {"detail": str(why)})
        err.charged = False
        raise err
    out = dig(got, model.get("output") or t.get("output") or "output")
    if out is None or (isinstance(out, (list, str, dict)) and not first_url(out)):
        raise AiError(f"{ctx.name} finished but sent back no result.", "upstream", 502, charged=True)
    cost = dig(got, t.get("cost")) if t.get("cost") else None
    if isinstance(cost, (int, float)) and t.get("costUnit") == "credits":
        cost = float(cost) * float(ctx.provider.get("creditUsd") or 0) if ctx.provider.get("creditUsd") else None
    return {"output": out, "cost": float(cost) if isinstance(cost, (int, float)) else None, "raw": got}
