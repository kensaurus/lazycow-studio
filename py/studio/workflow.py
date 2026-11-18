"""
FILE: py/studio/workflow.py
PURPOSE: The Workflow page and Settings › AI blocks: the whole pipeline as blocks (on or off, which service, on this
         computer or in the cloud, what one reel costs), the templates in shared/workflows/*.json with a preview of what
         each would change and its cost per reel, applying one (only when asked, with a backup so Undo works), and this
         month's AI spend by capability and provider from the real ledger (the `spend` table that ai.charge() writes).
OVERVIEW: A project's choice of service per capability lives in <data>/workflow.json (studio.ai: workflow(), block(),
          select()). This module reads it the same way and writes it with ai._save_workflow, so a template and a single
          choice on the page are the same file. Applying copies the file as it was to workflow.prev.json first (or notes
          that there was none); Undo puts that back and removes the copy.
          Cost per reel is priced without asking anyone: the price chain of the Settings page (fal's last live table,
          else the registry's list price, else a price you entered) times one typical 15 s reel (TYPICAL).
          A template block is {"on": false}, {"provider", "model", "voice"?} or one of three placeholders:
          "@default" (the registry's default), "@cheapest" (the lowest cost per reel among registered models without a
          risk mark or a required voice, preferring services whose key is saved, so services added to the registry are
          considered by themselves) and "@own" (your own model server: its writing model for llm, its picture model for
          vision; off, with a note, when none is set). Text-to-video is refused anywhere in a template.
DEPENDENCIES: studio.ai (workflow file, prices, keys, own LLM), studio.providers.registry, studio.db (spend)
USAGE: through studio.ai's actions (python -m studio.ai workflow | workflow-apply | workflow-undo | spend-month),
       request JSON on stdin, one RESULT line out; the server's /api/workflow* and /api/ai/spend routes call them.
"""
from __future__ import annotations

import calendar
import json
import re
from datetime import date, datetime
from pathlib import Path

from studio import ai
from studio.config import ROOT
from studio.providers import registry
from studio.providers.http import AiError

TEMPLATES = ROOT / "shared" / "workflows"
ID_RX = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
# One typical reel, for "what one reel costs" (the same counts as ai.plan's defaults on a 15 s reel).
REEL_SECONDS = 15
TYPICAL = {
    "voice": {"chars": 60, "what": "about 60 characters of approved words read aloud"},
    "music": {"seconds": REEL_SECONDS + 3, "calls": 1, "what": "one 18 s instrumental bed"},
    "sfx": {"seconds": 4, "calls": 2, "what": "natural sound for two silent 2 s shots"},
    "upscale": {"seconds": 6, "calls": 3, "what": "three soft 2 s shots sharpened"},
    "slowmo": {"seconds": 2, "calls": 2, "what": "two shots in half-speed slow motion"},
    "img2video": {"seconds": 5, "calls": 1, "what": "one photo moved for 5 s"},
    "bg-cut": {"seconds": 30, "calls": 1, "what": "one 2 s opening shot cut out (about 30 compute seconds)"},
    "vision": {"tokens_in": REEL_SECONDS * 300 + 3500, "tokens_out": 1800, "what": "one review of the rendered reel"},
    "llm": {"tokens_in": 1500, "tokens_out": 600, "what": "a few suggested lines"},
}
# Spend rows that are not "ai-<tool>": which capability they belong to.
PURPOSE_CAP = {"tagcheck": "vision", "tag": "vision", "words-suggest": "llm", "research": "llm", "ideas": "llm", "vision": "vision"}


# ---------- reading ----------

def _key(pid: str) -> bool:
    p = registry.provider(pid)
    if p.get("free") or not p.get("keyEnv"):
        return True
    return bool(ai.key_for(pid)) or bool(p.get("keyOptional"))


def _own(cap: str) -> dict | None:
    from studio.config import own_llm

    return own_llm(vision=cap == "vision")


def _local(pid: str) -> bool:
    return pid == "own" or bool(registry.provider(pid).get("local"))


def per_reel(cap: str, pid: str | None, mid: str | None, live: dict | None = None) -> dict:
    """What one typical reel costs on this service: {usd, basis, unit?, source?}; usd None when no price is known."""
    t = TYPICAL[cap]
    if not pid or not mid:
        return {"usd": None, "basis": t["what"]}
    if registry.provider(pid).get("free"):
        return {"usd": 0.0, "basis": t["what"], "source": "your own server: nothing is charged"}
    price = ai._price_view(pid, mid, live)
    if price.get("usd") is None:
        return {"usd": None, "basis": t["what"], "code": "no_price"}
    if "tokens_in" in t:
        completion = price.get("completion")
        unit = str(price.get("unit") or "")
        if completion is None and "token" not in unit:
            return {"usd": None, "basis": t["what"], "source": "charged by tokens on the provider's own price list"}
        usd = float(price["usd"]) * t["tokens_in"] + float(completion or price["usd"]) * t["tokens_out"]
        return {"usd": round(usd, 4), "basis": t["what"], "unit": "tokens", "source": price.get("source")}
    m = ai._model(pid, mid)
    unit = str(price["unit"])
    secs = float(t.get("seconds", 0))
    if unit.lower().startswith("unit"):
        secs *= float(m.get("unitsPerSecond") or 1)
    q = ai.quantity(unit, seconds=secs, chars=int(t.get("chars", 0)), megapixels=secs * 30 * 1080 * 1920 / 1e6)
    if q == 1.0 and not unit.lower().startswith(("second", "compute", "unit", "minute", "1000 char", "char", "megapixel")):
        q = float(t.get("calls", 1))  # priced per generation / audio / video / request: one per call
    return {"usd": round(float(price["usd"]) * q, 4), "basis": t["what"], "unit": unit, "unitPrice": price["usd"],
            "source": price.get("source"), **({"warning": price["warning"]} if price.get("warning") else {})}


def _docs(pid: str) -> dict:
    """The provider's own documentation (first link of the registry's `docs`) and the date its entry was read (`asOf`)."""
    p = registry.provider(pid)
    d = p.get("docs")
    first = d[0] if isinstance(d, list) and d else d if isinstance(d, str) else None
    return {"docs": first if isinstance(first, str) and first.startswith("https://") else None, "asOf": p.get("asOf") or registry.load().get("asOf")}


def _choices(cap: str, live: dict) -> list[dict]:
    """Every service the registry lists for this capability, plus your own server where it can do it. A model with no
    price anywhere (Luma bills credits) is marked priceNeeded: it can be picked only once you enter a price."""
    out = []
    for pid, mid, m in registry.models_for(cap):
        if registry.FORBIDDEN.search(mid):
            continue
        cost = per_reel(cap, pid, mid, live)
        out.append({"provider": pid, "providerName": ai.PROVIDER_NAMES.get(pid, pid), "model": mid, "label": m.get("label") or mid,
                    "hasKey": _key(pid), "local": _local(pid), "default": bool(m.get("default")), "risk": m.get("risk"),
                    "note": m.get("note"), "voiceRequired": bool(m.get("voiceRequired")), "voiceDefault": m.get("voiceDefault"),
                    "perReel": cost, "priceNeeded": cost.get("code") == "no_price", **_docs(pid)})
    for pid, p in registry.providers().items():
        if cap in (p.get("freeModels") or []) and p.get("free"):
            own = _own(cap)
            out.append({"provider": pid, "providerName": ai.PROVIDER_NAMES.get(pid, pid), "model": own["model"] if own else "",
                        "label": own["model"] if own else "", "hasKey": True, "local": True, "default": False, "configured": bool(own),
                        "perReel": per_reel(cap, pid, own["model"] if own else "x"), **_docs(pid)})
    return out


def _effective(cap: str, b: dict) -> dict:
    """The block as it really runs. Writing help (llm) and the reviewer (vision) follow your own model server first
    (studio.research, ai.review_basis), so the page says that instead of an unused default."""
    out = {"on": b["on"], "provider": b["provider"], "model": b["model"], "voice": b.get("voice"), "source": b["source"]}
    if cap == "llm":
        own = _own("llm")
        if own:
            out.update(provider="own", model=own["model"], source="own")
        elif b["source"] != "workflow":
            out.update(provider="openrouter" if ai.key_for("openrouter") else None, model=None, source="key" if ai.key_for("openrouter") else "none")
    if cap == "vision" and ai.review_basis() == "frames":
        own = _own("vision")
        out.update(provider="own", model=own["model"] if own else b["model"], source="own", basis="frames")
    elif cap == "vision":
        out["basis"] = "video" if ai.reviewer_key() else None
    return out


def view(req: dict | None = None) -> dict:
    """Everything the Workflow page draws: the blocks with their choices and cost per reel, the templates with their
    preview, whether Undo can put back an earlier workflow, the month's spend. Never a key: only whether one is saved."""
    live = ai._cached_fal_prices()
    avg = _ledger_average()
    caps = {}
    for cap in registry.CAPABILITIES:
        b = ai.block(cap)
        eff = _effective(cap, b)
        reg = registry.capability(cap)
        pid, mid = eff["provider"], eff["model"]
        m = ai._model(pid, mid) if pid and mid else {}
        cost = per_reel(cap, pid, mid, live) if eff["on"] else {"usd": 0.0, "basis": TYPICAL[cap]["what"]}
        if cost["usd"] is None and (cap, pid) in avg:  # charged by tokens with no list price: what a call cost you so far
            cost = {**cost, "usd": avg[(cap, pid)], "source": "your average per call so far (the spend ledger)"}
        caps[cap] = {**eff, "capability": cap, "what": reg.get("what"), "labelRequired": bool(reg.get("labelRequired")),
                     "providerName": ai.PROVIDER_NAMES.get(pid, pid) if pid else None, "modelLabel": m.get("label") or mid,
                     "local": _local(pid) if pid else False, "hasKey": _key(pid) if pid else False,
                     "perReel": cost, "warning": b.get("warning"), "choices": _choices(cap, live),
                     "tools": [t for t, v in registry.tools().items() if v["capability"] == cap]}
    w = ai.workflow()
    total = round(sum(c["perReel"]["usd"] or 0 for c in caps.values() if c["on"]), 4)
    return {"capabilities": caps, "order": list(registry.CAPABILITIES), "template": w.get("template"), "perReel": total,
            "reelSeconds": REEL_SECONDS, "templates": [preview(t, caps) for t in templates()], "undo": undo_info(),
            "ownLlm": ai.own_llm_view(), "reviewBasis": ai.review_basis(), "spend": spend_month({}), "units": list(ai.UNITS),
            "rejected": rejected()}


def rejected() -> list[dict]:
    """What the registry looked at and does not offer, and why (its `_rejected`: {what: reason})."""
    r = registry.load().get("_rejected") or {}
    if isinstance(r, dict):
        return [{"what": str(k), "why": str(v)} for k, v in r.items()]
    return [{"what": str(x.get("what") or x.get("id") or ""), "why": str(x.get("why") or x.get("reason") or "")} for x in r if isinstance(x, dict)]


# ---------- templates ----------

def templates() -> list[dict]:
    """shared/workflows/*.json, checked (a bad file is skipped, never half-read), in their `order`."""
    out = []
    for f in sorted(TEMPLATES.glob("*.json")):
        try:
            t = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not check_template(t):
            out.append(t)
    return sorted(out, key=lambda t: (t.get("order", 99), t["id"]))


def check_template(t) -> list[str]:
    """What is wrong with a template ([] when it may be used)."""
    errs = []
    if not isinstance(t, dict) or not ID_RX.fullmatch(str(t.get("id") or "")):
        return ["id: lowercase letters, digits and dashes"]
    if registry.FORBIDDEN.search(json.dumps(t, ensure_ascii=False)):
        errs.append(f"{t['id']}: text-to-video is never used")
    for k in ("name", "summary"):
        if not isinstance(t.get(k), dict) or not t[k].get("en") or not t[k].get("ja"):
            errs.append(f"{t['id']}: {k} needs en and ja")
    blocks = t.get("blocks")
    if not isinstance(blocks, dict) or not blocks:
        return errs + [f"{t['id']}: blocks"]
    for cap, b in blocks.items():
        if cap not in registry.CAPABILITIES:
            errs.append(f"{t['id']}: {cap} is not a capability")
            continue
        if not isinstance(b, dict):
            errs.append(f"{t['id']}.{cap}: an object")
            continue
        if b.get("on") is False and not b.get("provider"):
            continue
        pid, mid = str(b.get("provider") or ""), str(b.get("model") or "")
        if pid in ("@default", "@cheapest") or mid in ("@default", "@cheapest"):
            continue
        if mid == "@own" or pid == "own":
            if cap not in (registry.provider("own").get("freeModels") or []):
                errs.append(f"{t['id']}.{cap}: your own server does not do {cap}")
            continue
        m = registry.model(pid, mid)
        if not m or m.get("capability") != cap:
            errs.append(f"{t['id']}.{cap}: {pid} {mid} is not a registered {cap} model")
        elif m.get("risk"):
            errs.append(f"{t['id']}.{cap}: {mid} is marked {m['risk']}; a template never picks it")
        elif m.get("voiceRequired") and not b.get("voice"):
            errs.append(f"{t['id']}.{cap}: {mid} needs a voice")
    # A template's backups (studio.fallback): {cap: [{provider, model}]}, registered models of that capability, never an
    # unofficial route (a template cannot accept a risk for you).
    fb = t.get("fallback")
    if fb is not None:
        if not isinstance(fb, dict):
            return errs + [f"{t['id']}: fallback is {{capability: [{{provider, model}}]}}"]
        for cap, lst in fb.items():
            if cap not in registry.CAPABILITIES or not isinstance(lst, list):
                errs.append(f"{t['id']}.fallback.{cap}: a capability and a list")
                continue
            for x in lst:
                m = registry.model(str((x or {}).get("provider") or ""), str((x or {}).get("model") or "")) if isinstance(x, dict) else None
                if not m or m.get("capability") != cap or m.get("risk"):
                    errs.append(f"{t['id']}.fallback.{cap}: {x} is not a registered official {cap} model")
    return errs


def _template(tid: str) -> dict:
    for t in templates():
        if t["id"] == tid:
            return t
    raise AiError(f"template: one of {', '.join(t['id'] for t in templates())}.", "bad_input", 400)


def _cheapest(cap: str, live: dict) -> tuple[str, str] | None:
    rows = []
    for pid, mid, m in registry.models_for(cap):
        if m.get("risk") or m.get("voiceRequired") or registry.FORBIDDEN.search(mid):
            continue
        c = per_reel(cap, pid, mid, live)["usd"]
        if c is not None:
            rows.append((not _key(pid), c, not m.get("default"), pid, mid))
    return min(rows)[3:] if rows else None


def resolve(t: dict, live: dict | None = None) -> tuple[dict, list[str]]:
    """A template's blocks as workflow.json blocks ({cap: {on, provider?, model?, voice?}} or None = back to the
    default), and the notes to show (a placeholder that could not be filled)."""
    live = ai._cached_fal_prices() if live is None else live
    out, notes = {}, []
    for cap, b in t["blocks"].items():
        on = b.get("on", True) is not False
        pid, mid = str(b.get("provider") or ""), str(b.get("model") or "")
        if not on and not pid:
            out[cap] = {"on": False}
            continue
        if "@default" in (pid, mid):
            out[cap] = None if on else {"on": False}
            continue
        if "@cheapest" in (pid, mid):
            got = _cheapest(cap, live)
            if not got:
                out[cap] = None
                continue
            pid, mid = got
        if pid == "own" or mid == "@own":
            own = _own(cap)
            if not own:
                out[cap] = {"on": False}
                notes.append(f"{cap}: set your own model server in Settings › Keys & AI to switch this on (it stays off until then).")
                continue
            pid, mid = "own", own["model"]
        out[cap] = {"on": on, "provider": pid, "model": mid, **({"voice": b["voice"]} if b.get("voice") else {})}
    return out, notes


def _after(blocks: dict, cap: str, now: dict) -> dict:
    """What a capability would be after applying: {on, provider, model}."""
    if cap not in blocks:
        return {"on": now["on"], "provider": now["provider"], "model": now["model"]}
    b = blocks[cap]
    if b is None:
        d = registry.default_model(cap)
        out = {"on": True, "provider": d[0] if d else None, "model": d[1] if d else None}
        own = _own(cap) if cap in ("llm", "vision") else None
        local = ai._env("STUDIO_AI_REVIEW_LOCAL").lower() in ("1", "on", "true", "yes")
        if own and (cap == "llm" or not ai.reviewer_key() or local):  # what _effective would say once it is the default
            out.update(provider="own", model=own["model"])
        return out
    if "provider" not in b:
        return {"on": False, "provider": now["provider"], "model": now["model"]}
    return {"on": b["on"], "provider": b["provider"], "model": b["model"]}


def preview(t: dict, caps: dict | None = None) -> dict:
    """One template as the page shows it before Apply: its words, what changes per capability, and the cost per reel
    before and after."""
    live = ai._cached_fal_prices()
    if caps is None:
        caps = {c: _effective(c, ai.block(c)) for c in registry.CAPABILITIES}
    blocks, notes = resolve(t, live)
    diff, after_total, before_total = [], 0.0, 0.0
    for cap in registry.CAPABILITIES:
        now = caps[cap]
        before = {"on": now["on"], "provider": now["provider"], "model": now["model"]}
        after = _after(blocks, cap, now)
        cost_before = (per_reel(cap, before["provider"], before["model"], live)["usd"] or 0) if before["on"] else 0.0
        cost_after = (per_reel(cap, after["provider"], after["model"], live)["usd"] or 0) if after["on"] else 0.0
        before_total += cost_before
        after_total += cost_after
        if before != after:
            m = ai._model(after["provider"], after["model"]) if after["provider"] and after["model"] else {}
            diff.append({"capability": cap, "before": {**before, "providerName": ai.PROVIDER_NAMES.get(before["provider"], before["provider"])},
                         "after": {**after, "providerName": ai.PROVIDER_NAMES.get(after["provider"], after["provider"]),
                                   "modelLabel": m.get("label") or after["model"], "local": _local(after["provider"]) if after["provider"] else False,
                                   "hasKey": _key(after["provider"]) if after["provider"] else True},
                         "usdBefore": round(cost_before, 4), "usdAfter": round(cost_after, 4)})
    missing = sorted({d["after"]["providerName"] for d in diff if d["after"]["on"] and not d["after"]["hasKey"]})
    return {"id": t["id"], "name": t["name"], "summary": t["summary"], "who": t.get("who"), "tags": t.get("tags") or [],
            "icon": t.get("icon"), "on": [c for c in registry.CAPABILITIES if _after(blocks, c, caps[c])["on"]],
            "diff": diff, "notes": notes, "missingKeys": missing,
            "fallback": {c: [ai.PROVIDER_NAMES.get(x["provider"], x["provider"]) for x in lst] for c, lst in (t.get("fallback") or {}).items()},
            "perReel": round(after_total, 4), "perReelNow": round(before_total, 4)}


# ---------- applying and undoing ----------

def _backup() -> Path:
    return ai.WORKFLOW.with_name("workflow.prev.json")


def undo_info() -> dict:
    f = _backup()
    if not f.exists():
        return {"can": False}
    b = ai._read(f) or {}
    return {"can": True, "at": b.get("savedAt"), "template": b.get("appliedTemplate")}


def apply(req: dict) -> dict:
    """Apply one template: back up workflow.json as it is (or note it did not exist), then write the template's blocks
    over it. Prices you entered stay. Only on an explicit request ({template, confirm: true})."""
    tid = str(req.get("template") or "")
    if not ID_RX.fullmatch(tid):
        raise AiError("template: a template id from /api/workflow.", "bad_input", 400)
    if req.get("confirm") is not True:
        raise AiError("Applying changes this project's workflow: send confirm: true (the page's Apply button does).", "confirm", 400)
    t = _template(tid)
    blocks, notes = resolve(t)
    raw = ai._read(ai.WORKFLOW) if ai.WORKFLOW.exists() else None
    ai._write(_backup(), {"savedAt": datetime.now().isoformat(timespec="seconds"), "appliedTemplate": tid, "existed": raw is not None, "workflow": raw})
    w = ai.workflow()
    for cap, b in blocks.items():
        if b is None:
            w["blocks"].pop(cap, None)
        elif "provider" not in b:
            w["blocks"][cap] = {**(w["blocks"].get(cap) or {}), "on": False}
        else:
            w["blocks"][cap] = b
    if isinstance(t.get("fallback"), dict):  # the template's backups replace those blocks' lists (Undo puts them back)
        w["fallback"] = {**(w.get("fallback") or {}), **{c: [{"provider": x["provider"], "model": x["model"]} for x in lst] for c, lst in t["fallback"].items()}}
    w["template"] = tid
    ai._save_workflow(w)
    return {"applied": tid, "notes": notes, "undo": undo_info(), "view": view({})}


def undo(req: dict | None = None) -> dict:
    """Put back the workflow from before the last Apply (deleting workflow.json if there was none), once."""
    f = _backup()
    if not f.exists():
        raise AiError("There is nothing to undo: no template was applied since the last Undo.", "nothing", 409)
    b = ai._read(f) or {}
    if b.get("existed") and isinstance(b.get("workflow"), dict):
        ai._write(ai.WORKFLOW, b["workflow"])
    elif ai.WORKFLOW.exists():
        ai.WORKFLOW.unlink()
    f.unlink()
    return {"undone": b.get("appliedTemplate"), "undo": undo_info(), "view": view({})}


# ---------- this month's spend (the ledger charge() writes) ----------

def _cap_of(purpose: str) -> str:
    p = purpose or ""
    if p.startswith(ai.PURPOSE):
        t = registry.tools().get(p[len(ai.PURPOSE):])
        return t["capability"] if t else "other"
    base = re.sub(r"-error$", "", p)
    return PURPOSE_CAP.get(base) or next((c for k, c in PURPOSE_CAP.items() if base.startswith(k)), "other")


def _ledger(sql: str, args: tuple = ()) -> list[dict]:
    """Rows of the spend ledger through a read-only connection with a short wait: db.connect() first runs the schema
    script, which waits on any writer (a long ingest held it for 45 s and the page timed out). [] if it cannot be read."""
    import sqlite3

    from studio.db import catalog_path

    try:
        con = sqlite3.connect(f"file:{catalog_path().as_posix()}?mode=ro", uri=True, timeout=4)
    except sqlite3.Error:
        return []
    try:
        con.row_factory = sqlite3.Row
        return [dict(r) for r in con.execute(sql, args)]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def _ledger_average() -> dict:
    """{(capability, provider): average USD per paid call} over the whole ledger, for blocks priced by tokens."""
    rows = _ledger("SELECT purpose, provider, model, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd FROM spend WHERE usd > 0 GROUP BY purpose, provider, model")
    acc = {}
    for r in rows:
        k = (_cap_of(r["purpose"]), ai._provider_of(r["model"], r["provider"]))
        a = acc.setdefault(k, [0.0, 0])
        a[0] += float(r["usd"])
        a[1] += int(r["calls"])
    return {k: round(u / n, 4) for k, (u, n) in acc.items() if n}


def spend_month(req: dict | None = None) -> dict:
    """Paid AI this calendar month (this computer's clock), from the `spend` table: by capability, by provider and both,
    with the AI limit and the daily budget it runs inside. {month?: "YYYY-MM"} reads another month."""
    req = req or {}
    month = str(req.get("month") or date.today().strftime("%Y-%m"))
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise AiError("month: YYYY-MM.", "bad_input", 400)
    rows = _ledger("SELECT purpose, provider, model, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd FROM spend WHERE ts LIKE ? GROUP BY purpose, provider, model",
                   (month + "%",))
    by_cap, by_prov, pairs = {}, {}, {}
    for r in rows:
        cap, pid = _cap_of(r["purpose"]), ai._provider_of(r["model"], r["provider"])
        for d, k in ((by_cap, cap), (by_prov, pid), (pairs, (cap, pid))):
            x = d.setdefault(k, {"usd": 0.0, "calls": 0})
            x["usd"] += float(r["usd"] or 0)
            x["calls"] += int(r["calls"] or 0)
    total = round(sum(x["usd"] for x in by_cap.values()), 4)
    y, mo = (int(v) for v in month.split("-"))
    days = calendar.monthrange(y, mo)[1]
    c = ai.caps()
    s = {"total": float((_ledger("SELECT COALESCE(SUM(usd), 0) AS t FROM spend WHERE purpose LIKE ?", (ai.PURPOSE + "%",)) or [{"t": 0}])[0]["t"])}
    today = date.today()
    day_no = today.day if today.strftime("%Y-%m") == month else days
    return {"month": month, "total": total, "calls": sum(x["calls"] for x in by_cap.values()),
            "byCapability": sorted(({"capability": k, "usd": round(v["usd"], 4), "calls": v["calls"]} for k, v in by_cap.items()), key=lambda x: -x["usd"]),
            "byProvider": sorted(({"provider": k, "name": ai.PROVIDER_NAMES.get(k, k), "usd": round(v["usd"], 4), "calls": v["calls"]} for k, v in by_prov.items()),
                                 key=lambda x: -x["usd"]),
            "rows": sorted(({"capability": k[0], "provider": k[1], "usd": round(v["usd"], 4), "calls": v["calls"]} for k, v in pairs.items()), key=lambda x: -x["usd"]),
            "budget": {"daily": c["daily"], "month": round(c["daily"] * days, 2), "dayOfMonth": day_no, "days": days,
                       "aiCap": c["total"], "aiSpent": s["total"], "aiLeft": round(max(0.0, c["total"] - s["total"]), 4)}}
