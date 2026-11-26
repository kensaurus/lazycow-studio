"""
FILE: py/studio/providers/openai_chat.py
PURPOSE: The OpenAI chat protocol (POST <base>/chat/completions), shared by the reviewer and vision_json on OpenRouter,
         Together, kie.ai and your own model server (Ollama, LM Studio, vLLM, llama.cpp: config.own_llm). The llm and
         vision blocks pick one of these.
OVERVIEW: endpoint() is where to send for a provider (its registry base + /chat/completions, a model's own `path` when
          the provider gives each model its own address — kie.ai's "/gemini-3-8-flash-openai/v1/chat/completions" — or
          your own server's URL). post() sends one chat request. body_status() reads an error a provider puts inside an
          HTTP 200 (kie.ai: {"code": 402, "msg": …}; the provider's `chat` block names bodyCode / okCodes / bodyMessage).
          text_of() reads the answer's text (a list of parts joined). json_of() reads JSON from it: a fenced block, or
          the outermost {...} when a model wraps its JSON in a sentence. usage() returns the provider's own cost
          (OpenRouter's usage.cost; kie.ai's credits_consumed, named by `chat.cost` with costUnit "credits") or works it
          out from the token counts.
DEPENDENCIES: studio.providers.http.
"""
from __future__ import annotations

import json
import re

from studio.providers.http import KIND_STATUS, _json

REFERER = {"HTTP-Referer": "https://kensaur.us", "X-Title": "Lazycow Studio"}


def endpoint(provider: dict, own: dict | None = None, model: dict | None = None) -> str:
    if own:
        return own["url"]
    path = str((model or {}).get("path") or "")
    if path.startswith("https://"):
        return path
    return str(provider.get("base") or "").rstrip("/") + (path or "/chat/completions")


def _dig(obj, path: str):
    for part in str(path or "").split("."):
        if isinstance(obj, dict):
            obj = obj.get(part)
        elif isinstance(obj, list) and part.isdigit() and int(part) < len(obj):
            obj = obj[int(part)]
        else:
            return None
    return obj


def body_status(provider: dict, body) -> tuple[int, dict] | None:
    """(HTTP status, error body) for an error inside an HTTP 200 (kie.ai), or None when the body says all is well. The
    provider's own code is read through its `errorKinds` first (kie.ai's 430 and 455 are not HTTP statuses)."""
    spec = provider.get("chat") or {}
    if not spec.get("bodyCode") or not isinstance(body, dict):
        return None
    code = _dig(body, spec["bodyCode"])
    if code is None or code in (spec.get("okCodes") or [200]):
        return None
    msg = _dig(body, spec.get("bodyMessage") or "msg") or ""
    kind = (provider.get("errorKinds") or {}).get(str(code))
    try:
        status = int(code)
    except (TypeError, ValueError):
        status = 502
    status = KIND_STATUS[kind] if kind in KIND_STATUS else (status if 400 <= status < 600 else 502)
    return status, {"detail": f"{msg} (code {code})".strip()}


def headers(key: str, *, openrouter: bool = False) -> dict:
    return {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {}), **(REFERER if openrouter else {})}


def post(http, url: str, payload: dict, who: str, key: str = "", *, timeout: int = 180, openrouter: bool = False):
    """(status, headers, body as a dict). An error that comes as a list of one (Gemini: [{"error": {…}}]) is that one."""
    status, h, raw = http("POST", url, who, data=json.dumps(payload).encode("utf-8"), headers=headers(key, openrouter=openrouter), timeout=timeout)
    body = _json(raw)
    if isinstance(body, list):
        body = body[0] if body and isinstance(body[0], dict) else {}
    return status, h, body


def text_of(body: dict) -> str:
    """The first choice's text. Raises KeyError / IndexError / TypeError when there is none."""
    text = body["choices"][0]["message"]["content"]
    if isinstance(text, list):
        text = "".join(x.get("text", "") for x in text if isinstance(x, dict))
    return text or ""


def json_of(text: str):
    """JSON from a model's text: fences stripped; when it is wrapped in a sentence, the outermost object. Raises ValueError."""
    text = re.sub(r"^```(json)?|```$", "", (text or "").strip()).strip()
    try:
        return json.loads(text)
    except ValueError:
        hit = re.search(r"\{[\s\S]*\}", text)
        if not hit:
            raise
        return json.loads(hit.group(0))


def usage(body: dict, prices: dict | None = None, provider: dict | None = None) -> tuple[float | None, int, int]:
    """(actual USD or None, tokens in, tokens out). The provider's own cost wins (OpenRouter's usage.cost, or the field
    its registry `chat.cost` names: kie.ai's credits_consumed times its creditUsd); else tokens x price; else None."""
    u = body.get("usage") or {}
    tin, tout = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
    cost = u.get("cost")
    if isinstance(cost, (int, float)):
        return float(cost), tin, tout
    spec = (provider or {}).get("chat") or {}
    own = _dig(body, spec["cost"]) if spec.get("cost") else None
    if isinstance(own, (int, float)) and not isinstance(own, bool):
        if spec.get("costUnit") == "credits":
            if (provider or {}).get("creditUsd"):
                return float(own) * float(provider["creditUsd"]), tin, tout
        else:
            return float(own), tin, tout
    if tin and prices:
        return tin * prices["prompt"] + tout * prices["completion"], tin, tout
    return None, tin, tout
