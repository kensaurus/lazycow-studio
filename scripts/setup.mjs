#!/usr/bin/env node
/**
 * FILE: scripts/setup.mjs
 * PURPOSE: One command from a fresh clone to a studio that starts: checks Node, Python, ffmpeg and disk, writes .env
 *          for this computer, makes the Python venv with every package, fetches the picture-quality model and some
 *          free music, and says the one next step. Safe to run again: it only does what is still missing.
 * USAGE: npm run setup                     do everything that is missing
 *        npm run setup -- --check          only look and report (changes nothing)
 *        npm run setup -- --data D:\studio-data --footage "D:\My Footage"   choose the folders on a first run
 *        npm run setup -- --no-music       skip the music download (Openverse; about a minute)
 * NOTES: ffmpeg is never downloaded for you (a binary from the web is your choice): the script says where to get a
 *        current build and where to put it. Nothing here touches footage; the studio only ever reads it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WIN = process.platform === "win32";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
const CHECK = flag("--check");
const AESTHETIC_URL = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_b_32_linear.pth";

let problems = 0;
const say = (ok, what, detail = "", fix = "") => {
  if (!ok) problems++;
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? ` · ${detail}` : ""}`);
  if (!ok && fix) console.log(`    → ${fix}`);
};
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", timeout: 20 * 60 * 1000, ...opts });

/* ---------- .env ---------- */
function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw.trim());
    if (m && !raw.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const ENV_FILE = join(ROOT, ".env");
// As in the server: a STUDIO_* variable exported in the shell wins over .env.
const shellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("STUDIO_")));
let env = { ...readEnv(ENV_FILE), ...shellEnv() };
const abs = (p) => (p ? (isAbsolute(p) ? p : resolve(ROOT, p)) : "");
const DATA = abs(env.STUDIO_DATA || opt("--data") || join(ROOT, "data"));
const SOURCE = abs(env.STUDIO_SOURCE || opt("--footage") || join(DATA, "footage"));
const VENV_PY = WIN ? join(DATA, "venv", "Scripts", "python.exe") : join(DATA, "venv", "bin", "python");
const PY = abs(env.STUDIO_PY) || VENV_PY;
const TOOLS = abs(env.STUDIO_TOOLS) || join(DATA, "bin");
const FFMPEG = join(TOOLS, WIN ? "ffmpeg.exe" : "ffmpeg");

console.log(`Lazycow Studio setup${CHECK ? " (check only: nothing is changed)" : ""}\n  code    ${ROOT}\n  data    ${DATA}\n  footage ${SOURCE}\n`);

/* 1. Node */
const nodeMajor = Number(process.versions.node.split(".")[0]);
say(nodeMajor >= 20, "Node.js 20 or newer", `found ${process.versions.node}`, "install the current LTS from https://nodejs.org");
say(existsSync(join(ROOT, "node_modules")), "npm packages installed", "", "run: npm ci");

/* 2. .env for this computer */
if (!existsSync(ENV_FILE)) {
  if (CHECK) say(false, ".env", "missing", "run: npm run setup (it writes one for this computer)");
  else {
    const keep = { STUDIO_DATA: DATA, STUDIO_SOURCE: SOURCE, STUDIO_PY: PY, STUDIO_TOOLS: TOOLS, STUDIO_TAKEOUT: "" };
    const text = readFileSync(join(ROOT, ".env.example"), "utf8").replace(/^([A-Z0-9_]+)=.*$/gm, (line, k) => (k in keep ? `${k}=${keep[k]}` : line));
    writeFileSync(ENV_FILE, text);
    env = { ...readEnv(ENV_FILE), ...shellEnv() };
    say(true, ".env", "written for this computer (edit it any time)");
  }
} else say(true, ".env", "present");

/* 3. folders and disk */
for (const [dir, what] of [[DATA, "data folder"], [SOURCE, "footage folder"], [TOOLS, "tools folder"]]) {
  if (!existsSync(dir) && !CHECK) mkdirSync(dir, { recursive: true });
  say(existsSync(dir), what, dir, `create it, or set its path in .env`);
}
try {
  const fs = statfsSync(existsSync(DATA) ? DATA : ROOT);
  const gb = (fs.bavail * fs.bsize) / 1e9;
  say(gb >= 3, "free disk for renders", `${gb.toFixed(1)} GB`, "renders need 3 GB at least, 20 GB recommended: set STUDIO_DATA to a bigger disk");
} catch { /* statfs is informational */ }

/* 4. Python and the venv */
function basePython() {
  const tries = WIN ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  for (const [cmd, pre] of tries) {
    const r = run(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
    if (r.status === 0) { const [a, b] = r.stdout.trim().split(".").map(Number); if (a === 3 && b >= 12) return [cmd, pre, `${a}.${b}`]; }
  }
  return null;
}
if (!existsSync(PY)) {
  const base = basePython();
  if (!base) say(false, "Python 3.12 or newer", "not found", "install it from https://www.python.org/downloads/ (tick \"Add to PATH\"), then run setup again");
  else if (CHECK) say(false, "studio Python (venv)", `missing at ${PY}`, "run: npm run setup");
  else {
    console.log(`  making the venv with Python ${base[2]} (a few minutes the first time)…`);
    mkdirSync(dirname(dirname(VENV_PY)), { recursive: true });
    const made = run(base[0], [...base[1], "-m", "venv", join(DATA, "venv")], { stdio: "inherit" });
    say(made.status === 0 && existsSync(VENV_PY), "studio Python (venv)", VENV_PY, "see the error above");
  }
} else say(true, "studio Python (venv)", PY);

const pyOk = (code) => existsSync(PY) && run(PY, ["-c", code], { env: { ...process.env, PYTHONPATH: join(ROOT, "py") } }).status === 0;
const pip = (argv) => run(PY, ["-m", "pip", "install", "--disable-pip-version-check", ...argv], { stdio: "inherit" }).status === 0;
if (existsSync(PY)) {
  const have = pyOk("import numpy, PIL, cv2, scenedetect, librosa, soundfile, pillow_heif, rawpy, cryptography");
  if (!have && !CHECK) pip(["-r", join(ROOT, "py", "requirements.txt")]);
  say(have || pyOk("import numpy, PIL, cv2, scenedetect, librosa, soundfile, pillow_heif, rawpy, cryptography"), "Python packages", "py/requirements.txt", "run: npm run setup");
  const clip = pyOk("import torch, open_clip");
  if (!clip && !CHECK) { pip(["torch", "--index-url", "https://download.pytorch.org/whl/cpu"]) && pip(["open_clip_torch"]); }
  say(clip || pyOk("import torch, open_clip"), "footage search model (torch + open_clip, CPU)", "", "run: npm run setup");
}

/* 5. ffmpeg: a current build in the tools folder (the 2021 one many PATHs carry lacks -fps_mode) */
const ffmpegFound = existsSync(FFMPEG) ? FFMPEG : run(WIN ? "where" : "which", ["ffmpeg"]).stdout?.split(/\r?\n/)[0]?.trim() || "";
const fpsMode = ffmpegFound && /fps_mode/.test(run(ffmpegFound, ["-hide_banner", "-h", "full"], { maxBuffer: 64 * 1024 * 1024 }).stdout || "");
say(!!ffmpegFound && fpsMode, "ffmpeg with -fps_mode", ffmpegFound || "not found",
  WIN ? `download a current "release essentials" build from https://www.gyan.dev/ffmpeg/builds/ and put ffmpeg.exe and ffprobe.exe in ${TOOLS}`
    : process.platform === "darwin" ? "brew install ffmpeg (or put a current ffmpeg and ffprobe in " + TOOLS + ")" : `install a current ffmpeg (your package manager, or a static build in ${TOOLS})`);

/* 6. the picture-quality (aesthetic) head: 4 KB of weights the reel picker scores clips with */
const aes = join(TOOLS, "sa_0_4_vit_b_32_linear.pth");
if (!existsSync(aes) && !CHECK && existsSync(TOOLS)) {
  try {
    const r = await fetch(AESTHETIC_URL, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (r.ok) writeFileSync(aes, Buffer.from(await r.arrayBuffer()));
  } catch { /* reported below */ }
}
say(existsSync(aes), "picture-quality model", aes, `download ${AESTHETIC_URL} into ${TOOLS}`);

/* 7. free music (CC0 / public domain from Openverse), so the first reels are not silent */
const musicDir = join(DATA, "audio", "music");  // py/studio/sound.py LIB / "music"
const tracks = () => { try { return readdirSync(musicDir).filter((f) => /\.(mp3|ogg|oga|wav|flac|m4a)$/i.test(f)).length; } catch { return 0; } };
if (!tracks() && !CHECK && !flag("--no-music") && existsSync(PY)) {
  console.log("  fetching free music (about a minute)…");
  run(PY, ["-m", "studio", "audio", "--seed"], { stdio: "inherit", env: { ...process.env, PYTHONPATH: join(ROOT, "py"), STUDIO_DATA: DATA } });
}
say(tracks() > 0, "music library", `${tracks()} tracks in ${musicDir}`,
  flag("--no-music") ? "skipped (--no-music): run npm run setup later, or add music in a reel's Sound tab" : "run: npm run setup (needs the internet)");

console.log(problems ? `\n${problems} thing${problems === 1 ? "" : "s"} still to do (above). Run npm run setup again after fixing them.`
  : `\nReady. Start the studio with:  npm run review   then open http://127.0.0.1:${env.STUDIO_PORT || 4317}`);
process.exit(problems && CHECK ? 1 : 0);
