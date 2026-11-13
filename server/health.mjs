/**
 * FILE: server/health.mjs
 * PURPOSE: Can this computer run the studio, how long will a reel take, and is the server current?
 * OVERVIEW: Pure rules (`judgeSystem`, `medianSeconds`, `etaSeconds`, `buildId`) plus the few
 *           probes that read the machine (`freeDiskBytes`, `probeEncoders`, `folderBytes`).
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
import { join } from "node:path";
import os from "node:os";

const GB = 1024 ** 3;

/** Minimums. Below `slow` the studio works but warns; below `min` it refuses heavy work. */
export const LIMITS = {
  threads: { min: 4, slow: 8 },
  ramGb: { min: 6, slow: 12 },
  diskGb: { min: 3, slow: 20 },
};

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
  if (!existsSync(ffmpeg)) return { ffmpeg: false, hardware: [] };
  const r = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 8000 });
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

/**
 * The verdict for this machine. Every check says what it found and, when it is not ok,
 * what to do about it, in words a person who is not an engineer can act on.
 */
export function judgeSystem(s) {
  const checks = [];
  const add = (id, lvl, label, found, fix = "") => checks.push({ id, level: lvl, label, found, fix });

  const t = s.threads;
  add("cpu", level(t, LIMITS.threads), "Processor", `${t} threads${s.cpuModel ? ` · ${s.cpuModel}` : ""}`,
    t < LIMITS.threads.min ? "Rendering would take well over half an hour a reel. Use a computer with at least 4 cores / 8 threads."
      : t < LIMITS.threads.slow ? "Reels render, slowly. Close other heavy apps while the studio renders." : "");

  const ram = s.ramGb;
  add("ram", level(ram, LIMITS.ramGb), "Memory", `${ram.toFixed(0)} GB (${s.freeRamGb.toFixed(1)} GB free now)`,
    ram < LIMITS.ramGb.min ? "The footage search and the renderer need about 4 GB together. Use a computer with 8 GB or more."
      : ram < LIMITS.ramGb.slow ? "Close browser tabs and other apps before making several reels at once." : "");

  const disk = s.diskFreeGb;
  const reels = disk != null && s.reelGb ? Math.floor(disk / s.reelGb) : null;
  add("disk", level(disk, LIMITS.diskGb), "Free space for renders",
    disk == null ? "unknown" : `${disk.toFixed(1)} GB free${reels != null ? ` · room for about ${reels} more reels` : ""}`,
    disk != null && disk < LIMITS.diskGb.min ? `New renders are paused. Free space on the drive holding ${s.dataDir}, or point STUDIO_DATA at a bigger drive.`
      : disk != null && disk < LIMITS.diskGb.slow ? "Space is getting short. Delete old drafts you will not post." : "");

  for (const [id, ok, label, fix] of [
    ["python", s.python, "Studio engine (Python)", "Run the setup in README › First run: it creates the venv the studio needs."],
    ["ffmpeg", s.ffmpeg, "Video tools (ffmpeg)", "Put ffmpeg.exe and ffprobe.exe in STUDIO_DATA\\bin (README › First run)."],
    ["data", s.dataWritable, "Studio data folder", "STUDIO_DATA must exist and be writable."],
  ]) add(id, ok ? "ok" : "blocked", label, ok ? "found" : "missing", ok ? "" : fix);

  add("media", s.mediaReachable ? "ok" : "slow", "Footage folder",
    s.mediaReachable ? "reachable" : "not reachable", s.mediaReachable ? "" : "Is Google Drive running and signed in? Reels can still be edited; new footage cannot be read.");

  // A stopped helper is a hiccup (it restarts on the next search), not a computer that is too weak: never "blocked".
  add("helper", s.helper === "ready" ? "ok" : s.helper === "starting" ? "unknown" : "slow", "Footage search",
    s.helper === "ready" ? "loaded" : s.helper === "starting" ? "loading the model (about 20 s after start)" : `stopped${s.helperError ? `: ${s.helperError}` : ""}`,
    s.helper === "down" ? "It restarts by itself on the next search. If it keeps stopping, run `python -m studio service` to see why." : "");

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
export function systemFacts({ dataDir, mediaDir, python, ffmpeg, helper, helperError, encoders, reelGb, history }) {
  const cpus = os.cpus();
  const threads = cpus.length || 1;
  const free = freeDiskBytes(dataDir);
  const typical = medianSeconds(history, "build");
  let dataWritable = false;
  try { dataWritable = statSync(dataDir).isDirectory(); } catch { dataWritable = false; }
  return {
    threads, cpuModel: (cpus[0]?.model || "").replace(/\s+/g, " ").trim(),
    ramGb: os.totalmem() / GB, freeRamGb: os.freemem() / GB,
    diskFreeGb: free == null ? null : free / GB, dataDir, reelGb,
    python: existsSync(python), ffmpeg: existsSync(ffmpeg), dataWritable, mediaReachable: existsSync(mediaDir),
    helper, helperError, hardware: encoders?.hardware || [],
    buildSeconds: typical ?? guessBuildSeconds(threads), buildSecondsSource: typical ? "measured" : "estimate",
    platform: `${os.platform()} ${os.release()}`,
  };
}
