/**
 * FILE: server/health.mjs
 * PURPOSE: Can this computer run the studio, how long will a reel take, and is the server current?
 * OVERVIEW: Pure rules (`judgeSystem`, `checkCpu`, `checkRam`, `medianSeconds`, `etaSeconds`, `buildId`), the one
 *           ffmpeg rule (`resolveTool`, `parseFfmpegVersion`, `MIN_FFMPEG`; py/studio/config.py follows the same), plus
 *           the few probes that read the machine (`freeDiskBytes`, `probeEncoders`, `folderBytes`, `ffmpegStatus`).
 *           scripts/build-packages.mjs copies this file into the npm package, where `npx lazycow doctor` reuses it.
 *           review.mjs serves the result at /api/health; the page adds the browser's own
 *           checks (screen, GPU, video decode) and shows one verdict: ok, slow or blocked.
 * DEPENDENCIES: node:os, node:fs, node:crypto, node:child_process
 * USAGE: import { systemReport } from "./health.mjs"
 * NOTES: Thresholds come from measured runs: a 9-clip reel renders in 4.7-9 min on a
 *        32-thread desktop (renders/jobs.jsonl, 2026-11-08), CLIP plus ffmpeg peak near 4 GB,
 *        and one reel folder holds every size and network package (about 0.3-0.6 GB).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, posix, win32 } from "node:path";
import os from "node:os";

const GB = 1024 ** 3;

/** Minimums. Below `slow` the studio works but warns; below `min` it refuses heavy work. */
export const LIMITS = {
  threads: { min: 4, slow: 8 },
  ramGb: { min: 6, slow: 12 },
  diskGb: { min: 3, slow: 20 },
};

/* ---------- ffmpeg: one rule, here and in py/studio/config.py (ffmpeg_bin, ffprobe_bin) ---------- */

/**
 * The oldest ffmpeg the studio runs on. Two things in the code set it, and a 2021 build fails both:
 * - `-fps_mode` (py/studio/pick.py frame sampling) first shipped in 5.1 (fftools/ffmpeg_opt.c; absent in 5.0):
 *   "Unrecognized option 'fps_mode'".
 * - `sidechaincompress` fed two different audio formats (py/studio/sound.py ducking under a voice or the clip sound)
 *   negotiates them only since 5.0's rewrite of that filter; 4.4 says "could not choose their formats".
 * Debian 12 (5.1), Ubuntu 24.04 (6.1) and Homebrew pass; Ubuntu 22.04 (4.4) does not.
 */
export const MIN_FFMPEG = { major: 5, minor: 1 };

/* libavcodec version of each release, for builds that print a date or a git hash ("N-1234-g…") instead of a number. */
const LAVC = [[62, 11, 8, 0], [61, 19, 7, 1], [61, 3, 7, 0], [60, 31, 6, 1], [60, 3, 6, 0], [59, 37, 5, 1], [59, 18, 5, 0],
  [58, 134, 4, 4], [58, 91, 4, 3], [58, 54, 4, 2], [58, 35, 4, 1], [58, 18, 4, 0]];

/**
 * The version in `ffmpeg -version` (or `ffprobe -version`) output: { major, minor, text, approx } or null.
 * Release builds say it ("7.1.1", "6.1.1-3ubuntu5", "n7.1-2-g…", "9.0.2-essentials_build-www.gyan.dev"); git builds
 * ("2021-06-23-git-…", "N-128532-g…") only say their libavcodec, which is mapped to the release it follows.
 */
export function parseFfmpegVersion(text) {
  const s = String(text || "");
  const raw = /\bff(?:mpeg|probe) version\s+(\S+)/i.exec(s)?.[1] || "";
  const rel = /^n?(\d{1,2})\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (rel) return { major: +rel[1], minor: +rel[2], text: `${rel[1]}.${rel[2]}${rel[3] ? `.${rel[3]}` : ""}`, approx: false };
  const lavc = /libavcodec\s+(\d+)\.\s*(\d+)\./.exec(s);
  if (!lavc) return null;
  const [maj, min] = [+lavc[1], +lavc[2]];
  if (maj > LAVC[0][0]) return { major: maj - 54, minor: 0, text: `${maj - 54}.x (git build)`, approx: true };
  const row = LAVC.find(([a, b]) => maj > a || (maj === a && min >= b));
  if (!row) return { major: 3, minor: 0, text: "older than 4.0 (git build)", approx: true };
  return { major: row[2], minor: row[3], text: `${row[2]}.${row[3]} (git build)`, approx: true };
}

/** True when version `v` is older than `min`. An unreadable version counts as too old: it is never used silently. */
export function versionTooOld(v, min = MIN_FFMPEG) {
  if (!v) return true;
  return v.major < min.major || (v.major === min.major && v.minor < min.minor);
}

/** First `exe` on PATH (no shell, no spawn), or "". Everything is injectable for tests. */
export function whichSync(exe, { path = process.env.PATH || process.env.Path || "", platform = process.platform, exists = existsSync } = {}) {
  const P = platform === "win32" ? win32 : posix;
  for (const dir of path.split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const p = P.join(dir.replace(/^"|"$/g, ""), exe);
    if (exists(p)) return p;
  }
  return "";
}

/** `<exe> -version` output, or "" when it does not run. */
export function runVersion(exe) {
  try {
    const r = spawnSync(exe, ["-version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    return r.status === 0 ? r.stdout || "" : "";
  } catch { return ""; }
}

/**
 * Where the studio finds ffmpeg or ffprobe. The one rule (py/studio/config.py `_resolve_tool` is the same):
 *   1. STUDIO_FFMPEG / STUDIO_FFPROBE when set (your choice, used as it is);
 *   2. the studio tools folder (STUDIO_TOOLS, else <data>/bin): ffmpeg.exe on Windows, ffmpeg elsewhere;
 *   3. PATH, only when its version is MIN_FFMPEG or newer. An older one is reported (`tooOld`), never used silently.
 * Pure apart from its defaults: `exists`, `which` and `run` are injected by the tests, so they need no ffmpeg.
 * @returns {{ name: string, path: string|null, source: "env"|"tools"|"path"|null, found: boolean, version: string|null,
 *             tooOld: boolean, usable: boolean, toolsDir: string }}
 */
export function resolveTool(name, { env = process.env, toolsDir = "", platform = process.platform, exists = existsSync,
  which = (exe) => whichSync(exe, { platform, exists }), run = runVersion, min = MIN_FFMPEG } = {}) {
  const exe = platform === "win32" ? `${name}.exe` : name;
  const out = (path, source, extra = {}) => {
    const r = { name, path, source, found: !!path, version: null, tooOld: false, toolsDir, ...extra };
    return { ...r, usable: r.found && !r.tooOld };
  };
  const chosen = String(env?.[`STUDIO_${name.toUpperCase()}`] || "").trim();
  if (chosen) return remember(out(chosen, "env", { found: exists(chosen) || (!/[\\/]/.test(chosen) && !!which(chosen)) }));
  if (toolsDir) {
    const local = (platform === "win32" ? win32 : posix).join(toolsDir, exe);
    if (exists(local)) return remember(out(local, "tools"));
  }
  const onPath = which(exe);
  if (!onPath) return out(null, null);
  const v = parseFfmpegVersion(run(onPath));
  return remember(out(onPath, "path", { version: v?.text ?? null, tooOld: versionTooOld(v, min) }));
}

/* What resolveTool last said about each path, so systemFacts can tell a PATH ffmpeg from the tools folder's. */
const RESOLVED = new Map();
function remember(r) { if (r.path) RESOLVED.set(r.path, r); return r; }

export const minFfmpegText = (min = MIN_FFMPEG) => `${min.major}.${min.minor}`;

/** What to do about a missing or too-old ffmpeg, in this computer's own terms. `tool` is a resolveTool result. */
export function ffmpegFix(platform = process.platform, toolsDir = "", tool = null) {
  const where = toolsDir || "the studio's tools folder";
  const old = tool?.tooOld ? `The ${tool.name || "ffmpeg"} on PATH (${tool.path}, version ${tool.version || "unknown"}) is older than ${minFfmpegText()}, which the studio needs. ` : "";
  if (platform === "win32") {
    return `${old}Run the setup again (double-click "Start Lazycow"): it downloads a current ffmpeg into the studio's tools folder (${where}). `
      + `Or set STUDIO_FFMPEG and STUDIO_FFPROBE to an ffmpeg ${minFfmpegText()} or newer.`;
  }
  if (platform === "darwin") {
    return `${old}Install a current one with: brew install ffmpeg. Or run the setup again ("Start Lazycow"): it downloads ffmpeg into ${where}.`;
  }
  return `${old}Install ffmpeg ${minFfmpegText()} or newer from your distribution (Debian 12, Ubuntu 24.04 and newer: sudo apt install ffmpeg), `
    + `or put a static build of ffmpeg and ffprobe (https://johnvansickle.com/ffmpeg/) in ${where}.`;
}

const statusCache = new Map();
/** Is this ffmpeg there, which version is it, and is it too old? Runs `-version` once per path (again if the file changes). */
export function ffmpegStatus(path, { run = runVersion } = {}) {
  const none = { found: false, version: null, tooOld: false };
  if (!path) return none;
  let stamp = "path";
  if (/[\\/]/.test(path)) { try { stamp = String(statSync(path).mtimeMs); } catch { return none; } }
  const hit = statusCache.get(path);
  if (hit && hit.stamp === stamp) return hit.result;
  const text = run(path);
  const v = parseFfmpegVersion(text);
  const result = { found: !!text, version: v?.text ?? null, tooOld: !!text && versionTooOld(v) };
  statusCache.set(path, { stamp, result });
  return result;
}

/** One short fingerprint of the files the running server serves, so a stale server can tell. */
export function buildId(paths) {
  const h = createHash("sha1");
  for (const p of paths) h.update(existsSync(p) ? readFileSync(p) : `missing:${p}`);
  return h.digest("hex").slice(0, 10);
}

/** Free bytes on the drive holding `path`, or null when the OS will not say. */
export function freeDiskBytes(path) {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

/** Bytes under a folder, depth-limited so a huge tree cannot stall the server. */
export function folderBytes(dir, depth = 3) {
  let total = 0;
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isFile()) total += statSync(p).size;
      else if (ent.isDirectory() && depth > 0) total += folderBytes(p, depth - 1);
    }
  } catch { /* unreadable folders count as empty */ }
  return total;
}

/** Hardware H.264 encoders this ffmpeg build offers (informational: renders use libx264 today). */
export function probeEncoders(ffmpeg) {
  if (!ffmpeg || (/[\\/]/.test(ffmpeg) && !existsSync(ffmpeg))) return { ffmpeg: false, hardware: [] };
  const r = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (r.error) return { ffmpeg: false, hardware: [] };
  const text = r.stdout || "";
  const hardware = [["h264_nvenc", "NVIDIA"], ["h264_amf", "AMD"], ["h264_qsv", "Intel"], ["h264_videotoolbox", "Apple"]]
    .filter(([name]) => text.includes(name)).map(([, vendor]) => vendor);
  return { ffmpeg: r.status === 0, hardware };
}

/** Median seconds of finished jobs of one kind, from jobs.jsonl lines. */
export function medianSeconds(rows, kind) {
  const xs = rows.filter((r) => r.kind === kind && r.status === "done" && Number.isFinite(r.seconds) && r.seconds > 0)
    .map((r) => r.seconds).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/** Seconds left for a running job: history first, progress once the job is past its typical length. */
export function etaSeconds({ elapsed, pct, typical }) {
  const byPct = pct >= 8 && pct < 100 ? Math.round(elapsed * (100 - pct) / pct) : null;
  if (typical && elapsed < typical) {
    const byHistory = typical - elapsed;
    return byPct == null ? Math.round(byHistory) : Math.round((byHistory + byPct) / 2);
  }
  return byPct ?? (typical ? 30 : null);
}

/** A rough reel time for a machine with no history yet: the measured desktop time scaled by threads. */
export function guessBuildSeconds(threads) {
  return Math.round(400 * Math.max(1, 32 / Math.max(1, threads)) ** 0.7);
}

const level = (value, { min, slow }) => (value == null ? "unknown" : value < min ? "blocked" : value < slow ? "slow" : "ok");
const WORST = ["ok", "unknown", "slow", "blocked"];
const worst = (levels) => levels.reduce((a, b) => (WORST.indexOf(b) > WORST.indexOf(a) ? b : a), "ok");

/** The processor check, shared with `npx lazycow doctor` (packages/lazycow/lib/doctor.mjs). */
export function checkCpu(threads, cpuModel = "") {
  const t = threads;
  return { id: "cpu", level: level(t, LIMITS.threads), label: "Processor", found: `${t} threads${cpuModel ? ` · ${cpuModel}` : ""}`,
    fix: t < LIMITS.threads.min ? "Rendering would take well over half an hour a reel. Use a computer with at least 4 cores / 8 threads."
      : t < LIMITS.threads.slow ? "Reels render, slowly. Close other heavy apps while the studio renders." : "" };
}

/** The memory check, shared with `npx lazycow doctor`. `freeRamGb` is optional. */
export function checkRam(ramGb, freeRamGb = null) {
  const ram = ramGb;
  return { id: "ram", level: level(ram, LIMITS.ramGb), label: "Memory",
    found: `${ram.toFixed(0)} GB${freeRamGb == null ? "" : ` (${freeRamGb.toFixed(1)} GB free now)`}`,
    fix: ram < LIMITS.ramGb.min ? "The footage search and the renderer need about 4 GB together. Use a computer with 8 GB or more."
      : ram < LIMITS.ramGb.slow ? "Close browser tabs and other apps before making several reels at once." : "" };
}

/** The setup that makes the studio's Python, named the way this computer starts it. */
function pythonFix(platform) {
  if (platform === "win32") return "Run the setup again (double-click \"Start Lazycow\"): it makes the Python environment the studio needs.";
  if (platform === "darwin") return "Run the setup again (double-click \"Start Lazycow\", or: bash scripts/bootstrap/mac.sh): it makes the Python environment the studio needs.";
  return "Run npm run setup in the studio folder: it makes the Python environment (data/venv) the studio needs.";
}

/**
 * The verdict for this machine. Every check says what it found and, when it is not ok,
 * what to do about it, in words a person who is not an engineer can act on, for this computer's system (`s.os`).
 */
export function judgeSystem(s) {
  const checks = [];
  const add = (id, lvl, label, found, fix = "") => checks.push({ id, level: lvl, label, found, fix });
  const platform = s.os || process.platform;

  checks.push(checkCpu(s.threads, s.cpuModel));
  checks.push(checkRam(s.ramGb, s.freeRamGb));

  const disk = s.diskFreeGb;
  const reels = disk != null && s.reelGb ? Math.floor(disk / s.reelGb) : null;
  add("disk", level(disk, LIMITS.diskGb), "Free space for renders",
    disk == null ? "unknown" : `${disk.toFixed(1)} GB free${reels != null ? ` · room for about ${reels} more reels` : ""}`,
    disk != null && disk < LIMITS.diskGb.min ? `New renders are paused. Free space on the drive holding ${s.dataDir}, or point STUDIO_DATA at a bigger drive.`
      : disk != null && disk < LIMITS.diskGb.slow ? "Space is getting short. Delete old drafts you will not post." : "");

  add("python", s.python ? "ok" : "blocked", "Studio engine (Python)", s.python ? "found" : "missing", s.python ? "" : pythonFix(platform));

  // ffmpeg: missing, or found but older than MIN_FFMPEG (a PATH ffmpeg from years ago fails half the renders), blocks.
  const ff = s.ffmpegInfo || {};
  const ffOk = !!s.ffmpeg && !ff.tooOld;
  const ffWhere = ff.source === "path" ? " on PATH" : ff.source === "env" ? " (STUDIO_FFMPEG)" : "";
  add("ffmpeg", ffOk ? "ok" : "blocked", "Video tools (ffmpeg)",
    !s.ffmpeg ? "missing" : ff.version ? `${ff.version}${ffWhere}${ff.tooOld ? ` · older than ${minFfmpegText()}` : ""}` : "found",
    ffOk ? "" : ffmpegFix(platform, s.toolsDir, ff.tooOld ? { ...ff, tooOld: true, path: ff.path || "ffmpeg" } : null));

  add("data", s.dataWritable ? "ok" : "blocked", "Studio data folder", s.dataWritable ? "found" : "missing",
    s.dataWritable ? "" : `STUDIO_DATA must exist and be writable${s.dataDir ? ` (now ${s.dataDir})` : ""}. Set it in the .env file in the studio folder.`);

  add("media", s.mediaReachable ? "ok" : "slow", "Footage folder",
    s.mediaReachable ? "reachable" : "not reachable", s.mediaReachable ? ""
      : `${platform === "linux" ? "Is the drive or network share holding your footage mounted?" : "Is Google Drive (or the drive holding your footage) running and signed in?"} Reels can still be edited; new footage cannot be read.`);

  // A stopped helper is a hiccup (it restarts on the next search), not a computer that is too weak: never "blocked".
  const venvPy = platform === "win32" ? "venv\\Scripts\\python.exe" : "venv/bin/python";
  add("helper", s.helper === "ready" ? "ok" : s.helper === "starting" ? "unknown" : "slow", "Footage search",
    s.helper === "ready" ? "loaded" : s.helper === "starting" ? "loading the model (about 20 s after start)" : `stopped${s.helperError ? `: ${s.helperError}` : ""}`,
    s.helper === "down" ? `It restarts by itself on the next search. If it keeps stopping, run the studio's Python (${venvPy} in the data folder) with -m studio service, from the py folder, to see why.` : "");

  add("gpu", "ok", "Video encoding", `on the processor (x264)${s.hardware?.length ? ` · this ffmpeg could also use ${s.hardware.join(" / ")} graphics encoders` : ""}`,
    "");

  // `verdict` is about the computer (can it render at all, how fast); `service` is about what is running
  // right now (Drive mounted, search helper up). A crashed helper must never read as "your PC is too weak".
  const MACHINE = ["cpu", "ram", "disk", "python", "ffmpeg", "data"];
  const verdict = worst(checks.filter((c) => MACHINE.includes(c.id)).map((c) => c.level));
  const service = worst(checks.filter((c) => c.id === "media" || c.id === "helper").map((c) => c.level));
  return { verdict, service, checks, buildSeconds: s.buildSeconds, buildSecondsSource: s.buildSecondsSource };
}

/** Gather the facts `judgeSystem` needs. Cheap enough to call every few seconds except `reelGb` (cached by the caller). */
export function systemFacts({ dataDir, mediaDir, python, ffmpeg, toolsDir, helper, helperError, encoders, reelGb, history }) {
  const cpus = os.cpus();
  const threads = cpus.length || 1;
  const free = freeDiskBytes(dataDir);
  const typical = medianSeconds(history, "build");
  let dataWritable = false;
  try { dataWritable = statSync(dataDir).isDirectory(); } catch { dataWritable = false; }
  // `ffmpeg` is a path (or a bare name found on PATH) or a resolveTool() result; either way its version is read once.
  const tool = ffmpeg && typeof ffmpeg === "object" ? ffmpeg : RESOLVED.get(ffmpeg) || { path: ffmpeg || null, source: null };
  const status = ffmpegStatus(tool.path);
  return {
    threads, cpuModel: (cpus[0]?.model || "").replace(/\s+/g, " ").trim(),
    ramGb: os.totalmem() / GB, freeRamGb: os.freemem() / GB,
    diskFreeGb: free == null ? null : free / GB, dataDir, reelGb,
    python: existsSync(python), ffmpeg: status.found, dataWritable, mediaReachable: existsSync(mediaDir),
    ffmpegInfo: { path: tool.path, source: tool.source, version: status.version, tooOld: status.tooOld },
    toolsDir: toolsDir || tool.toolsDir || "",
    helper, helperError, hardware: encoders?.hardware || [],
    buildSeconds: typical ?? guessBuildSeconds(threads), buildSecondsSource: typical ? "measured" : "estimate",
    platform: `${os.platform()} ${os.release()}`, os: os.platform(),
  };
}
