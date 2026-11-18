"""
FILE: py/studio/fallback.py
PURPOSE: When an AI service runs out of credit, refuses its key, is rate-limited or down, the same step goes to the next
         service in that capability's backup list, and every other block that uses the service skips straight to its own
         backup until the service is back. The owner's words (18 Nov): "if I run out of fal.ai auto switch to others for
         all workflow in the block".
OVERVIEW: run() is what ai.charge() calls for a step that can switch (cap and a `backup` factory given): the chosen
          service first, then each backup in order. It switches only on the four kinds that say "this service, not this
          request" (SWITCH_ON: out_of_credit, auth, rate_limited after the retries, unavailable), never on refused or
          bad_input (another service must not be used to get around a safety refusal), and never after a failure the
          provider may have billed (a submit that timed out): one result is never paid for twice. Every attempt goes
          through the caps again at that service's own price (ai._charge_once), and a backup dearer than maxRise x the
          first choice's estimate (default 2x) is passed over, with the reason.
          The backup list: the project's own (workflow.json `fallback: {cap: [{provider, model, voice?}]}`), else an
          automatic one: the other services that do this capability, have a key and a price, are not marked unofficial
          (unless you accepted the risk in your own list) and need no voice to be picked first; the registry's default
          first, then the cheapest for one typical reel.
          Switches: one master switch and one per capability (`autoSwitch: {on, maxRise, caps}` in workflow.json). Voice
          is OFF by default, because another service changes the voice; every other capability is on.
          "Out" memory (<data>/ai-health.json, written atomically): out_of_credit marks a service out for 6 h, auth until
          its key changes (a hash of the key, never the key), rate_limited and unavailable for 10 min. The mark is per
          service, so every block that uses it goes straight to its backup. reset() ("Try X again") clears it; after the
          cooldown the next call asks the service first again. Each successful switch is logged (the last 200) for the
          Needs-you item ("fal.ai is out of credit, so 3 jobs used Runway instead").
DEPENDENCIES: studio.ai (keys, prices, the workflow file, the ledger), studio.workflow (price for one reel),
              studio.providers.registry. Imported by studio.ai; it imports studio.ai only inside functions.
USAGE: through studio.ai's actions: health (GET /api/ai/health), health-reset (POST /api/ai/health/reset), fallback
       (POST /api/ai/fallback). docs/ai-api.md, "When a service runs out".
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from pathlib import Path

from studio.providers import registry
from studio.providers.http import AiError

SWITCH_ON = ("out_of_credit", "auth", "rate_limited", "unavailable")
COOLDOWN = {"out_of_credit": 6 * 3600, "rate_limited": 600, "unavailable": 600}   # seconds; auth: until the key changes
RANK = {"auth": 0, "out_of_credit": 1, "unavailable": 2, "rate_limited": 3}       # a worse mark is not replaced by a milder one
MAX_RISE, RISE_RANGE = 2.0, (1.0, 10.0)
DEFAULT_OFF = ("voice",)          # another service changes the voice: off until the owner turns it on
SWITCH_LOG = 200
WORDS = {"out_of_credit": "out of credit", "auth": "key not accepted", "rate_limited": "too many requests",
         "unavailable": "not answering", "refused": "refused the request", "bad_input": "could not use the request"}


def _ai():
    from studio import ai

    return ai


def _name(pid: str) -> str:
    return _ai().PROVIDER_NAMES.get(pid, pid)


def _usd(x: float) -> str:
    return _ai()._usd(x)


# ---------- settings (workflow.json: autoSwitch, fallback) ----------

def settings(w: dict | None = None) -> dict:
    """{on: the master switch, maxRise: how much dearer a backup may be (x the first choice), caps: {cap: on}}."""
    w = w if w is not None else _ai().workflow()
    a = w.get("autoSwitch") if isinstance(w.get("autoSwitch"), dict) else {}
    caps = {c: c not in DEFAULT_OFF for c in registry.CAPABILITIES}
    caps.update({c: v for c, v in (a.get("caps") or {}).items() if c in caps and isinstance(v, bool)})
    rise = a.get("maxRise")
    ok = isinstance(rise, (int, float)) and not isinstance(rise, bool) and math.isfinite(rise) and RISE_RANGE[0] <= rise <= RISE_RANGE[1]
    return {"on": a.get("on", True) is not False, "maxRise": float(rise) if ok else MAX_RISE, "caps": caps}


def enabled(cap: str, s: dict | None = None) -> bool:
    s = s or settings()
    return bool(s["on"] and s["caps"].get(cap))


def own_list(cap: str, w: dict | None = None) -> list[dict] | None:
    """The project's own backup list for cap, or None (the automatic one is used)."""
    w = w if w is not None else _ai().workflow()
    lst = (w.get("fallback") or {}).get(cap) if isinstance(w.get("fallback"), dict) else None
    return [x for x in lst if isinstance(x, dict) and x.get("provider") and x.get("model")] if isinstance(lst, list) else None


# ---------- the backup list ----------

def _has_key(pid: str) -> bool:
    p = registry.provider(pid)
    return bool(p.get("free") or not p.get("keyEnv") or p.get("keyOptional") or _ai().key_for(pid))


def _priced(pid: str, mid: str) -> bool:
    ai = _ai()
    p = registry.provider(pid)
    return bool(p.get("free") or p.get("priceApi") or ai.list_price(pid, mid) or ai.user_price(pid, mid)
                or ((registry.model(pid, mid) or {}).get("price") or {}).get("completion") is not None)


def why_not(cap: str, pid: str, mid: str, voice: str | None = None, accepted: bool = False) -> str | None:
    """Why this service cannot stand in for cap right now (a plain reason), or None when it can."""
    if pid not in registry.providers():
        return "not a service the studio knows"
    m = registry.model(pid, mid)
    if not m or m.get("capability") != cap:
        return f"not a {cap} model"
    if registry.FORBIDDEN.search(mid):
        return "text-to-video is never used"
    if m.get("risk") and not accepted:
        return f"marked {m['risk']}: used only when you accept its risk"
    if not _priced(pid, mid):
        return "no price yet: enter one first"
    if not _has_key(pid):
        return "no key saved"
    if m.get("voiceRequired") and not (voice or m.get("voiceDefault")):
        return "needs a voice picked first"
    return None


def _per_reel(cap: str, pid: str, mid: str, live: dict) -> float | None:
    from studio import workflow as wf

    return wf.per_reel(cap, pid, mid, live).get("usd")


def chain(cap: str, first: tuple[str, str] | None = None, *, w: dict | None = None, live: dict | None = None) -> dict:
    """The backups for cap after `first` (the block's own choice when not given), in the order they are asked:
    {source: "yours" | "auto", items: [{provider, model, voice?, providerName, label, hasKey, perReel, docs, skip}]}.
    `skip` says why an entry would be passed over now (no key, no price, unofficial …); the health of each service is
    added by view()."""
    ai = _ai()
    w = w if w is not None else ai.workflow()
    live = ai._cached_fal_prices() if live is None else live
    if first is None:
        b = ai.block(cap)
        first = (b["provider"], b["model"])
    mine = own_list(cap, w)
    rows = []
    if mine is not None:
        for x in mine:
            pid, mid = str(x["provider"]), str(x["model"])
            if (pid, mid) == tuple(first):
                continue
            rows.append({"provider": pid, "model": mid, "voice": x.get("voice") or None, "acceptRisk": x.get("acceptRisk") is True,
                         "skip": why_not(cap, pid, mid, x.get("voice"), x.get("acceptRisk") is True)})
    else:
        for pid, mid, m in registry.models_for(cap):
            if pid == first[0] or pid == "own":
                continue  # the same service is out with it; your own server stands in through its own setting
            why = why_not(cap, pid, mid)
            if why and (m.get("risk") or "price" in why):
                continue  # the automatic list never offers an unofficial route or an unpriced model
            rows.append({"provider": pid, "model": mid, "voice": None, "skip": why, "_default": bool(m.get("default"))})
    for r in rows:
        m = registry.model(r["provider"], r["model"]) or {}
        r.update(providerName=_name(r["provider"]), label=m.get("label") or r["model"], hasKey=_has_key(r["provider"]) if r["provider"] in registry.providers() else False,
                 perReel=_per_reel(cap, r["provider"], r["model"], live) if not r["skip"] or "key" in (r["skip"] or "") else None,
                 docs=_docs(r["provider"]), dashboard=(registry.providers().get(r["provider"]) or {}).get("dashboard"))
    if mine is None:
        rows.sort(key=lambda r: (bool(r["skip"]), not r.pop("_default"), r["perReel"] if r["perReel"] is not None else math.inf, r["provider"]))
    return {"source": "yours" if mine is not None else "auto", "items": rows}


def _docs(pid: str) -> str | None:
    d = (registry.providers().get(pid) or {}).get("docs")
    first = d[0] if isinstance(d, list) and d else None
    return first if isinstance(first, str) and first.startswith("https://") else None


# ---------- "out" memory (<data>/ai-health.json) ----------

def health_file() -> Path:
    return _ai().WORKFLOW.with_name("ai-health.json")


def _read() -> dict:
    try:
        h = json.loads(health_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        h = {}
    if not isinstance(h, dict):
        h = {}
    return {"version": 1, "providers": h.get("providers") if isinstance(h.get("providers"), dict) else {},
            "switches": h.get("switches") if isinstance(h.get("switches"), list) else []}


def _write(h: dict) -> None:
    """Written whole to a temporary file, then moved over the old one: a reader never sees half a file."""
    f = health_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_name(f"{f.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(h, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, f)


def key_tag(pid: str) -> str:
    """A short hash of the provider's saved key ("" for none): an auth mark lasts until this changes. Never the key."""
    k = _ai().key_for(pid) if pid in registry.providers() else ""
    return hashlib.sha256(k.encode("utf-8")).hexdigest()[:12] if k else ""


def active(pid: str, e: dict | None, now: float | None = None) -> bool:
    if not isinstance(e, dict) or e.get("kind") not in SWITCH_ON:
        return False
    if e["kind"] == "auth":
        return e.get("keyTag", "") == key_tag(pid)
    return float(e.get("until") or 0) > (now or time.time())


def state(pid: str, h: dict | None = None) -> dict | None:
    """The provider's mark while it lasts ({kind, at, until, message}), else None."""
    h = h or _read()
    e = h["providers"].get(pid)
    return e if active(pid, e) else None


def mark(pid: str, kind: str | None, message: str = "") -> None:
    """Remember that pid failed with kind (one of SWITCH_ON), for every capability. A milder mark never replaces a
    worse one that still lasts (a 429 does not turn "out of credit" into "wait 10 minutes")."""
    if kind not in SWITCH_ON or pid not in registry.providers():
        return
    h, now = _read(), time.time()
    old = h["providers"].get(pid)
    if active(pid, old, now) and RANK[old["kind"]] < RANK[kind]:
        return
    e = {"kind": kind, "at": now, "message": str(message)[:300]}
    if kind == "auth":
        e.update(until=None, keyTag=key_tag(pid))
    else:
        e["until"] = now + COOLDOWN[kind]
    h["providers"][pid] = e
    _write(h)


def note_switch(cap: str, frm: str, to: str, kind: str | None, tool: str, slug: str | None) -> None:
    h = _read()
    h["switches"] = (h["switches"] + [{"at": time.time(), "cap": cap, "from": frm, "to": to, "kind": kind, "tool": tool, "slug": slug}])[-SWITCH_LOG:]
    _write(h)


def reset(req: dict | None = None) -> dict:
    """"Try X again": forget X's mark ({provider}), or every mark ({all: true}). The next call asks it first again."""
    req = req or {}
    pid = str(req.get("provider") or "")
    h = _read()
    if req.get("all") is True:
        h["providers"] = {}
    elif pid in registry.providers():
        h["providers"].pop(pid, None)
    else:
        raise AiError(f"provider: one of {', '.join(registry.providers())}, or all: true.", "bad_input", 400)
    _write(h)
    return view({})


# ---------- one step, with its backups (called by ai.charge) ----------

def run(cap: str, first: tuple[str, str], tool: str, slug: str | None, estimate: float, call, note: str, purpose: str | None, backup, once):
    """The chosen service, then its backups. backup(provider, model, voice) -> (estimate, call) for one backup, or None
    when that service cannot do this step; once(...) is ai._charge_once (the caps, the ledger row)."""
    pid, mid = first
    s = settings()
    auto = backup is not None and enabled(cap, s)
    h = _read()
    out_first = state(pid, h)
    cands = [c for c in chain(cap, first)["items"] if not c["skip"]] if auto else []
    me = {"provider": pid, "model": mid, "first": True}
    passed: list[str] = []
    reason = None
    if auto and out_first and cands:
        # Marked out a moment ago by another block: straight to the backup. The first choice is still asked last, in
        # case it was topped up and nothing else works.
        reason = out_first["kind"]
        passed.append(f"{_name(pid)} ({WORDS[reason]})")
        attempts = [*cands, me]
    else:
        attempts = [me, *cands]
    first_err: AiError | None = None
    for a in attempts:
        is_first = bool(a.get("first"))
        if is_first:
            est, fn = estimate, call
        else:
            if state(a["provider"]):
                passed.append(f"{_name(a['provider'])} ({WORDS[state(a['provider'])['kind']]})")
                continue
            try:
                got = backup(a["provider"], a["model"], a.get("voice"))
            except AiError as err:
                passed.append(f"{_name(a['provider'])} ({err})")
                continue
            if got is None:
                passed.append(f"{_name(a['provider'])} (cannot do this step)")
                continue
            est, fn = got
            if estimate > 0 and est > estimate * s["maxRise"] + 1e-9:
                passed.append(f"{_name(a['provider'])} (costs {_usd(est)}, over {s['maxRise']:g}x the {_usd(estimate)} of the first choice)")
                continue
        try:
            result, usd = once(a["provider"], a["model"], tool, slug, est, fn, note, purpose,
                               fell_back_from=None if is_first else pid, reason=None if is_first else reason)
        except AiError as err:  # once() has already remembered a provider that failed with a switch kind (mark)
            if not is_first and err.code == "cap":  # this backup would break a limit at its price: the next may fit
                passed.append(f"{_name(a['provider'])} ({err})")
                continue
            if not auto or err.kind not in SWITCH_ON or err.charged:
                raise
            first_err = first_err or err
            reason = reason or err.kind
            passed.append(f"{_name(a['provider'])} ({WORDS[err.kind]})")
            continue
        if not is_first:
            note_switch(cap, pid, a["provider"], reason, tool, slug)
        return result, usd
    err = first_err or AiError(f"{_name(pid)} could not do this step.", "upstream", 502)
    tail = (f" Backups tried or passed over: {'; '.join(p for p in passed if not p.startswith(_name(pid) + ' ('))}."
            if any(not p.startswith(_name(pid) + " (") for p in passed) else f" No other service is set up for {cap}.")
    raise AiError(str(err).rstrip() + tail, err.code, err.status, charged=err.charged, kind=err.kind) from err


# ---------- the page: health, chains and the problems it causes ----------

def _caps_using(pid: str) -> list[str]:
    ai = _ai()
    out = []
    for cap in registry.CAPABILITIES:
        b = ai.block(cap)
        if b["on"] and b["provider"] == pid:
            out.append(cap)
    return out


def view(req: dict | None = None) -> dict:
    """Everything the page shows about switching: the settings, each service's health (OK, out of credit until …, key
    problem), each capability's backup list with what it uses now, and the problems for the Needs-you strip."""
    ai = _ai()
    w, h, s, now = ai.workflow(), _read(), settings(), time.time()
    live = ai._cached_fal_prices()
    marks = {pid: e for pid, e in h["providers"].items() if active(pid, e, now)}
    caps = {}
    for cap in registry.CAPABILITIES:
        b = ai.block(cap)
        first = (b["provider"], b["model"])
        ch = chain(cap, first, w=w, live=live)
        for r in ch["items"]:
            e = marks.get(r["provider"])
            r["health"] = e["kind"] if e else "ok"
        usable = [r for r in ch["items"] if not r["skip"] and r["health"] == "ok"]
        auto = enabled(cap, s)
        using = None
        e = marks.get(first[0]) if first[0] else None
        if e and b["on"]:
            last = next((x for x in reversed(h["switches"]) if x.get("cap") == cap and x.get("from") == first[0] and x.get("at", 0) >= e["at"]), None)
            nxt = usable[0] if auto and usable else None
            using = {"from": first[0], "fromName": _name(first[0]), "kind": e["kind"], "since": last["at"] if last else None,
                     "provider": (last or {}).get("to") or (nxt or {}).get("provider"),
                     "providerName": _name((last or {}).get("to") or (nxt or {}).get("provider") or "") if (last or nxt) else None,
                     "auto": auto, "backup": bool(nxt)}
        caps[cap] = {"auto": auto, "on": b["on"], "provider": first[0], "model": first[1], "source": ch["source"], "chain": ch["items"],
                     "backup": usable[0]["provider"] if usable else None, "backupName": usable[0]["providerName"] if usable else None,
                     "using": using}
    provs = []
    for pid, p in registry.providers().items():
        if pid == "own":
            continue
        e = marks.get(pid)
        used = _caps_using(pid)
        if not (e or used or (p.get("keyEnv") and ai.key_for(pid))):
            continue
        provs.append({"id": pid, "name": _name(pid), "state": e["kind"] if e else "ok", "since": e["at"] if e else None,
                      "until": e.get("until") if e else None, "message": ai._scrub(e.get("message") or "") if e else None,
                      "billing": p.get("dashboard"), "caps": used, "hasKey": bool(ai.key_for(pid)) or bool(p.get("keyOptional"))})
    provs.sort(key=lambda x: (x["state"] == "ok", x["name"].lower()))
    return {"settings": s, "capabilities": caps, "providers": provs, "problems": problems(caps, marks, h), "now": now,
            "cooldowns": {"out_of_credit": COOLDOWN["out_of_credit"], "rate_limited": COOLDOWN["rate_limited"], "unavailable": COOLDOWN["unavailable"]}}


def problems(caps: dict, marks: dict, h: dict) -> list[dict]:
    """One per service that is out of credit or has a key problem and is used by a block that is on: amber when every
    such block has a backup that will take over ("so 3 jobs used Runway instead"), red when some have none."""
    out = []
    for pid, e in marks.items():
        if e["kind"] not in ("out_of_credit", "auth"):
            continue
        mine = [c for c, v in caps.items() if v["on"] and v["provider"] == pid]
        if not mine:
            continue
        stranded = [c for c in mine if not (caps[c]["using"] or {}).get("backup")]
        took = {}
        for x in h["switches"]:
            if x.get("from") == pid and x.get("at", 0) >= e["at"]:
                took[x["to"]] = took.get(x["to"], 0) + 1
        out.append({"provider": pid, "name": _name(pid), "kind": e["kind"], "since": e["at"], "until": e.get("until"),
                    "level": "red" if stranded else "amber", "caps": mine, "noBackup": stranded,
                    "switched": [{"provider": k, "name": _name(k), "n": n} for k, n in sorted(took.items(), key=lambda kv: -kv[1])],
                    "backups": sorted({caps[c]["using"]["provider"] for c in mine if (caps[c]["using"] or {}).get("backup")} - {None}),
                    "billing": (registry.providers().get(pid) or {}).get("dashboard")})
    return out


def save(req: dict) -> dict:
    """POST /api/ai/fallback. Any of: {on: master switch}, {maxRise: 1-10}, {capability, auto: true|false},
    {capability, chain: [{provider, model, voice?, acceptRisk?}] | null (null: back to the automatic list)}."""
    ai = _ai()
    w = ai.workflow()
    a = dict(w.get("autoSwitch") or {})
    changed = []
    if "on" in req:
        if not isinstance(req["on"], bool):
            raise AiError("on: true or false (the master switch).", "bad_input", 400)
        a["on"] = req["on"]
        changed.append("on")
    if "maxRise" in req:
        v = req["maxRise"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not RISE_RANGE[0] <= v <= RISE_RANGE[1]:
            raise AiError(f"maxRise: a number from {RISE_RANGE[0]:g} to {RISE_RANGE[1]:g} (times the first choice's price).", "bad_input", 400)
        a["maxRise"] = float(v)
        changed.append("maxRise")
    cap = req.get("capability")
    if cap is not None and cap not in registry.CAPABILITIES:
        raise AiError(f"capability: one of {', '.join(registry.CAPABILITIES)}.", "bad_input", 400)
    if "auto" in req:
        if cap is None or not isinstance(req["auto"], bool):
            raise AiError("auto: true or false, with a capability.", "bad_input", 400)
        a["caps"] = {**(a.get("caps") or {}), cap: req["auto"]}
        changed.append("auto")
    warnings = []
    if "chain" in req:
        if cap is None:
            raise AiError("chain: send it with a capability.", "bad_input", 400)
        fb = dict(w.get("fallback") or {})
        if req["chain"] is None:
            fb.pop(cap, None)
        else:
            if not isinstance(req["chain"], list) or len(req["chain"]) > 8:
                raise AiError("chain: a list of up to 8 {provider, model} backups, or null for the automatic list.", "bad_input", 400)
            out, seen = [], set()
            for x in req["chain"]:
                if not isinstance(x, dict):
                    raise AiError("chain: each backup is {provider, model}.", "bad_input", 400)
                pid, mid = str(x.get("provider") or ""), str(x.get("model") or "")
                if (pid, mid) in seen:
                    continue
                seen.add((pid, mid))
                m = registry.model(pid, mid) if pid in registry.providers() else None
                if not m or m.get("capability") != cap or registry.FORBIDDEN.search(mid):
                    raise AiError(f"{pid} {mid or '(none)'} is not a registered {cap} model.", "bad_input", 400)
                voice = x.get("voice")
                if voice is not None and (not isinstance(voice, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{1,100}", voice)):
                    raise AiError("voice: the voice's id as the provider lists it.", "bad_input", 400)
                if m.get("risk") and x.get("acceptRisk") is not True:
                    raise AiError(f"{m.get('label') or mid} is marked {m['risk']}: {m.get('note') or ''} Send acceptRisk: true to list it.".replace("  ", " "),
                                  "risk", 409)
                row = {"provider": pid, "model": mid, **({"voice": voice} if voice else {}), **({"acceptRisk": True} if m.get("risk") else {})}
                why = why_not(cap, pid, mid, voice, bool(row.get("acceptRisk")))
                if why:
                    warnings.append(f"{_name(pid)} {m.get('label') or mid}: {why}; it is passed over until that is fixed.")
                out.append(row)
            fb[cap] = out
        w["fallback"] = fb
        changed.append("chain")
    if not changed:
        raise AiError("Send on, maxRise, or a capability with auto or chain.", "bad_input", 400)
    w["autoSwitch"] = a
    ai._save_workflow(w)
    return {"saved": changed, "warnings": warnings, **view({})}

