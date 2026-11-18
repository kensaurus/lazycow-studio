"""
FILE: py/studio/providers/openai_chat.py
PURPOSE: The OpenAI chat protocol (POST <base>/chat/completions), shared by the reviewer and vision_json on OpenRouter,
         Together and your own model server (Ollama, LM Studio, vLLM, llama.cpp: config.own_llm). The llm and vision
         blocks pick one of these.
OVERVIEW: endpoint() is where to send for a provider (its registry base, or your own server's URL). post() sends one
          chat request. text_of() reads the answer's text (a list of parts joined). json_of() reads JSON from it: a
          fenced block, or the outermost {...} when a model wraps its JSON in a sentence. usage() returns the
          provider's own cost (OpenRouter's usage.cost) or works it out from the token counts.
DEPENDENCIES: studio.providers.http.
"""
from __future__ import annotations

import json
import re

from studio.providers.http import _json

REFERER = {"HTTP-Referer": "https://kensaur.us", "X-Title": "Lazycow Studio"}


def endpoint(provider: dict, own: dict | None = None) -> str:
    if own:
        return own["url"]
    return str(provider.get("base") or "").rstrip("/") + "/chat/completions"


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


def usage(body: dict, prices: dict | None = None) -> tuple[float | None, int, int]:
    """(actual USD or None, tokens in, tokens out). The provider's own cost wins; else tokens x price; else None."""
    u = body.get("usage") or {}
    tin, tout = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
    cost = u.get("cost")
    if isinstance(cost, (int, float)):
        return float(cost), tin, tout
    if tin and prices:
        return tin * prices["prompt"] + tout * prices["completion"], tin, tout
    return None, tin, tout
