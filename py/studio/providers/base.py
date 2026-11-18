"""
FILE: py/studio/providers/base.py
PURPOSE: What the four protocol adapters share: the call context, filling a registry input template, reading a value
         out of a provider's answer by a dotted path, and polling with back-off.
OVERVIEW: Ctx carries everything an adapter may touch (the HTTP function, sleep, the key, the provider's registry entry,
          the scrubber), so an adapter never reads .env or the network on its own and tests drive it with a fake.
          protocol_of() is a model's protocol: its own `protocol` when it names one (OpenRouter's video and speech
          models speak async_task / sync_http although OpenRouter's chat is openai_chat), else its provider's.
          fill() turns {"duration": "{seconds:str}"} into {"duration": "5"}: a value that is exactly one placeholder keeps
          its type (int, float, str, json), a placeholder inside longer text is replaced as text, and a key whose value
          is missing (None) is left out. dig() reads "data.resultJson.~json.resultUrls.0" (~json parses a JSON string; not "@json", which reads as an e-mail address to the export scan).
DEPENDENCIES: Python stdlib.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from studio.providers.http import KIND_CODE, KIND_STATUS, AiError, _json, _provider_error

POLL_FIRST, POLL_MAX, POLL_GROWTH = 3.0, 15.0, 1.5   # seconds: 3 s, backing off to 15 s
SUBMIT_TIMEOUT = 60
_PH = re.compile(r"\{([a-z_][a-z0-9_]*)(?::(int|float|str|json))?\}")
_MISSING = object()


@dataclass
class Ctx:
    """One provider call's surroundings. http(method, url, who, **kw) -> (status, headers, body)."""
    pid: str
    provider: dict
    http: Callable
    key: str = ""
    sleep: Callable = time.sleep
    poll: float = POLL_FIRST
    scrub: Callable = lambda s: s  # noqa: E731
    clock: Callable = time.time
    extra: dict = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.provider.get("name") or self.pid

    def auth(self) -> dict:
        """The key's header, plus the provider's fixed headers (registry `headers`, e.g. Runway's X-Runway-Version),
        which every call to it needs. The fixed ones are never secret."""
        a = self.provider.get("auth") or {}
        fixed = dict(self.provider.get("headers") or {})
        if not self.key or not a.get("header"):
            return fixed
        return {**fixed, a["header"]: f"{a.get('scheme', '')}{self.key}"}

    def error(self, status: int, body, headers: dict | None = None) -> AiError:
        return _provider_error(self.name, status, body, headers, self.scrub)

    def url(self, path: str, values: dict | None = None) -> str:
        p = fill(path, values or {})
        return p if p.startswith("https://") or p.startswith("http://") else str(self.provider.get("base", "")).rstrip("/") + p


def protocol_of(provider: dict, model: dict | None) -> str:
    return str((model or {}).get("protocol") or provider.get("protocol") or "")


def _cast(v, kind):
    if kind == "int":
        return int(round(float(v)))
    if kind == "float":
        return float(v)
    if kind == "str":
        return str(v)
    if kind == "json":
        return json.dumps(v)
    return v


def fill(template: Any, values: dict) -> Any:
    """A registry template with `values` put in. A key whose whole value is a missing placeholder is left out."""
    if isinstance(template, dict):
        out = {}
        for k, v in template.items():
            got = fill(v, values)
            if got is not _MISSING:
                out[k] = got
        return out
    if isinstance(template, list):
        return [x for x in (fill(v, values) for v in template) if x is not _MISSING]
    if isinstance(template, str):
        whole = _PH.fullmatch(template)
        if whole:
            v = values.get(whole.group(1))
            return _MISSING if v is None else _cast(v, whole.group(2))

        def one(m):
            v = values.get(m.group(1))
            return "" if v is None else str(_cast(v, m.group(2)))
        return _PH.sub(one, template)
    return template


def finish(template: Any, values: dict) -> Any:
    out = fill(template, values)
    return {} if out is _MISSING else out


def dig(obj: Any, path: str | None, default=None):
    """A value from a provider's answer: "video.url", "output.0", "data.resultJson.~json.resultUrls.0"."""
    if not path:
        return default
    cur = obj
    for part in str(path).split("."):
        if part == "~json":
            if isinstance(cur, str):
                try:
                    cur = json.loads(cur)
                except ValueError:
                    return default
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.lstrip("-").isdigit() and -len(cur) <= int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return default
        if cur is None:
            return default
    return cur


def first_url(v) -> str:
    """A URL from whatever shape an output takes: "https://…", ["https://…"], {"url": "https://…"}."""
    if isinstance(v, str):
        return v
    if isinstance(v, list) and v:
        return first_url(v[0])
    if isinstance(v, dict):
        return first_url(v.get("url") or v.get("uri") or v.get("audio_url") or v.get("video_url") or "")
    return ""


def backoff(ctx: Ctx):
    """The waits between status checks: ctx.poll (3 s), growing by half each time, never over 15 s."""
    wait = float(ctx.poll)
    while True:
        yield wait
        wait = min(POLL_MAX, wait * POLL_GROWTH) if wait else 0.0


def body_error(ctx: Ctx, body, spec: dict) -> AiError | None:
    """A provider that answers HTTP 200 with its error inside the body (kie.ai: {"code": 402, "msg": "…"}): the body's
    code read as an HTTP status, or None when the body says all is well."""
    if not spec.get("bodyCode") or not isinstance(body, dict):
        return None
    code = dig(body, spec["bodyCode"])
    if code is None or code in (spec.get("okCodes") or [200]):
        return None
    msg = dig(body, spec.get("bodyMessage") or "msg") or ""
    kind = kind_for_code(ctx, code)
    try:
        status = int(code)
    except (TypeError, ValueError):
        status = 502
    status = KIND_STATUS[kind] if kind else (status if 400 <= status < 600 else 502)
    return with_kind(ctx.error(status, {"detail": f"{msg} (code {code})".strip()}), kind)


def kind_for_code(ctx: Ctx, code) -> str | None:
    """A provider's own error code read through its registry `errorKinds` ({"1008": "out_of_credit", "SAFETY.*":
    "refused"}): exact first, then the longest prefix ending in "*". None when the registry does not list it."""
    table = ctx.provider.get("errorKinds") or {}
    if code is None or not table:
        return None
    c = str(code)
    if c in table:
        return table[c]
    hits = [k for k in table if k.endswith("*") and c.startswith(k[:-1])]
    return table[max(hits, key=len)] if hits else None


def with_kind(err: AiError, kind: str | None) -> AiError:
    """err with the vocabulary word the provider's own code gave (its sentence and status already say it in words)."""
    if kind and kind != err.kind:
        err.kind = kind
        err.code = KIND_CODE.get(kind, err.code)
    return err


def json_body(raw: bytes):
    return _json(raw)
