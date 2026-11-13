"""
FILE: py/studio/sound.py
PURPOSE: Music and sound effects for the reels, free and licence-clean, mixed locally.
OVERVIEW: - fetch(): CC0 / public-domain music and effects from the Openverse API
            (Freesound, Wikimedia Commons, Jamendo), each saved with a JSON sidecar
            that records title, creator, licence and the landing page.
          - synth(): whoosh, riser and soft hit made here with ffmpeg, so no third
            party holds any right in them.
          - choose_music() / sfx_plan(): which bed and which hits a reel gets.
          - mix(): rendered picture + clip sound + music (auto-ducked under the clip
            sound) + effects, then one loudness pass. The picture is copied, not re-encoded.
DEPENDENCIES: ffmpeg (studio build), urllib (Openverse, no key), studio.config
USAGE: python -m studio audio --synth ; python -m studio audio --fetch music "calm piano"
       reels.build() calls mix(); reels.remix(slug) re-runs only the audio.
NOTES: Openverse anonymous limits: 20 requests/min, 200/day, 20 results per page
       (checked 2026-11-07). Only cc0 and pdm are fetched: no credit is owed and no
       NC term applies. Credits are still written beside every delivery.
       Sound design follows the research: few whooshes, starting ~0.25 s before the
       cut; music well under the clip sound; final loudness from shared/spec.json.
"""
from __future__ import annotations

import hashlib
import json
import ssl
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

from studio.config import DATA, SPEC, ffmpeg_bin, ffprobe_bin

LIB = DATA / "audio"
OPENVERSE = "https://api.openverse.org/v1/audio/"
UA = "tsumagoi-studio/1.0 (local reel tool; contact via kensaur.us)"
LICENSES = "cc0,pdm"
AUDIO_EXT = {".mp3", ".ogg", ".wav", ".flac", ".m4a", ".oga"}

# Theme / house reel -> the search words its music is fetched and chosen with.
MOOD = {
    "office": "calm piano",
    "winter": "calm piano",
    "carstay": "acoustic guitar",
    "field": "acoustic guitar",
    "fire": "warm acoustic",
    "autumn": "ambient cinematic",
    "view": "ambient cinematic",
}
SEED_QUERIES = {"music": sorted(set(MOOD.values())), "sfx": ["whoosh", "wind"]}
# Field recordings and noise that a word search for "music" still returns.
NOT_MUSIC = ("city", "street", "traffic", "crowd", "bar ", "voice", "speech", "talk", "vocal", "noise", "thriller",
             "horror", "metal", "scream", "siren", "rain", "pickup", "plugging", "single note", "chord ", "sample pack",
             "battle", "war ", "epic", "trailer", "dubstep", "glitch")


def _sidecar(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".json")


def _duration(path: Path) -> float:
    out = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    ).stdout.strip()
    try:
        return round(float(out), 2)
    except ValueError:
        return 0.0


def _tls() -> ssl.SSLContext:
    """Verified TLS. This PC's default store holds an expired chain for cdn.freesound.org; certifi's is current."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _open(url: str, accept: str = "*/*", timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    return urllib.request.urlopen(req, timeout=timeout, context=_tls())


def _get(url: str) -> dict:
    with _open(url, "application/json", 30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch(kind: str, query: str, n: int = 6) -> list[dict]:
    """Download up to n new CC0 / public-domain tracks for one query. kind: music | sfx."""
    if kind not in ("music", "sfx"):
        raise ValueError(kind)
    folder = LIB / kind
    folder.mkdir(parents=True, exist_ok=True)
    # Freesound results carry no category, so `category=music` drops them all; search words instead.
    params = {
        "q": (f"{query} music" if kind == "music" else query)[:200],
        "license": LICENSES,
        "page_size": 20,
        "filter_dead": "true",
    }
    data = _get(OPENVERSE + "?" + urllib.parse.urlencode(params))
    got = []
    for r in data.get("results", []):
        if len(got) >= n:
            break
        dur = (r.get("duration") or 0) / 1000
        if kind == "music" and not 25 <= dur <= 360:
            continue
        if kind == "sfx" and not 0.2 <= dur <= 6:
            continue
        words = f"{r.get('title', '')} {' '.join(t.get('name', '') for t in r.get('tags') or [])}".lower()
        if kind == "music" and any(w in words for w in NOT_MUSIC):
            continue
        if (r.get("license") or "").lower() not in ("cc0", "pdm"):
            continue
        ext = "." + (r.get("filetype") or Path(urllib.parse.urlparse(r["url"]).path).suffix.lstrip(".") or "mp3").lower()
        if ext not in AUDIO_EXT:
            ext = ".mp3"
        dest = folder / f"ov_{r['id']}{ext}"
        if dest.exists():
            continue
        try:
            with _open(r["url"]) as resp:
                blob = resp.read()
        except OSError:
            continue
        if len(blob) < 2000:
            continue
        dest.write_bytes(blob)
        real = _duration(dest)
        if real <= 0:
            dest.unlink()
            continue
        meta = {
            "kind": kind,
            "title": r.get("title") or dest.stem,
            "creator": r.get("creator") or "unknown",
            "license": (r.get("license") or "").upper(),
            "licenseUrl": r.get("license_url"),
            "landing": r.get("foreign_landing_url"),
            "source": r.get("source") or r.get("provider"),
            "attribution": r.get("attribution"),
            "duration": real,
            "query": query,
            "fetched": time.strftime("%Y-%m-%d"),
            "via": "Openverse API",
        }
        _sidecar(dest).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        got.append({"file": str(dest), **meta})
    return got


SYNTH = {
    # name: (filter graph producing [a], seconds)
    "whoosh_1": ("anoisesrc=d=0.7:c=pink:a=0.7,highpass=f=250,lowpass=f=3800,afade=t=in:d=0.42:curve=qsin,afade=t=out:st=0.42:d=0.28:curve=exp", 0.7),
    "whoosh_2": ("anoisesrc=d=0.6:c=pink:a=0.7,highpass=f=400,lowpass=f=6000,afade=t=in:d=0.36:curve=qsin,afade=t=out:st=0.36:d=0.24:curve=exp", 0.6),
    "whoosh_3": ("anoisesrc=d=0.8:c=brown:a=0.9,highpass=f=150,lowpass=f=2600,afade=t=in:d=0.5:curve=qsin,afade=t=out:st=0.5:d=0.3:curve=exp", 0.8),
    "riser": ("anoisesrc=d=1.2:c=white:a=0.25,highpass=f=900,afade=t=in:d=1.15:curve=exp[n];"
              "aevalsrc='0.25*sin(2*PI*(180*t+260*t*t))':d=1.2:s=48000,afade=t=in:d=1.15:curve=exp[s];"
              "[n][s]amix=inputs=2:normalize=0", 1.2),
    "hit": ("aevalsrc='0.8*sin(2*PI*55*t)*exp(-4.5*t)+0.25*sin(2*PI*110*t)*exp(-7*t)':d=1.6:s=48000,lowpass=f=900", 1.6),
}


def synth() -> list[str]:
    """Make the house effects. Made here from noise and sine waves: no third-party rights."""
    folder = LIB / "sfx"
    folder.mkdir(parents=True, exist_ok=True)
    made = []
    for name, (graph, sec) in SYNTH.items():
        dest = folder / f"synth_{name}.wav"
        if not dest.exists():
            subprocess.run(
                [str(ffmpeg_bin()), "-y", "-filter_complex", f"{graph},aformat=sample_rates=48000:channel_layouts=stereo[a]",
                 "-map", "[a]", "-t", f"{sec}", str(dest)],
                check=True, capture_output=True, timeout=60,
            )
            meta = {"kind": "sfx", "title": name.replace("_", " "), "creator": "Tsumagoi Studio (synthesised)", "license": "OWN",
                    "licenseUrl": None, "landing": None, "source": "ffmpeg lavfi", "duration": sec, "query": name, "via": "made locally"}
            _sidecar(dest).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        made.append(str(dest))
    return made


def library() -> list[dict]:
    """Every music and effect file with its licence record, music first."""
    out = []
    for kind in ("music", "sfx"):
        for path in sorted((LIB / kind).glob("*")) if (LIB / kind).exists() else []:
            if path.suffix.lower() not in AUDIO_EXT:
                continue
            side = _sidecar(path)
            meta = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {"title": path.stem, "license": "UNKNOWN"}
            out.append({"id": path.name, "file": str(path), "kind": kind, **meta})
    return out


def lead_in(track: dict) -> float:
    """Seconds of near-silence at the top of a track (cached in its sidecar). The hook starts on sound."""
    if "lead" in track:
        return float(track["lead"])
    proc = subprocess.run(
        [str(ffmpeg_bin()), "-hide_banner", "-t", "15", "-i", track["file"], "-af", "silencedetect=n=-40dB:d=0.2", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
    )
    lead = 0.0
    lines = proc.stderr.splitlines()
    starts = [ln for ln in lines if "silence_start: 0" in ln or "silence_start: -0" in ln]
    if starts:
        ends = [ln for ln in lines if "silence_end:" in ln]
        if ends:
            lead = round(float(ends[0].split("silence_end:")[1].split("|")[0]), 2)
    side = _sidecar(Path(track["file"]))
    if side.exists():
        meta = json.loads(side.read_text(encoding="utf-8"))
        meta["lead"] = lead
        side.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return lead


def _mood_of(reel: dict) -> str:
    slug = reel["slug"]
    key = reel.get("theme") or slug.split("-")[0]
    return MOOD.get(key, "ambient cinematic")


def track_beats(path: str) -> list[float]:
    """Beat times in seconds, cached in the licence sidecar. Empty when the track has no pulse."""
    side = _sidecar(Path(path))
    if side.exists():
        meta = json.loads(side.read_text(encoding="utf-8"))
        if "beats" in meta:
            return [float(b) for b in meta["beats"]]
    else:
        meta = {}
    try:
        import librosa

        samples, rate = librosa.load(path, sr=22050, mono=True)
        _, frames = librosa.beat.beat_track(y=samples, sr=rate)
        times = [round(float(t), 3) for t in librosa.frames_to_time(frames, sr=rate)[:80]]
    except Exception:
        times = []
    if side.exists() or meta:
        meta["beats"] = times
        side.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return times


def fit_cuts(beats: list[float], n: int, grid: float = 0.5, rng=None) -> list[float] | None:
    """n shot lengths on the grid whose cuts land on musical beats.

    Each length is 1 to 3 seconds. The total stays inside 8 to 25 seconds.
    Returns None when the track has too few beats to follow.
    With `rng`, each cut picks among the lengths that land on a beat (not always the shortest), and one shot in the
    middle holds longer, so two reels on the same track do not share one rhythm (an even, template rhythm is the
    clearest sign of a machine edit: docs/research/2026-11-10-multilayer-editing.md).
    """
    marks = sorted(b for b in beats if b >= grid)
    if len(marks) < 4 or n < 4:
        return None
    hold = rng.randrange(2, n - 1) if rng is not None and n > 4 else None
    cuts = [0.0]
    while len(cuts) <= n:
        t = cuts[-1]
        options = []
        for step in (1.0, 1.5, 2.0, 2.5, 3.0):
            nxt = round((t + step) / grid) * grid
            options.append((min(abs(nxt - b) for b in marks), nxt, step))
        best = min(options)[:2]
        if rng is not None:
            on_beat = [o for o in options if o[0] <= grid / 4]
            if len(cuts) - 1 == hold:
                on_beat = [o for o in on_beat if o[2] >= 2.5] or on_beat
            elif on_beat:
                on_beat = [o for o in on_beat if o[2] <= 2.0] or on_beat
            if on_beat:
                best = rng.choice(on_beat)[:2]
        dist, nxt = best
        if dist > grid / 2:
            nxt = round((t + 1.5) / grid) * grid
        if nxt <= t:
            nxt = t + grid
        cuts.append(round(nxt, 2))
        if cuts[-1] > 25:
            return None
    lengths = [round(cuts[i + 1] - cuts[i], 2) for i in range(n)]
    total = round(sum(lengths), 2)
    if not 8 <= total <= 25 or any(step < grid or abs(step / grid - round(step / grid)) > 1e-6 for step in lengths):
        return None
    return lengths


def choose_music(reel: dict, seconds: float) -> dict | None:
    """The reel's bed. reel["music"]: None / "off" = none, {"id": ...} = that track, "auto" or missing = picked."""
    choice = reel.get("music", "auto")
    if choice in (None, "off", False):
        return None
    tracks = [t for t in library() if t["kind"] == "music" and t.get("license") in ("CC0", "PDM")]
    if isinstance(choice, dict) and choice.get("id"):
        # A bed made for one reel by studio.ai (sidecar "ai": true) is used only when that reel names it; never auto-picked.
        made = [t for t in library() if t["kind"] == "music" and t.get("ai") is True and t.get("license") == "AI-GENERATED"]
        hit = next((t for t in tracks + made if t["id"] == choice["id"]), None)
        if not hit:
            return None
        start = choice.get("start")
        return {**hit, "start": float(lead_in(hit) if start is None else start), "volume": float(choice.get("volume", 1.0))}
    if not tracks:
        return None
    mood = _mood_of(reel)
    fits = [t for t in tracks if t.get("query") == mood and t.get("duration", 0) >= seconds + 1] or \
           [t for t in tracks if t.get("duration", 0) >= seconds + 1] or tracks
    pick = fits[int(hashlib.sha1(reel["slug"].encode()).hexdigest(), 16) % len(fits)]
    return {**pick, "start": lead_in(pick), "volume": 1.0}


def sfx_plan(reel: dict) -> list[dict]:
    """Few, quiet hits: a whoosh into each caption line (peaking on its cut), a riser into
    the end card and a soft hit on it. reel["sfx"] = False turns them off."""
    if reel.get("sfx") is False:
        return []
    have = {p.stem.replace("synth_", ""): p for p in (LIB / "sfx").glob("synth_*.wav")} if (LIB / "sfx").exists() else {}
    if not have:
        synth()
        have = {p.stem.replace("synth_", ""): p for p in (LIB / "sfx").glob("synth_*.wav")}
    plan = []
    whooshes = sorted(k for k in have if k.startswith("whoosh"))
    lines = [b for b in reel["beats"] if b["kind"] == "line"][:3]
    for k, b in enumerate(lines):
        name = whooshes[k % len(whooshes)]
        plan.append({"name": name, "file": str(have[name]), "at": round(max(0.0, b["startSec"] - 0.1 - 0.42), 2), "gain": 0.32})
    end = next((b for b in reel["beats"] if b["kind"] == "end"), None)
    if end:
        plan.append({"name": "riser", "file": str(have["riser"]), "at": round(max(0.0, end["startSec"] - 1.2), 2), "gain": 0.28})
        plan.append({"name": "hit", "file": str(have["hit"]), "at": round(end["startSec"], 2), "gain": 0.5})
    return plan


def _has_audio(path: Path) -> bool:
    probe = subprocess.run(
        [str(ffprobe_bin()), "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    return bool((probe.stdout or "").strip())


PEAK_SAFE = -1.3  # dBTP a finished mix must stay under (the QA gate allows -1.0; AAC adds a few tenths)


def _measure(path: Path) -> dict:
    from studio.verify import parse_ebur128

    err = subprocess.run([str(ffmpeg_bin()), "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0?", "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900).stderr
    return parse_ebur128(err)


def _regain(path: Path, af: str) -> bool:
    tmp = path.with_name(path.stem + "_level" + path.suffix)
    proc = subprocess.run([str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:v:0?", "-map", "0:a:0", "-c:v", "copy",
                           "-af", af, "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-map_metadata", "-1", str(tmp)], capture_output=True, timeout=900)
    if proc.returncode:
        tmp.unlink(missing_ok=True)
        return False
    from studio.held import replace

    replace(tmp, path)  # a player or scan may hold the file for a moment
    return True


def trim_loudness(path: Path, target: float, tolerance: float = 0.5) -> float:
    """One-pass loudnorm lands 1-2 LU off its target, and its true-peak limit is not kept after the AAC encode (the QA
    gate, studio.verify, measured -0.7 dBTP on long films mixed for -2.5). Measure the finished mix; when its level is
    more than `tolerance` off or its true peak is over PEAK_SAFE, make it again from the sound as it was, in one pass:
    the gain onto the level, then a limiter run at 4x the sample rate (so it sees the peaks between samples). Still over
    after the encode: once more from the same sound with a lower limit. Every try starts from the original, never from
    a re-encode (fire crackle went from -1.0 to +0.8 dBTP over three encodes of plain gain). The picture is copied.
    Returns the gain applied in dB (0.0 when nothing was needed or the mix could not be measured)."""
    import shutil

    m = _measure(path)
    lufs, tp = m.get("lufs"), m.get("truePeak")
    if lufs is None or (abs(target - lufs) <= tolerance and (tp is None or tp <= PEAK_SAFE)):
        return 0.0
    gain = round(max(-12.0, min(12.0, target - lufs)), 2) if abs(target - lufs) > tolerance else 0.0
    src = path.with_name(path.stem + "_src" + path.suffix)
    shutil.copy2(path, src)
    best = None
    try:
        for limit_db in (-2.0, -3.0, -4.0, -5.5):
            af = (f"volume={gain}dB,aresample=192000,alimiter=limit={10 ** (limit_db / 20):.4f}:attack=1:release=60:level=disabled,"
                  "aresample=48000")
            out = path.with_name(path.stem + "_try" + path.suffix)
            proc = subprocess.run([str(ffmpeg_bin()), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-map", "0:v:0?", "-map", "0:a:0", "-c:v", "copy",
                                   "-af", af, "-c:a", "aac", "-ar", "48000", "-b:a", "256k", "-map_metadata", "-1", str(out)], capture_output=True, timeout=900)
            if proc.returncode:
                out.unlink(missing_ok=True)
                break
            got = _measure(out)
            ok = got.get("truePeak") is None or got["truePeak"] <= PEAK_SAFE
            if best is None or ok or (got.get("truePeak") or 99) < (best[1].get("truePeak") or 99):
                if best:
                    best[0].unlink(missing_ok=True)
                keep = path.with_name(path.stem + f"_best{abs(int(limit_db * 10))}" + path.suffix)
                out.replace(keep)
                best = (keep, got)
            else:
                out.unlink(missing_ok=True)
            if ok:
                break
        if best is None:
            return 0.0
        new_tp, new_lufs = best[1].get("truePeak"), best[1].get("lufs") or lufs
        if tp is not None and tp > PEAK_SAFE:  # it clipped: a cure wins even if limiting it costs some level
            better = new_tp is not None and new_tp <= PEAK_SAFE
        else:  # only the level was off: closer to it, and no new peak over the line
            better = abs(target - new_lufs) < abs(target - lufs) and (new_tp is None or new_tp <= PEAK_SAFE)
        if not better:  # never leave it worse than it was
            best[0].unlink(missing_ok=True)
            return 0.0
        from studio.held import replace

        replace(best[0], path)  # a player or scan may hold the file for a moment
        return round((best[1].get("lufs") or lufs) - lufs, 2)
    finally:
        src.unlink(missing_ok=True)
        for extra in path.parent.glob(path.stem + "_best*" + path.suffix):
            extra.unlink(missing_ok=True)


def mix(video: Path, dest: Path, seconds: float, music: dict | None, sfx: list[dict], voice: dict | None = None,
        foley: list[dict] | None = None, peak: float = -1.5, duck: tuple[float, float] = (0.05, 4.0)) -> dict:
    """Picture copied from `video`; sound = clip + ducked music + effects, loudness-normalised.
    `voice` (studio.ai): {"lines": [{"file", "at", "tempo"}], "gain"}: a read-aloud track over the rest; music and
    clip sound dip under it. Without a voice the filter graph is exactly the one before voices existed.
    `duck`: (threshold, ratio) of the music's dip under the clip's own sound. A long video passes a higher threshold
    so the music dips for speech, not for every breeze or bird (its windy stretches are already turned down)."""
    lines = [v for v in ((voice or {}).get("lines") or []) if Path(str(v.get("file", ""))).exists()]
    level = SPEC["loudnessLufs"]
    ff = str(ffmpeg_bin())
    inputs = ["-i", str(video)]
    graph = []
    if _has_audio(video):
        graph.append(f"[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{seconds:.3f}[clip0]")
    else:
        graph.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{seconds:.3f}[clip0]")
    n = 1
    # Natural sound made for silent shots (studio.ai foley): laid into the clip track at each shot's place, with short
    # fades, so it ducks under a voice and lifts the music's ducking exactly like the clip's own sound.
    fol = [f for f in (foley or []) if Path(str(f.get("file", ""))).exists()]
    if fol:
        graph[-1] = graph[-1].replace("[clip0]", "[cliprw]")
        parts = ["[cliprw]"]
        for f in fol:
            inputs += ["-i", str(f["file"])]
            ms, sec = int(float(f["at"]) * 1000), float(f["seconds"])
            graph.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{sec:.3f},afade=t=in:d=0.12,"
                         f"afade=t=out:st={max(0.0, sec - 0.25):.3f}:d=0.25,volume={float(f.get('gain', 0.8)):.2f},adelay={ms}|{ms}[fo{n}]")
            parts.append(f"[fo{n}]")
            n += 1
        graph.append(f"{''.join(parts)}amix=inputs={len(parts)}:duration=first:normalize=0[clip0]")
    graph.append("[clip0]asplit=2[clip][key]")
    mixes = ["[clip]"]
    if lines:
        gain = float((voice or {}).get("gain", 1.0))
        parts = []
        for v in lines:
            inputs += ["-i", str(v["file"])]
            ms = int(float(v["at"]) * 1000)
            tempo = min(2.0, max(0.5, float(v.get("tempo", 1.0))))
            graph.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,atempo={tempo:.3f},volume={gain:.2f},adelay={ms}|{ms}[vl{n}]")
            parts.append(f"[vl{n}]")
            n += 1
        graph.append(f"{''.join(parts)}amix=inputs={len(parts)}:duration=longest:normalize=0,apad,atrim=0:{seconds:.3f},asplit=3[vo][vokey][vokey2]")
        # The clip's own sound dips under the voice; the music (below) dips under clip and voice together.
        graph[graph.index("[clip0]asplit=2[clip][key]")] = "[clip0]asplit=2[clipv][key]"
        graph.append("[clipv][vokey2]sidechaincompress=threshold=0.02:ratio=3:attack=20:release=300[clip]")
        graph.append("[key][vokey]amix=inputs=2:normalize=0[key2]" if music else "[key][vokey]amix=inputs=2:normalize=0,anullsink")
        mixes.append("[vo]")
    if music:
        inputs += ["-stream_loop", "-1", "-i", music["file"]]
        fade_out = max(0.0, seconds - 1.6)
        graph.append(
            f"[{n}:a]atrim=start={music.get('start', 0):.2f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
            f"atrim=0:{seconds:.3f},loudnorm=I=-21:TP=-3:LRA=9,volume={music.get('volume', 1.0):.2f},"
            f"afade=t=in:d=0.12,afade=t=out:st={fade_out:.2f}:d=1.5[mus]"
        )
        # Auto-ducking: the music dips when the clip itself has something to say (and deeper under a voice).
        if lines:
            graph.append("[mus][key2]sidechaincompress=threshold=0.03:ratio=8:attack=30:release=500[duck]")
        else:
            graph.append(f"[mus][key]sidechaincompress=threshold={duck[0]:g}:ratio={duck[1]:g}:attack=60:release=450[duck]")
        mixes.append("[duck]")
        n += 1
    elif not lines:
        graph.append("[key]anullsink")
    for s in sfx:
        inputs += ["-i", s["file"]]
        ms = int(s["at"] * 1000)
        graph.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,volume={s['gain']:.2f},adelay={ms}|{ms}[fx{n}]")
        mixes.append(f"[fx{n}]")
        n += 1
    graph.append(
        f"{''.join(mixes)}amix=inputs={len(mixes)}:duration=first:normalize=0,"
        f"loudnorm=I={level}:TP={peak}:LRA=11,atrim=0:{seconds:.3f}[out]"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ff, "-y", *inputs, "-filter_complex", ";".join(graph), "-map", "0:v", "-map", "[out]",
           "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-map_metadata", "-1", "-shortest", str(dest)]
    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[-1500:])
    trim_loudness(dest, level)
    out = {
        "music": {k: music.get(k) for k in ("id", "title", "creator", "license", "licenseUrl", "landing", "source", "start", "volume")} if music else None,
        "sfx": [{"name": s["name"], "at": s["at"]} for s in sfx],
    }
    if music and music.get("ai"):
        out["music"].update(ai=True, licenceNote=music.get("licenceNote"))
    if lines:
        out["voice"] = {"ai": True, "model": (voice or {}).get("model"), "voiceId": (voice or {}).get("voiceId"), "lines": len(lines)}
    if fol:
        out["foley"] = {"ai": True, "model": "fal-ai/mmaudio-v2", "shots": len(fol)}
    return out


def credits(audio: dict) -> str:
    """Plain-text record kept beside each delivery, even when CC0 asks for none."""
    lines = ["Sound in this video", ""]
    m = audio.get("music")
    if m:
        lines += [f"Music: \"{m['title']}\" by {m['creator']}", f"Licence: {m['license']} {m.get('licenseUrl') or ''}".rstrip(),
                  f"Source: {m.get('landing') or m.get('source') or ''}", ""]
    else:
        lines += ["Music: none (clip sound only)", ""]
    if m and m.get("licenceNote"):
        lines += [m["licenceNote"], ""]
    if audio.get("foley"):
        lines.append(f"Natural sound: AI-made ambience for {audio['foley']['shots']} silent shot(s) (MMAudio V2 via fal.ai), from the shots' own picture.")
    if audio.get("voice"):
        v = audio["voice"]
        lines += [f"Voice: AI-generated Japanese voice ({v.get('model')}, {v.get('voiceId')}) reading the reel's approved words.",
                  "Label it as AI-made content where the platform asks.", ""]
    if audio.get("sfx"):
        lines += ["Effects: whoosh / riser / hit synthesised locally by Tsumagoi Studio (no third-party rights)."]
    lines += ["", "Instagram / TikTok: a *_no-music.mp4 is included if you add trending audio in the app."]
    return "\n".join(lines) + "\n"
