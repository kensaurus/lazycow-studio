/**
 * FILE: packages/lazycow/lib/doctor.mjs
 * PURPOSE: `npx lazycow doctor`: can this computer run Lazycow Studio, and how fast, before anything is downloaded.
 * OVERVIEW: gatherFacts() reads the machine: system and processor type, threads, memory, free disk where the studio
 *           goes, graphics, Python / Node / ffmpeg if present, whether each download host answers (HEAD, 5 s, all at
 *           once) and a 3-second processor test. judgeDoctor() turns those facts into checks and one verdict, READY /
 *           SLOW / BLOCKED (exit 0 / 1 / 2); formatReport() prints it on one screen. The judging is pure and uses the
 *           studio's own rules: ./health.mjs is server/health.mjs, copied by scripts/build-packages.mjs.
 * DEPENDENCIES: node:os, node:fs, node:path, node:child_process, node:worker_threads, global fetch, ./health.mjs
 * NOTES: scripts/bootstrap/doctor.ps1 and doctor.sh do the core checks (system, memory, disk, hosts) before Node is
 *        on the computer; test/doctor.test.mjs keeps their numbers and host lists in step with this file.
 * Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.
 */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { checkCpu, checkRam, ffmpegFix, guessBuildSeconds, LIMITS, minFfmpegText, probeEncoders, resolveTool } from "./health.mjs";

const GB = 1024 ** 3;

/**
 * What installing takes. diskGb: the double-click setup's own floor (runtimes, the Python environment, 1.6 GB on the
 * reference PC, node_modules, models, download cache). rendersGb: the studio's "space is getting short" line.
 * downloadGb, measured 17 Nov 2026 from the pinned files: during setup about 0.65 GB (Node 41 MB, uv 15 MB, ffmpeg
 * 115 MB, Python and its locked packages about 390 MB, npm packages 82 MB), then the 605 MB footage-search model the
 * first time the studio searches. Music and the renderer's headless browser add a little more, hence "about".
 */
export const INSTALL = { diskGb: 6, rendersGb: LIMITS.diskGb.slow, downloadGb: 1.3, minutes: "10–30" };

/**
 * Hosts the install downloads from (scripts/bootstrap/versions.json, the bootstrap scripts, scripts/setup.mjs and the
 * footage-search model). `need`: "install" = setup cannot finish without it (BLOCKED); "later" = a feature waits (SLOW).
 */
export const HOSTS = [
  { host: "github.com", url: "https://github.com/", what: "the studio, uv, Python, ffmpeg for Windows", need: "install" },
  { host: "release-assets.githubusercontent.com", url: "https://release-assets.githubusercontent.com/", what: "GitHub release downloads", need: "install" },
  { host: "nodejs.org", url: "https://nodejs.org/dist/", what: "Node", need: "install" },
  { host: "pypi.org", url: "https://pypi.org/simple/", what: "Python package index", need: "install" },
  { host: "files.pythonhosted.org", url: "https://files.pythonhosted.org/", what: "Python packages", need: "install" },
  { host: "download.pytorch.org", url: "https://download.pytorch.org/whl/cpu/", what: "PyTorch (footage search)", need: "install" },
  { host: "registry.npmjs.org", url: "https://registry.npmjs.org/", what: "the studio's npm packages", need: "install" },
  { host: "ffmpeg.martin-riedl.de", url: "https://ffmpeg.martin-riedl.de/", what: "ffmpeg for macOS and Linux", need: "install", platforms: ["darwin", "linux"] },
  { host: "huggingface.co", url: "https://huggingface.co/", what: "the footage-search model (first search)", need: "later" },
  { host: "raw.githubusercontent.com", url: "https://raw.githubusercontent.com/", what: "the picture-quality model", need: "later" },
  { host: "api.openverse.org", url: "https://api.openverse.org/v1/", what: "free music", need: "later" },
];

/**
 * The yardstick. The reference PC (AMD Ryzen 9 5950X, 32 threads) builds a reel in a median 357 s over 364 real builds;
 * `single` and `multi` are the best of 28 runs of runBenchmark() on that PC (Node 26.13, 17 Nov 2026), in loops/s,
 * taken as it is used every day: a WSL virtual machine busy beside it, like during those builds.
 */
export const REFERENCE = { cpu: "AMD Ryzen 9 5950X", threads: 32, seconds: 357, builds: 364, single: 134000, multi: 2780000 };

/* Share of a build that waits on one core (Python glue, CLIP on few threads, muxing); the rest scales with every core.
   0.45 makes 8 threads of the same speed take 2.6x the 32-thread time, close to guessBuildSeconds' measured curve. */
const SERIAL = 0.45;

/** Seconds per reel for a benchmark result ({ single, multi } loops/s), scaled from the reference PC's 357 s. */
export function estimateReelSeconds(bench, ref = REFERENCE) {
  if (!bench || !(bench.single > 0) || !(bench.multi > 0) || !(ref.single > 0) || !(ref.multi > 0)) return null;
  return Math.round(ref.seconds * (SERIAL * (ref.single / bench.single) + (1 - SERIAL) * (ref.multi / bench.multi)));
}

/** A reel slower than this makes the verdict SLOW. */
export const SLOW_REEL_SECONDS = 30 * 60;

export const EXIT = { READY: 0, SLOW: 1, BLOCKED: 2 };
export const exitCodeFor = (verdict) => EXIT[verdict] ?? 2;

const RANK = { ok: 0, note: 0, warn: 0, slow: 1, blocked: 2 };

/** "about 9 minutes" */
export function minutesText(seconds) {
  if (seconds == null) return "unknown";
  if (seconds < 90) return "about 1 minute";
  const m = Math.round(seconds / 60);
  return m < 120 ? `about ${m} minutes` : `about ${(m / 60).toFixed(1)} hours`;
}

/** Is this system and processor type one Lazycow installs on? Pure. */
export function checkSystem(f) {
  const id = "system";
  const label = "System";
  const name = `${f.osName || f.platform} ${f.arch}`;
  if (f.platform === "darwin") {
    if (f.arch !== "arm64" && !f.rosetta) {
      return { id, level: "blocked", label, found: `${name}: this Mac has an Intel processor`,
        fix: "Lazycow's footage search runs on PyTorch, which has had no builds for Intel Macs (macOS x86) since version 2.2 in January 2024. "
          + "Use a Mac with Apple silicon (M1 or newer), or a Windows or Linux PC." };
    }
    if (f.macMajor && f.macMajor < 14) {
      return { id, level: "blocked", label, found: `macOS ${f.macMajor}`, fix: "Update to macOS 14 (Sonoma) or newer: the studio's Python packages are built for it." };
    }
    return { id, level: "ok", label, found: `${f.osName || "macOS"}, Apple silicon${f.rosetta ? " (this Node runs under Rosetta; the setup installs native tools)" : ""}`, fix: "" };
  }
  if (f.platform === "win32") {
    if (!["x64", "arm64"].includes(f.arch)) return { id, level: "blocked", label, found: `${name}: 32-bit`, fix: "Lazycow needs 64-bit Windows 10 or 11." };
    if (f.winBuild && f.winBuild < 17134) return { id, level: "blocked", label, found: `Windows build ${f.winBuild}`, fix: "Update Windows to 10 version 1803 or newer (the setup needs its built-in curl)." };
    if (f.arch === "arm64") {
      return { id, level: "slow", label, found: `${name}: Windows on ARM`, fix: "The setup's tools are x64 builds, so they run under Windows' emulation: everything works, more slowly." };
    }
    return { id, level: "ok", label, found: `${f.osName || "Windows"}, 64-bit`, fix: "" };
  }
  if (f.platform === "linux") {
    if (!["x64", "arm64"].includes(f.arch)) return { id, level: "blocked", label, found: name, fix: "Lazycow needs a 64-bit x86 or ARM Linux." };
    return { id, level: "ok", label, found: `${f.osName || "Linux"}, ${f.arch}`, fix: "" };
  }
  return { id, level: "blocked", label, found: name, fix: "Lazycow runs on Windows 10/11, macOS 14+ on Apple silicon, and 64-bit Linux." };
}

/** Free space where the studio goes: BLOCKED below what the install needs, SLOW without room for renders. Pure. */
export function checkDisk(freeGb, where = "", need = INSTALL) {
  const label = `Free space${where ? ` on ${where}` : ""}`;
  const needs = `(needs ${need.diskGb} GB to install, ${need.rendersGb} GB for renders)`;
  if (freeGb == null) return { id: "disk", level: "note", label, found: `unknown ${needs}`, fix: "" };
  const found = `${freeGb.toFixed(0)} GB ${needs}`;
  if (freeGb < need.diskGb) return { id: "disk", level: "blocked", label, found, fix: `Free at least ${need.diskGb} GB there, or install to a bigger drive: npx lazycow install --dir "<folder on that drive>".` };
  if (freeGb < need.diskGb + need.rendersGb) return { id: "disk", level: "slow", label, found, fix: `It installs, with room for only a few reels. Free up space, or put the studio's data on a bigger drive later (STUDIO_DATA).` };
  return { id: "disk", level: "ok", label, found, fix: "" };
}

/** Which hosts answered. A host needed by the install that does not answer BLOCKS; a later one only warns. Pure. */
export function checkHosts(results, platform) {
  if (!results) return { id: "net", level: "note", label: "Downloads", found: "not checked (offline)", fix: "" };
  const wanted = HOSTS.filter((h) => !h.platforms || h.platforms.includes(platform));
  const byHost = new Map(results.map((r) => [r.host, r]));
  const down = wanted.filter((h) => !byHost.get(h.host)?.ok);
  const okHosts = wanted.filter((h) => byHost.get(h.host)?.ok).map((h) => h.host);
  if (!down.length) {
    return { id: "net", level: "ok", label: "Downloads reachable", found: `${okHosts.slice(0, 4).join(", ")}${okHosts.length > 4 ? ", …" : ""} (${okHosts.length} of ${wanted.length})`, fix: "" };
  }
  const hard = down.filter((h) => h.need === "install");
  const list = down.map((h) => `${h.host} (${h.what})`).join(", ");
  return { id: "net", level: hard.length ? "blocked" : "slow", label: "Downloads", found: `no answer from ${list}`,
    fix: hard.length ? "The install cannot finish without these. Check the internet connection; on a work or school network, ask for these sites to be allowed, or set HTTPS_PROXY."
      : "The install works; the features named wait until these answer. Check a firewall or proxy." };
}

/** Graphics, for information: the studio renders on the processor (x264) today. Pure. */
export function checkGraphics(gpus = [], encoders = []) {
  const vendors = [...new Set([...gpus.map(vendorOf).filter(Boolean), ...encoders])];
  if (!vendors.length) return { id: "gpu", level: "note", label: "Graphics", found: "none detected. Lazycow renders on the processor, so none is needed.", fix: "" };
  return { id: "gpu", level: "warn", label: "Graphics", found: `${vendors.join(" / ")} found. Lazycow renders on the processor today.`, fix: "" };
}

export function vendorOf(name = "") {
  const n = String(name);
  return /nvidia|geforce|quadro|rtx/i.test(n) ? "NVIDIA" : /amd|radeon/i.test(n) ? "AMD" : /intel|arc|iris|uhd/i.test(n) ? "Intel"
    : /apple|m\d/i.test(n) ? "Apple" : "";
}

/** Python, Node and ffmpeg already on this computer: information, since the setup brings its own. Pure. */
export function checkTools(f) {
  const out = [];
  const nodeMajor = Number(String(f.node || "").split(".")[0]);
  out.push({ id: "node", level: nodeMajor >= 20 ? "ok" : "note", label: "Node", found: f.node ? `${f.node}${nodeMajor >= 20 ? "" : " (the setup brings its own 26)"}` : "not found", fix: "" });
  out.push({ id: "python", level: f.python ? "ok" : "note", label: "Python",
    found: f.python ? `${f.python} found (the setup still makes its own 3.13)` : "not installed. The setup brings its own 3.13.", fix: "" });
  const ff = f.ffmpeg || {};
  if (ff.usable) out.push({ id: "ffmpeg", level: "ok", label: "ffmpeg", found: `${ff.version || "found"} (${ff.source === "tools" ? "the studio's tools folder" : ff.source === "env" ? "STUDIO_FFMPEG" : "PATH"})`, fix: "" });
  else if (ff.tooOld) {
    out.push({ id: "ffmpeg", level: "warn", label: "ffmpeg", found: `${ff.version || "unknown version"} on PATH is older than ${minFfmpegText()}, so the studio will not use it`,
      fix: f.platform === "linux" ? ffmpegFix("linux", ff.toolsDir || "", null) : "The setup downloads its own current ffmpeg into the studio's tools folder." });
  } else out.push({ id: "ffmpeg", level: "note", label: "ffmpeg", found: "not installed. The setup downloads its own.", fix: "" });
  return out;
}

/** The speed line: the benchmark's estimate, else a rough guess from the thread count. Pure. */
export function checkSpeed(f) {
  const bench = estimateReelSeconds(f.bench);
  const seconds = bench ?? guessBuildSeconds(f.threads || 1);
  const how = bench != null ? `processor test: ${(f.bench.multi / REFERENCE.multi).toFixed(2)}x the ${REFERENCE.cpu}` : "a guess from the thread count";
  const slow = seconds > SLOW_REEL_SECONDS;
  return { id: "speed", level: slow ? "slow" : "ok", label: "Estimated time per reel", found: `${minutesText(seconds)} (${how})`, seconds,
    source: bench != null ? "benchmark" : "threads",
    fix: slow ? "Reels will take a long time each. Make them while you do something else, or use a faster computer." : "" };
}

/**
 * Facts in, checks and one verdict out. Pure: everything it reads is in `f` (see gatherFacts).
 * @returns {{ verdict: "READY"|"SLOW"|"BLOCKED", exitCode: number, checks: object[], seconds: number, header: string,
 *             reason: string, fix: string, install: typeof INSTALL }}
 */
export function judgeDoctor(f) {
  const checks = [checkSystem(f), checkCpu(f.threads, f.cpuModel), checkRam(f.ramGb), checkDisk(f.diskFreeGb, f.diskWhere),
    checkGraphics(f.gpus, f.encoders), ...checkTools(f), checkHosts(f.hosts, f.platform)];
  const speed = checkSpeed(f);
  checks.push(speed);
  const top = Math.max(...checks.map((c) => RANK[c.level] ?? 0));
  const verdict = top === 2 ? "BLOCKED" : top === 1 ? "SLOW" : "READY";
  const worst = checks.filter((c) => RANK[c.level] === top && top > 0);
  const reason = worst.map(labelled).join("; ");
  const fix = worst.map((c) => c.fix).filter(Boolean).join(" ");
  const header = `Lazycow check · ${f.osName || f.platform} ${f.arch} · ${f.threads} threads · ${Math.round(f.ramGb)} GB RAM`;
  return { verdict, exitCode: exitCodeFor(verdict), checks, seconds: speed.seconds, secondsSource: speed.source, header, reason, fix, install: INSTALL };
}

const MARK = { ok: "✓", note: "·", warn: "!", slow: "!", blocked: "✗" };
/* "Memory: 8 GB", and "Free space on D: 210 GB" (a label that already ends with the drive's colon gets no second one). */
const labelled = (c) => `${c.label}${/:$/.test(c.label) ? "" : ":"} ${c.found}`;

/** One screen of plain text. */
export function formatReport(r) {
  const lines = [r.header];
  for (const c of r.checks) {
    if (c.id === "speed") continue;
    lines.push(`${MARK[c.level] || "·"} ${labelled(c)}`);
    if (c.fix && (c.level === "blocked" || c.level === "slow" || c.level === "warn")) lines.push(`    → ${c.fix}`);
  }
  const speed = r.checks.find((c) => c.id === "speed");
  lines.push(`Estimated time per reel: ${speed.found}`);
  const dl = `Install downloads about ${r.install.downloadGb} GB and takes ${r.install.minutes} minutes.`;
  if (r.verdict === "READY") lines.push(`Verdict: READY. ${dl}`);
  else if (r.verdict === "SLOW") lines.push(`Verdict: SLOW. ${r.reason}. Lazycow will run, slower or with less room. ${dl}`);
  else lines.push(`Verdict: BLOCKED. ${r.reason}.${r.fix ? ` What to do: ${r.fix}` : ""}`);
  return lines.join("\n");
}

/* ---------- reading the machine (not pure) ---------- */

const BENCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
function spin(ms) {
  const a = new Float64Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  let x = 2463534242 | 0, loops = 0;
  const t0 = performance.now(), end = t0 + ms;
  while (performance.now() < end) {
    for (let k = 0; k < 4096; k++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; const j = x & 255; a[j] = a[j] * 0.9999 + (x >>> 20) * 1e-4; }
    loops++;
  }
  return { rate: loops / ((performance.now() - t0) / 1000), sink: a[7] };
}
spin(150);
parentPort.postMessage("ready");
parentPort.once("message", () => parentPort.postMessage(spin(workerData.ms).rate));
`;

async function runWorkers(n, ms) {
  const workers = Array.from({ length: n }, () => new Worker(BENCH_WORKER, { eval: true, workerData: { ms } }));
  try {
    await Promise.all(workers.map((w) => new Promise((ok, no) => { w.once("message", ok); w.once("error", no); })));
    const rates = await Promise.all(workers.map((w) => new Promise((ok, no) => { w.once("message", ok); w.once("error", no); w.postMessage("go"); })));
    return rates.reduce((a, b) => a + b, 0);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/** About 3 s: one core for 0.8 s, then every thread at once for 1.5 s. Loops per second, higher is faster. */
export async function runBenchmark({ threads = os.availableParallelism?.() || os.cpus().length || 1, singleMs = 800, multiMs = 1500 } = {}) {
  const single = await runWorkers(1, singleMs);
  const multi = await runWorkers(Math.max(1, threads), multiMs);
  return { single: Math.round(single), multi: Math.round(multi), threads };
}

/** HEAD each host, all at once, 5 s each. Any HTTP answer counts as reachable; only no answer does not. */
export async function probeHosts(hosts = HOSTS, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  return Promise.all(hosts.map(async (h) => {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(h.url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      return { host: h.host, ok: true, status: res.status, ms: Date.now() - t0 };
    } catch (err) {
      return { host: h.host, ok: false, error: err?.cause?.code || err?.name || String(err), ms: Date.now() - t0 };
    }
  }));
}

const quiet = (cmd, args, timeout = 8000) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    return r.status === 0 ? `${r.stdout || ""}${r.stderr || ""}`.trim() : "";
  } catch { return ""; }
};

function osFacts() {
  const platform = os.platform();
  const f = { platform, arch: os.arch(), release: os.release() };
  if (platform === "win32") {
    f.winBuild = Number(os.release().split(".")[2]) || 0;
    f.osName = f.winBuild >= 22000 ? "Windows 11" : "Windows 10";
  } else if (platform === "darwin") {
    const v = quiet("sw_vers", ["-productVersion"]);
    f.macMajor = Number(v.split(".")[0]) || null;
    f.osName = v ? `macOS ${v}` : "macOS";
    f.rosetta = f.arch === "x64" && quiet("sysctl", ["-n", "sysctl.proc_translated"]) === "1";
  } else {
    try { f.osName = /^PRETTY_NAME="?([^"\n]+)/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] || "Linux"; } catch { f.osName = "Linux"; }
  }
  return f;
}

function gpuNames(platform) {
  if (platform === "win32") {
    return quiet("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"], 10000).split(/\r?\n/).filter(Boolean);
  }
  if (platform === "darwin") return os.arch() === "arm64" || quiet("sysctl", ["-n", "sysctl.proc_translated"]) === "1" ? ["Apple GPU"] : [];
  return quiet("lspci", []).split("\n").filter((l) => /vga|3d controller/i.test(l));
}

function pythonVersion(platform) {
  const tries = platform === "win32" ? [["py", ["-3", "--version"]], ["python", ["--version"]]] : [["python3", ["--version"]], ["python", ["--version"]]];
  for (const [cmd, args] of tries) {
    const m = /Python (\d+\.\d+\.\d+)/.exec(quiet(cmd, args));
    if (m) return m[1];
  }
  return null;
}

/** The studio's tools folder, when this computer already has a studio (STUDIO_TOOLS, else the one setup recorded). */
function knownToolsDir() {
  if (process.env.STUDIO_TOOLS) return process.env.STUDIO_TOOLS;
  const home = process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local"), "Lazycow")
    : process.platform === "darwin" ? join(os.homedir(), "Library", "Application Support", "Lazycow") : join(os.homedir(), ".local", "share", "lazycow");
  try { const data = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")).data; return data ? join(data, "bin") : ""; } catch { return ""; }
}

/** Free GiB on the drive that holds `dir` (or its nearest existing parent), and how to name that drive. */
export function diskFacts(dir) {
  let p = resolve(dir);
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  let free = null;
  try { const s = statfsSync(p); free = (Number(s.bavail) * Number(s.bsize)) / GB; } catch { /* unknown */ }
  const root = parse(p).root;
  const where = process.platform === "win32" ? root.replace(/\\$/, "") : p;
  return { diskFreeGb: free, diskWhere: where, diskPath: p };
}

/** Everything judgeDoctor needs, read from this computer. `offline` skips the host check; `bench: false` the test. */
export async function gatherFacts({ dir = join(os.homedir(), "Lazycow Studio"), offline = false, bench = true } = {}) {
  const f = osFacts();
  const cpus = os.cpus();
  f.threads = os.availableParallelism?.() || cpus.length || 1;
  f.cpuModel = (cpus[0]?.model || "").replace(/\s+/g, " ").trim();
  f.ramGb = os.totalmem() / GB;
  Object.assign(f, diskFacts(dir));
  f.node = process.versions.node;
  f.python = pythonVersion(f.platform);
  const tool = resolveTool("ffmpeg", { env: process.env, toolsDir: knownToolsDir() });
  f.ffmpeg = { path: tool.path, source: tool.source, version: tool.version, tooOld: tool.tooOld, usable: tool.usable, toolsDir: tool.toolsDir };
  if (tool.usable && !tool.version) f.ffmpeg.version = /ffmpeg version (\S+)/.exec(quiet(tool.path, ["-version"]))?.[1]?.replace(/-.*/, "") || null;
  f.gpus = gpuNames(f.platform);
  f.encoders = tool.usable ? probeEncoders(tool.path).hardware : [];
  // The network check waits on the wire, not the processor, so it runs during the processor test.
  const [hosts, b] = await Promise.all([
    offline ? Promise.resolve(null) : probeHosts(HOSTS.filter((h) => !h.platforms || h.platforms.includes(f.platform))),
    bench ? runBenchmark({ threads: f.threads }).catch(() => null) : Promise.resolve(null),
  ]);
  f.hosts = hosts;
  f.bench = b;
  return f;
}

/** Run the whole check. Prints to `out` (stdout by default) unless `print` is false; returns { result, facts }. */
export async function doctor({ dir, offline = false, json = false, print = true, out = process.stdout } = {}) {
  const facts = await gatherFacts({ dir, offline });
  const result = judgeDoctor(facts);
  if (print) out.write((json ? JSON.stringify({ ...result, facts }, null, 2) : formatReport(result)) + "\n");
  return { result, facts };
}
