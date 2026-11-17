"""
FILE: py/studio/providers/registry.py
PURPOSE: The AI provider registry (shared/ai-providers.json): which services the studio can use, for which job, how
         to reach them, what they cost. Data, not code: a new model is a new entry, not a new branch in ai.py.
OVERVIEW: load() reads and validates the file once (cached by mtime). The capability list is closed (CAPABILITIES):
          voice, music, sfx, upscale, slowmo, img2video, bg-cut, llm, vision. Text-to-video can never be registered
          (house rule: the studio never invents scenes). labelRequired belongs to the capability, never the provider.
          A model without a commercial licence is refused, and a model marked risk "unofficial" (kie.ai's Suno, PiAPI's
          account-pool Kling) can be picked by hand but is never a default. Every keyEnv matches KEY_ENV_RX (or is one
          of LEGACY_KEY_ENVS), so a key saved from Settings can only ever land in a *_KEY / *_TOKEN line of .env.
          Every provider names the official docs its entry was checked against (`docs`) and the day (`asOf`); every
          img2video model takes the real still (a prompt-only mode would be text-to-video); a model may speak another
          protocol than its provider's chat (`protocol`, e.g. OpenRouter's video and speech).
DEPENDENCIES: Python stdlib.
USAGE: from studio.providers import registry; registry.load(); registry.default_model("music") -> ("fal", "fal-ai/…")
NOTES: The shape of the file is described in docs/ai-api.md ("The provider registry").
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILE = ROOT / "shared" / "ai-providers.json"

CAPABILITIES = ("voice", "music", "sfx", "upscale", "slowmo", "img2video", "bg-cut", "llm", "vision")
PROTOCOLS = ("fal_queue", "async_task", "sync_http", "openai_chat")
# Never a capability, whatever a provider calls it: a model that makes a scene from words is not wanted here.
FORBIDDEN = re.compile(r"text[-_ ]?to[-_ ]?video|t2v|txt2vid|text2video", re.I)
KEY_ENV_RX = re.compile(r"^[A-Z][A-Z0-9_]{2,40}_(KEY|TOKEN)$")
RISKS = ("unofficial",)
UPLOAD_KINDS = ("fal_storage", "multipart", "data_uri", "base64", "json_base64", "presigned")
DATE_RX = re.compile(r"^20\d\d-[01]\d-[0-3]\d$")
# Where a model's request goes: a name here that says text-to-video is refused like the model's own name.
PATH_FIELDS = ("path", "submitPath", "task")
# Names that predate the rule and must keep their place in people's .env files (the reviewer's OpenRouter key is
# parked under this name so the old paid tagging, which reads OPENROUTER_API_KEY, stays off).
LEGACY_KEY_ENVS = {"OPENROUTER_API_KEY_PARKED"}
COMMERCIAL = {"commercial", "apache-2.0", "mit", "cc0", "cc-by-4.0", "openrail-m"}

_cache: dict = {}


class RegistryError(ValueError):
    pass


def load(path: Path | None = None) -> dict:
    """The validated registry. Cached until the file changes."""
    p = Path(path or FILE)
    stamp = p.stat().st_mtime_ns
    hit = _cache.get(str(p))
    if hit and hit[0] == stamp:
        return hit[1]
    data = json.loads(p.read_text(encoding="utf-8"))
    problems = validate(data)
    if problems:
        raise RegistryError(f"{p.name}: " + "; ".join(problems[:5]))
    _cache[str(p)] = (stamp, data)
    return data


def validate(data: dict) -> list[str]:
    """Every rule the registry must keep, as a list of plain problems (empty = valid)."""
    out: list[str] = []
    caps = data.get("capabilities") or {}
    if set(caps) - set(CAPABILITIES):
        out.append(f"unknown capabilities {sorted(set(caps) - set(CAPABILITIES))} (the list is closed: {', '.join(CAPABILITIES)})")
    for c in CAPABILITIES:
        if c not in caps:
            out.append(f"capability {c} is missing")
        elif not isinstance(caps[c].get("labelRequired"), bool):
            out.append(f"capability {c}: labelRequired must be true or false")
    for name in caps:
        if FORBIDDEN.search(name):
            out.append(f"capability {name}: text-to-video is never registered")
    for tool, t in (data.get("tools") or {}).items():
        if t.get("capability") not in caps:
            out.append(f"tool {tool}: capability {t.get('capability')} is not registered")
    defaults: dict[str, list[str]] = {}
    for pid, p in (data.get("providers") or {}).items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,29}", pid):
            out.append(f"provider id {pid}: lowercase letters, digits and dashes")
        if p.get("protocol") not in PROTOCOLS:
            out.append(f"provider {pid}: protocol {p.get('protocol')} is not one of {', '.join(PROTOCOLS)}")
        for env in [p.get("keyEnv")] + list(p.get("keyEnvAlso") or []):
            if env is None and p.get("keyOptional"):
                continue
            if not env or not (KEY_ENV_RX.match(env) or env in LEGACY_KEY_ENVS):
                out.append(f"provider {pid}: keyEnv {env!r} must match {KEY_ENV_RX.pattern}")
        if "labelRequired" in p:
            out.append(f"provider {pid}: labelRequired belongs to the capability, not the provider")
        # Every provider says where its contract was read and when (docs: the official pages; asOf: the day).
        docs = p.get("docs")
        if not isinstance(docs, list) or not docs or not all(isinstance(u, str) and u.startswith("https://") for u in docs):
            out.append(f"provider {pid}: docs must list the official https pages its entry was checked against")
        if not DATE_RX.match(str(p.get("asOf") or "")):
            out.append(f"provider {pid}: asOf must be the day its entry was checked (YYYY-MM-DD)")
        if (p.get("upload") or {}).get("kind") not in (None, *UPLOAD_KINDS):
            out.append(f"provider {pid}: upload kind {(p.get('upload') or {}).get('kind')!r} is not one of {', '.join(UPLOAD_KINDS)}")
        for mid, m in (p.get("models") or {}).items():
            where = f"{pid} {mid}"
            cap = m.get("capability")
            if cap not in caps:
                out.append(f"{where}: capability {cap} is not registered")
            if any(FORBIDDEN.search(str(x or "")) for x in (cap, mid, m.get("id"), *(m.get(f) for f in PATH_FIELDS), m.get("input"))):
                out.append(f"{where}: text-to-video is never registered")
            if m.get("protocol") is not None and m.get("protocol") not in PROTOCOLS:
                out.append(f"{where}: protocol {m.get('protocol')} is not one of {', '.join(PROTOCOLS)}")
            if m.get("risk") is not None and m.get("risk") not in RISKS:
                out.append(f"{where}: risk must be one of {', '.join(RISKS)} or absent")
            # A mode that needs only a prompt must not be reachable: every image-to-video model takes the real still.
            if cap == "img2video" and "image" not in (m.get("files") or {}).values():
                out.append(f"{where}: an img2video model must take the still (files: {{…: \"image\"}}); a prompt-only mode is text-to-video")
            if m.get("asOf") is not None and not DATE_RX.match(str(m["asOf"])):
                out.append(f"{where}: asOf must be YYYY-MM-DD")
            # Placeholders are lowercase ({image_url}); "{promptImage}" would be sent as it is, never filled.
            odd = [x for x in re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::[a-z]+)?\}", json.dumps([m.get("input"), m.get("path"), m.get("task")]))
                   if not re.fullmatch(r"[a-z_][a-z0-9_]*", x)]
            if odd:
                out.append(f"{where}: placeholders must be lowercase ({', '.join(sorted(set(odd)))})")
            for name in (m.get("files") or {}):
                if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
                    out.append(f"{where}: file field {name} must be a lowercase placeholder name")
            if "labelRequired" in m:
                out.append(f"{where}: labelRequired belongs to the capability, not the model")
            if str(m.get("licence") or "").lower() not in COMMERCIAL:
                out.append(f"{where}: no commercial licence ({m.get('licence')!r}); such models are refused")
            if m.get("default"):
                if m.get("risk"):
                    out.append(f"{where}: a model marked risk {m['risk']!r} is never a default")
                defaults.setdefault(cap, []).append(where)
            price = m.get("price")
            if price is not None and not (isinstance(price.get("usd"), (int, float)) and price.get("unit") and price.get("asOf") and price.get("source")):
                out.append(f"{where}: a list price needs usd, unit, source and asOf")
            if price and price.get("validUntil") is not None and not DATE_RX.match(str(price["validUntil"])):
                out.append(f"{where}: price validUntil must be YYYY-MM-DD")
    for cap, who in defaults.items():
        if len(who) > 1:
            out.append(f"capability {cap} has {len(who)} defaults ({', '.join(who)}); one only")
    for cap in CAPABILITIES:
        if cap not in ("llm",) and cap not in defaults:
            out.append(f"capability {cap} has no default model")
    return out


def providers() -> dict:
    return load()["providers"]


def provider(pid: str) -> dict:
    p = providers().get(pid)
    if p is None:
        raise KeyError(pid)
    return p


def model(pid: str, mid: str) -> dict | None:
    return (providers().get(pid) or {}).get("models", {}).get(mid)


def capability(cap: str) -> dict:
    return load()["capabilities"][cap]


def tools() -> dict:
    return load()["tools"]


def default_model(cap: str) -> tuple[str, str] | None:
    """(provider, model) marked default for a capability."""
    for pid, p in providers().items():
        for mid, m in (p.get("models") or {}).items():
            if m.get("capability") == cap and m.get("default"):
                return pid, mid
    return None


def models_for(cap: str) -> list[tuple[str, str, dict]]:
    return [(pid, mid, m) for pid, p in providers().items() for mid, m in (p.get("models") or {}).items() if m.get("capability") == cap]


def key_envs() -> dict[str, list[str]]:
    """{provider: [keyEnv, then the names also read]} for every provider that takes a key."""
    return {pid: [p["keyEnv"], *(p.get("keyEnvAlso") or [])] for pid, p in providers().items() if p.get("keyEnv")}
