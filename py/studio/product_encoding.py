"""
FILE: py/studio/product_encoding.py
PURPOSE: How a product video is encoded (studio.product), and whether that encoding meets the chosen store's rules:
         rate control (constrained CBR, VBR or CRF), target / floor / ceiling bit rates and the VBV buffer, frame rate,
         keyframe interval, AAC bit rate and sample rate, and the sound bed (a quiet dither or a music track).
OVERVIEW: resolve(): the settings for one render, layered (each layer only changes the fields it names):
            1. the preset's defaults (shared/product-presets.json presets.<id>.encode, inside its store's rules),
            2. the kit's own hints (manifest "encoding"; a kit is someone else's file, so a bad hint is a warning and
               is dropped, never an error),
            3. this project's defaults (<data>/product-encoding.json, saved from the studio page),
            4. this render's choice (the page, POST /api/product/render, MCP make_product_video): a bad value here is
               an error that names the field.
          Then the cross-field checks (CBR holds one rate, a ceiling over its target, the H.264 level this size, frame
          rate and buffer need) and the store's rules (encoding.stores: "error" = the store requires it and the render
          is refused, "warn" = the store recommends it).
          check_file(): the same rules against what ffprobe measured in the finished file.
          video_args(): the ffmpeg/x264 arguments for the settings. Nothing here ever takes an ffmpeg or x264 string from
          a request, a project file or a kit: only typed, range-checked fields.
DEPENDENCIES: studio.config (DATA, ROOT); studio.sound (the audio library) only when a music bed is named.
USAGE: from studio import product_encoding as pe; r = pe.resolve("appstore-iphone", render={"videoKbps": 12000})
NOTES: libx264 ignores -minrate on its own, and plain VBR fell to 0.55 Mbps on a still screen (27 Nov 2026, ffmpeg 9.0):
       so constrained CBR is target = min = max with x264's CBR filler (nal-hrd=cbr), which held 10.9 Mbps on the same
       still. A floor (minKbps) under VBR or CRF is kept by encoding again as constrained CBR at the floor when the file
       comes out under it (studio.product.build).
"""
from __future__ import annotations

import json
import math
from studio.config import DATA, ROOT

_FILE = json.loads((ROOT / "shared" / "product-presets.json").read_text(encoding="utf-8"))
PRESETS: dict = _FILE["presets"]
FIELDS: dict = _FILE["encoding"]["fields"]
STORES: dict = _FILE["encoding"]["stores"]
PROJECT_FILE = DATA / "product-encoding.json"
MODES = ("cbr", "vbr", "crf")
MODE_FIELDS = ("minKbps", "maxKbps", "bufsizeKbits", "crf")  # dropped from lower layers when a layer changes the mode
KEYS = tuple(FIELDS)
NAMES = {"rateControl": "rate control", "videoKbps": "target bit rate", "minKbps": "floor (min bit rate)", "maxKbps": "max bit rate",
         "bufsizeKbits": "buffer (bufsize)", "crf": "CRF", "fps": "frame rate", "keyframeSec": "keyframe interval",
         "audioKbps": "sound bit rate", "audioRate": "sample rate", "audioBed": "sound bed"}
UNITS = {"videoKbps": " kbps", "minKbps": " kbps", "maxKbps": " kbps", "bufsizeKbits": " kbit", "fps": " fps", "keyframeSec": " s",
         "audioKbps": " kbps", "audioRate": " Hz"}

# H.264 Annex A, Table A-1, for the High profile (MaxBR and MaxCPB x 1.25): level, macroblocks a second, macroblocks a
# frame, max bit rate (kbps), max VBV buffer (kbit).
LEVELS = (("3.1", 108000, 3600, 17500, 17500), ("3.2", 216000, 5120, 25000, 25000), ("4.0", 245760, 8192, 25000, 31250),
          ("4.1", 245760, 8192, 62500, 78125), ("4.2", 522240, 8704, 62500, 78125), ("5.0", 589824, 22080, 168750, 168750),
          ("5.1", 983040, 36864, 300000, 300000), ("5.2", 2073600, 36864, 300000, 300000))


def _issue(field: str, text: str) -> dict:
    return {"field": field, "text": text}


def _fmt(field: str, v) -> str:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return f"{v}{UNITS.get(field, '')}"


def store_of(pid: str) -> dict:
    return STORES.get(PRESETS[pid]["store"]) or {"name": PRESETS[pid]["store"], "rules": []}


def defaults(pid: str) -> dict:
    """The preset's own encoding: every field set (mode fields only for its mode)."""
    p = PRESETS[pid]
    e = p["encode"]
    out = {k: e[k] for k in KEYS if k in e}
    out["fps"] = p["fps"]
    out["audioBed"] = dict(e.get("audioBed") or {"kind": "dither"})
    return out


# ---------- one layer: types and ranges ----------

def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_layer(layer, where: str) -> tuple[dict, list[dict]]:
    """One layer of settings: (the fields that passed, an issue for each that did not). Unknown fields are issues too:
    a typo must not be silently ignored."""
    if layer is None:
        return {}, []
    if not isinstance(layer, dict):
        return {}, [_issue("", f"{where}: encoding settings must be an object of fields ({', '.join(KEYS)})")]
    clean: dict = {}
    issues: list[dict] = []
    for k, v in layer.items():
        if k not in FIELDS:
            issues.append(_issue(k, f"{where}: {k} is not an encoding setting; allowed: {', '.join(KEYS)}"))
            continue
        if v is None:
            continue  # null = "use what the layer below says"
        f = FIELDS[k]
        if k == "audioBed":
            bed, more = _check_bed(v, where)
            issues += more
            if bed:
                clean[k] = bed
            continue
        if "enum" in f:
            if v not in f["enum"] or isinstance(v, bool):
                issues.append(_issue(k, f"{where}: {NAMES[k]} must be one of {', '.join(str(x) for x in f['enum'])} (it is {v!r})"))
                continue
            if isinstance(v, float) and v.is_integer():
                v = int(v)
        else:
            if not _number(v) or (f.get("type") == "integer" and float(v) != int(v)):
                issues.append(_issue(k, f"{where}: {NAMES[k]} must be {'a whole number' if f.get('type') == 'integer' else 'a number'} (it is {v!r})"))
                continue
            if v < f["min"] or v > f["max"]:
                issues.append(_issue(k, f"{where}: {NAMES[k]} must be {_fmt(k, f['min'])} to {_fmt(k, f['max'])} (it is {_fmt(k, v)})"))
                continue
            v = int(v) if f.get("type") == "integer" else float(v)
        clean[k] = v
    return clean, issues


def _check_bed(v, where: str) -> tuple[dict | None, list[dict]]:
    spec = FIELDS["audioBed"]
    if not isinstance(v, dict):
        return None, [_issue("audioBed", f'{where}: sound bed must be {{"kind": "dither"}} or {{"kind": "music", "id": "<a music file in the audio library>", "volume": 0.5}}')]
    kind = v.get("kind")
    if kind not in spec["kind"]["enum"]:
        return None, [_issue("audioBed", f"{where}: sound bed kind must be one of {', '.join(spec['kind']['enum'])} (it is {kind!r})")]
    extra = sorted(set(v) - {"kind", "id", "volume"})
    if extra:
        return None, [_issue("audioBed", f"{where}: sound bed takes kind, id and volume only (not {', '.join(extra)})")]
    if kind == "dither":
        return {"kind": "dither"}, []
    tid = v.get("id")
    if not isinstance(tid, str) or not tid or len(tid) > 200 or "/" in tid or "\\" in tid or tid.startswith("."):
        return None, [_issue("audioBed", f"{where}: a music bed needs id, the name of a music file in the audio library (Reels › Audio)")]
    vol = v.get("volume", 0.5)
    lo, hi = spec["volume"]["min"], spec["volume"]["max"]
    if not _number(vol) or not lo <= vol <= hi:
        return None, [_issue("audioBed", f"{where}: music volume must be {lo} to {hi} (it is {vol!r})")]
    return {"kind": "music", "id": tid, "volume": float(vol)}, []


def _profile_layers(src, pid: str, where: str) -> list[tuple[dict, str]]:
    """A kit's or a project's {default?, presets?: {<id>: {...}}}: the layers that apply to this preset, in order."""
    if not isinstance(src, dict):
        return []
    out = []
    if isinstance(src.get("default"), dict):
        out.append((src["default"], f"{where} (every preset)"))
    per = src.get("presets")
    if isinstance(per, dict) and isinstance(per.get(pid), dict):
        out.append((per[pid], f"{where} ({pid})"))
    return out


def merge(base: dict, layer: dict) -> dict:
    """A layer over the settings so far. A layer that changes the rate control drops the mode fields below it (a VBR
    ceiling must not turn into a CBR rate), unless the same layer sets them."""
    out = dict(base)
    if "rateControl" in layer and layer["rateControl"] != base.get("rateControl"):
        for k in MODE_FIELDS:
            out.pop(k, None)
    out.update(layer)
    return out


# ---------- the whole: cross-field checks, the H.264 level, the store's rules ----------

def level_for(width: int, height: int, fps: float, max_kbps: int | None, buf: int | None, start: str = "4.0") -> str | None:
    """The lowest H.264 level from `start` up that this picture size, frame rate and VBV fit (None: none does)."""
    mbs = math.ceil(width / 16) * math.ceil(height / 16)
    for name, mbps, fs, br, cpb in LEVELS:
        if float(name) < float(start):
            continue
        if mbs <= fs and mbs * fps <= mbps and (max_kbps or 0) <= br and (buf or 0) <= cpb:
            return name
    return None


def _limits(name: str) -> tuple:
    return next(x for x in LEVELS if x[0] == name)


def finish(pid: str, s: dict) -> tuple[dict, list[dict]]:
    """Fill the fields the mode needs from the ones given, and check how they fit together. Returns the settings ready for
    the encoder (with "level") and the errors."""
    p = PRESETS[pid]
    st = store_of(pid)
    errs: list[dict] = []
    s = dict(s)
    mode = s.get("rateControl", "vbr")
    T = s.get("videoKbps")
    if mode == "cbr" and T is None:
        errs.append(_issue("videoKbps", "Constrained CBR needs a target bit rate"))
    elif mode == "cbr":
        for k in ("minKbps", "maxKbps"):
            if k in s and s[k] != T:
                errs.append(_issue(k, f"Constrained CBR holds one rate: the {NAMES[k]} is the target ({_fmt('videoKbps', T)}); x264 pads still screens "
                                      f"with filler so the rate never drops. Leave it out, or use VBR for a range."))
        s["minKbps"] = s["maxKbps"] = T
        s.setdefault("bufsizeKbits", T)
        s.pop("crf", None)
    elif mode == "vbr":
        if T is None:
            errs.append(_issue("videoKbps", "VBR needs a target bit rate"))
        else:
            s.setdefault("maxKbps", int(round(T * 1.2)))
            if s["maxKbps"] < T:
                errs.append(_issue("maxKbps", f"The max bit rate ({_fmt('maxKbps', s['maxKbps'])}) is under the target ({_fmt('videoKbps', T)})"))
            if "minKbps" in s and s["minKbps"] > T:
                errs.append(_issue("minKbps", f"The floor ({_fmt('minKbps', s['minKbps'])}) is over the target ({_fmt('videoKbps', T)})"))
            s.setdefault("bufsizeKbits", s["maxKbps"] * 2)
        s.pop("crf", None)
    else:  # crf
        s.setdefault("crf", 18)
        s.pop("videoKbps", None)
        if st.get("levelMax") and "maxKbps" not in s:
            # A store that caps the level caps the peak rate too: CRF alone may go past it on a busy scene.
            _, _, _, br, cpb = _limits(st["levelMax"])
            s["maxKbps"] = br
            s.setdefault("bufsizeKbits", cpb)
        if "maxKbps" in s:
            s.setdefault("bufsizeKbits", s["maxKbps"] * 2)
            if "minKbps" in s and s["minKbps"] > s["maxKbps"]:
                errs.append(_issue("minKbps", f"The floor ({_fmt('minKbps', s['minKbps'])}) is over the max bit rate ({_fmt('maxKbps', s['maxKbps'])})"))
        elif "bufsizeKbits" in s:
            errs.append(_issue("bufsizeKbits", "A buffer (bufsize) only means something with a max bit rate: set maxKbps too, or leave the buffer out"))
    if s.get("maxKbps") and s.get("bufsizeKbits") and s["bufsizeKbits"] < s["maxKbps"] / 8:
        errs.append(_issue("bufsizeKbits", f"The buffer ({_fmt('bufsizeKbits', s['bufsizeKbits'])}) is under 1/8 s of the max bit rate: the encoder would starve every keyframe"))
    lv = level_for(p["width"], p["height"], s["fps"], s.get("maxKbps"), s.get("bufsizeKbits"), p["encode"].get("level", "4.0"))
    cap = st.get("levelMax")
    if lv is None or (cap and float(lv) > float(cap)):
        name = cap or "5.2"
        _, mbps, _, br, cpb = _limits(name)
        mbs = math.ceil(p["width"] / 16) * math.ceil(p["height"] / 16)
        why = []
        if mbs * s["fps"] > mbps:
            why.append(f"{_fmt('fps', s['fps'])} at {p['width']}x{p['height']} needs more than level {name}")
        if (s.get("maxKbps") or 0) > br:
            why.append(f"level {name} allows at most {br} kbps (max bit rate {_fmt('maxKbps', s['maxKbps'])})")
        if (s.get("bufsizeKbits") or 0) > cpb:
            why.append(f"level {name} allows a buffer of at most {cpb} kbit (it is {_fmt('bufsizeKbits', s['bufsizeKbits'])})")
        who = f"{st['name']} takes H.264 up to High profile level {cap}" if cap else "H.264 goes no higher than level 5.2"
        errs.append(_issue("maxKbps" if (s.get("maxKbps") or 0) > br else "bufsizeKbits" if (s.get("bufsizeKbits") or 0) > cpb else "fps",
                           f"{who}: " + "; ".join(why or [f"these settings need more than level {name}"])))
        lv = cap or "5.2"
    s["level"] = lv
    s["profile"] = p["encode"].get("profile", "high")
    return s, errs


def _applies(rule: dict, fps: float) -> bool:
    w = rule.get("when") or {}
    return not (("fpsMax" in w and fps > w["fpsMax"]) or ("fpsMin" in w and fps < w["fpsMin"]))


def _breaks(rule: dict, v, tolerance: float = 1.0) -> bool:
    if "oneOf" in rule:
        return v not in rule["oneOf"]
    if "min" in rule and v < rule["min"] * tolerance:
        return True
    return "max" in rule and v > rule["max"] / (tolerance if tolerance < 1 else 1)


def _want(rule: dict, field: str) -> str:
    if "oneOf" in rule:
        return " or ".join(_fmt(field, x) for x in rule["oneOf"])
    if "min" in rule and "max" in rule:
        return f"{_fmt(field, rule['min'])} to {_fmt(field, rule['max'])}"
    return f"at least {_fmt(field, rule['min'])}" if "min" in rule else f"at most {_fmt(field, rule['max'])}"


def store_check(pid: str, s: dict) -> tuple[list[dict], list[dict]]:
    """The settings against the store's rules: (errors, warnings)."""
    st = store_of(pid)
    errs, warns = [], []
    for r in st.get("rules", []):
        f = r["field"]
        if not _applies(r, s["fps"]):
            continue
        v = s.get(f)
        if f == "videoKbps" and s.get("rateControl") == "crf":
            # CRF holds a quality, not a rate: the floor is what it promises, else the file is checked after the render.
            v = s.get("minKbps")
            if v is None:
                if "min" in r:
                    warns.append(_issue(f, f"{r['why']}; CRF does not hold a bit rate, so the finished file's rate is checked after the render "
                                           f"(set a floor, minKbps, to keep {_fmt(f, r['min'])})"))
                continue
            if "min" not in r or v >= r["min"]:
                continue  # a floor at or over the recommended rate keeps it; only a floor under it breaks the rule
        if v is None:
            continue
        if _breaks(r, v):
            (errs if r["level"] == "error" else warns).append(
                _issue(f, f"{r['why']}: the {NAMES[f]} is {_fmt(f, v)}, {st['name']} {'needs' if r['level'] == 'error' else 'recommends'} {_want(r, f)}"))
    return errs, warns


def _music(bed: dict) -> tuple[dict | None, list[dict], list[dict]]:
    """A music bed's track from the audio library: (track, errors, warnings)."""
    from studio import sound

    track = next((t for t in sound.library() if t["kind"] == "music" and t["id"] == bed["id"]), None)
    if not track:
        return None, [_issue("audioBed", f"The music {bed['id']} is not in the audio library (Reels › Audio lists its music files)")], []
    lic = str(track.get("license") or "UNKNOWN")
    warn = [] if lic in ("CC0", "PDM") else [_issue("audioBed", f"The music {bed['id']} has the licence {lic}: make sure you may use it in a store listing or an ad")]
    return track, [], warn


def load_project() -> dict:
    """This project's saved defaults: {default?: {...}, presets?: {<id>: {...}}} ({} when none)."""
    try:
        d = json.loads(PROJECT_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_project(pid: str, layer: dict | None) -> dict:
    """Save (or with None clear) this project's default for one preset. The layer must pass check_layer and the store's
    required rules first, so a saved default never refuses a render later."""
    if pid not in PRESETS:
        raise ValueError(f"preset: one of {', '.join(PRESETS)}")
    d = load_project()
    per = d.get("presets") if isinstance(d.get("presets"), dict) else {}
    if layer:
        r = resolve(pid, project={}, render=layer)
        if r["errors"]:
            raise ValueError("; ".join(e["text"] for e in r["errors"]))
        per[pid] = check_layer(layer, "project")[0]
    else:
        per.pop(pid, None)
    d["presets"] = per
    PROJECT_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROJECT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PROJECT_FILE)
    return d


def resolve(pid: str, kit: dict | None = None, project: dict | None = None, render: dict | None = None, music: bool = True) -> dict:
    """The settings for one render and what is wrong with them.

    kit: the kit's "encoding" ({default?, presets?}); project: this project's defaults (None = read the file);
    render: this render's fields. Returns {"settings", "errors", "warnings", "sources"}: errors and warnings are
    [{"field", "text"}]; sources says which layer set each field (preset, kit, project, render)."""
    if pid not in PRESETS:
        raise ValueError(f"preset: one of {', '.join(PRESETS)}")
    s = defaults(pid)
    sources = {k: "preset" for k in s}
    errs: list[dict] = []
    warns: list[dict] = []

    def layer(src: str, data: dict, where: str, strict: bool) -> None:
        nonlocal s
        clean, issues = check_layer(data, where)
        (errs if strict else warns).extend(issues if strict else [_issue(i["field"], i["text"] + " (left out)") for i in issues])
        before = s
        s = merge(s, clean)
        for k in MODE_FIELDS:
            if k in before and k not in s:
                sources.pop(k, None)
        for k in clean:
            sources[k] = src

    for data, where in _profile_layers((kit or {}), pid, "the kit's encoding"):
        layer("kit", data, where, strict=False)
    for data, where in _profile_layers(load_project() if project is None else project, pid, "this project's encoding defaults"):
        layer("project", data, where, strict=False)
    if render is not None:
        layer("render", render, "encoding", strict=True)
    if isinstance(render, dict) and render.get("rateControl") == "crf" and "videoKbps" in render:
        warns.append(_issue("videoKbps", "CRF ignores the target bit rate: it holds a quality (crf) instead"))
    s, more = finish(pid, s)
    errs += more
    e2, w2 = store_check(pid, s)
    if any(e["field"] == "fps" for e in e2):  # the store's own frame-rate rule says it plainer than the level does
        errs = [e for e in errs if not (e["field"] == "fps" and "level" in e["text"])]
    errs += e2
    warns += w2
    if music and s["audioBed"].get("kind") == "music":
        _, e3, w3 = _music(s["audioBed"])
        # A kit's or a project's music that is not here falls back to the quiet bed; a render's choice is an error.
        if e3 and sources.get("audioBed") != "render":
            warns.append(_issue("audioBed", e3[0]["text"] + "; the quiet bed is used instead"))
            s["audioBed"] = {"kind": "dither"}
            sources["audioBed"] = "preset"
        else:
            errs += e3
            warns += w3
    return {"preset": pid, "store": store_of(pid)["name"], "settings": s, "errors": errs, "warnings": warns, "sources": sources}


# ---------- the encoder ----------

def video_args(s: dict) -> list[str]:
    """x264 arguments for finished settings (finish()): profile, level, rate control, keyframes."""
    g = max(1, int(round(s["fps"] * s["keyframeSec"])))
    out = ["-c:v", "libx264", "-profile:v", s["profile"], "-level:v", s["level"], "-preset", "medium", "-g", str(g)]
    mode = s["rateControl"]
    if mode == "cbr":
        t = s["videoKbps"]
        out += ["-b:v", f"{t}k", "-minrate", f"{t}k", "-maxrate", f"{t}k", "-bufsize", f"{s['bufsizeKbits']}k", "-x264-params", "nal-hrd=cbr:force-cfr=1"]
    elif mode == "vbr":
        out += ["-b:v", f"{s['videoKbps']}k", "-maxrate", f"{s['maxKbps']}k", "-bufsize", f"{s['bufsizeKbits']}k"]
    else:
        out += ["-crf", f"{s['crf']:g}"]
        if s.get("maxKbps"):
            out += ["-maxrate", f"{s['maxKbps']}k", "-bufsize", f"{s['bufsizeKbits']}k"]
    return out


def floor_settings(s: dict) -> dict:
    """Constrained CBR at the floor: what a VBR or CRF file under its floor is encoded again with."""
    t = s["minKbps"]
    return {**s, "rateControl": "cbr", "videoKbps": t, "minKbps": t, "maxKbps": t, "bufsizeKbits": t}


# ---------- the finished file ----------

def measure(probe: dict, size_bytes: int) -> dict:
    """What ffprobe says about the file, in the units the settings use (kbps, fps, Hz, s, MB)."""
    streams = probe.get("streams") or []
    v = next((x for x in streams if x.get("codec_type") == "video"), {}) or {}
    a = next((x for x in streams if x.get("codec_type") == "audio"), {}) or {}

    def num(x, scale=1.0):
        try:
            return round(float(x) / scale, 1) if x not in (None, "") else None
        except (TypeError, ValueError):
            return None

    n, _, d = str(v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = round(float(n) / float(d or 1), 3)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    seconds = num(v.get("duration")) or num((probe.get("format") or {}).get("duration")) or 0.0
    vk = num(v.get("bit_rate"), 1000)
    if vk is None and seconds:
        # A container that does not say the stream's rate: the whole file's rate, less the sound.
        total = num((probe.get("format") or {}).get("bit_rate"), 1000)
        vk = round(total - (num(a.get("bit_rate"), 1000) or 0), 1) if total else None
    return {"videoKbps": vk, "audioKbps": num(a.get("bit_rate"), 1000), "audioRate": int(a.get("sample_rate") or 0) or None,
            "channels": int(a.get("channels") or 0) or None, "audioCodec": a.get("codec_name"), "videoCodec": v.get("codec_name"),
            "fps": fps, "profile": v.get("profile"), "level": (int(v.get("level") or 0) / 10) or None, "pixFmt": v.get("pix_fmt"),
            "width": v.get("width"), "height": v.get("height"), "seconds": seconds, "mb": round(size_bytes / 1024 / 1024, 2)}


def check_file(pid: str, m: dict, s: dict | None = None) -> tuple[list[dict], list[dict]]:
    """The measured file (measure()) against the store's rules and the settings it was made with: (errors, warnings).
    The structure checks (codec, profile, level, pixels, stereo, size) stay in studio.product.verify_file."""
    st = store_of(pid)
    s = s or finish(pid, defaults(pid))[0]
    errs, warns = [], []
    fps = m.get("fps") or 0
    if fps and abs(fps - s["fps"]) > 0.01:
        errs.append(_issue("fps", f"The file plays at {fps:g} fps; it was set to {s['fps']} fps"))
    for r in st.get("rules", []):
        f = r["field"]
        if f not in ("fps", "videoKbps", "audioKbps", "audioRate") or not _applies(r, fps or s["fps"]):
            continue
        v = m.get(f)
        if v is None:
            if f == "audioKbps" and r["level"] == "error":
                v = 0.0  # no rate at all: a silent track (about 2 kbps) or none
            else:
                continue
        tol = r.get("fileTolerance", 0.95 if f in ("videoKbps", "audioKbps") else 1.0)
        if _breaks(r, v, tol):
            words = f"{r['why']}: the file's {NAMES[f]} is {_fmt(f, v)}, {st['name']} {'needs' if r['level'] == 'error' else 'recommends'} {_want(r, f)}"
            (errs if r["level"] == "error" else warns).append(_issue(f, words))
    if s.get("rateControl") == "cbr" and m.get("videoKbps") and m["videoKbps"] < s["videoKbps"] * 0.9:
        warns.append(_issue("videoKbps", f"Constrained CBR was set to {s['videoKbps']} kbps; the file holds {m['videoKbps']:g} kbps"))
    if s.get("minKbps") and s.get("rateControl") != "cbr" and m.get("videoKbps") and m["videoKbps"] < s["minKbps"] * 0.97:
        warns.append(_issue("videoKbps", f"The file's bit rate ({m['videoKbps']:g} kbps) is under the floor ({s['minKbps']} kbps)"))
    return errs, warns


def view() -> dict:
    """What the studio page needs to draw the Encoding panel: the fields with their ranges, each preset's defaults and
    store, the stores' rules, this project's saved defaults and the audio library's music."""
    try:
        from studio import sound

        music = [{"id": t["id"], "title": t.get("title") or t["id"], "license": t.get("license") or "UNKNOWN"} for t in sound.library() if t["kind"] == "music"]
    except Exception:  # an audio library that cannot be read only hides the music choice
        music = []
    return {"fields": FIELDS, "stores": STORES, "defaults": {pid: finish(pid, defaults(pid))[0] for pid in PRESETS},
            "project": load_project(), "music": music[:200]}
