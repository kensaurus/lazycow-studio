/**
 * FILE: server/review.mjs
 * PURPOSE: Local editor server for the house reels (CapCut-style editor.html).
 * OVERVIEW: Serves the editor, reel manifests, the dashboard overview, the tagged media
 *           library (through a long-lived python helper so CLIP loads once), the audio
 *           library (CC0 music / effects, fetch more), 540p preview proxies, project
 *           saves, autopilot (one proposal per theme), a one-at-a-time render queue
 *           (build or sound-only remix) with stage progress, approve / consent /
 *           reject / re-roll through the python CLI, covers, YouTube (connect, upload,
 *           schedule, list the channel), the posting log (reminders, posted links), and
 *           footage folders: browse any drive, discover a folder before adding it, and a
 *           timer that catalogs and tags new files on every folder while nothing renders.
 *           Research (/api/research*, docs/research-api.md): Firecrawl-backed ideas, a website check
 *           against the approved facts, a page read, local events and a link check, read-only.
 *           AI assist (/api/ai*, docs/ai-api.md): a video reviewer and fal.ai tools (slow motion, sharpen, music,
 *           Japanese voice, living photo), each priced first and run inside per-reel, total and daily caps.
 *           Performance (/api/perf*, docs/perf-api.md): per-post numbers (YouTube, Facebook, Bluesky read hourly;
 *           the rest typed in or imported from CSV), what worked, and Thompson-sampled next-reel suggestions.
 * DEPENDENCIES: node:http, node:fs, node:child_process, the studio venv
 * USAGE: npm run review, then http://127.0.0.1:4317
 * NOTES: Listens on 127.0.0.1 only and answers only a loopback Host and same-origin POSTs
 *        (trust.mjs refusal; an optional STUDIO_API_TOKEN), so other sites in the browser cannot use it. /file serves only the studio folders and the
 *        Drive media root (read-only). The only thing that posts is a YouTube upload a
 *        person starts in the editor; every other network is posted by hand.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { withLimit } from "./helper.mjs";
import { setLinkWanted, autoReconnect, beginConnect, browserState, cancelConnect, closeHelper, configureHelper, extensionConnected, setExtensionToken, headlineOf, helperStatus, inLane, openSignin, PERF_NETWORKS, readPerf, planWeek, postFor, prepare as helperPrepare, schedule as helperSchedule, scheduleRefusal, SCHEDULERS, unschedule as helperUnschedule, UNSCHEDULERS } from "./helper.mjs";
import { buildId, folderBytes, freeDiskBytes, judgeSystem, LIMITS, medianSeconds, etaSeconds, probeEncoders, systemFacts } from "./health.mjs";
import { openDrop, closeDrop, dropState, DROP_TYPES, saveUpload } from "./dropbox.mjs";
import { classify, pickNext, noteStart, noteResult, YT_PER_DAY } from "./swap.mjs";
import { AUTO_NETS, CHROME_NETS, fitsNetwork, planAhead, todayIn } from "./autoplan.mjs";
import { setStartup, startupState } from "../scripts/autostart.mjs";
import qrcode from "qrcode-generator";
import { defaultProjectsDir, isRanch, ranchOverlay } from "../shared/ranch.mjs";
import { createStore as problemStore, findProblems } from "./problems.mjs";
import { approvalRefusal, insideRoots, isSlug, pathKey, strayPath, NET_RX, parseRange, readJson, refusal, SLUG_RX, tokenOk, TOKEN_COOKIE, trustRules } from "./trust.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// STUDIO_PORT runs a second studio beside the first. Google sign-in returns to this port (a Desktop-type Google app accepts any
// port on 127.0.0.1: py/studio/youtube.py redirect_uri).
// STUDIO_QUIET=1: a studio for looking only (tests, a second copy on the same data): no posting, booking, swaps,
// checks, Chrome link or resumed renders start by themselves (the footage engine does). What a person presses still works.
const QUIET = process.env.STUDIO_QUIET === "1";
const PORT = /^\d{4,5}$/.test(process.env.STUDIO_PORT || "") ? Number(process.env.STUDIO_PORT) : 4317;
/* What this process is serving. If the files change on disk later, /api/health says the server is stale. */
// The server's own code: a change here needs a restart. The page (editor.html) is read fresh on every load, so a change
// there only needs open pages to reload: it has its own fingerprint (pageBuild), which the page watches.
const SERVED = [SELF, ...["health.mjs", "helper.mjs", "trust.mjs", "chrome-bridge.mjs", "dropbox.mjs", "swap.mjs", "autoplan.mjs", "problems.mjs"].map((f) => join(ROOT, "server", f))];
const PAGE = join(ROOT, "server", "editor.html");
const BUILD = buildId(SERVED);
const STARTED = Date.now();
/* Who made this and which version it is: package.json is the one source (shown in the header and About). */
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ABOUT = {
  name: "Lazycow Studio", version: PKG.version, author: "Kenji Sakuramoto (kensaurus)", homepage: PKG.homepage || "https://kensaur.us",
  // How to pay for development: Stripe plans in shared/support.json (a GitHub Sponsors listing never existed, 13 Nov).
  support: (() => { try { const s = JSON.parse(readFileSync(join(ROOT, "shared", "support.json"), "utf8")); delete s._documentation; return s; } catch { return null; } })(),
  licence: "Apache-2.0 (from the public release; until then all rights reserved)",
  credit: "Based on Lazycow Studio by kensaurus", docs: ["NOTICE", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md"],
};
const DOC_FILES = new Set(ABOUT.docs);
/** .env fills STUDIO_* when the shell did not export them, so a clone runs with one file. */
function envFile() {
  const out = {};
  for (const name of [".env", ".env.local"]) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || line.startsWith("#")) continue;
      out[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
const FILE_ENV = envFile();
const FILE_ENV_BASE = { ...FILE_ENV };  // .env as written, before a project overlays its paths
/* Projects (workspaces): one studio, several brands or accounts. A project is a data folder (renders, drafts,
   reel files, posts, logins, network switches) plus a footage folder. The list lives outside every project in
   STUDIO_HOME/workspaces.json; "main" is the one .env describes. Switching restarts the server on the other folder. */
const HOME_DIR = process.env.STUDIO_HOME || FILE_ENV.STUDIO_HOME || join(homedir(), ".lazycow");
const WS_FILE = join(HOME_DIR, "workspaces.json");
const WS_COLORS = ["#2f7d4f", "#2563eb", "#c2410c", "#9333ea", "#0e7490", "#be123c", "#a16207", "#4d7c0f"];
function readWorkspaces() {
  try {
    const w = JSON.parse(readFileSync(WS_FILE, "utf8"));
    return { active: typeof w.active === "string" ? w.active : "main", list: Array.isArray(w.list) ? w.list : [] };
  } catch { return { active: "main", list: [] }; }
}
function writeWorkspaces(w) { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(WS_FILE, JSON.stringify(w, null, 2)); }
const WS = readWorkspaces();
/* STUDIO_PROJECT=<id> pins this studio to one project, whatever is open in the main one: a second studio (with
   STUDIO_PORT, usually STUDIO_QUIET=1) where another project is worked on side by side. It never switches. */
const PINNED = /^[a-z0-9-]{1,60}$/.test(process.env.STUDIO_PROJECT || "") ? process.env.STUDIO_PROJECT : null;
const ACTIVE_WS = PINNED ? (WS.list.find((w) => w.id === PINNED) || null) : (WS.list.find((w) => w.id === WS.active) || null);
// The active project's paths win over .env (a shell export still wins over both, as everywhere else) - except the
// folders that ARE the project: a STUDIO_DATA exported for the main project must never make another project write its
// catalog, brand, reels and renders into the main project's folder. Those are set in process.env too, so the Python
// helper and render processes started below get the same folders.
const SHELL_ENV = { ...process.env };  // as started: a restart (switching projects) starts from this, not from one project's folders
const PROJECT_OWN = new Set(["STUDIO_DATA", "STUDIO_SOURCE", "STUDIO_DRAFTS", "STUDIO_READY", "STUDIO_PROJECTS", "STUDIO_WORKSPACE"]);
if (ACTIVE_WS) for (const [k, v] of Object.entries(ACTIVE_WS.env || {})) {
  if (!/^STUDIO_[A-Z_]+$/.test(k) || k === "STUDIO_HOME") continue;
  FILE_ENV[k] = String(v);
  if (PROJECT_OWN.has(k)) process.env[k] = String(v);
}
// A project made in the studio is its own brand: the main project's extra footage folders, Takeout folder, YouTube
// channel and business pages in .env never reach it (a trip project showed the ranch's office photos). Only
// the project's own settings count; the same blanks go to the Python and render processes through process.env.
const MAIN_ONLY = ["STUDIO_EXTRA_SOURCES", "STUDIO_TAKEOUT", "STUDIO_YT_CHANNEL", "STUDIO_GBP_LOCATION", "STUDIO_LINKEDIN_PAGE", "STUDIO_WEBSITE_ENV"];
if (ACTIVE_WS && ACTIVE_WS.id !== "main") for (const k of MAIN_ONLY) {
  const own = ACTIVE_WS.env?.[k] ? String(ACTIVE_WS.env[k]) : "";
  FILE_ENV[k] = own;
  process.env[k] = own;
}
const pick = (key, fallback) => process.env[key] || FILE_ENV[key] || fallback;
// Defaults match py/studio/config.py: everything in ./data beside the code; a machine sets real paths in .env.
const DATA = pick("STUDIO_DATA", join(ROOT, "data"));
const PY = pick("STUDIO_PY", process.platform === "win32" ? join(DATA, "venv", "Scripts", "python.exe") : join(DATA, "venv", "bin", "python"));
const MEDIA = pick("STUDIO_SOURCE", join(DATA, "footage"));
// The audience's time zone (IANA name, e.g. Asia/Tokyo). Post times are picked and shown in it; empty = this computer's zone.
const AUDIENCE_TZ = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(pick("STUDIO_TZ", "")) ? pick("STUDIO_TZ", "") : "";
// The browser helper drives your own Chrome through the Playwright extension (docs/helper.md); the token skips its one click.
configureHelper({ browser: pick("STUDIO_HELPER_BROWSER", ""), token: pick("PLAYWRIGHT_MCP_EXTENSION_TOKEN", "") });
setLinkWanted(() => (channelsView().channels || []).some((c) => CHROME_NETS.includes(c.id) && !c.off));
if (!QUIET) setTimeout(() => autoReconnect(0), 3000);  // a saved Chrome link key: link to Chrome at start, no click (when a network needs it)
// Whose studio this is (footage, words, accounts): shown beside the logo. Any short name.
const WORKSPACE = String(pick("STUDIO_WORKSPACE", "")).replace(/[<>\u0000-\u001f]/g, "").slice(0, 40);
const FFMPEG = join(pick("STUDIO_TOOLS", join(DATA, "bin")), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const RENDERS = join(DATA, "renders");
/* Collected footage lands under imports/ (a trusted footage source the watcher already scans). */
const COLLECT_INBOX = join(DATA, "imports", "collected");
let dropQuiet = null;
const COLLECT_FILE = join(DATA, "collect.json");
function readCollect() { try { return JSON.parse(readFileSync(COLLECT_FILE, "utf8")) || {}; } catch { return {}; } }
const PROXIES = join(DATA, "proxies", "lib");
// The drafts folder too: a project other than the ranch keeps them in DATA/drafts (py/studio/reels.py DRAFTS), and the
// post panel's video there answered 403, a black player (the ranch's drafts sit under MEDIA).
const ALLOWED = [RENDERS, join(DATA, "review"), join(DATA, "library"), join(DATA, "keyframes"), join(DATA, "thumbs"), join(DATA, "audio"), PROXIES, join(ROOT, "public", "mezz"), MEDIA,
  pick("STUDIO_DRAFTS", join(DATA, "drafts")), join(DATA, "versions")]
  .map(pathKey);  // folded where the file system ignores case (server/trust.mjs)
const HOUSE = ["view", "fire", "field", "winter"];
const TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".json": "application/json" };
const ENV = { ...process.env, PYTHONPATH: join(ROOT, "py"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
for (const [key, value] of Object.entries(FILE_ENV)) if (key.startsWith("STUDIO_") && !process.env[key]) ENV[key] = value;

/** The long videos of this project: the plan (parts, days, chapters) and, per part, what was built and any job. */
const vlogBusy = () => [...jobs.values()].some((j) => j.kind === "vlog" && ["queued", "running"].includes(j.status));
/* The person's notes on a trip (py/studio/vlog.py trip()): where each day was and which words go on screen. */
const VLOG_STYLES = ["documentary", "cinematic", "energetic", "journal", "retro", "fieldguide", "monochrome", "slow", "roadmovie", "calm", "lively", "photos"];  // the last three: older names
const VLOG_MAX = 20;  // videos in one plan (py/studio/vlog.py PLAN_MAX): a showreel, more looks, and films of what is left
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
function vlogTrip() {
  let t = {};
  try { t = JSON.parse(readFileSync(join(DATA, "vlog-trip.json"), "utf8")); } catch { /* none yet */ }
  // tz, clocks, origin and routeNote (the series maps and days, py/studio/vlog.py trip()) are kept as they are.
  const target = Number.isFinite(t.target) && t.target >= 5 && t.target <= 15 ? t.target : 10;  // minutes per series episode
  return { ...t, places: t.places || {}, overlays: { places: true, animals: true, captions: true, ...(t.overlays || {}) }, hints: t.hints || {},
    moments: t.moments || {}, personal: t.personal === true, privateOk: t.privateOk === true, target,
    route: t.route && typeof t.route === "object" && !Array.isArray(t.route) ? t.route : {} };
}
/* Country names the trip notes accept: as on the map (shared/countries.json, Natural Earth), any case, or a 2-letter code. */
const COUNTRY_NAMES = (() => { try { return JSON.parse(readFileSync(join(ROOT, "shared", "countries.json"), "utf8")).map((c) => c.name); } catch { return []; } })();
const COUNTRY_ALIAS = { "united republic of tanzania": "Tanzania", "uae": "United Arab Emirates", "usa": "United States of America", "uk": "United Kingdom" };
function countryName(v) {
  const s = String(v || "").trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  const low = s.toLowerCase();
  return COUNTRY_ALIAS[low] || COUNTRY_NAMES.find((n) => n.toLowerCase() === low) || null;
}
const cleanTitle = (s) => String(s || "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 70);
/* What the footage can become (vlog.suggest: a dry run of the picker, no AI spend), kept a while per style. */
let suggestCache = new Map(), vlogChain = null, levelsCache = null, versionsCache = null;
async function vlogSuggest(style, target = null) {
  const key = `${style}|${target ?? ""}`;
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
  const data = await pyResult(["vlog", "suggest", "--style", style, ...(target != null ? ["--target", String(target)] : [])], null, 300_000);
  suggestCache.set(key, { at: Date.now(), data });
  return data;
}
/* Build parts from..to one after another (one long render at a time); the page shows which is next. */
const CHAIN_FILE = join(DATA, "vlog-chain.json");  // the long videos still to build, kept across a restart
function buildVlogs(from, to) {
  vlogChain = from < to ? { next: from + 1, last: to } : null;
  return startTask(`vlog-${from}`, "vlog", ["vlog", "build", String(from)], from < to ? () => {
    if (restartPending || pendingSwitch) {  // a restart or a project switch waits only for this part: the rest of the chain
      writeFileSync(CHAIN_FILE, JSON.stringify({ next: from + 1, last: to }));  // carries on after a restart, or when this project is open again
      vlogChain = null;
      return restartPending ? restartWhenIdle() : undefined;  // the switch timer sees nothing running and switches
    }
    buildVlogs(from + 1, to);
  } : () => { vlogChain = null; });
}
let restartPending = false;
/* A restart asked for while something long was running: it happens at the first moment nothing but renders (which
   resume) is busy, or at the end of the current long-video part (the chain resumes from CHAIN_FILE). */
function restartWhenIdle() {
  const busy = [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running");
  if (busy.some((j) => !["build", "remix"].includes(j.kind) && j.slug !== "helper-perf")) return false;
  saveQueue(); queueFrozen = true;
  for (const j of busy) { j.cancelled = true; killTree(j.child); }
  restartSelf();
  return true;
}
setInterval(() => { if (restartPending && !vlogChain) restartWhenIdle(); }, 20_000).unref();
setTimeout(() => {  // a chain a restart interrupted between two parts goes on
  if (QUIET || pendingSwitch) return;  // another project is about to open: the chain waits for this one to be open again
  let c = null;
  try { c = JSON.parse(readFileSync(CHAIN_FILE, "utf8")); } catch { return; }
  try { unlinkSync(CHAIN_FILE); } catch { /* gone */ }
  if (Number.isInteger(c?.next) && Number.isInteger(c?.last) && c.next >= 1 && c.next <= c.last && c.last <= 20) buildVlogs(c.next, c.last);
}, 5000).unref();
function vlogsView() {
  let plan = null;
  try { plan = JSON.parse(readFileSync(join(DATA, "vlog-plan.json"), "utf8")); } catch { /* no plan yet */ }
  const parts = (plan?.videos || []).map((v) => {
    const dir = join(RENDERS, "vlogs", v.slug);
    let built = null, mb = 0;
    try { built = JSON.parse(readFileSync(join(dir, "youtube.json"), "utf8")); mb = Math.round(statSync(join(dir, "master.mp4")).size / 1e6); } catch { built = null; }
    let mix = null;  // what the part is made of: moving clips and photos, and how much of the time is moving
    try {
      const sh = JSON.parse(readFileSync(join(dir, "props.json"), "utf8")).shots || [];
      const vids = sh.filter((s) => !s.photo), secs = (l) => l.reduce((a, s) => a + (s.durationSec || 0), 0);
      mix = { videos: vids.length, photos: sh.length - vids.length, videoPct: Math.round((100 * secs(vids)) / Math.max(1, secs(sh))) };
    } catch { /* not built yet */ }
    const shots = [...(v.cold || []), ...(v.chapters || []).flatMap((c) => c.shots || [])];
    const job = jobs.get(`vlog-${v.n}`), up = jobs.get(`ytvlog-${v.n}`);
    let uploaded = null;
    try { uploaded = JSON.parse(readFileSync(join(dir, "uploaded.json"), "utf8")); } catch { /* not on YouTube yet */ }
    // A series reuses the folders vlog-1, vlog-2, ...: an earlier film's upload there is not this part's (its video stays as it is).
    if (uploaded && built && (uploaded.made ? uploaded.made !== built.made : !!v.series)) uploaded = null;
    return { n: v.n, slug: v.slug, title: built?.youtube?.title || v.title, uploaded, series: v.series || null, episode: v.episode || null,
      upload: up && ["queued", "running"].includes(up.status) ? jobView(up) : up?.status === "error" ? { status: "error", label: (up.lines || []).slice(-1)[0] || "failed" } : null, days: v.days, span: v.span, summary: v.summary || null, shots: shots.length, look: v.look || plan?.style || null,
      estSec: Math.round(shots.reduce((a, s) => a + s.sec, 0) - 0.4 * Math.max(0, shots.length - 1)),
      chapters: (v.chapters || []).map((c) => ({ day: c.day, title: c.title, shots: (c.shots || []).length })),
      built: built ? { seconds: built.seconds, chapters: built.chapters || [], qaOk: !!built.qa?.ok, qa: (built.qa?.checks || []).filter((c) => c.level !== "ok"),
        description: built.youtube?.description || "", tags: built.youtube?.tags || [], made: built.made || null, mb, mix, subs: built.subtitles?.cues || 0,
        target: built.target ?? null, band: built.band ?? null, lengthOk: built.lengthOk ?? null } : null,
      job: job && ["queued", "running"].includes(job.status) ? jobView(job) : job?.status === "error" ? { status: "error", label: (job.lines || []).slice(-1)[0] || "failed" } : null };
  });
  const pj = jobs.get("vlog-plan");
  let series = null;  // the series playlist, once the link pass made it
  try { series = JSON.parse(readFileSync(join(DATA, "vlog-series.json"), "utf8")); } catch { /* not linked yet */ }
  return { plan: plan ? { made: plan.made, name: plan.name, parts: plan.parts, minutes: plan.minutes, items: plan.items, days: plan.days, style: plan.style || null,
    series: plan.series || null } : null, parts, seriesLinks: series,
    trip: vlogTrip(), chain: vlogChain, youtube: vlogYtSettings(),
    planning: pj && ["queued", "running"].includes(pj.status) ? jobView(pj) : null, planError: pj?.status === "error" ? (pj.lines || []).slice(-1)[0] || "failed" : null };
}
/* Long videos to YouTube (POST /api/vlogs/youtube): the project's saved choice, and the uploads one after another. */
function vlogYtSettings() {
  const base = { account: "main", privacy: "unlisted", schedule: false, startAt: "", everyDays: 2, ticks: {} };
  try { return { ...base, ...JSON.parse(readFileSync(join(DATA, "vlog-youtube.json"), "utf8")) }; } catch { return base; }
}
const wallIso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);  // this PC's wall time, as the CLI reads it
function uploadVlogs(plan, s) {
  const [first, ...rest] = plan;
  if (!first) return;
  const args = ["youtube", "upload-vlog", "--part", String(first.n), "--account", s.account, "--privacy", s.privacy, ...(first.at ? ["--at", first.at] : [])];
  startTask(`ytvlog-${first.n}`, "youtube", args, () => uploadVlogs(rest, s));
}
/** Every project for the switcher: "main" (the .env one) first, then the ones made in the studio. */
function workspacesView() {
  const w = readWorkspaces();
  const main = w.list.find((x) => x.id === "main") || {};
  const out = [{ id: "main", main: true, name: main.name || FILE_ENV_BASE.STUDIO_WORKSPACE || "Main", color: main.color || WS_COLORS[0],
    // as the studio was started (a shell export wins over .env, as everywhere): switching back to Main restarts from SHELL_ENV
    data: SHELL_ENV.STUDIO_DATA || FILE_ENV_BASE.STUDIO_DATA || join(ROOT, "data"), source: SHELL_ENV.STUDIO_SOURCE || FILE_ENV_BASE.STUDIO_SOURCE || "" }];
  for (const x of w.list) {
    if (x.id === "main") continue;
    out.push({ id: x.id, name: x.name, color: x.color, data: x.env?.STUDIO_DATA || "", source: x.env?.STUDIO_SOURCE || "", created: x.created || null });
  }
  const pend = pendingSwitch ? { id: pendingSwitch.id, name: out.find((x) => x.id === pendingSwitch.id)?.name || pendingSwitch.id, since: pendingSwitch.since,
    busy: [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running").length } : null;
  const active = PINNED || w.active;  // a pinned studio shows its own project as the open one
  return { active: out.some((x) => x.id === active) ? active : "main", running: ACTIVE_WS?.id || "main", home: HOME_DIR, list: out, pending: pend, pinned: PINNED };
}
const cleanName = (s) => String(s || "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 40);
/* A switch asked for while jobs ran: done by itself as soon as nothing is queued or running (checked every 5 s). */
// Kept on disk: a restart that comes first (new code, a long-video part ending) must not forget a switch asked for.
const SWITCH_FILE = join(HOME_DIR, "switch-pending.json");
let pendingSwitch = PINNED ? null : (() => { try { const v = JSON.parse(readFileSync(SWITCH_FILE, "utf8")); return v && typeof v.id === "string" ? v : null; } catch { return null; } })();
function setPending(v) {
  pendingSwitch = v;
  try { if (v) writeFileSync(SWITCH_FILE, JSON.stringify(v)); else unlinkSync(SWITCH_FILE); } catch { /* none to remove */ }
}
setInterval(() => {
  if (!pendingSwitch || [...jobs.values()].some((j) => j.status === "queued" || j.status === "running")) return;
  const w = readWorkspaces();
  if (pendingSwitch.id !== "main" && !w.list.some((y) => y.id === pendingSwitch.id)) { setPending(null); return; }
  w.active = pendingSwitch.id;
  writeWorkspaces(w);
  console.log(`[projects] switching to ${pendingSwitch.id}: the jobs it waited for have finished`);
  setPending(null);
  restartSelf();
}, 5000);
/** A new project: its own data folder under STUDIO_HOME/projects/<id>, sharing this studio's Python and ffmpeg. */
function createWorkspace(b) {
  const name = cleanName(b.name);
  if (!name) throw Object.assign(new Error("name: a short name for the project"), { status: 400 });
  const w = readWorkspaces();
  let id = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "project";
  if (id === "main") id = "main-2";
  for (let n = 2; w.list.some((x) => x.id === id); n++) id = id.replace(/-\d+$/, "") + "-" + n;
  const data = join(HOME_DIR, "projects", id);
  const source = b.source ? resolve(String(b.source)) : join(data, "footage");
  if (b.source && !existsSync(source)) throw Object.assign(new Error("footage folder not found: " + source), { status: 400 });
  for (const d of [data, join(data, "drafts"), join(data, "ready"), join(data, "projects"), source]) mkdirSync(d, { recursive: true });
  const tz = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(b.tz || "") ? b.tz : AUDIENCE_TZ;
  // A blank profile kit and every network off but the ones asked for: a new brand starts quiet.
  const nets = Array.isArray(b.networks) ? b.networks.filter((n) => NET_RX.test(n)) : [];
  const all = JSON.parse(readFileSync(join(ROOT, "shared", "channels.json"), "utf8")).channels.map((c) => c.id);
  writeFileSync(join(data, "networks.json"), JSON.stringify({ on: nets, off: all.filter((n) => !nets.includes(n)), accounts: {} }, null, 2));
  writeFileSync(join(data, "profiles.json"), JSON.stringify({ displayName: name, handle: "", networks: {} }, null, 2));
  const entry = { id, name, color: WS_COLORS.includes(b.color) ? b.color : WS_COLORS[(w.list.length + 1) % WS_COLORS.length], created: new Date().toISOString(),
    env: { STUDIO_DATA: data, STUDIO_SOURCE: source, STUDIO_DRAFTS: join(data, "drafts"), STUDIO_READY: join(data, "ready"), STUDIO_PROJECTS: join(data, "projects"),
      STUDIO_WORKSPACE: name, STUDIO_TZ: tz, STUDIO_PY: PY, STUDIO_TOOLS: dirname(FFMPEG) } };
  w.list.push(entry);
  writeWorkspaces(w);
  return entry;
}
/* Share a project: one JSON file with what makes it this brand (name, networks, profile kit, word bank, reel plans).
   Never secrets, sign-ins, keys, footage or renders: those stay on this computer. Import makes a new project from it. */
const SHARE_FORMAT = "lazycow-project";
const shareJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
function wordsFile() { return RANCH ? join(ROOT, "shared", "words.json") : join(dirname(PROJECTS_DIR), "words.json"); }
function exportProject() {
  const ws = workspacesView().list.find((x) => x.id === (ACTIVE_WS?.id || "main")) || {};
  const reels = existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => shareJson(join(PROJECTS_DIR, f))).filter(Boolean) : [];
  const own = (name, fallback) => shareJson(join(DATA, name)) ?? (fallback ? shareJson(fallback) : null);
  return { format: SHARE_FORMAT, version: 1, exported: new Date().toISOString(), studio: "Lazycow Studio",
    name: ws.name || "Project", color: ws.color || WS_COLORS[0], tz: AUDIENCE_TZ || null,
    networks: own("networks.json"), profiles: own("profiles.json", join(ROOT, "shared", "profiles", "profiles.json")),
    words: shareJson(wordsFile(), { lines: [] }),
    reels: reels.map((r) => { const { trace, ...rest } = r; return rest; }),  // the assembly trace names this machine's paths: left out
    note: "Footage, renders, sign-ins and keys are not in this file." };
}
function importProject(bundle, name) {
  if (!bundle || bundle.format !== SHARE_FORMAT || bundle.version !== 1) throw Object.assign(new Error("not a Lazycow project file"), { status: 400 });
  const all = Array.isArray(bundle.reels) ? bundle.reels.filter((r) => r && typeof r === "object" && /^[a-z0-9-]{1,80}$/.test(r.slug || "")).slice(0, 2000) : [];
  const reels = all.filter((r) => !strayPath(r));  // a network share or a path outside the footage folder: left out (trust.mjs)
  const nets = Array.isArray(bundle.networks?.on) ? bundle.networks.on.filter((n) => /^[a-z-]+$/.test(n)) : [];
  const made = createWorkspace({ name: cleanName(name || bundle.name || "Imported") || "Imported", color: bundle.color, tz: bundle.tz, networks: nets });
  const data = made.env.STUDIO_DATA;
  const clean = (o) => JSON.parse(JSON.stringify(o ?? null));
  if (bundle.networks && typeof bundle.networks === "object") writeFileSync(join(data, "networks.json"), JSON.stringify({ on: nets, off: (bundle.networks.off || []).filter((n) => /^[a-z-]+$/.test(n)), accounts: clean(bundle.networks.accounts || {}) }, null, 2));
  if (bundle.profiles && typeof bundle.profiles === "object") writeFileSync(join(data, "profiles.json"), JSON.stringify(clean(bundle.profiles), null, 2));
  if (Array.isArray(bundle.words?.lines)) writeFileSync(join(data, "words.json"), JSON.stringify({ lines: clean(bundle.words.lines).slice(0, 5000) }, null, 2) + "\n");
  for (const r of reels) writeFileSync(join(made.env.STUDIO_PROJECTS, `${r.slug}.json`), JSON.stringify(clean(r), null, 2));
  return { made: made.id, name: made.name, reels: reels.length, skipped: all.length - reels.length };
}
/** A request body up to `max` bytes (an imported project file can be a few MB); anything larger is refused. */
function bigBody(req, max) {
  return new Promise((ok, fail) => {
    let data = "", size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { fail(Object.assign(new Error("file too large"), { status: 413 })); req.destroy(); } else data += c; });
    req.on("end", () => { try { ok(JSON.parse(data || "{}")); } catch { fail(Object.assign(new Error("not JSON"), { status: 400 })); } });
  });
}
/** This project's network switches and account names over the shared channels.json (same rule as py/studio/reels.py). */
function channelsView() {
  const spec = JSON.parse(readFileSync(join(ROOT, "shared", "channels.json"), "utf8"));
  const own = join(DATA, "networks.json");
  const o = existsSync(own) ? JSON.parse(readFileSync(own, "utf8")) : {};
  for (const c of spec.channels) {
    // Whose account: the ranch's own (ranchWho) only in the ranch workspace; any other project sees "Your channel".
    if (RANCH && c.ranchWho) c.who = c.ranchWho;
    delete c.ranchWho;
    if ((o.off || []).includes(c.id)) c.off = true;
    else if ((o.on || []).includes(c.id)) delete c.off;
    if (o.accounts?.[c.id]) c.account = String(o.accounts[c.id]).slice(0, 80);
  }
  return spec;
}
function setNetwork(id, { on, account }) {
  const own = join(DATA, "networks.json");
  const o = existsSync(own) ? JSON.parse(readFileSync(own, "utf8")) : {};
  o.on = (o.on || []).filter((x) => x !== id); o.off = (o.off || []).filter((x) => x !== id); o.accounts = o.accounts || {};
  if (on === true) o.on.push(id); else if (on === false) o.off.push(id);
  if (typeof account === "string") { if (account.trim()) o.accounts[id] = cleanName(account); else delete o.accounts[id]; }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(own, JSON.stringify(o, null, 2));
}

/* A one-off studio CLI call in its own process. It never blocks the server (other requests, the live updates and
   the page keep going while it runs) and is stopped after timeoutMs; a stopped call reads as failed. */
function py(args, timeoutMs = 60_000) {
  return new Promise((ok) => {
    const child = spawn(PY, ["-m", "studio", ...args], { cwd: ROOT, env: ENV, windowsHide: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let out = "", err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); ok({ code: null, out, err: `studio ${args[0]} could not start Python: ${e.message}` }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      ok({ code: late ? null : code, out, err: late ? `studio ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped` : err });
    });
  });
}
/** A CLI call that prints `RESULT {json}`; does not block the server while Python starts. Stopped after timeoutMs. */
function pyResult(args, input, timeoutMs = 180_000, env = ENV) {
  return new Promise((ok, fail) => {
    const child = spawn(PY, ["-m", "studio", ...args], { cwd: ROOT, env });
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input); // secrets go on stdin, never on the command line
    let out = "", err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); fail(Object.assign(new Error(`studio ${args[0]} could not start Python: ${e.message}`), { status: 500 })); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (late) return fail(Object.assign(new Error(`studio ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Try again.`), { status: 504 }));
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
      if (code === 0 && line) { try { return ok(JSON.parse(line.slice(7))); } catch { /* a cut-off line is a failure */ } }
      fail(new Error(lastError(err) || `studio ${args[0]} failed`));
    });
  });
}
const lastError = (text) => text.split(/\r?\n/).filter((l) => l && !/Warning|warn\(|installation-guide|^\s/.test(l)).pop() || "";

/* ---------- research (Firecrawl, py/studio/research.py) ----------
   Each request is its own short Python process (the request JSON on stdin, `RESULT {...}` on stdout), so a
   slow web read never holds up the footage helper. Synchronous with a timeout per action; the same request
   asked twice while it runs shares one run (a double click does not spend credits twice). */
const RESEARCH = { ideas: 120_000, "site-check": 150_000, page: 120_000, events: 120_000, links: 150_000, status: 30_000, "check-key": 30_000 };
const researchRuns = new Map();
function research(action, input = {}) {
  const key = action + " " + JSON.stringify(input);
  if (researchRuns.has(key)) return researchRuns.get(key);
  const run = new Promise((ok, fail) => {
    const child = spawn(PY, ["-m", "studio.research", action], { cwd: ROOT, env: ENV });
    let out = "", err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, RESEARCH[action] || 120_000);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); fail(Object.assign(new Error(`Research could not start Python: ${e.message}`), { status: 500 })); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (late) return fail(Object.assign(new Error(`Research took longer than ${Math.round((RESEARCH[action] || 120_000) / 1000)} seconds and was stopped. Try again; pages already read come back from the cache.`), { status: 504, code: "timeout" }));
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
      let r = null;
      try { r = line ? JSON.parse(line.slice(7)) : null; } catch { r = null; }
      if (!r) return fail(Object.assign(new Error(lastError(err) || `research ${action} failed (exit ${code})`), { status: 500 }));
      if (!r.ok) return fail(Object.assign(new Error(r.error), { status: r.status || 500, code: r.code || "error" }));
      ok(r.data);
    });
    child.stdin.end(JSON.stringify(input));
  });
  researchRuns.set(key, run);
  const clear = () => researchRuns.delete(key);
  run.then(clear, clear);
  return run;
}
/* The approved words (py/studio/wording.py): the bank, a fresh draw for a reel, lines the owner adds, AI suggestions
   a person must approve. One short Python process per call; its last stdout line is the JSON answer. */
function words(action, input = {}, timeoutMs = 60_000) {
  return new Promise((ok, fail) => {
    const child = spawn(PY, ["-m", "studio.wording", action], { cwd: ROOT, env: ENV });
    let out = "", err = "";
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); fail(Object.assign(new Error(`Words could not start Python: ${e.message}`), { status: 500 })); });
    child.on("exit", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || "";
      let r = null;
      try { r = JSON.parse(line); } catch { r = null; }
      if (!r) return fail(Object.assign(new Error(lastError(err) || `words ${action} failed`), { status: 500 }));
      if (r.error) return fail(Object.assign(new Error(r.error), { status: 400 }));
      ok(r);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
/** The body fields each research action takes (anything else is dropped before Python sees it). */
function researchInput(action, b) {
  const out = {};
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: "bad_input" });
  if (b.fresh === true) out.fresh = true;
  if (action === "ideas") {
    if (b.topic !== undefined && b.topic !== null) {
      if (typeof b.topic !== "string" || b.topic.length > 120) throw bad("topic: a few words, at most 120 characters.");
      out.topic = b.topic.replace(/[\u0000-\u001f]/g, " ").trim();
    }
    if (b.days !== undefined && b.days !== null) out.days = b.days;
  } else if (action === "events") {
    if (b.days !== undefined && b.days !== null) out.days = b.days;
  } else if (action === "page" || action === "site-check") {
    if (b.url !== undefined && b.url !== null && b.url !== "") {
      if (typeof b.url !== "string" || b.url.length > 2000) throw bad("url: a web address starting with https://");
      out.url = b.url.trim();
    }
    if (action === "page" && !out.url) throw bad("Paste the page's address, starting with https://");
  }
  return out;
}

/* ---------- performance (py/studio/perf.py + learn.py, docs/perf-api.md) ----------
   How each reel did on each network, what worked, what to try next. Same shape as research: one short Python
   process per call (request JSON on stdin, `RESULT {...}` on stdout); the same request asked twice while it
   runs shares one run. Read-only towards the networks: nothing here posts, suggestions only steer drafts. */
const PERF_TIMEOUT = { collect: 180_000, import: 60_000 };
const PERF_NUMBERS = ["views", "likes", "comments", "shares", "saves", "watch_time_s", "avg_view_pct", "avg_view_s", "completion_pct", "followers_gained", "reach"];
const perfRuns = new Map();
function perf(action, input = {}) {
  const key = action + " " + JSON.stringify(input);
  if (perfRuns.has(key)) return perfRuns.get(key);
  const limit = PERF_TIMEOUT[action] || 60_000;
  const run = new Promise((ok, fail) => {
    const child = spawn(PY, ["-m", "studio.perf", action], { cwd: ROOT, env: ENV });
    let out = "", err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, limit);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); fail(Object.assign(new Error(`Performance could not start Python: ${e.message}`), { status: 500 })); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (late) return fail(Object.assign(new Error(`Reading the numbers took longer than ${Math.round(limit / 1000)} seconds and was stopped. Try again.`), { status: 504, code: "timeout" }));
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
      let r = null;
      try { r = line ? JSON.parse(line.slice(7)) : null; } catch { r = null; }
      if (!r) return fail(Object.assign(new Error(lastError(err) || `perf ${action} failed (exit ${code})`), { status: 500 }));
      if (!r.ok) return fail(Object.assign(new Error(r.error), { status: r.status || 500, code: r.code || "error" }));
      ok(r.data);
    });
    child.stdin.end(JSON.stringify(input));
  });
  perfRuns.set(key, run);
  const clear = () => perfRuns.delete(key);
  run.then(clear, clear);
  return run;
}
/** The fields each performance action takes (anything else is dropped before Python sees it; Python checks values). */
function perfInput(action, b) {
  const out = {};
  if (action === "collect") {
    if (b.fresh === true) out.fresh = true;
    if (Array.isArray(b.post_ids)) out.post_ids = b.post_ids.filter(Number.isInteger).slice(0, 500);
  } else if (action === "manual") {
    out.post_id = b.post_id;
    for (const k of PERF_NUMBERS) if (b[k] !== undefined && b[k] !== null && b[k] !== "") out[k] = b[k];
    if (typeof b.at === "string") out.at = b.at.slice(0, 40);
    if (typeof b.note === "string") out.note = b.note.replace(/[\u0000-\u001f]/g, " ").slice(0, 200);
  } else if (action === "import") {
    if (typeof b.network === "string") out.network = b.network.slice(0, 30);
    if (typeof b.csv === "string") out.csv = b.csv;
    if (b.mapping && typeof b.mapping === "object" && !Array.isArray(b.mapping)) {
      out.mapping = Object.fromEntries(Object.entries(b.mapping).filter(([k, v]) => typeof v === "string" && k.length <= 200).slice(0, 40));
    }
    if (b.post_id !== undefined && b.post_id !== null && b.post_id !== "") out.post_id = b.post_id;
    if (b.dry_run === true) out.dry_run = true;
  }
  return out;
}
/** Query string -> input for the GET actions. */
function perfQuery(action, q) {
  const out = {};
  if (action === "get") out.slug = q.get("slug") || "";
  if ((action === "summary" || action === "suggest") && /^[a-z-]{1,30}$/.test(q.get("network") || "")) out.network = q.get("network");
  if (action === "suggest") {
    if (/^\d{1,2}$/.test(q.get("n") || "")) out.n = Number(q.get("n"));
    if (/^(0(\.\d+)?|1(\.0+)?)$/.test(q.get("explore") || "")) out.explore = Number(q.get("explore"));
    if (/^\d{1,9}$/.test(q.get("seed") || "")) out.seed = Number(q.get("seed"));
  }
  return out;
}
/* At most hourly: read the live posts whose next checkpoint (1 h, 24 h, 72 h, 7 d, 28 d) has come. Python keeps
   the last run time, so a restart does not read twice; a network that fails is retried the next hour. */
async function tickPerf() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  try { await perf("collect", { timer: true }); } catch { /* offline or a network refused; the next hour tries again */ }
  // The networks without an API (TikTok, X, Pinterest, Google Maps, LinkedIn): read in your Chrome, but only while the
  // helper is already connected to it. The timer never opens a connect page or asks for a click.
  if (extensionConnected()) startPerfBrowser({ why: "timer" });
}
setTimeout(tickPerf, 5 * 60_000);
setInterval(tickPerf, 60 * 60_000);

/* ---------- Runs by itself (Posting › Runs by itself; settings in py/studio/live.py, plan rules in server/autoplan.mjs) ----------
   Hourly: tidy failures a newer booking replaced, ask YouTube and Facebook whether due posts went out. Daily: check the
   sign-ins posts depend on, and book the next days' posts from the approved reels. Every run leaves a line in
   autopost-runs.json (shown on the page) and a note on the Log; nothing here approves a reel. */
const AUTO_FILE = join(HOME_DIR, "autopost-runs.json");
function autoRuns() { try { return JSON.parse(readFileSync(AUTO_FILE, "utf8")) || {}; } catch { return {}; } }
function noteRun(what, data) {
  const s = autoRuns();
  s[what] = { when: new Date().toISOString(), day: localDay(), ...data };
  try { writeFileSync(AUTO_FILE, JSON.stringify(s)); } catch { /* best effort */ }
  return s[what];
}
const settleJob = async (j, ms) => { const t0 = Date.now(); while (j && ["queued", "running"].includes(j.status) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 2000)); return j; };
const jobError = (j) => (j?.lines || []).slice(-1)[0] || j?.label || j?.status || "did not finish";
const liveSettings = () => ask({ cmd: "live", action: "settings" });
/* A check that calls YouTube or Facebook runs as its own process, so the studio's helper is never held up by a network. */
async function liveTask(action, ms = 5 * 60e3) {
  const j = await settleJob(startTask(`live-${action}`, "live", ["live", action]), ms);
  return j?.status === "done" ? j.result : { error: jobError(j) };
}
let checking = null;
function runChecks({ health = false } = {}) {
  if (QUIET) return Promise.resolve(null);  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  if (checking) return checking;
  checking = (async () => {
    const st = await liveSettings();
    const out = {};
    if (st.tidy.on) out.tidy = await ask({ cmd: "live", action: "tidy" }).catch((e) => ({ error: e.message }));
    if (st.verify.on) out.check = await liveTask("check");
    noteRun("check", { seen: out.check?.seen?.length || 0, missing: out.check?.missing || [], failed: out.check?.failed || [],
      replaced: out.tidy?.replaced?.length || 0, error: out.check?.error || out.tidy?.error || null });
    for (const id of [...(out.check?.missing || []), ...(out.check?.failed || [])]) writeEvent("note", { text: `Post ${id} did not go out as booked: see Posting › Needs a look.` });
    const last = autoRuns().health;
    if (st.health.on && (health || !last || last.day !== localDay())) {
      const h = await liveTask("health", 2 * 60e3);
      noteRun("health", { items: h.items || [], error: h.error || null });
    }
    return out;
  })().finally(() => { checking = null; });
  return checking;
}
setTimeout(() => runChecks().catch((e) => console.error(`[checks] ${e.message || e}`)), 3 * 60_000);
setInterval(() => runChecks().catch((e) => console.error(`[checks] ${e.message || e}`)), 60 * 60_000);

/* Which networks can book right now: the Chrome ones while the helper is linked to your Chrome, the API ones while connected. */
async function autoReady() {
  const [conns, yt] = await Promise.all([ask({ cmd: "connections", port: PORT }).catch(() => ({})), ask({ cmd: "yt_status" }).catch(() => ({}))]);
  return Object.fromEntries(AUTO_NETS.map((n) => [n, CHROME_NETS.includes(n) ? extensionConnected() : n === "youtube" ? !!yt.connected : !!conns[n]?.connected]));
}
/* The next days' bookings from the approved reels (server/autoplan.mjs). confirm: false = what it would book. */
let planning = null;
async function autoPlan({ confirm = true, why = "timer" } = {}) {
  if (planning) return confirm ? { busy: true } : planning.then(() => autoPlan({ confirm: false, why }));
  const run = (async () => {
    const st = (await liveSettings()).plan;
    const tz = AUDIENCE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [rows, posts, ready] = await Promise.all([reviewRows(), ask({ cmd: "posts" }), autoReady()]);
    const spec = channelsView();
    const chosen = (st.networks.length ? st.networks : AUTO_NETS).filter((n) => AUTO_NETS.includes(n));
    const approved = new Set(rows.filter((r) => r.status === "approved").map((r) => r.slug.replace(/^story-/, "")));
    const busy = (slug) => ["queued", "running"].includes(jobs.get(slug)?.status);
    let ms = manifests().filter((m) => approved.has(m.slug) && !HOUSE.includes(m.slug) && !busy(m.slug));
    const reels = ms.map((m) => ({ slug: m.slug, headline: headlineOf(m, m.channels?.[0]), networks: chosen.filter((n) => fitsNetwork(m, n, spec)) }));
    const plan = planAhead({ reels, networks: chosen.filter((n) => ready[n]), posts, timeZone: tz, aheadDays: st.aheadDays,
      tiktokAheadDays: st.tiktokAheadDays, youtubeLeft: Math.max(0, YT_PER_DAY - autoReplaceState().yt) });
    const waiting = chosen.filter((n) => !ready[n]);
    if (!confirm) return { dryRun: true, ...plan, waiting, approved: reels.length };
    const batch = { signin: new Set() };
    let booked = 0;
    for (const p of plan.plan) {
      try {
        const chan = p.network === "youtube" ? "youtube-shorts" : p.network;
        let m = ms.find((x) => x.slug === p.slug);
        const has = (x) => (p.network === "youtube" ? (x?.channels || []).some((c) => c.name === chan && c.dir && c.videos?.length) : !!postFor(x, p.network));
        if (!has(m)) {  // the network's own files first, as Plan posts on the page does
          await ask({ cmd: "package", slug: p.slug, channels: [chan] });
          ms = manifests().filter((x) => approved.has(x.slug));
          m = ms.find((x) => x.slug === p.slug);
          if (!has(m)) { p.refused = "its files for this network could not be made"; continue; }
        }
        if (CHROME_NETS.includes(p.network)) {
          if (batch.signin.has(p.network)) { p.refused = "signed out (see the first booking)"; continue; }
          const c = await helperScheduleCheck(p.slug, p.network, p.at, { known: { rows, posts } });
          if (c.why) { p.refused = c.why; continue; }
          const j = await settleJob(startHelperSchedule({ slug: p.slug, network: p.network, at: p.at, batch }), 20 * 60e3);
          if (j?.status !== "done") { p.refused = jobError(j); continue; }
        } else if (p.network === "youtube") {
          const s = autoReplaceState(); s.yt = (s.yt || 0) + 1; saveAutoReplace(s);  // the day's upload allowance, shared with the swap
          const j = await settleJob(startUpload(p.slug, { at: p.at, privacy: "private" }), 30 * 60e3);
          if (j?.status !== "done") { p.refused = jobError(j); continue; }
        } else {
          const no = approvalRefusal(rows, p.slug);
          if (no) { p.refused = no; continue; }
          const j = await settleJob(startTask(`post-${p.slug}-${p.network}`, "post", ["publish", p.slug, p.network, "--at", p.at]), 30 * 60e3);
          if (j?.status !== "done") { p.refused = jobError(j); continue; }
        }
        booked++;
      } catch (e) { p.refused = String(e.message || e).split(/\r?\n/)[0]; }
    }
    const refused = plan.plan.filter((p) => p.refused).map((p) => ({ slug: p.slug, network: p.network, at: p.at, why: String(p.refused).slice(0, 200) }));
    const r = noteRun("plan", { why, booked, refused, waiting, open: plan.skipped.filter((s) => /no approved reel/.test(s.why)).length });
    if (booked || refused.length) writeEvent("note", { text: `Booked ${booked} post${booked === 1 ? "" : "s"} by itself${refused.length ? `; ${refused.length} not booked (Posting › Runs by itself)` : ""}.` });
    return r;
  })();
  planning = run.finally(() => { planning = null; });
  return run;
}
/* Every 10 minutes: the day's plan runs once after its hour (so a PC switched on late still books), and again the same
   day when Chrome was not linked the first time and is now. */
async function tickAuto() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  try {
    const st = (await liveSettings()).plan;
    if (!st.on || planning) return;
    const last = autoRuns().plan, today = localDay();
    const due = new Date().getHours() >= st.hour && last?.day !== today;
    const chromeNow = last?.day === today && (last.waiting || []).some((n) => CHROME_NETS.includes(n)) && extensionConnected();
    if (due || chromeNow) await autoPlan({ why: due ? "timer" : "chrome linked" });
  } catch (e) { console.error(`[auto-plan] ${e.message || e}`); }
}
setTimeout(tickAuto, 4 * 60_000);
setInterval(tickAuto, 10 * 60_000);

/* ---------- AI assist (py/studio/ai.py, docs/ai-api.md) ----------
   Same shape as research: one short Python process per call (request JSON on stdin, `RESULT {...}` on stdout).
   Every paid call inside goes through one ledger with a per-reel cap, an AI total cap and the daily budget.
   `run` is a background job (STAGE / PROGRESS lines, like a render) and can queue a render when it ends. */
const AI_TIMEOUT = { status: 60_000, estimate: 120_000, review: 300_000, "last-review": 30_000, "check-key": 40_000, "save-key": 40_000, "save-caps": 20_000, credits: 60_000 };
const AI_TOOLS = ["review", "sharpen", "slowmo", "living", "foley", "behind", "music", "voice"];
const AI_SETTINGS = ["fal_key", "openrouter_key", "together_key", "ai_reel_cap_usd", "ai_total_cap_usd", "daily_usd_budget"];
// The ranch overlay (shared/ranch.mjs): the owner's checkout keeps the ranch's reels in ./projects; a clone without it
// keeps them in its data folder. RANCH: the main project of a checkout with the overlay (same rule as py/studio/config.py).
const OVERLAY = ranchOverlay(ROOT, pick("STUDIO_RANCH", ""));
const PROJECTS_DIR = pick("STUDIO_PROJECTS", defaultProjectsDir(ROOT, DATA, OVERLAY));
const RANCH = isRanch(ROOT, PROJECTS_DIR, OVERLAY);
const aiRuns = new Map();
function ai(action, input = {}) {
  const key = action + " " + JSON.stringify(input);
  if (aiRuns.has(key)) return aiRuns.get(key);
  const limit = AI_TIMEOUT[action] || 120_000;
  const run = new Promise((ok, fail) => {
    const child = spawn(PY, ["-m", "studio.ai", action], { cwd: ROOT, env: ENV });
    let out = "", err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, limit);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); fail(Object.assign(new Error(`AI assist could not start Python: ${e.message}`), { status: 500 })); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (late) return fail(Object.assign(new Error(`AI assist took longer than ${Math.round(limit / 1000)} seconds and was stopped. Try again.`), { status: 504, code: "timeout" }));
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
      let r = null;
      try { r = line ? JSON.parse(line.slice(7)) : null; } catch { r = null; }
      if (!r) return fail(Object.assign(new Error(lastError(err) || `AI ${action} failed (exit ${code})`), { status: 500 }));
      if (!r.ok) return fail(Object.assign(new Error(r.error), { status: r.status || 500, code: r.code || "error" }));
      ok(r.data);
    });
    child.stdin.end(JSON.stringify(input));
  });
  aiRuns.set(key, run);
  const clear = () => aiRuns.delete(key);
  run.then(clear, clear);
  return run;
}
/** {slug, tools, options} checked before Python sees it; anything else is dropped. */
function aiInput(b, { needTools = true } = {}) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: "bad_input" });
  if (!SLUG_RX.test(b.slug || "")) throw bad("slug: lowercase letters, digits and dashes.");
  const out = { slug: b.slug };
  if (needTools) {
    if (!Array.isArray(b.tools) || !b.tools.length || !b.tools.every((t) => AI_TOOLS.includes(t))) throw bad(`tools: a list of ${AI_TOOLS.join(", ")}.`);
    out.tools = [...new Set(b.tools)];
  }
  const o = b.options && typeof b.options === "object" && !Array.isArray(b.options) ? b.options : {};
  const opt = {};
  if (o.into !== undefined && o.into !== null && o.into !== "") {
    if (typeof o.into !== "string" || o.into.length > 60 || !SLUG_RX.test(o.into)) throw bad("options.into: a new slug, e.g. day-1108-ai.");
    opt.into = o.into;
  }
  if (o.shots && typeof o.shots === "object") {
    opt.shots = {};
    for (const t of ["slowmo", "sharpen", "living", "foley"]) {
      const v = o.shots[t];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v) || v.length > 20 || !v.every((n) => Number.isInteger(n) && n >= 0 && n < 100)) throw bad(`options.shots.${t}: shot numbers counted from 0.`);
      opt.shots[t] = v;
    }
  }
  if (o.max_living !== undefined) {
    if (!Number.isInteger(o.max_living) || o.max_living < 0 || o.max_living > 5) throw bad("options.max_living: 0 to 5.");
    opt.max_living = o.max_living;
  }
  if (o.max_foley !== undefined) {
    if (!Number.isInteger(o.max_foley) || o.max_foley < 0 || o.max_foley > 12) throw bad("options.max_foley: 0 to 12.");
    opt.max_foley = o.max_foley;
  }
  if (o.fresh === true) opt.fresh = true;
  if (Object.keys(opt).length) out.options = opt;
  return out;
}
/* An AI run: beside the render queue (network, not CPU), reported through /api/events like a render. When it
   finishes and `render` was asked for, the reel it changed joins the render queue. */
function startAi(input, render) {
  const target = input.options?.into || input.slug;
  const key = `ai-${target}`;
  const prev = jobs.get(key);
  if (prev && prev.status === "running") return prev;
  const job = { slug: key, kind: "ai", status: "running", queued: Date.now(), started: Date.now(), lines: [], stage: 0, stages: input.tools.length, done: 0, of: 0, label: "pricing the AI steps" };
  jobs.set(key, job);
  const child = spawn(PY, ["-m", "studio.ai", "run"], { cwd: ROOT, env: ENV });
  let out = "", err = "";
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (const line of chunk.toString().split(/\r?\n/)) {
      const stage = /^STAGE (\d+)\/(\d+) (.*)$/.exec(line), step = /^PROGRESS (\d+)\/(\d+) (.*)$/.exec(line);
      if (stage) Object.assign(job, { stage: +stage[1], stages: +stage[2], done: 0, of: 0, label: stage[3] });
      else if (step) Object.assign(job, { done: +step[1], of: +step[2], label: step[3] });
      else continue;
      broadcast("job", job);
    }
  });
  child.stderr.on("data", (c) => { err += c; });
  const finish = (code) => {
    if (job.ended) return;
    job.ended = Date.now();
    const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
    let r = null;
    try { r = line ? JSON.parse(line.slice(7)) : null; } catch { r = null; }
    if (r?.ok) {
      job.result = r.data;
      Object.assign(job, { status: "done", stage: job.stages, done: 1, of: 1, label: r.data.summary || "finished" });
      if (render && (r.data.notes || []).length) {
        try { startRender(r.data.slug); job.label += " Rendering it now."; } catch (e) { job.lines.push(e.message); }
      }
    } else {
      job.status = "error";
      job.error = { error: r?.error || lastError(err) || `AI run failed (exit ${code})`, code: r?.code || "error" };
      job.label = job.error.error;
      job.lines.push(job.error.error);
    }
    recordJob(job);
    broadcast("job", job, true);
  };
  child.on("exit", finish);
  child.on("error", (e) => { err += e.message; finish(null); });
  child.stdin.end(JSON.stringify(input));
  return job;
}
/** The AI notes in a reel's project file and whether any needs the platform's AI label (read-only). */
function aiNotes(slug) {
  try {
    const p = JSON.parse(readFileSync(join(PROJECTS_DIR, `${slug}.json`), "utf8"));
    const notes = Array.isArray(p.ai) ? p.ai : [];
    return { ai: notes, aiLabel: notes.some((n) => n && n.label_required === true), aiOf: p.ai_of || null };
  } catch { return { ai: [], aiLabel: false, aiOf: null }; }
}

/* ---------- the python helper (CLIP stays loaded) ---------- */
/* If it dies (out of memory, a bad file, a killed process), every waiting request fails at once
   with the reason instead of hanging, and the next request starts a fresh helper. */
let helper = null;
let helperReady = null;
let helperState = "down";
let helperError = "";
let helperTail = "";
const pending = new Map();
let seq = 0;
function startHelper() {
  if (!existsSync(PY)) { helperState = "down"; helperError = `Python not found at ${PY}`; helperReady = Promise.reject(new Error(helperError)); helperReady.catch(() => {}); return; }
  helperState = "starting"; helperTail = "";
  const proc = spawn(PY, ["-m", "studio", "service"], { cwd: ROOT, env: ENV });
  helper = proc;
  helperReady = new Promise((ok, fail) => {
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { helperState = "ready"; helperError = ""; return ok(); }
      const p = pending.get(msg._rid);
      // A person's mistake (ValueError) is a 400 with the plain sentence; the technical place goes to server.log.
      if (p) { pending.delete(msg._rid); if (msg.ok) p.resolve(msg.data); else { if (msg.detail) console.error(`helper: ${msg.detail}: ${msg.error}`); p.reject(Object.assign(new Error(msg.error), { status: msg.input ? 400 : 500 })); } }
    });
    // Exit and spawn error end the same way. A helper that is no longer the current one (an orphan from
    // an earlier start) must not mark the live one down or reject its requests.
    let ended = false;
    const down = (reason) => {
      if (ended) return;
      ended = true;
      const err = new Error(`The footage search stopped (${reason}). Try again: it restarts by itself.`);
      fail(err);
      if (helper !== proc) return;
      helper = null;
      helperState = "down";
      helperError = reason;
      for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
    };
    proc.on("exit", (code) => down(lastError(helperTail) || `exited with code ${code}`));
    proc.on("error", (err) => down(err.message));
  });
  helperReady.catch(() => {});
  proc.stdin.on("error", () => {});  // a write racing the helper's exit must not crash the server
  proc.stderr.on("data", (c) => { helperTail = (helperTail + c).slice(-4000); });
}
async function ask(req) {
  if (!helper) startHelper();
  await helperReady;
  if (!helper) throw new Error(`The footage search is not running: ${helperError || "starting"}`);
  const id = ++seq;
  return new Promise((resolveP, rejectP) => {
    pending.set(id, { resolve: resolveP, reject: rejectP });
    // `_rid` matches the reply to this request; commands keep their own `id` (an asset id).
    helper.stdin.write(JSON.stringify({ ...req, _rid: id }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rejectP(new Error("helper timeout")); } }, 600000);
  });
}

/* ---------- render queue: one job at a time (parallel builds fight over CPU and the GPU encoder) ---------- */
const jobs = new Map();
const queue = [];
let running = null;
/* The render queue survives a restart: what is running and waiting is written to renders/queue.json on every change
   and queued again when the server starts (the interrupted render first). A reel stopped by hand is not resumed. */
const QUEUE_FILE = join(RENDERS, "queue.json");
let queueFrozen = false;
function saveQueue() {
  if (queueFrozen) return;
  const list = [...(running && !running.cancelled ? [running] : []), ...queue].filter((j) => ["build", "remix"].includes(j.kind)).map((j) => ({ slug: j.slug, kind: j.kind }));
  try { mkdirSync(RENDERS, { recursive: true }); writeFileSync(QUEUE_FILE, JSON.stringify(list)); } catch { /* resuming is a convenience */ }
}
function restoreQueue() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  let list = [];
  try { list = JSON.parse(readFileSync(QUEUE_FILE, "utf8")); } catch { return; }
  let n = 0;
  for (const e of Array.isArray(list) ? list : []) {
    try { if (isSlug(e.slug) && ["build", "remix"].includes(e.kind)) { startRender(e.slug, e.kind); n++; } } catch { /* a reel that cannot render now is skipped */ }
  }
  if (n) console.log(`resumed ${n} render${n === 1 ? "" : "s"} from before the restart`);
}
setTimeout(restoreQueue, 2500);
/* Refuse to start a render that would fill the disk halfway through (a half-written reel is worse than none). */
function diskGuard() {
  const free = freeDiskBytes(DATA);
  if (free != null && free < LIMITS.diskGb.min * 1024 ** 3) {
    const err = new Error(`Only ${(free / 1024 ** 3).toFixed(1)} GB free where the studio keeps renders (${DATA}). A reel needs about ${LIMITS.diskGb.min} GB while it renders: free some space, then try again.`);
    err.status = 507;
    throw err;
  }
}
/* Stop a process and everything it started (ffmpeg under python) — taskkill /T on Windows. */
function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
}
function cancelJob(slug) {
  const job = jobs.get(slug);
  if (!job || !["queued", "running"].includes(job.status)) return job;
  // Renders and long videos can be stopped: an upload or a footage scan must finish. Stopping a long video also stops
  // the parts waiting after it (the chain); the ones already made stay.
  if (job.kind === "vlog" && job.status === "running" && job.child) {
    vlogChain = null;
    Object.assign(job, { cancelled: true, label: "stopping" });
    killTree(job.child);
    return job;
  }
  if (!["build", "remix"].includes(job.kind)) { const err = new Error(job.kind + " cannot be stopped"); err.status = 409; throw err; }
  if (job.status === "queued") {
    queue.splice(queue.indexOf(job), 1);
    saveQueue();
    Object.assign(job, { status: "cancelled", ended: Date.now(), label: "cancelled" });
    recordJob(job); broadcast("job", job, true);
    return job;
  }
  job.cancelled = true;
  job.label = "stopping";
  killTree(job.child);
  return job;
}
/* Every caller checks the slug; this is the last line before it becomes a Python argument (results from Python too). */
function slugGuard(slug) {
  if (!isSlug(slug)) throw Object.assign(new Error(`slug: lowercase letters, digits and dashes, starting with a letter or digit (got ${JSON.stringify(String(slug).slice(0, 40))})`), { status: 400 });
}
function startRender(slug, kind = "build") {
  slugGuard(slug);
  diskGuard();
  const prev = jobs.get(slug);
  // A job being stopped is not busy: a new render asked for meanwhile queues behind it instead of vanishing.
  if (prev && !prev.cancelled && (prev.status === "queued" || prev.status === "running") && prev.kind === kind) return prev;
  if (prev?.status === "queued") queue.splice(queue.indexOf(prev), 1);
  const job = { slug, kind, status: "queued", queued: Date.now(), lines: [], stage: 0, stages: 7, done: 0, of: 0, label: kind === "remix" ? "waiting to mix sound" : "waiting its turn" };
  jobs.set(slug, job);
  queue.push(job);
  pump();
  saveQueue();
  return job;
}
function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  saveQueue();
  mkdirSync(RENDERS, { recursive: true });
  const args = job.kind === "remix" ? ["reels", "--remix", job.slug] : ["reels", "--build", job.slug];
  const child = spawn(PY, ["-m", "studio", ...args], { cwd: ROOT, env: ENV, detached: process.platform !== "win32" });
  Object.defineProperty(job, "child", { value: child, enumerable: false, configurable: true });
  Object.assign(job, { status: "running", started: Date.now(), label: job.kind === "remix" ? "mixing sound" : "starting" });
  broadcast("job", job);
  const push = (chunk) => {
    let moved = false;
    for (const line of chunk.toString().split(/\r?\n/)) {
      const stage = /^STAGE (\d+)\/(\d+) (.*)$/.exec(line);
      if (stage) { job.stage = +stage[1]; job.stages = +stage[2]; job.done = 0; job.of = 0; job.label = stage[3]; moved = true; continue; }
      const step = /^PROGRESS (\d+)\/(\d+) (.*)$/.exec(line);
      if (step) { job.done = +step[1]; job.of = +step[2]; job.label = step[3]; moved = true; continue; }
      if (line && !/Matplotlib|colour-science|warn\(|setPreferableTarget|graph engine|HF Hub|QuickGELU|installation-guide/.test(line)) job.lines.push(line);
    }
    job.lines = job.lines.slice(-40);
    if (moved) broadcast("job", job);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  // Exit, or a spawn error with no exit: either way the job ends once and the queue moves on.
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    job.status = job.cancelled ? "cancelled" : code === 0 ? "done" : "error"; job.ended = Date.now();
    if (job.cancelled) job.label = "stopped: some files may be half-made, render again before approving";
    else if (code === 0) { job.stage = job.stages; job.done = 1; job.of = 1; job.label = "ready to review"; }
    try { writeFileSync(join(RENDERS, `job-${job.slug}.log`), job.lines.join("\n")); } catch { /* the log is a convenience */ }
    recordJob(job);
    if (jobs.get(job.slug) === job) broadcast("job", job);  // a newer job for this reel speaks for it now
    if (running === job) running = null;
    pump();
    saveQueue();
  };
  child.on("exit", finish);
  child.on("error", (err) => { job.lines.push(`could not start: ${err.message}`); finish(null); });
}
setInterval(() => { if (running?.status === "running") broadcast("job", running, true); }, 1000);
/* A footage scan or a Google Photos import: beside the render queue, reported through /api/events. */
function startTask(key, kind, args, onDone = null, env = ENV) {
  const prev = jobs.get(key);
  if (prev && prev.status === "running") return prev;
  const job = { slug: key, kind, status: "running", queued: Date.now(), started: Date.now(), lines: [], stage: 0, stages: 2, done: 0, of: 0, label: "starting" };
  jobs.set(key, job);
  const child = spawn(PY, ["-m", "studio", ...args], { cwd: ROOT, env });
  job.child = child;  // a long video can be stopped (cancelJob)
  let err = "";
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const stage = /^STAGE (\d+)\/(\d+) (.*)$/.exec(line), step = /^PROGRESS (\d+)\/(\d+) (.*)$/.exec(line);
      if (stage) Object.assign(job, { stage: +stage[1], stages: +stage[2], done: 0, of: 0, label: stage[3] });
      else if (step) Object.assign(job, { done: +step[1], of: +step[2], label: step[3] });
      else if (line.startsWith("RESULT ")) job.result = JSON.parse(line.slice(7));
      else continue;
      broadcast("job", job);
    }
  });
  child.stderr.on("data", (c) => { err += c; });
  child.on("exit", (code) => {
    job.ended = Date.now();
    job.status = code === 0 ? "done" : "error";
    if (code === 0) Object.assign(job, { stage: job.stages, done: 1, of: 1, label: "finished" });
    else job.lines.push(lastError(err) || `${kind} failed`);
    recordJob(job);
    broadcast("job", job, true);
    if (code === 0 && onDone) Promise.resolve().then(() => onDone(job)).catch((e) => console.error(`[${key}] after: ${e.message || e}`));
  });
  return job;
}
/* The footage watcher: every STUDIO_WATCH_MINUTES (default 30; 0 turns it off) it diffs every
   footage folder against the catalog and catalogs + tags what is new. It waits while a reel
   renders or another footage job runs, so it never slows a build. */
const WATCH_MINUTES = Number.isFinite(+process.env.STUDIO_WATCH_MINUTES) && process.env.STUDIO_WATCH_MINUTES !== "" ? +process.env.STUDIO_WATCH_MINUTES : 30;
const watch = { every: WATCH_MINUTES, last: null, why: null, next: null };
function startWatch(why) {
  const busy = jobs.get("footage");
  if (busy?.status === "running") return busy;
  watch.last = Date.now();
  watch.why = why;
  return startTask("footage", "watch", ["sources", "watch"], (job) => { if ((job.result?.added || 0) > 0) autoDrafts(`${job.result.added} new files`); });
}
/* Drafts from new footage, by themselves: when the watcher or a Google Photos import brings in new clips, the
   studio proposes a few reels from the last days' footage (different looks, the learned choices) and renders
   them. At most STUDIO_AUTO_DRAFTS a day (default 2; 0 turns it off). They wait in Reels for a person to approve:
   nothing is posted from here. The day's count lives in STUDIO_HOME/auto-drafts.json. */
const AUTO_DRAFTS = Number.isFinite(+pick("STUDIO_AUTO_DRAFTS", "2")) ? Math.max(0, Math.min(10, +pick("STUDIO_AUTO_DRAFTS", "2"))) : 2;
async function autoDrafts(why) {
  if (!AUTO_DRAFTS) return;
  const file = join(HOME_DIR, "auto-drafts.json"), today = new Date().toISOString().slice(0, 10);
  let state = { day: today, n: 0, themeAt: 0 };
  try { const s0 = JSON.parse(readFileSync(file, "utf8")); state = { ...state, ...s0, ...(s0.day !== today ? { day: today, n: 0 } : {}) }; } catch { /* first time */ }
  const room = AUTO_DRAFTS - state.n;
  if (room <= 0) return;
  try { diskGuard(); } catch { return; }
  const themes = await ask({ cmd: "themes" }).then((t) => (Array.isArray(t) ? t : Object.keys(t || {})).map((x) => (typeof x === "string" ? x : x.key)).filter(Boolean)).catch(() => []);
  if (!themes.length) return;
  const pickThemes = Array.from({ length: Math.min(room, themes.length) }, (_, i) => themes[(state.themeAt + i) % themes.length]);
  const since = new Date(Date.now() - 4 * 86400e3).toISOString().slice(0, 10);  // the new footage, not the whole library
  const made = await ask({ cmd: "autopilot", themes: pickThemes, since, faces: true, cut: "short", vary: true, learned: true }).catch((e) => { console.error(`[auto-drafts] ${e.message || e}`); return []; });
  made.forEach((m) => startRender(m.slug));
  state = { day: today, n: state.n + made.length, themeAt: (state.themeAt + pickThemes.length) % themes.length };
  try { writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ }
  if (made.length) writeEvent("note", { text: `${made.length} new draft reel${made.length > 1 ? "s" : ""} from ${why}: ${made.map((m) => m.slug).join(", ")}. Review them in Reels.` });
  console.log(`[auto-drafts] ${why}: ${made.map((m) => m.slug).join(", ") || "none"}`);
}
function watchView() {
  return { every: watch.every, last: watch.last ? new Date(watch.last).toISOString() : null, why: watch.why,
    next: watch.next ? new Date(watch.next).toISOString() : null };
}
function tickWatch() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  if (!WATCH_MINUTES) return;
  watch.next = Date.now() + WATCH_MINUTES * 60_000;
  if (running || queue.length) return;  // a render has the CPU; try again next tick
  startWatch("timer");
}
/* Posts the studio sends itself (a connected network that cannot hold a schedule): once a minute, if any
   queued post is due, one "publish --due" run sends them. The check is a cheap read through the helper. */
async function tickPosts() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  try {
    if (jobs.get("post-due")?.status === "running") return;
    const rows = await ask({ cmd: "posts" });
    const now = Date.now();
    if (rows.some((r) => r.status === "queued" && r.at && Date.parse(r.at) <= now)) startTask("post-due", "post", ["publish", "--due"]);
  } catch { /* the helper is starting or busy; next minute */ }
}
setInterval(tickPosts, 60_000);
/* The folders and settings a Python job needs to act for a project that is not the open one: the same overlay this
   process made at start for its own project (null = the main project, as .env describes it). */
function projectEnv(ws) {
  const env = { ...SHELL_ENV, PYTHONPATH: join(ROOT, "py"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  for (const [k, v] of Object.entries(FILE_ENV_BASE)) if (k.startsWith("STUDIO_") && !SHELL_ENV[k]) env[k] = v;
  if (!ws) return env;
  for (const [k, v] of Object.entries(ws.env || {})) if (/^STUDIO_[A-Z_]+$/.test(k) && k !== "STUDIO_HOME") env[k] = String(v);
  for (const k of MAIN_ONLY) env[k] = ws.env?.[k] ? String(ws.env[k]) : "";
  return env;
}
/* Posts the studio sends itself (Bluesky, a queued post) go out for every project, not only the open one: on 11 Nov a
   ranch post was missed while the Kenya project was open. Every 5 minutes each other project sends what is due
   (publish --due marks a post missed instead when it is past the catch-up grace). Booking ahead, swaps and checks stay
   with the open project; they need its Chrome sign-ins. */
function tickOtherPosts() {
  if (QUIET) return;
  const open = ACTIVE_WS?.id || "main";
  const all = [{ id: "main", ws: null }, ...readWorkspaces().list.map((w) => ({ id: w.id, ws: w }))];
  for (const o of all) {
    if (o.id === open || !/^[a-z0-9-]{1,60}$/.test(o.id) || jobs.get(`post-due-${o.id}`)?.status === "running") continue;
    if (o.ws && !existsSync(join(String(o.ws.env?.STUDIO_DATA || ""), "catalog"))) continue;  // a project with no data yet
    startTask(`post-due-${o.id}`, "post", ["publish", "--due"], null, projectEnv(o.ws));
  }
}
setInterval(tickOtherPosts, 5 * 60_000).unref();
/* Keep bookings on the newest render (owner, 2026-11-10: "86 bookings use an older render - fix this"). A booking
   made before its reel got new words carries the old words on the network. Once the reel is re-rendered and approved,
   the studio swaps it at the same time slot by itself, one at a time: Facebook and YouTube by API, X and TikTok in
   your Chrome. YouTube takes at most YT_PER_DAY (20) a day of its 100-a-day upload allowance. Bluesky never needs it: the studio sends the
   newest render at its time. LINE, LinkedIn and Google Maps are booked inside those sites and cannot be taken off. */
const AUTO_REPLACE_FILE = join(HOME_DIR, "auto-replace.json");
const localDay = () => new Date().toLocaleDateString("sv");
function autoReplaceState() {
  const today = localDay();
  let s = { on: true, day: today, yt: 0, done: 0, failed: 0, fails: {}, last: null };
  try { s = { ...s, ...JSON.parse(readFileSync(AUTO_REPLACE_FILE, "utf8")) }; } catch { /* first time: on */ }
  if (s.day !== today) Object.assign(s, { day: today, yt: 0 });
  return s;
}
function saveAutoReplace(s) { try { writeFileSync(AUTO_REPLACE_FILE, JSON.stringify(s)); } catch { /* best effort */ } }
/* Every booking still holding older words, and why it has not been swapped yet (server/swap.mjs classify). */
async function staleBookings() {
  const [rows, o, review] = await Promise.all([ask({ cmd: "posts" }), ask({ cmd: "overview" }), reviewRows()]);
  const reels = new Map((o.reels || []).map((r) => [r.slug, r]));
  const fails = autoReplaceState().fails || {}, now = Date.now();
  const out = [];
  for (const p of rows) {
    const why = classify(p, reels.get(p.slug), { needsReview: !!approvalRefusal(review, p.slug), busy: ["queued", "running"].includes(jobs.get(p.slug)?.status), now, fails });
    if (why) out.push({ id: p.id, slug: p.slug, network: p.network, at: p.at, why, ...(why === "failed" ? { error: fails[p.id]?.error } : {}) });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
const swapping = () => [...jobs.values()].some((j) => ["queued", "running"].includes(j.status) && (j.kind === "helper" || /^post-/.test(j.slug)));
/* A reel that finishes rendering gets its AI score by itself (the reviewer's hook and look marks; about $0.0075, priced
   against the AI limits first), one at a time, so new reels are never left with a partial score. Skipped without an AI
   key, when the reel already has a review, or when the limits refuse it. Shows on the board as ai-<slug>. */
const scoreQueue = [];
let scoreRunning = false;
function autoScore(slug) {
  if (!SLUG_RX.test(slug || "") || scoreQueue.includes(slug)) return;
  if (existsSync(join(DATA, "ai", "reviews", `${slug}.json`))) return;
  scoreQueue.push(slug);
  if (!scoreRunning) runScoreQueue();
}
async function runScoreQueue() {
  scoreRunning = true;
  try {
    while (scoreQueue.length) {
      const slug = scoreQueue.shift();
      try {
        // No reviewer key (a new install, or a project that does not use AI): skip quietly, as promised above, instead
        // of leaving a failed ai-<slug> job on the board after every render.
        const st = await ai("status").catch(() => null);
        if (!st?.keys?.openrouter) { console.log(`[auto-score] ${slug}: skipped, no OpenRouter key`); continue; }
        const input = aiInput({ slug, tools: ["review"] });
        const est = await ai("estimate", input);
        if (!est.fits) { console.log(`[auto-score] ${slug}: ${est.refusal}`); continue; }
        const aj = startAi(input, false);
        while (["queued", "running"].includes(aj.status)) await new Promise((r) => setTimeout(r, 3000));
      } catch (e) { console.error(`[auto-score] ${slug}: ${e.message || e}`); }
    }
  } finally { scoreRunning = false; }
}
function startScoreAll() {
  const key = "score-all", prev = jobs.get(key);
  if (prev && ["queued", "running"].includes(prev.status)) return prev;
  const job = { slug: key, kind: "score", status: "running", queued: Date.now(), started: Date.now(), lines: [], stage: 0, stages: 1, done: 0, of: 0, label: "finding reels without an AI review" };
  jobs.set(key, job); broadcast("job", job, true);
  (async () => {
    const sc = await perf("scores");
    const o = await ask({ cmd: "overview" });
    const ready = new Set((o.reels || []).filter((r) => r.rendered && !["queued", "running"].includes(jobs.get(r.slug)?.status)).map((r) => r.slug));
    const todo = Object.entries(sc.scores || {}).filter(([s, v]) => (v.missing || []).includes("hook") && ready.has(s)).map(([s]) => s);
    job.of = todo.length; broadcast("job", job, true);
    for (const slug of todo) {
      if (job.cancel) break;
      job.label = `AI review of ${slug}`; broadcast("job", job, true);
      const input = aiInput({ slug, tools: ["review"] });
      const est = await ai("estimate", input).catch((e) => ({ fits: false, refusal: e.message }));
      if (!est.fits) { job.lines.push(`${slug}: ${est.refusal}`); break; }
      const aj = startAi(input, false);
      while (["queued", "running"].includes(aj.status)) await new Promise((r) => setTimeout(r, 2000));
      if (aj.status !== "done") job.lines.push(`${slug}: ${(aj.lines || []).slice(-1)[0] || aj.status}`);
      job.done++; broadcast("job", job, true);
    }
    const failed = job.lines.length;
    Object.assign(job, { status: job.done || !todo.length ? "done" : "error", ended: Date.now(), label: `${job.done - failed} of ${todo.length} reels scored${failed ? `, ${failed} not` : ""}`, result: { scored: job.done - failed, of: todo.length } });
    broadcast("job", job, true);
  })().catch((e) => { Object.assign(job, { status: "error", ended: Date.now(), label: String(e.message || e).split(/\r?\n/)[0] }); job.lines.push(job.label); broadcast("job", job, true); });
  return job;
}
let replaceTicking = false;
async function tickReplace() {
  if (QUIET) return;  // STUDIO_QUIET: a second studio for looking only (nothing runs by itself)
  const s = autoReplaceState();
  if (!s.on || replaceTicking || swapping()) return;
  replaceTicking = true;
  let started = false;
  try {
    const next = pickNext(await staleBookings(), s);
    if (!next) return;
    saveAutoReplace(noteStart(s, next));
    const job = UNSCHEDULERS.includes(next.network) ? startHelperReplace({ slug: next.slug, network: next.network, at: next.at, postId: next.id })
      : startTask(`post-${next.slug}-${next.network}`, "post", ["publish", "--replace", String(next.id)]);
    writeEvent("note", { text: `Swapping ${next.slug} on ${next.network} for its newest render, same time (${next.at}).` });
    watchSwap(next, job);
    started = true;
  } catch (e) { console.error(`[auto-replace] ${e.message || e}`); }
  finally { replaceTicking = false; if (started) setTimeout(tickReplace, 60_000); }  // the next one a minute after this finishes
}
/* A swap counts only when it ends well: for X and TikTok that is the old booking taken off AND the new one booked. */
async function watchSwap(b, job) {
  const settle = async (j, ms) => { const t0 = Date.now(); while (j && ["queued", "running"].includes(j.status) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 3000)); return j; };
  let end = await settle(job, 3600e3);
  if (end?.status === "done" && UNSCHEDULERS.includes(b.network)) {
    const t0 = Date.now(); let book = null;
    while (!book && Date.now() - t0 < 60e3) { book = jobs.get(`helper-${b.slug}-${b.network}`); if (!book || (book.queued || 0) < (job.queued || 0)) { book = null; await new Promise((r) => setTimeout(r, 2000)); } }
    end = await settle(book, 3600e3);
  }
  const ok = end?.status === "done";
  const err = ok ? "" : (end?.lines || []).slice(-1)[0] || end?.label || end?.status || "did not finish";
  saveAutoReplace(noteResult(autoReplaceState(), b, ok, Date.now(), err));
  if (!ok) writeEvent("note", { text: `The swap of ${b.slug} on ${b.network} did not finish (${String(err).slice(0, 120)}). It is tried again later, at most 3 times.` });
}
setInterval(tickReplace, 5 * 60_000);
setTimeout(tickReplace, 120_000);
if (WATCH_MINUTES > 0) {
  setTimeout(tickWatch, 90_000);  // first look shortly after start, once the helper has loaded
  setInterval(tickWatch, WATCH_MINUTES * 60_000);
  watch.next = Date.now() + 90_000;
}
/* A folder from the page: an absolute path, no control characters, a sane length. */
function folderArg(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return null;
  if (!/^([A-Za-z]:[\\/]|\/)/.test(value)) return null;
  return value;
}
/* A YouTube upload runs beside the render queue (network, not CPU) and reports like a render. */
function startUpload(slug, { at, privacy }) {
  slugGuard(slug);
  const prev = jobs.get(slug);
  if (prev && (prev.status === "queued" || prev.status === "running")) throw new Error(`${slug} is busy: ${prev.label}`);
  const job = { slug, kind: "youtube", status: "running", queued: Date.now(), started: Date.now(), lines: [], stage: 0, stages: 2, done: 0, of: 0, label: "connecting to YouTube" };
  jobs.set(slug, job);
  const args = ["youtube", "upload", slug, "--privacy", privacy || "private", ...(at ? ["--at", at] : [])];
  const child = spawn(PY, ["-m", "studio", ...args], { cwd: ROOT, env: ENV });
  let err = "";
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const stage = /^STAGE (\d+)\/(\d+) (.*)$/.exec(line);
      const step = /^PROGRESS (\d+)\/(\d+) (.*)$/.exec(line);
      if (stage) Object.assign(job, { stage: +stage[1], stages: +stage[2], done: 0, of: 0, label: stage[3] });
      else if (step) Object.assign(job, { done: +step[1], of: +step[2], label: step[3] });
      else if (line.startsWith("RESULT ")) job.result = JSON.parse(line.slice(7));
      else continue;
      broadcast("job", job);
    }
  });
  child.stderr.on("data", (c) => { err += c; });
  child.on("exit", (code) => {
    job.ended = Date.now();
    job.status = code === 0 && job.result ? "done" : "error";
    if (job.status === "done") Object.assign(job, { stage: job.stages, done: 1, of: 1, label: job.result.publishAt ? "scheduled on YouTube" : "on YouTube" });
    else job.lines.push(lastError(err) || "upload failed");
    recordJob(job);
    broadcast("job", job, true);
  });
  return job;
}
/* ---------- the browser helper schedules X, TikTok, Google Maps and LINE posts (server/helper.mjs, docs/helper.md) ----------
   Approved reels only, never twice at the same slot, one helper job at a time (inLane), reported like a render. */
const GBP_LOCATION = String(pick("STUDIO_GBP_LOCATION", "")).replace(/\D/g, "");
const LINKEDIN_PAGE = String(pick("STUDIO_LINKEDIN_PAGE", "")).replace(/\D/g, "");  // the company page LinkedIn posts go to
/** {why} when it must not be scheduled, else {what: {file, text, extra, headline}}. known = {rows, posts} already read. */
async function helperScheduleCheck(slug, network, at, { postId, job, known } = {}) {
  const rows = known?.rows || (await reviewRows());
  const posts = known?.posts || await ask({ cmd: "posts" });
  const draft = rows.find((r) => r.slug === `story-${slug}`) || rows.find((r) => r.slug === slug);
  const prev = jobs.get(`helper-${slug}-${network}`);
  const busy = !!prev && prev !== job && ["queued", "running"].includes(prev.status);
  if (postId !== undefined) {
    const own = posts.find((r) => r.id === postId);
    if (!own || own.slug !== slug || own.network !== network || own.status !== "planned") return { why: `Post ${postId} is not a planned ${network} post of ${slug}.` };
  }
  // A planned reminder this fulfils is not a duplicate of itself.
  const why = scheduleRefusal({ status: draft?.status, slug, network, at, posts: posts.filter((r) => r.id !== postId), busy });
  if (why) return { why };
  const m = manifests().find((x) => x.slug === slug);
  const what = m && postFor(m, network);
  if (!what) return { why: `${slug} has no ${network} file yet: open it and press Prepare files.` };
  if (!allowed(what.file) || !existsSync(what.file)) return { why: `The ${network} file of ${slug} is missing; press Prepare files again.` };
  return { what };
}
function endHelperJob(job, status, message) {
  Object.assign(job, { status, ended: Date.now(), started: job.started || Date.now(), label: message });
  if (status === "done") Object.assign(job, { stage: job.stages, done: 1, of: 1 });
  else job.lines.push(message);
  recordJob(job);
  broadcast("job", job, true);
}
/** Queue one scheduling job. batch: shared by a week's jobs, so one "sign in" stops the rest on that network. */
/* The Chrome link carries files up to 48 MB. Over that, a lighter copy (same size and frame rate, made once) goes
   instead of the job failing; the original is untouched. Sites re-encode what they receive anyway. */
/* A lighter H.264 copy of a reel at kbps (same size and frame rate), without blocking the server; stopped after 10 min.
   Resolves with the copy's path; rejects with ffmpeg's last words. */
function lighterCopy(src, out, kbps, timeoutMs = 600_000) {
  mkdirSync(dirname(out), { recursive: true });
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG, ["-y", "-v", "error", "-i", src, "-c:v", "libx264", "-preset", "medium", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "", late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, timeoutMs);
    child.stderr.on("data", (c) => { err = (err + c).slice(-400); });
    child.on("error", (e) => { clearTimeout(timer); fail(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !late && existsSync(out)) return done(out);
      fail(new Error(late ? `the lighter copy took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped` : `could not make a lighter copy of the video${err.trim() ? `: ${err.trim().slice(-200)}` : ""}`));
    });
  });
}
function chromeSized(file, sec, onLabel) {
  if (statSync(file).size <= 47e6) return Promise.resolve(file);
  const lite = join(RENDERS, "share-cache", `${file.split(/[\\/]/).pop().replace(/\.mp4$/i, "")}_chrome.mp4`);
  if (existsSync(lite) && statSync(lite).mtimeMs >= statSync(file).mtimeMs) return Promise.resolve(lite);
  onLabel("making a lighter copy for Chrome");
  const kbps = Math.max(1500, Math.floor((44 * 8e3) / Math.max(1, sec || 30)) - 160);
  return lighterCopy(file, lite, kbps);
}
function startHelperSchedule({ slug, network, at, what, postId, rehearse = false, batch = null }) {
  const key = `helper-${slug}-${network}`;
  const job = { slug: key, kind: "helper", status: "queued", queued: Date.now(), lines: [], stage: 0, stages: 7, done: 0, of: 0, label: "waiting for the helper" };
  jobs.set(key, job);
  broadcast("job", job, true);
  inLane(async () => {
    if (batch?.signin?.has(network)) return endHelperJob(job, "error", `Sign in to ${network} in the helper window once, then schedule again.`);
    // Checked again at its turn: the log or the review may have changed while it waited.
    const again = await helperScheduleCheck(slug, network, at, { postId, job });
    if (again.why) return endHelperJob(job, "error", again.why);
    Object.assign(job, { status: "running", started: Date.now(), label: `opening ${network}` });
    broadcast("job", job, true);
    const sized = await chromeSized(again.what.file, manifests().find((x) => x.slug === slug)?.durationSec, (label) => { job.label = label; broadcast("job", job); });
    const r = await helperSchedule({ home: HOME_DIR, network, file: sized, text: again.what.text, at, rehearse,
      extra: { ...again.what.extra, ...(GBP_LOCATION ? { location: GBP_LOCATION } : {}), ...(LINKEDIN_PAGE ? { linkedinPage: LINKEDIN_PAGE } : {}) },
      onStep: (label, stage, stages) => { Object.assign(job, { label, stage, stages }); broadcast("job", job); } });
    if (r.state === "signin") batch?.signin?.add(network);
    if (r.state === "scheduled") {
      try {
        const id = postId ?? (await ask({ cmd: "posts", action: "plan", slug, network, at })).id;
        await ask({ cmd: "posts", action: "booked", id, url: r.proof?.url || "", at });
        r.postId = id;
      } catch (e) {
        r.message += ` It is scheduled on the site, but the posting log could not be updated (${String(e.message || e).split(/\r?\n/)[0]}): add it as booked by hand.`;
      }
    }
    job.result = r;
    endHelperJob(job, ["scheduled", "rehearsed"].includes(r.state) ? "done" : "error", r.message);
  }).catch((e) => endHelperJob(job, "error", `The helper stopped: ${String(e.message || e).split(/\r?\n/)[0]}`));
  return job;
}
/* Replace a booking booked in your Chrome: take the old one off the site (helper.unschedule), mark it replaced, then
   book the reel's current render in the same slot (startHelperSchedule). Approved reels only. */
function startHelperReplace({ slug, network, at, postId }) {
  const key = `replace-${slug}-${network}`;
  const job = { slug: key, kind: "helper", status: "queued", queued: Date.now(), lines: [], stage: 0, stages: 5, done: 0, of: 0, label: "waiting for the helper" };
  jobs.set(key, job);
  broadcast("job", job, true);
  inLane(async () => {
    const refusal = approvalRefusal((await reviewRows()), slug);
    if (refusal) return endHelperJob(job, "error", refusal);
    Object.assign(job, { status: "running", started: Date.now(), label: `opening ${network}` });
    broadcast("job", job, true);
    const r = await helperUnschedule({ home: HOME_DIR, network, at, onStep: (label, stage, stages) => { Object.assign(job, { label, stage, stages }); broadcast("job", job); } });
    if (!["removed", "gone"].includes(r.state)) return endHelperJob(job, "error", r.message);
    try { await ask({ cmd: "posts", action: "replaced", id: postId }); } catch (e) { return endHelperJob(job, "error", `${r.message} The log could not mark it replaced (${String(e.message || e).split(/\r?\n/)[0]}).`); }
    job.result = r;
    endHelperJob(job, "done", `${r.message} Booking the new version…`);
    startHelperSchedule({ slug, network, at });
  }).catch((e) => endHelperJob(job, "error", `The helper stopped: ${String(e.message || e).split(/\r?\n/)[0]}`));
  return job;
}
/* Performance from the networks' own pages (TikTok, X, Pinterest, Google Maps, LinkedIn), read in your Chrome by the
   helper: read only. Each reading is stored like /api/perf/manual with source "browser"; one job, in the helper lane. */
const SPECIFIC_POST = /\/status\/\d+|\/pin\/\d+|\/video\/\d+|\/feed\/update\/urn/;
function startPerfBrowser({ networks = [], why = "asked" } = {}) {
  const key = "helper-perf";
  const prev = jobs.get(key);
  if (prev && ["queued", "running"].includes(prev.status)) return prev;
  const job = { slug: key, kind: "helper", status: "queued", queued: Date.now(), lines: [], stage: 0, stages: 2, done: 0, of: 0, label: "waiting for the helper", why };
  jobs.set(key, job);
  broadcast("job", job, true);
  inLane(() => withLimit((async () => {
    Object.assign(job, { status: "running", started: Date.now(), label: "finding the posts that need numbers" });
    broadcast("job", job, true);
    const { needsNumbers = [] } = await perf("needs", networks.length ? { networks } : {});
    const ms = manifests();
    const items = needsNumbers.filter((n) => PERF_NETWORKS.includes(n.network)).map((n) => {
      const what = (() => { try { return postFor(ms.find((m) => m.slug === n.slug), n.network); } catch { return null; } })();
      return { ...n, hint: what?.text?.split("\n").find((l) => l.trim()) || "" };
    });
    if (!items.length) {
      job.result = { stored: [], left: [], summary: "Every post that is out already has its numbers for now." };
      return endHelperJob(job, "done", job.result.summary);
    }
    const read = await readPerf({ home: HOME_DIR, items,
      onStep: (label, stage, stages) => { Object.assign(job, { label, stage, stages }); broadcast("job", job); } });
    const stored = [], left = [];
    for (const r of read) {
      // Found on the network (no numbers yet, or LINE, which has none): the post is out (py/studio/live.py seen).
      if (r.state === "found") await ask({ cmd: "live", action: "seen", id: r.post_id, url: r.page && SPECIFIC_POST.test(r.page) ? r.page : "", source: "found in your Chrome" }).catch(() => {});
      // Not found: marked missing only once it is hours past its time and still booked (live.missing decides).
      if (r.state === "missing") await ask({ cmd: "live", action: "missing", id: r.post_id, why: r.message }).catch(() => {});
      if (r.state !== "read") { left.push({ post_id: r.post_id, network: r.network, slug: r.slug, state: r.state, message: r.message }); continue; }
      try {
        const s = await perf("manual", { post_id: r.post_id, ...r.numbers, source: "browser", note: "read in your Chrome by the helper",
          ...(r.page ? { page: r.page } : {}), ...(r.remote_id ? { remote_id: String(r.remote_id) } : {}) });
        stored.push({ post_id: r.post_id, network: r.network, slug: r.slug, checkpoint: s.stored.checkpoint, ...r.numbers });
        // The log learns the post's own link once (it often holds a profile or a scheduled-list address).
        if (r.page && SPECIFIC_POST.test(r.page) && !SPECIFIC_POST.test(r.url || "")) await ask({ cmd: "posts", action: "link", id: r.post_id, url: r.page }).catch(() => {});
      } catch (e) { left.push({ post_id: r.post_id, network: r.network, slug: r.slug, state: "failed", message: String(e.message || e).split(/\r?\n/)[0] }); }
    }
    // A post that shows no counts yet (state "missing": too new, or the site has not counted it) is not a failure: it
    // is read again on the next hourly round. Only a real problem (sign-in, a failed read) makes the job an error.
    const notYet = left.filter((x) => ["missing", "found", "unreadable"].includes(x.state)).length, real = left.length - notYet;
    const summary = `Read ${stored.length} of ${items.length} post${items.length === 1 ? "" : "s"} in your Chrome`
      + (notYet ? `; ${notYet} not showing numbers yet (read again next hour)` : "") + (real ? `; ${real} not read (see the list)` : "") + ".";
    job.result = { stored, left, summary };
    endHelperJob(job, stored.length || !real ? "done" : "error", summary);
  })(), 15 * 60e3, "Reading the numbers")).catch((e) => endHelperJob(job, "error", `Reading the numbers stopped: ${String(e.message || e).split(/\r?\n/)[0]}`));
  return job;
}
/** The history the Log page reads: one line per finished job (render, sound, upload, footage scan). */
function loadHistory() {
  try {
    return readFileSync(join(RENDERS, "jobs.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-500);
  } catch { return []; }
}
const history = loadHistory();
/* The Problems list: problems.json beside the project's data, checked every 5 minutes and after each job. */
const PROBLEMS = problemStore(join(DATA, "problems.json"));
const PROBLEM_KINDS = { build: "make", remix: "remix", versions: "re-cut", vlog: "long video", vlogup: "upload", publish: "post", upload: "upload" };
/** A job that ended in an error: kept as a problem for a week (or until dismissed), with its last line. */
function noteJobProblem(job) {
  if (job.status !== "error" || job.cancelled) return;
  const what = PROBLEM_KINDS[job.kind] || "job";
  const verUse = /^ver-/.test(job.slug || "") ;
  PROBLEMS.record({
    id: `job:${job.slug}`, level: "red",
    title: verUse ? `The new version of ${job.slug.slice(4)} was not used` : `The ${what} of ${job.slug} did not finish`,
    detail: String((job.lines || []).slice(-1)[0] || job.label || "It stopped with an error.").slice(0, 300),
    fix: verUse ? { label: "Versions", href: "#/versions" } : /^vlog/.test(job.slug || "") ? { label: "Long videos", href: "#/videos" } : { label: "See the log", href: "#/log/activity" },
  });
  setTimeout(() => tickProblems().catch(() => {}), 2000);
}
let problemsRunning = null;
async function tickProblems() {
  if (problemsRunning) return problemsRunning;
  problemsRunning = (async () => {
    const posts = await ask({ cmd: "posts" }).catch(() => []);
    const reviews = await reviewRows().catch(() => []);
    let parts = [];
    try { parts = vlogsView().parts || []; } catch { /* no long videos here */ }
    if (PROBLEMS.checked(findProblems({ posts: Array.isArray(posts) ? posts : [], reviews, parts }))) writeEvent("problems", { count: PROBLEMS.open().length });
  })().finally(() => { problemsRunning = null; });
  return problemsRunning;
}
setTimeout(() => tickProblems().catch((e) => console.error(`[problems] ${e.message || e}`)), 45_000);
setInterval(() => tickProblems().catch((e) => console.error(`[problems] ${e.message || e}`)), 5 * 60_000).unref();
try {  // a project switch, said once in the project it switched to
  const sw = JSON.parse(readFileSync(join(HOME_DIR, "switched.json"), "utf8"));
  unlinkSync(join(HOME_DIR, "switched.json"));
  if (Date.now() - Date.parse(sw.at) < 3600e3) PROBLEMS.record({ id: `switch:${sw.at}`, level: "info", title: `This studio switched from ${sw.from}`,
    detail: `At ${new Date(sw.at).toLocaleString("en-GB")}. The other project's booked posts still go out in the background. Switch back any time from the project menu.`,
    fix: { label: "Projects", href: "#/settings" } }, 2);
} catch { /* no switch */ }

function recordJob(job) {
  noteJobProblem(job);
  const row = {
    slug: job.slug, kind: job.kind, status: job.status, started: new Date(job.started || job.queued).toISOString(),
    ended: new Date(job.ended || Date.now()).toISOString(), seconds: Math.round(((job.ended || Date.now()) - (job.started || job.queued)) / 1000),
    last: job.status === "error" ? (job.lines || []).slice(-1)[0] || "" : job.label || "",
  };
  history.push(row);
  if (history.length > 500) history.shift();
  if (["build", "remix"].includes(job.kind) && job.status === "done") autoScore(job.slug);
  try {
    mkdirSync(RENDERS, { recursive: true });
    appendFileSync(join(RENDERS, "jobs.jsonl"), JSON.stringify(row) + "\n");
  } catch { /* the log is a convenience; a failed write never fails the job */ }
}
/* One open stream per browser tab. The server pushes; the page does not poll. */
const streams = new Set();
let broadcastTimer = null;
function broadcast(event, job, now = false) {
  // Progress of running jobs is sent at most every 200 ms, the newest state of EACH job (several run at once: a render,
  // an AI touch, a swap); a start, an end or an error goes out at once.
  if (event === "job" && !now && job.status === "running") { broadcastPending.set(job.slug, job); if (!broadcastTimer) broadcastTimer = setTimeout(flushBroadcast, 200); return; }
  broadcastPending.delete(job.slug);
  writeEvent(event, jobView(job));
}
const broadcastPending = new Map();
function flushBroadcast() { broadcastTimer = null; for (const j of broadcastPending.values()) writeEvent("job", jobView(j)); broadcastPending.clear(); }
function writeEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}
function jobPct(job) {
  if (!job || job.status === "none") return 0;
  if (job.status === "done") return 100;
  if (job.status !== "running") return 0;
  const frac = job.of ? Math.min(1, job.done / job.of) : 0.04;
  return Math.min(99, Math.round(100 * ((Math.max(job.stage, 1) - 1) + frac) / job.stages));
}
/* Seconds left, from how long this kind of job took before on this machine. A queued job adds the
   time of everything ahead of it, so "about 14 min" on a card is honest. */
function jobEta(job) {
  const typical = medianSeconds(history, job.kind);
  if (job.status === "running") return etaSeconds({ elapsed: (Date.now() - job.started) / 1000, pct: jobPct(job), typical });
  if (job.status !== "queued" || !typical) return null;
  const ahead = queue.indexOf(job);
  const runLeft = running ? jobEta(running) ?? typical : 0;
  return Math.round(runLeft + ahead * typical + typical);
}
function jobView(job) {
  if (!job) return { status: "none" };
  const pos = job.status === "queued" ? queue.indexOf(job) + 1 : 0;
  const from = job.started || job.queued;
  return { slug: job.slug, kind: job.kind, status: job.status, position: pos, stage: job.stage, stages: job.stages,
    done: job.done || 0, of: job.of || 0, pct: jobPct(job), label: job.label, result: job.result || null,
    lines: job.lines.slice(-6), seconds: Math.round(((job.ended || Date.now()) - from) / 1000), eta: jobEta(job),
    cancellable: ["build", "remix"].includes(job.kind) && ["queued", "running"].includes(job.status) };
}

/* ---------- proxies for preview ---------- */
const making = new Map();
function proxyFor(id, path) {
  mkdirSync(PROXIES, { recursive: true });
  const out = join(PROXIES, `${id}.mp4`);
  if (existsSync(out) && statSync(out).size > 0) return Promise.resolve(out);
  if (making.has(id)) return making.get(id);
  const p = new Promise((ok, fail) => {
    const child = spawn(FFMPEG, ["-y", "-i", path, "-vf", "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)',fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-g", "15", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out], { stdio: "ignore", windowsHide: true });
    // A stuck read (a Drive file that never arrives) must not hold this preview, and every later ask for it, forever.
    const timer = setTimeout(() => killTree(child), 15 * 60_000);
    const end = (made) => { clearTimeout(timer); making.delete(id); made ? ok(out) : fail(new Error("proxy failed")); };
    child.on("error", () => end(false));
    child.on("exit", (code) => end(code === 0));
  });
  making.set(id, p);
  return p;
}

/* ---------- health: can this machine run the studio, and is this server current? ---------- */
let encoders = null;
let reelGbCache = { at: 0, value: null };
/* The average size of a finished reel folder (every size, every network package), sampled from the newest eight. */
function reelGb() {
  if (Date.now() - reelGbCache.at < 10 * 60_000) return reelGbCache.value;
  let value = null;
  try {
    const dirs = readdirSync(RENDERS).filter((d) => d.startsWith("story-")).map((d) => join(RENDERS, d))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 8);
    if (dirs.length) value = dirs.reduce((a, d) => a + folderBytes(d), 0) / dirs.length / 1024 ** 3;
  } catch { value = null; }
  reelGbCache = { at: Date.now(), value };
  return value;
}
function healthView() {
  encoders ??= probeEncoders(FFMPEG);
  const facts = systemFacts({ dataDir: DATA, mediaDir: MEDIA, python: PY, ffmpeg: FFMPEG, helper: helperState, helperError, encoders, reelGb: reelGb(), history });
  const current = buildId(SERVED);
  let version = "";
  try { version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; } catch { /* optional */ }
  return {
    build: BUILD, current, stale: current !== BUILD, pageBuild: buildId([PAGE]), version, started: new Date(STARTED).toISOString(), restartPending,
    queue: { running: running ? running.slug : null, queued: queue.length },
    machine: { threads: facts.threads, cpu: facts.cpuModel, ramGb: Math.round(facts.ramGb), platform: facts.platform },
    ...judgeSystem(facts),
  };
}
/* Installable as an app (Chrome/Edge "Install"); icons are the generated Lazycow set in server/brand. */
const MANIFEST = JSON.stringify({
  name: "Lazycow Studio", short_name: "Lazycow", description: "You shot it. Lazycow edits it: ready-to-post Reels, Shorts and TikToks from your own footage, on your own computer.",
  // An app window, not a tab: installed in Chrome or Edge, the header becomes the title bar (editor.html, display-mode).
  start_url: "/", display: "standalone", display_override: ["window-controls-overlay", "standalone"], background_color: "#faf8f1", theme_color: "#15180f",
  icons: [
    { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/brand/lazycow-mark.svg", sizes: "any", type: "image/svg+xml" },
  ],
});
/* Hand the port to a fresh copy of this server (new code on disk), then leave. The new one retries until the port is free. */
function restartSelf() {
  mkdirSync(RENDERS, { recursive: true });
  const log = join(RENDERS, "server.log");
  appendFileSync(log, `\n--- restart requested ${new Date().toISOString()} (was ${BUILD}) ---\n`);
  // The new server writes to server.log, so a start that fails on the new code leaves its reason there.
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [SELF], { cwd: ROOT, env: SHELL_ENV, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  if (helper) killTree(helper);
  server.close();
  for (const res of streams) res.end();
  // The tabs the helper opened in your Chrome close with it (never your own tabs); at most 2 s, then exit regardless.
  Promise.race([closeHelper().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]).finally(() => setTimeout(() => process.exit(0), 300));
}

/* ---------- helpers ---------- */
function manifests() {
  if (!existsSync(RENDERS)) return [];
  const all = readdirSync(RENDERS)
    .filter((d) => d.startsWith("story-") && existsSync(join(RENDERS, d, "manifest.json")))
    .map((d) => JSON.parse(readFileSync(join(RENDERS, d, "manifest.json"), "utf8")));
  return all.sort((a, b) => {
    const ia = HOUSE.indexOf(a.slug), ib = HOUSE.indexOf(b.slug);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.slug.localeCompare(b.slug);
  });
}
/** Every draft's review status. From the running studio service (no Python start-up, nothing blocked); a fresh
    process only if the service cannot answer. */
async function reviewRows() {
  try { const rows = await ask({ cmd: "review_list" }); if (Array.isArray(rows)) return rows; } catch { /* fall back below */ }
  const result = await py(["review-list"]);
  try { return JSON.parse(result.out || "[]"); } catch { return []; }
}
/* Text over 1 KB goes out gzipped when the browser asks for it: the page is ~250 KB and the footage
   list ~700 KB as plain text, a fifth of that compressed. */
const gzipOk = (req) => /\bgzip\b/.test(req?.headers?.["accept-encoding"] || "");
function sendText(res, code, text, headers) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length > 1024 && gzipOk(res.req)) {
    const z = gzipSync(buf, { level: 6 });
    res.writeHead(code, { ...headers, "content-encoding": "gzip", "content-length": z.length, vary: "accept-encoding" });
    return res.end(z);
  }
  res.writeHead(code, { ...headers, "content-length": buf.length });
  res.end(buf);
}
function send(res, code, body, type = "application/json") {
  sendText(res, code, typeof body === "string" ? body : JSON.stringify(body), { "content-type": type });
}
function allowed(path) {
  return insideRoots(path, ALLOWED);
}
/* A card shows a picture about 170px wide; the hook frame is 1080x1920. /file?w= sends a small copy, made once and kept
   under the data folder (keyed by the file's size and time, so a re-rendered reel gets a new one). At most four at a time. */
const THUMBS = join(DATA, "thumbs");
let thumbsBusy = 0;
const thumbsWaiting = [];
function thumbOf(path, width) {
  const full = resolve(path), st = statSync(full);
  const out = join(THUMBS, `${createHash("sha1").update(`${full}|${st.size}|${st.mtimeMs}|${width}`).digest("hex")}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  return new Promise((done) => {
    const run = () => {
      thumbsBusy++;
      mkdirSync(THUMBS, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      const child = spawn(FFMPEG, ["-y", "-v", "error", "-i", full, "-vf", `scale=${width}:-2`, "-frames:v", "1", "-q:v", "5", tmp], { stdio: "ignore", windowsHide: true });
      // Four slots: one stuck ffmpeg must not hold a slot (and every card picture behind it) forever.
      const timer = setTimeout(() => killTree(child), 60_000);
      let ended = false;
      const finish = (made) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        thumbsBusy--;
        thumbsWaiting.shift()?.();
        try { if (made) renameSync(tmp, out); done(made ? out : full); } catch { done(existsSync(out) ? out : full); }
      };
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0 && existsSync(tmp)));
    };
    if (thumbsBusy < 4) run(); else thumbsWaiting.push(run);
  });
}
function sendFile(req, res, path) {
  if (!allowed(path)) return send(res, 403, "outside studio folders", "text/plain");
  const full = resolve(path);
  if (!existsSync(full)) return send(res, 404, "missing", "text/plain");
  const type = TYPES[extname(full).toLowerCase()] || "application/octet-stream";
  const st = statSync(full), size = st.size;
  /* Revalidate by size + mtime (ETag), so a thumbnail is sent once, not on every visit. A URL that carries
     its own version (&v=…) is a new URL whenever the file changes: cache it for good. */
  const etag = `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const versioned = /[?&]v=/.test(req.url || "");
  const cache = versioned ? "public, max-age=31536000, immutable" : "no-cache";
  if (!req.headers.range && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": cache });
    return res.end();
  }
  // A range past the end (or backwards) is 416: it used to write a negative length and leave the request hanging.
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", "content-length": 0 });
    return res.end();
  }
  if (range) {
    const { start, end } = range;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    createReadStream(full, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": cache, etag, "last-modified": st.mtime.toUTCString() });
  createReadStream(full).pipe(res);
}
/* The JSON body as an object ({} when it is not valid JSON or not an object). Over 8 MB answers 413 instead of
   growing a string without limit. */
const body = (req) => readJson(req);

/* Only this machine's browser, on this origin. A page on another site cannot reach the studio
   through DNS rebinding (Host check) or make it act through a cross-site POST (Origin check). */
/* Networks with a one-click sign-in (POST /api/connect/start, GET /oauth/<network>). localhost is in LOCAL_HOST
   on purpose: Facebook's login returns to http://localhost:<port>/oauth/facebook. */
const SIGNIN_NETS = ["bluesky", "facebook"];
// STUDIO_API_TOKEN (optional, .env): every caller must carry it (server/trust.mjs tokenOk). Empty = off, as before.
const API_TOKEN = String(pick("STUDIO_API_TOKEN", "")).trim();
const TRUST = trustRules(PORT, API_TOKEN);
const LOCAL_HOST = TRUST.host;
/* The rules live in server/trust.mjs (tested in test/trust.test.mjs), applied once per request in createServer below.
   GETs from another site's page (an <img>, fetch or EventSource) are refused too; a top-level navigation (a link,
   Google returning to /oauth/youtube) is not. */

/* Hand-off links: the studio page asks for one (POST /api/share) and a network's upload page open in
   this browser fetches that one file, so the video lands in its upload box without a file picker.
   One random token per file, valid 15 minutes, only for files the studio already serves. Nothing else
   is reachable from another site: every other route still answers only the studio's own page. */
const shares = new Map();
function shareLink(path) {
  for (const [t, s] of shares) if (s.until < Date.now()) shares.delete(t);
  const token = randomBytes(24).toString("hex");
  shares.set(token, { path, until: Date.now() + 15 * 60e3 });
  return token;
}
function serveShare(req, res, url) {
  const origin = req.headers.origin || "*";
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-private-network", "true");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "GET", "access-control-allow-headers": "range", "access-control-max-age": "600" });
    return res.end();
  }
  const s = shares.get(url.pathname.split("/")[2] || "");
  if (req.method !== "GET" || !s || s.until < Date.now()) return send(res, 404, "expired or unknown link", "text/plain");
  return sendFile(req, res, s.path);
}

const server = createServer(async (req, res) => {
  // No other site may show the studio inside a frame: a see-through frame could line Approve or Post up under a decoy
  // button (security review 13 Nov). The studio never frames itself.
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  const url = new URL(req.url, "http://127.0.0.1");
  // /api/collect* was renamed /api/intake* (0.12): ad blockers drop any URL ending in /collect as analytics, and the page
  // then thought the studio was down. The old name keeps working for pages and scripts written before the rename.
  if (url.pathname === "/api/collect" || url.pathname.startsWith("/api/collect/")) url.pathname = "/api/intake" + url.pathname.slice(12);
  if (url.pathname.startsWith("/share/") && LOCAL_HOST.test(req.headers.host || "")) return serveShare(req, res, url);
  // With an API token: opening /?token=<token> once (the address printed at start) keeps it in this browser as a cookie.
  if (API_TOKEN && url.pathname === "/" && url.searchParams.has("token") && LOCAL_HOST.test(req.headers.host || "")
      && tokenOk({ authorization: `Bearer ${url.searchParams.get("token")}` }, API_TOKEN)) {
    res.writeHead(303, { location: "/", "set-cookie": `${TOKEN_COOKIE}=${encodeURIComponent(API_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, "cache-control": "no-store" });
    return res.end();
  }
  const why = refusal(req, TRUST);
  if (why === "token") return send(res, 401, { error: "this studio asks for its API token: open the address it printed when it started (…/?token=…), or send Authorization: Bearer <STUDIO_API_TOKEN>" });
  if (why) return send(res, 403, { error: "the studio only answers its own page on this machine" });
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return sendText(res, 200, readFileSync(join(ROOT, "server", "editor.html"), "utf8"), { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-studio-build": BUILD });
    }
    /* The Lazycow icon set (server/brand): favicons, app icons, the mascot, and the web app manifest. */
    if (req.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico" || url.pathname.startsWith("/brand/"))) {
      const name = url.pathname === "/favicon.svg" ? "lazycow-mark.svg" : url.pathname === "/favicon.ico" ? "favicon.ico" : url.pathname.slice(7);
      const full = join(ROOT, "server", "brand", name);
      if (!/^[a-z0-9-]+\.(svg|png|ico)$/.test(name) || !existsSync(full)) return send(res, 404, "no", "text/plain");
      const type = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" }[extname(name).slice(1)];
      res.writeHead(200, { "content-type": type, "cache-control": "max-age=86400" });
      return createReadStream(full).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return send(res, 200, MANIFEST, "application/manifest+json");
    }
    if (req.method === "GET" && url.pathname === "/api/holidays") {
      // Japanese national holidays for the Posting calendar (shared/holidays-jp.json; npm run holidays refreshes it).
      try { return send(res, 200, JSON.parse(readFileSync(join(ROOT, "shared", "holidays-jp.json"), "utf8"))); } catch { return send(res, 200, { days: {} }); }
    }
    if (req.method === "GET" && url.pathname === "/api/about") {
      return send(res, 200, { ...ABOUT, build: BUILD, started: new Date(STARTED).toISOString(), node: process.version, platform: process.platform });
    }
    /* The credits and licence texts themselves, readable from the About window (only these files). */
    if (req.method === "GET" && url.pathname.startsWith("/docs/")) {
      const name = decodeURIComponent(url.pathname.slice(6));
      if (!DOC_FILES.has(name) || !existsSync(join(ROOT, name))) return send(res, 404, "no", "text/plain");
      return sendText(res, 200, readFileSync(join(ROOT, name), "utf8"), { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, healthView());
    }
    if (req.method === "POST" && url.pathname === "/api/restart") {
      const b = await body(req);
      // Every child dies with this process's pipes: an upload or footage import is never cut off, and a
      // render only with force (it is stopped first, so no orphan writes into a reel the new server re-renders).
      const busy = [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running");
      // Reading post numbers only reads pages and runs again every hour: it never holds a restart (a hung read did).
      const other = busy.find((j) => !["build", "remix"].includes(j.kind) && j.slug !== "helper-perf");
      if (other && b.whenIdle === true) {  // wait for it instead of refusing: the studio restarts by itself when it can
        restartPending = true;
        return send(res, 202, { waiting: true, busy: other.slug, kind: other.kind });
      }
      if (other) return send(res, 409, { error: `${other.slug} is busy (${other.kind}: ${other.label}). Restart when it finishes.` });
      // Renders resume after the restart (renders/queue.json), the interrupted one first: no need to wait for them.
      saveQueue(); queueFrozen = true;
      for (const j of busy) { j.cancelled = true; killTree(j.child); }
      send(res, 200, { restarting: true, from: BUILD });
      return restartSelf();
    }
    if (req.method === "POST" && url.pathname === "/api/job/cancel") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "bad slug" });
      return send(res, 200, jobView(cancelJob(b.slug)));
    }
    if (req.method === "GET" && url.pathname === "/api/reels") {
      return send(res, 200, manifests().map((m) => ({ slug: m.slug, title: m.title, durationSec: m.durationSec, house: HOUSE.includes(m.slug) })));
    }
    if (req.method === "GET" && url.pathname === "/api/reel") {
      const slug = url.searchParams.get("slug");
      const m = manifests().find((x) => x.slug === slug);
      if (!m) return send(res, 404, { error: "no such reel" });
      // AI notes from the project (py/studio/ai.py): aiLabel = some note needs the platform's AI label when posted.
      const notes = aiNotes(slug);
      Object.assign(m, notes, { aiLabelNote: notes.aiLabel ? "This reel has AI-made content (an AI voice or an AI-moved photo). Tick the platform's AI label when you post; YouTube's is set on upload. No AI hashtags needed." : null });
      m.review = await ask({ cmd: "review", slug });
      const ids = await ask({ cmd: "ids", paths: m.shots.map((s) => s.path) });
      m.shots.forEach((s) => { s.assetId = ids[s.path]; });
      return send(res, 200, m);
    }
    if (req.method === "GET" && url.pathname === "/api/log") {
      return send(res, 200, await ask({ cmd: "log" }));
    }
    if (req.method === "POST" && url.pathname === "/api/footage/scan") {
      return send(res, 200, jobView(startTask("footage", "scan", ["library", "--ingest", "--scan"])));
    }
    /* Footage folders: browse any drive, discover a folder before adding it, watch for new files. */
    if (req.method === "GET" && url.pathname === "/api/sources") {
      return send(res, 200, { ...(await pyResult(["sources", "list"])), watch: watchView() });
    }
    if (req.method === "GET" && url.pathname === "/api/fs/roots") {
      return send(res, 200, await pyResult(["sources", "roots"]));
    }
    if (req.method === "GET" && url.pathname === "/api/fs/list") {
      const path = folderArg(url.searchParams.get("path"));
      if (!path) return send(res, 400, { error: "folder path" });
      return send(res, 200, await pyResult(["sources", "ls", path]));
    }
    if (req.method === "POST" && url.pathname === "/api/sources/discover") {
      const path = folderArg((await body(req)).path);
      if (!path) return send(res, 400, { error: "folder path" });
      return send(res, 200, jobView(startTask("discover", "discover", ["sources", "discover", path])));
    }
    /* Collect footage from other people (Footage › Collect footage): the drop box for phones on this Wi-Fi, and a
       Google Form whose uploads land in the owner's Drive. Neither uses the senders' storage. */
    if (req.method === "GET" && url.pathname === "/api/intake") {
      const saved = readCollect();
      return send(res, 200, { drop: dropState(), types: DROP_TYPES, inbox: COLLECT_INBOX, form: { url: saved.formUrl || "" } });
    }
    if (req.method === "POST" && url.pathname === "/api/intake/drop") {
      const b = await body(req);
      if (b.open === false) return send(res, 200, { drop: closeDrop() });
      try { return send(res, 200, { drop: openDrop({ hours: b.hours, inbox: COLLECT_INBOX, place: WORKSPACE, onFiles: () => { startWatch("collected footage"); writeEvent("collect", dropState()); } }) }); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    /* Files dragged from this computer onto the studio page: saved to the collected-footage inbox (a folder per day),
       then catalogued once the drops go quiet. Same types and limits as the drop box. */
    if (req.method === "POST" && url.pathname === "/api/footage/upload") {
      const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      return saveUpload(req, res, { inbox: COLLECT_INBOX, name: url.searchParams.get("name") || "", folder: `${day}_dropped`,
        reply: (code, msg) => send(res, code, { error: msg }),
        onSaved: () => { clearTimeout(dropQuiet); dropQuiet = setTimeout(() => { startWatch("dropped footage"); writeEvent("note", { text: "Footage dropped on the studio page is being catalogued." }); }, 20e3); } });
    }
    if (req.method === "POST" && url.pathname === "/api/intake/form") {
      const b = await body(req);
      const u = String(b.url || "").trim();
      if (u && !/^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)[^\s]{4,300}$/.test(u)) return send(res, 400, { error: "a Google Forms link (https://forms.gle/… or https://docs.google.com/forms/…)" });
      const saved = readCollect();
      writeFileSync(COLLECT_FILE, JSON.stringify({ ...saved, formUrl: u }, null, 2));
      return send(res, 200, { form: { url: u } });
    }
    if (req.method === "GET" && url.pathname === "/api/intake/qr") {
      // A QR code for a link the page shows (the drop box or the form), as SVG.
      const u = url.searchParams.get("u") || "";
      if (!/^https?:\/\/[^\s]{4,400}$/.test(u)) return send(res, 400, { error: "link" });
      const q = qrcode(0, "M"); q.addData(u); q.make();
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
    }
    if (req.method === "POST" && url.pathname === "/api/sources/add") {
      const b = await body(req);
      const path = folderArg(b.path);
      if (!path || !["gps", "trusted"].includes(b.mode)) return send(res, 400, { error: "folder path and mode" });
      // --label=<text> keeps a label that starts with "-" a value, not an option.
      const row = await pyResult(["sources", "add", path, "--mode", b.mode, ...(b.label ? [`--label=${String(b.label).replace(/[\u0000-\u001f]/g, " ").slice(0, 80)}`] : [])]);
      startWatch("added a folder");
      return send(res, 200, row);
    }
    if (req.method === "POST" && url.pathname === "/api/sources/remove") {
      const path = folderArg((await body(req)).path);
      if (!path) return send(res, 400, { error: "folder path" });
      return send(res, 200, await pyResult(["sources", "remove", path]));
    }
    if (req.method === "POST" && url.pathname === "/api/sources/watch") {
      return send(res, 200, jobView(startWatch("asked")));
    }
    /* Google Photos: the Picker API. The owner picks items in Google Photos; the studio downloads them. */
    if (req.method === "GET" && url.pathname === "/api/gphotos") {
      return send(res, 200, await pyResult(["gphotos", "status"]));
    }
    if (req.method === "GET" && url.pathname === "/api/gphotos/connect") {
      const { url: to } = await pyResult(["gphotos", "auth-url"]);
      res.writeHead(302, { location: to });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/oauth/gphotos") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      let note;
      try {
        if (url.searchParams.get("error") || !code) throw new Error(url.searchParams.get("error") || "no code from Google");
        await pyResult(["gphotos", "exchange", `--code=${code}`, `--state=${state || ""}`]);
        note = "gphotos=connected";
      } catch (err) { note = `ytError=${encodeURIComponent(String(err.message || err).slice(0, 200))}`; }
      res.writeHead(302, { location: `/?${note}#/footage` });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/gphotos/session") {
      return send(res, 200, await pyResult(["gphotos", "session"]));
    }
    if (req.method === "GET" && url.pathname === "/api/gphotos/session") {
      const id = url.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_-]{6,200}$/.test(id)) return send(res, 400, { error: "session id" });
      return send(res, 200, await pyResult(["gphotos", "poll", "--id", id]));
    }
    if (req.method === "POST" && url.pathname === "/api/gphotos/import") {
      const b = await body(req);
      if (!/^[A-Za-z0-9_-]{6,200}$/.test(b.id || "")) return send(res, 400, { error: "session id" });
      return send(res, 200, jobView(startTask("gphotos", "import", ["gphotos", "import", "--id", b.id], (job) => {
        const n = job.result?.downloaded ?? job.result?.added ?? 0;
        if (n > 0) autoDrafts(`${n} items from Google Photos`);
      })));
    }
    if (req.method === "GET" && url.pathname === "/api/spec") {
      return send(res, 200, readFileSync(join(ROOT, "shared", "spec.json"), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/typekits") {  // type pairings, colours, word motions, grades (the editor's pickers)
      return send(res, 200, readFileSync(join(ROOT, "shared", "type-kits.json"), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/channels") {
      return send(res, 200, channelsView());
    }
    /* Per-network playbooks (shared/playbooks.json, from docs/research/2026-11-09-channel-playbooks.md):
       format, caption, hashtags, best time, profile and comment rules, shown on Accounts and in the post panel. */
    if (req.method === "GET" && url.pathname === "/api/playbooks") {
      try { return send(res, 200, JSON.parse(readFileSync(join(ROOT, "shared", "playbooks.json"), "utf8"))); }
      catch { return send(res, 200, { playbooks: [] }); }
    }
    if (req.method === "GET" && url.pathname === "/api/words") {
      try { return send(res, 200, await words("report")); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/words") {
      // {action: "add", kind, ja, en} · {action: "status", ja, status: approved|retired} · {action: "suggest", n?, topic?}
      const b = await body(req);
      const action = String(b.action || "");
      if (!["add", "status", "suggest"].includes(action)) return send(res, 400, { error: "action: add, status or suggest" });
      const text = (v, n) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f]/g, "").slice(0, n);
      const input = action === "add" ? { kind: b.kind === "hook" ? "hook" : "line", ja: text(b.ja, 80), en: text(b.en, 200), status: b.status === "suggested" ? "suggested" : "approved" }
        : action === "status" ? { ja: text(b.ja, 80), status: ["approved", "retired", "suggested"].includes(b.status) ? b.status : "approved" }
        : { n: Math.max(2, Math.min(12, Number(b.n) || 8)), topic: text(b.topic, 60) };
      try { return send(res, 200, await words(action, input, action === "suggest" ? 120_000 : 30_000)); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/words/reword") {
      // New approved words for one reel (same shots). Saved without rendering; Save & render sends it back to review.
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "slug" });
      try { return send(res, 200, await words("reword", { slug: b.slug, preview: b.preview === true, seed: Number.isInteger(b.seed) ? b.seed : undefined })); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/channels/set") {
      const b = await body(req);
      if (!NET_RX.test(b.id || "") || !channelsView().channels.some((c) => c.id === b.id)) return send(res, 400, { error: "network id" });
      setNetwork(b.id, { on: typeof b.on === "boolean" ? b.on : undefined, account: typeof b.account === "string" ? b.account : undefined });
      return send(res, 200, channelsView());
    }
    /* ---------- projects (workspaces) ---------- */
    /* Long videos (py/studio/vlog.py): plan a trip into parts, build each part, watch it, copy its YouTube text. */
    if (req.method === "GET" && url.pathname === "/api/vlogs") return send(res, 200, vlogsView());
    /* The Problems list (server/problems.mjs): what went wrong, kept until it is fixed. */
    if (req.method === "GET" && url.pathname === "/api/problems") {
      if (url.searchParams.get("fresh") === "1") await tickProblems();
      return send(res, 200, { items: PROBLEMS.open() });
    }
    if (req.method === "POST" && url.pathname === "/api/problems/dismiss") {
      const b = await body(req);
      if (typeof b.id !== "string" || b.id.length > 200) return send(res, 400, { error: "id" });
      const done = PROBLEMS.dismiss(b.id);
      if (done === "missing") return send(res, 404, { error: "No such problem (it may be fixed already)." });
      if (!done) return send(res, 409, { error: "This one can only be fixed, not dismissed: it is about something that has not happened yet." });
      writeEvent("problems", { count: PROBLEMS.open().length });
      return send(res, 200, { items: PROBLEMS.open() });
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/youtube") {
      /* Long videos to YouTube. {settings}: which account, who can see them (private, unlisted, public) and an optional
         schedule (public from startAt, one part every everyDays days), kept per project. {upload: [n, ...]}: upload
         those parts one after another with the saved settings. */
      const b = await body(req);
      if (b.settings) {
        const s = b.settings, out = vlogYtSettings();
        if (s.account != null) { if (!/^(main|a\d{1,3})$/.test(s.account)) return send(res, 400, { error: "account" }); out.account = s.account; }
        if (s.privacy != null) { if (!["private", "unlisted", "public"].includes(s.privacy)) return send(res, 400, { error: "privacy: private, unlisted or public" }); out.privacy = s.privacy; }
        if (s.schedule != null) out.schedule = s.schedule === true;
        if (s.startAt != null) { if (s.startAt && !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(s.startAt)) return send(res, 400, { error: "startAt: YYYY-MM-DDTHH:MM" }); out.startAt = s.startAt; }
        if (s.everyDays != null) { const d = Number(s.everyDays); if (!Number.isInteger(d) || d < 1 || d > 60) return send(res, 400, { error: "everyDays: 1 to 60" }); out.everyDays = d; }
        if (s.ticks != null) {  // the "Do in YouTube Studio" checklist: which steps the person has done
          if (typeof s.ticks !== "object" || Array.isArray(s.ticks)) return send(res, 400, { error: "ticks: { step: true or false }" });
          for (const [k, v] of Object.entries(s.ticks)) {
            if (!/^(playlist|series|p\d{1,2}-(end|pin|shorts|public))$/.test(k) || typeof v !== "boolean") return send(res, 400, { error: `ticks: ${k}` });
            out.ticks = { ...(out.ticks || {}), [k]: v };
          }
        }
        writeFileSync(join(DATA, "vlog-youtube.json"), JSON.stringify(out, null, 1));
        return send(res, 200, out);
      }
      const parts = Array.isArray(b.upload) ? [...new Set(b.upload)].filter((n) => Number.isInteger(n) && n >= 1 && n <= VLOG_MAX).sort((a, b) => a - b) : [];
      if (!parts.length) return send(res, 400, { error: "upload: the part numbers" });
      if ([...jobs.values()].some((j) => /^ytvlog-/.test(j.slug) && ["queued", "running"].includes(j.status))) return send(res, 409, { error: "Long videos are being uploaded; wait for them to finish." });
      // Only a part built from the current plan goes up: one made before the plan changed is an old cut (13 Nov: the
      // page offered "Upload 4 ready parts" for four greyed-out builds of the earlier 13-part plan).
      const view = vlogsView(), madePlan = view.plan?.made || "";
      const old = parts.filter((n) => { const p = view.parts.find((q) => q.n === n); return !p?.built || (madePlan && p.built.made && p.built.made < madePlan); });
      if (old.length) return send(res, 409, { error: `Part${old.length > 1 ? "s" : ""} ${old.join(", ")} ${old.length > 1 ? "are" : "is"} not built from the current plan yet. Build ${old.length > 1 ? "them" : "it"} first.` });
      const s = vlogYtSettings(), plan = [];
      let at = s.schedule && s.startAt ? new Date(s.startAt) : null;
      if (at && at.getTime() < Date.now() + 20 * 60e3) return send(res, 400, { error: "The first publish time must be at least 20 minutes from now." });
      for (const n of parts) {
        plan.push({ n, at: at ? wallIso(at) : null });
        if (at) at = new Date(at.getTime() + s.everyDays * 864e5);
      }
      uploadVlogs(plan, s);
      return send(res, 200, { started: plan, settings: s });
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/series-links") {
      /* Once every part of a series is on YouTube: the series playlist in order and each description's links to the
         part before, the part after and the playlist (youtube link-series). {comments: true}: one comment on each part,
         "Part n of N. Next: ...", for the person to pin in YouTube Studio. {dryRun: true}: what would be sent. */
      const b = await body(req);
      if ([...jobs.values()].some((j) => /^ytvlog-/.test(j.slug) && ["queued", "running"].includes(j.status))) return send(res, 409, { error: "Long videos are being uploaded; wait for them to finish." });
      const s = vlogYtSettings(), title = b.title ? cleanTitle(b.title) : "";
      const args = ["youtube", b.comments === true ? "series-comments" : "link-series", "--account", s.account,
        ...(title && b.comments !== true ? ["--playlist-title", title] : []), ...(b.dryRun === true ? ["--dry-run"] : [])];
      try { return send(res, 200, await pyResult(args, null, 180_000)); }
      catch (err) { return send(res, 400, { error: String(err.message || err).split(/\r?\n/)[0] }); }
    }
    if (req.method === "GET" && url.pathname === "/api/vlogs/suggest") {
      const style = url.searchParams.get("style") || "calm";
      if (!VLOG_STYLES.includes(style)) return send(res, 400, { error: `style: ${VLOG_STYLES.join(", ")}` });
      const tq = url.searchParams.get("target"), target = tq == null || tq === "" ? null : Number(tq);
      if (target != null && !(Number.isFinite(target) && target >= 5 && target <= 15)) return send(res, 400, { error: "target: 5 to 15 minutes per episode" });
      return send(res, 200, await vlogSuggest(style, target));
    }
    if (req.method === "GET" && url.pathname === "/api/vlogs/trip") return send(res, 200, vlogTrip());
    /* Google Maps Timeline (py/studio/timeline.py): the export streams into DATA/timeline-inbox, is read into the slim
       vlog-timeline.json (the trip's days only, no home or work, no raw signals) and is always deleted. Local only. */
    if (req.method === "GET" && url.pathname === "/api/vlogs/timeline") {
      try { return send(res, 200, await pyResult(["timeline", "show"])); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/timeline") {
      const MAX = 600 * 1024 * 1024;
      const size = Number(req.headers["content-length"] || 0);
      if (!size) return send(res, 411, { error: "No file." });
      if (size > MAX) return send(res, 413, { error: "That file is over 600 MB. Export only the trip's months, or ask on GitHub." });
      const inbox = join(DATA, "timeline-inbox");
      mkdirSync(inbox, { recursive: true });
      const name = String(url.searchParams.get("name") || "timeline.json").toLowerCase().endsWith(".gpx") ? ".gpx" : ".json";
      const file = join(inbox, `${randomBytes(8).toString("hex")}${name}`);
      try {
        await new Promise((ok, fail) => {
          let got = 0;
          const ws = createWriteStream(file);
          req.on("data", (c) => { got += c.length; if (got > MAX) { req.destroy(); fail(Object.assign(new Error("too big"), { status: 413 })); } });
          req.on("error", fail); ws.on("error", fail); ws.on("finish", ok);
          req.pipe(ws);
        });
        const args = ["timeline", "import", "--file", file];
        if (DAY_RX.test(url.searchParams.get("from") || "") && DAY_RX.test(url.searchParams.get("to") || "")) args.push(`--from=${url.searchParams.get("from")}`, `--to=${url.searchParams.get("to")}`);
        const r = await pyResult(args, null, 10 * 60_000);
        suggestCache = new Map();
        return send(res, 200, r);
      } catch (e) {
        return send(res, e.status || 400, { error: String(e.message || e).replace(/^\w*Error: /, "").replace(/[A-Z]:\\[^\s"]+/g, "the file") });  // no paths, no coordinates
      } finally {
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/timeline/choose") {
      const b = await body(req);
      const changes = (Array.isArray(b.changes) ? b.changes : []).slice(0, 2000).filter((c) => c && DAY_RX.test(String(c.day || "")) && /^v\d{1,6}$/.test(String(c.id || "")))
        .map((c) => ({ day: c.day, id: c.id, ...(c.name !== undefined ? { name: cleanName(String(c.name)).slice(0, 60) } : {}), ...(c.show !== undefined ? { show: !!c.show } : {}) }));
      try { const r = await pyResult(["timeline", "choose", `--json=${JSON.stringify(changes)}`]); suggestCache = new Map(); return send(res, 200, r); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/timeline/forget") {
      try { const r = await pyResult(["timeline", "forget"]); suggestCache = new Map(); return send(res, 200, r); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/places") {
      // Places read from signs in each day's pictures (vision model, about $0.003 a day): hints the person accepts or edits.
      const r = await pyResult(["vlog", "places"], null, 600_000);
      suggestCache = new Map();
      return send(res, 200, { ...r, trip: vlogTrip() });
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/trip") {
      const b = await body(req), t = vlogTrip();
      for (const [day, place] of Object.entries(b.places || {})) {
        if (!DAY_RX.test(day)) return send(res, 400, { error: `places: ${day} is not a day (YYYY-MM-DD)` });
        const v = cleanName(String(place || "")).slice(0, 60);
        if (v) t.places[day] = v; else delete t.places[day];
      }
      for (const [day, text] of Object.entries(b.moments || {})) {
        // What happened that day, in the person's words: names and captions may use it where the pictures show it.
        if (!DAY_RX.test(day)) return send(res, 400, { error: `moments: ${day} is not a day (YYYY-MM-DD)` });
        const v = cleanName(String(text || "")).slice(0, 80);
        if (v) t.moments[day] = v; else delete t.moments[day];
      }
      if (b.target != null) {  // "Length of each episode": minutes, 5 to 15
        const m = Number(b.target);
        if (!Number.isFinite(m) || m < 5 || m > 15) return send(res, 400, { error: "target: 5 to 15 minutes per episode" });
        t.target = Math.round(m * 2) / 2;
      }
      for (const [day, c] of Object.entries(b.countries || {})) {
        // The country each day was in, for the maps and the place tags; the map pin follows the place by itself.
        if (!DAY_RX.test(day)) return send(res, 400, { error: `countries: ${day} is not a day (YYYY-MM-DD)` });
        const raw = cleanName(String(c || "")), name = raw ? countryName(raw) : "";
        if (raw && !name) return send(res, 400, { error: `countries: "${raw}" is not a country name as on a map (Kenya, Tanzania, Qatar, ...) or a 2-letter code` });
        const r = { ...(t.route[day] || {}) };
        if (name) r.country = name; else delete r.country;
        if (Object.keys(r).length) t.route[day] = r; else delete t.route[day];
      }
      for (const [day, r] of Object.entries(b.route || {})) {
        // A position the person knows better than the studio's pin: lat -90..90, lon -180..180 (null clears it).
        if (!DAY_RX.test(day) || !r || typeof r !== "object") return send(res, 400, { error: `route: ${day} is not a day (YYYY-MM-DD)` });
        const cur = { ...(t.route[day] || {}) };
        for (const [k, lo, hi] of [["lat", -90, 90], ["lon", -180, 180]]) {
          if (r[k] === null) { delete cur[k]; continue; }
          if (r[k] === undefined) continue;
          if (!Number.isFinite(r[k]) || r[k] < lo || r[k] > hi) return send(res, 400, { error: `route: ${k} must be ${lo} to ${hi}` });
          cur[k] = Math.round(r[k] * 1e4) / 1e4;
        }
        if (Object.keys(cur).length) t.route[day] = cur; else delete t.route[day];
      }
      if (typeof b.personal === "boolean") t.personal = b.personal;
      if (typeof b.privateOk === "boolean") t.privateOk = b.privateOk;  // pictures that look private (a hospital bed, a passport) may be used
      for (const k of ["places", "animals", "captions"]) if (typeof b.overlays?.[k] === "boolean") t.overlays[k] = b.overlays[k];
      writeFileSync(join(DATA, "vlog-trip.json"), JSON.stringify(t, null, 1));  // hints (from signs) are kept as they were
      suggestCache = new Map();  // the places show in the suggestions
      return send(res, 200, t);
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/plan") {
      const b = await body(req);
      if (b.extend === true) {
        // More videos on the plan there is (one per look it does not have yet); the built ones stay as they are.
        if (vlogBusy()) return send(res, 409, { error: "A long video is being planned or built; wait for it to finish." });
        const had = vlogsView().parts.length;
        if (!had) return send(res, 400, { error: "Plan the long videos first." });
        if (had >= VLOG_MAX) return send(res, 400, { error: `A plan holds at most ${VLOG_MAX} videos.` });
        suggestCache = new Map();
        return send(res, 200, jobView(startTask("vlog-plan", "vlog", ["vlog", "extend", ...(b.fresh === true ? ["--fresh"] : [])], b.build ? () => { const now = vlogsView().parts.length; if (now > had) buildVlogs(had + 1, now); } : null)));
      }
      if (b.series === true) {
        // A series: even episodes of the person's length, each day once, in story order, one look (vlog plan --series).
        const target = b.target == null ? vlogTrip().target : Number(b.target);
        if (!Number.isFinite(target) || target < 5 || target > 15) return send(res, 400, { error: "target: 5 to 15 minutes per episode" });
        const titles = b.titles == null ? null : b.titles;
        if (titles && (!Array.isArray(titles) || titles.length > 8 || !titles.every((x) => typeof x === "string" && x.length <= 70)))
          return send(res, 400, { error: "titles: up to 8 episode titles of at most 70 characters, in order" });
        if (vlogBusy()) return send(res, 409, { error: "A long video is being planned or built; wait for it to finish." });
        const name = cleanName(b.name || "");
        const args = ["vlog", "plan", "--series", "--target", String(target), ...(name ? ["--name", name] : []), ...(titles ? ["--titles", JSON.stringify(titles.map(cleanTitle))] : [])];
        suggestCache = new Map();
        return send(res, 200, jobView(startTask("vlog-plan", "vlog", args, b.build ? () => buildVlogs(1, vlogsView().parts.length || 1) : null)));
      }
      const style = b.style == null ? null : String(b.style);
      if (style && !VLOG_STYLES.includes(style)) return send(res, 400, { error: `style: ${VLOG_STYLES.join(", ")}` });
      const groups = b.groups == null ? null : b.groups;
      if (groups && (!Array.isArray(groups) || !groups.length || groups.length > 8 || !groups.every((g) => Array.isArray(g) && g.length && g.every((d) => DAY_RX.test(String(d))))))
        return send(res, 400, { error: "groups: 1 to 8 lists of days (YYYY-MM-DD)" });
      const lengths = b.lengths == null ? null : b.lengths;
      if (lengths && (!Array.isArray(lengths) || lengths.length !== (groups || []).length || !lengths.every((m) => Number.isFinite(m) && m >= 3 && m <= 15)))
        return send(res, 400, { error: "lengths: minutes per part (3 to 15), one per group" });
      const looks = b.looks == null ? null : b.looks;
      if (looks && (!Array.isArray(looks) || looks.length !== (groups || []).length || !looks.every((l) => VLOG_STYLES.includes(String(l)))))
        return send(res, 400, { error: `looks: one per group, each one of ${VLOG_STYLES.slice(0, 9).join(", ")}` });
      const parts = groups ? groups.length : Number(b.parts), minutes = groups ? 8 : Number(b.minutes);
      if (!Number.isInteger(parts) || parts < 1 || parts > 8) return send(res, 400, { error: "parts: 1 to 8" });
      if (!Number.isFinite(minutes) || minutes < 3 || minutes > 15) return send(res, 400, { error: "minutes: 3 to 15" });
      if (vlogBusy()) return send(res, 409, { error: "A long video is being planned or built; wait for it to finish." });
      const name = cleanName(b.name || "");
      const args = ["vlog", "plan", "--parts", String(parts), "--minutes", String(minutes), ...(name ? ["--name", name] : []), ...(style ? ["--style", style] : []),
        ...(groups ? ["--groups", JSON.stringify(groups)] : []), ...(lengths ? ["--lengths", JSON.stringify(lengths)] : []), ...(looks ? ["--looks", JSON.stringify(looks)] : []),
        ...(b.more === true ? ["--more"] : [])];  // more: the four films cut by theme join the plan
      // "build": plan, then build every part in turn (the person picked a suggestion and pressed one button).
      return send(res, 200, jobView(startTask("vlog-plan", "vlog", args, b.build ? () => buildVlogs(1, vlogsView().parts.length || parts) : null)));
    }
    if (req.method === "POST" && url.pathname === "/api/vlogs/build") {
      const b = await body(req);
      if (b.all === true) {
        if (vlogBusy()) return send(res, 409, { error: "A long video is being planned or built; wait for it to finish." });
        const n = vlogsView().parts.length;
        if (!n) return send(res, 400, { error: "Plan the long videos first." });
        return send(res, 200, jobView(buildVlogs(1, n)));
      }
      if (!Number.isInteger(b.n) || b.n < 1 || b.n > VLOG_MAX) return send(res, 400, { error: "n: the part number" });
      if (vlogBusy()) return send(res, 409, { error: "A long video is being planned or built; wait for it to finish." });
      return send(res, 200, jobView(startTask(`vlog-${b.n}`, "vlog", ["vlog", "build", String(b.n)])));
    }
    if (req.method === "GET" && url.pathname === "/api/vlogs/file") {
      const n = Number(url.searchParams.get("n")), kind = url.searchParams.get("kind");
      if (!Number.isInteger(n) || n < 1 || n > VLOG_MAX || !["master", "thumb", "srt"].includes(kind)) return send(res, 400, "n and kind", "text/plain");
      return sendFile(req, res, join(RENDERS, "vlogs", `vlog-${n}`, { thumb: "thumbnail.jpg", srt: "subtitles.srt", master: "master.mp4" }[kind]));
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      return send(res, 200, workspacesView());
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const b = await body(req);
      const made = createWorkspace(b);
      return send(res, 200, { made: made.id, ...workspacesView() });
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces/export") {
      const out = exportProject();
      const file = (out.name || "project").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.lazycow.json"`, "Cache-Control": "no-store" });
      return res.end(JSON.stringify(out, null, 1));
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/import") {
      try {
        const b = await bigBody(req, 20 * 1024 * 1024);
        return send(res, 200, { ...importProject(b.bundle, b.name), ...workspacesView() });
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/edit") {
      const b = await body(req);
      const w = readWorkspaces();
      let x = w.list.find((y) => y.id === b.id);
      if (!x && b.id === "main") { x = { id: "main", env: {} }; w.list.unshift(x); }
      if (!x) return send(res, 404, { error: "no such project" });
      if (b.name !== undefined) {
        const n = cleanName(b.name);
        if (!n) return send(res, 400, { error: "A project needs a name.", code: "no_name" });
        x.name = n; if (x.id !== "main") x.env.STUDIO_WORKSPACE = n;
      }
      if (WS_COLORS.includes(b.color)) x.color = b.color;
      writeWorkspaces(w);
      return send(res, 200, workspacesView());
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/forget") {
      // Takes the project off the list; its folders and files stay where they are.
      const b = await body(req);
      const w = readWorkspaces();
      if (b.id === "main" || b.id === (ACTIVE_WS?.id || "main")) return send(res, 400, { error: "switch to another project first; the main one stays" });
      w.list = w.list.filter((y) => y.id !== b.id);
      writeWorkspaces(w);
      return send(res, 200, workspacesView());
    }
    /* Switch project. A render or upload in flight is never cut off: with jobs running the switch waits for them
       (whenIdle, the page's default) and happens by itself when the last one ends; {cancel: true} drops a waiting one. */
    if (req.method === "POST" && url.pathname === "/api/workspaces/switch") {
      const b = await body(req);
      if (PINNED) return send(res, 409, { error: `This studio is pinned to the project ${PINNED} (STUDIO_PROJECT); switch in the main studio.` });
      if (b.cancel === true) { setPending(null); return send(res, 200, workspacesView()); }
      const w = readWorkspaces();
      if (b.id !== "main" && !w.list.some((y) => y.id === b.id)) return send(res, 404, { error: "no such project" });
      const busy = [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running");
      if (busy.length && b.whenIdle === true) {
        setPending({ id: b.id, since: new Date().toISOString() });
        return send(res, 202, { waiting: busy.length, first: `${busy[0].slug}: ${busy[0].label}`, ...workspacesView() });
      }
      if (busy.length) return send(res, 409, { error: `${busy.length} job${busy.length === 1 ? " is" : "s are"} still running (${busy[0].slug}: ${busy[0].label}). Switch when they finish, or stop them first.`, busy: busy.length });
      setPending(null);
      const fromName = w.list.find((y) => y.id === w.active)?.name || (w.active === "main" || !w.active ? "the main project" : w.active);
      w.active = b.id;
      writeWorkspaces(w);
      // Said on the other side of the restart (startup reads it): which project, when, and that bookings carry on.
      try { writeFileSync(join(HOME_DIR, "switched.json"), JSON.stringify({ from: fromName, to: b.id, at: new Date().toISOString() })); } catch { /* informational */ }
      send(res, 200, { switching: b.id });
      return restartSelf();
    }
    /* ---------- accounts and posting from the studio ---------- */
    if (req.method === "GET" && url.pathname === "/api/connections") {
      return send(res, 200, await ask({ cmd: "connections", port: PORT }));
    }
    /* One-click connect (Bluesky, Facebook): Python asks the network for its own sign-in page and returns the
       address; the browser goes there and the network sends it back to /oauth/<network>. Pending sign-ins live
       10 minutes in Python's secrets folder, so a helper restart in between does not lose them. */
    if (req.method === "POST" && url.pathname === "/api/connect/start") {
      const b = await body(req);
      if (!SIGNIN_NETS.includes(b.network)) return send(res, 400, { error: "network" });
      const handle = typeof b.handle === "string" ? b.handle.trim().slice(0, 253) : "";
      return send(res, 200, await ask({ cmd: "connections", action: "start", network: b.network, fields: { handle }, port: PORT }));
    }
    /* The one-time setup a button needs first (Facebook: the owner's Meta app ID and secret). */
    if (req.method === "POST" && url.pathname === "/api/connect/setup") {
      const b = await body(req);
      if (b.network !== "facebook") return send(res, 400, { error: "network" });
      const fields = {};
      for (const k of ["app_id", "app_secret"]) {
        const v = b.fields?.[k];
        if (typeof v !== "string" || v.length > 200) return send(res, 400, { error: "fields" });
        fields[k] = v;
      }
      return send(res, 200, await ask({ cmd: "connections", action: "setup", network: b.network, fields, port: PORT }));
    }
    /* The network sends the browser back here. Facebook returns to http://localhost:<port> (Meta allows localhost
       for apps in development mode), Bluesky to 127.0.0.1; both land on the studio's own Accounts page. */
    const back = /^\/oauth\/(bluesky|facebook)$/.exec(url.pathname);
    if (req.method === "GET" && back) {
      const net = back[1], params = {};
      for (const k of ["code", "state", "iss", "error", "error_description", "error_reason"]) {
        const v = url.searchParams.get(k);
        if (v != null) params[k] = v.slice(0, 2000);
      }
      let to;
      try {
        await ask({ cmd: "connections", action: "finish", network: net, params, port: PORT });
        to = `#/accounts?connected=${net}`;
      } catch (err) {
        to = `#/accounts?connectError=${net}&why=${encodeURIComponent(String(err.message || err).replace(/^\w*Error: /, "").slice(0, 600))}`;
      }
      res.writeHead(302, { location: `http://127.0.0.1:${PORT}/${to}`, "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/connections") {
      const b = await body(req);
      if (!NET_RX.test(b.network || "")) return send(res, 400, { error: "network" });
      const fields = {};
      for (const [k, v] of Object.entries(b.fields || {})) {
        if (!/^[a-z_]{1,30}$/.test(k) || typeof v !== "string" || v.length > 4000) return send(res, 400, { error: "fields" });
        fields[k] = v;
      }
      return send(res, 200, await ask({ cmd: "connections", action: b.remove ? "disconnect" : "connect", network: b.network, fields }));
    }
    if (req.method === "GET" && url.pathname === "/api/profiles") {
      return send(res, 200, await ask({ cmd: "profiles" }));
    }
    if (req.method === "POST" && url.pathname === "/api/publish") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.network || "")) return send(res, 400, { error: "slug and network" });
      if (b.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}([+-]\d{2}:\d{2})?$/.test(b.at)) return send(res, 400, { error: "time: YYYY-MM-DDTHH:MM, optionally with +HH:MM" });
      // Refused here with a plain 409, not only later inside the job (publish.assert_approved checks again).
      const unapproved = approvalRefusal((await reviewRows()), b.slug);
      if (unapproved) return send(res, 409, { error: unapproved });
      const args = ["publish", b.slug, b.network];
      if (b.at) args.push("--at", b.at);
      if (Number.isInteger(b.id)) args.push("--id", String(b.id));
      return send(res, 200, jobView(startTask(`post-${b.slug}-${b.network}`, "post", args)));
    }
    /* Bookings holding older words, grouped by why; the switch that swaps them by itself. */
    /* Runs by itself: what it does, when it last ran, what it found; change it; run a part now. */
    if (req.method === "GET" && url.pathname === "/api/autopost") {
      const [settings, waiting] = await Promise.all([liveSettings(), ask({ cmd: "live", action: "waiting" })]);
      const tz = AUDIENCE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
      return send(res, 200, { settings, runs: autoRuns(), waiting, chrome: extensionConnected(), startup: startupState(), planning: !!planning,
        checking: !!checking, networks: AUTO_NETS, today: todayIn(tz) });
    }
    if (req.method === "POST" && url.pathname === "/api/autopost") {
      const b = await body(req);
      if (!b.set || typeof b.set !== "object" || Array.isArray(b.set)) return send(res, 400, { error: "set: {plan|verify|catchUp|tidy|health: {...}}" });
      return send(res, 200, { settings: await ask({ cmd: "live", action: "settings", set: b.set }) });
    }
    if (req.method === "POST" && url.pathname === "/api/autopost/run") {
      const b = await body(req);
      if (b.what === "preview") return send(res, 200, await autoPlan({ confirm: false, why: "asked" }));
      if (b.what === "plan") { if (planning) return send(res, 409, { error: "Plan posts is already running." }); autoPlan({ why: "asked" }).catch((e) => console.error(`[auto-plan] ${e.message || e}`)); return send(res, 202, { started: true }); }
      if (b.what === "check") return send(res, 200, await runChecks({ health: true }));
      return send(res, 400, { error: "what: preview, plan or check" });
    }
    /* A post that needs a person: it is out after all (kept at its booked time), or set aside (history, never deleted). */
    if (req.method === "POST" && url.pathname === "/api/autopost/post") {
      const b = await body(req);
      if (!Number.isInteger(b.id) || b.id < 1 || !["out", "aside"].includes(b.action)) return send(res, 400, { error: "id and action: out or aside" });
      return send(res, 200, await ask({ cmd: "live", action: b.action === "out" ? "seen" : "aside", id: b.id, source: "you said it is out" }));
    }
    if (req.method === "POST" && url.pathname === "/api/autopost/startup") {
      const b = await body(req);
      if (typeof b.on !== "boolean") return send(res, 400, { error: "on: true or false" });
      try { return send(res, 200, setStartup(b.on)); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    /* Versions of a reel (py/studio/versions.py): a better cut made beside the live one, which a person compares and
       chooses. Re-cutting renders and asks the AI reviewer (inside the AI limits); choosing is the person's approval. */
    if (req.method === "GET" && url.pathname === "/api/versions/todo") {
      if (!versionsCache || Date.now() - versionsCache.at > 60e3 || url.searchParams.get("fresh") === "1") {
        versionsCache = { at: Date.now(), data: await pyResult(["versions", "todo"], null, 120_000) };
      }
      return send(res, 200, { ...versionsCache.data, making: jobView(jobs.get("versions") || null) });
    }
    if (req.method === "GET" && url.pathname === "/api/versions") {
      const slug = url.searchParams.get("slug") || "";
      if (!isSlug(slug)) return send(res, 400, { error: "slug" });
      return send(res, 200, await pyResult(["versions", "list", "--slug", slug], null, 60_000));
    }
    if (req.method === "GET" && url.pathname === "/api/versions/file") {
      const slug = url.searchParams.get("slug") || "", n = Number(url.searchParams.get("n")), kind = url.searchParams.get("kind");
      if (!isSlug(slug) || !Number.isInteger(n) || n < 1 || n > 999 || !["master", "hook"].includes(kind)) return send(res, 400, "slug, n and kind", "text/plain");
      return sendFile(req, res, join(DATA, "versions", slug, `v${n}`, kind === "hook" ? "hook.jpg" : `${slug}_9x16.mp4`));
    }
    if (req.method === "POST" && url.pathname === "/api/versions/recut") {
      const b = await body(req);
      if (jobs.get("versions")?.status === "running") return send(res, 409, { error: "Re-cuts are being made; wait for them to finish." });
      const slugs = b.booked === true ? null : (Array.isArray(b.slugs) ? b.slugs : [b.slug]).filter(isSlug).slice(0, 200);
      if (slugs && !slugs.length) return send(res, 400, { error: "slug, slugs or booked" });
      versionsCache = null;
      return send(res, 200, jobView(startTask("versions", "versions", ["versions", "recut", ...(slugs ? ["--slug", slugs.join(",")] : ["--booked"])], () => { versionsCache = null; })));
    }
    if (req.method === "POST" && url.pathname === "/api/versions/use" || req.method === "POST" && url.pathname === "/api/versions/discard") {
      // use: a person chose this version (the page sends it from the person's press): it becomes the reel and is approved.
      const b = await body(req), act = url.pathname.endsWith("use") ? "use" : "discard";
      if (!isSlug(b.slug || "") || !Number.isInteger(b.n) || b.n < 1) return send(res, 400, { error: "slug and n" });
      versionsCache = null;
      const key = `ver-${b.slug}`;
      if (jobs.get(key)?.status === "running") return send(res, 409, { error: "That reel's version is being changed now." });
      return send(res, 200, jobView(startTask(key, "versions", ["versions", act, "--slug", b.slug, "--n", String(b.n)], () => { versionsCache = null; })));
    }
    if (req.method === "GET" && url.pathname === "/api/levels") {
      // Booked reels whose sound is off the loudness target or peaks over the limit (studio.levels; measured, kept 30 min).
      if (!levelsCache || Date.now() - levelsCache.at > 30 * 60e3 || url.searchParams.get("fresh") === "1") {
        const r = await pyResult(["levels", "check", "--booked"], null, 300_000);
        levelsCache = { at: Date.now(), data: { reels: r.reels || [], off: (r.reels || []).filter((x) => x.off) } };
      }
      return send(res, 200, { ...levelsCache.data, fixing: jobs.get("levels")?.status === "running" });
    }
    if (req.method === "POST" && url.pathname === "/api/levels/fix") {
      // Every booked reel off the level, fixed in place by gain alone: same picture, words and approval (studio.levels).
      levelsCache = null;
      return send(res, 200, jobView(startTask("levels", "levels", ["levels", "fix", "--booked"], () => { levelsCache = null; })));
    }
    if (req.method === "GET" && url.pathname === "/api/posts/stale") {
      const s = autoReplaceState(), list = await staleBookings();
      const groups = {}; for (const x of list) groups[x.why] = (groups[x.why] || 0) + 1;
      const readyYt = list.filter((x) => x.why === "ready" && x.network === "youtube").length;
      return send(res, 200, { on: s.on, today: { youtube: s.yt, perDay: YT_PER_DAY }, done: s.done, failed: s.failed || 0, last: s.last, busy: swapping(),
        total: list.length, groups, youtubeLater: Math.max(0, readyYt - Math.max(0, YT_PER_DAY - s.yt)), list });
    }
    if (req.method === "POST" && url.pathname === "/api/posts/autoreplace") {
      const b = await body(req);
      if (typeof b.on !== "boolean") return send(res, 400, { error: "on: true or false" });
      const s = autoReplaceState(); s.on = b.on;
      if (b.retry === true) s.fails = {};  // "Try them again": the stopped swaps start over
      saveAutoReplace(s);
      if (s.on) setTimeout(tickReplace, 0);
      return send(res, 200, { on: s.on });
    }
    if (req.method === "POST" && url.pathname === "/api/posts/replace") {
      // Swap one booking for the reel's current render (publish.replace): Facebook and YouTube by API, Bluesky by itself,
      // X through your Chrome (take it off, then book the new one in the same slot).
      const b = await body(req);
      if (!Number.isInteger(b.id) || b.id < 1) return send(res, 400, { error: "id" });
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.network || "")) return send(res, 400, { error: "slug and network" });
      const unapproved = approvalRefusal((await reviewRows()), b.slug);
      if (unapproved) return send(res, 409, { error: unapproved });
      if (UNSCHEDULERS.includes(b.network)) {
        const row = (await ask({ cmd: "posts" })).find((p) => p.id === b.id && p.slug === b.slug && p.network === b.network);
        if (!row || !["scheduled", "queued"].includes(row.status) || !row.at) return send(res, 400, { error: "no such booking" });
        return send(res, 200, jobView(startHelperReplace({ slug: b.slug, network: b.network, at: row.at, postId: b.id })));
      }
      return send(res, 200, jobView(startTask(`post-${b.slug}-${b.network}`, "post", ["publish", "--replace", String(b.id)])));
    }
    if (req.method === "POST" && url.pathname === "/api/library") {
      const b = await body(req);
      return send(res, 200, await ask({ cmd: "library", query: b.query || "", filters: b.filters || {}, limit: b.limit || 300 }));
    }
    if (req.method === "GET" && url.pathname === "/api/asset") {
      return send(res, 200, await ask({ cmd: "asset", id: Number(url.searchParams.get("id")) }));
    }
    /* Footage health: per camera, reuse, reels of runway left, what to film next with which camera (cached 10 min;
       ?fresh=1 recounts). POST /api/footage/cameras reads each file's own camera make and model (a job). */
    if (req.method === "GET" && url.pathname === "/api/footage/health") {
      return send(res, 200, await ask({ cmd: "footage", fresh: url.searchParams.get("fresh") === "1" }));
    }
    if (req.method === "POST" && url.pathname === "/api/footage/cameras") {
      return send(res, 200, jobView(startTask("cameras", "cameras", ["footage", "cameras"])));
    }
    if (req.method === "GET" && url.pathname === "/api/themes") {
      return send(res, 200, await ask({ cmd: "themes" }));
    }
    /* A project's own themes (the theme editor): a headline, lines and what to film. A person types the words, so
       they are approved by being saved; the project's guard checks them. Built-in themes cannot be changed here. */
    if (req.method === "POST" && url.pathname === "/api/themes") {
      const b = await body(req);
      return send(res, 200, await ask({ cmd: "theme_save", key: String(b.key || ""), theme: b.theme && typeof b.theme === "object" ? b.theme : {} }));
    }
    if (req.method === "POST" && url.pathname === "/api/themes/delete") {
      const b = await body(req);
      return send(res, 200, await ask({ cmd: "theme_delete", key: String(b.key || "") }));
    }
    /* Whose reels these are: name, link, hashtags, home place and copy rules (py/studio/brand.py). */
    if (req.method === "GET" && url.pathname === "/api/brand") {
      return send(res, 200, await ask({ cmd: "brand" }));
    }
    if (req.method === "POST" && url.pathname === "/api/brand") {
      const b = await body(req);
      return send(res, 200, await ask({ cmd: "brand_save", brand: b }));
    }
    if (req.method === "POST" && url.pathname === "/api/assemble") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "slug: lowercase letters, digits, dashes" });
      diskGuard();
      const project = await ask({ cmd: "assemble", theme: b.theme, slug: b.slug, faces: !!b.faces, since: b.since || null });
      const job = startRender(b.slug);
      return send(res, 200, { project, job: { slug: job.slug, status: job.status } });
    }
    if (req.method === "POST" && url.pathname === "/api/project") {
      const b = await body(req);
      if (!SLUG_RX.test(b.project?.slug || "")) return send(res, 400, { error: "bad slug" });
      if (b.render) diskGuard();
      const saved = await ask({ cmd: "save_project", project: b.project });
      if (saved.problems.length) return send(res, 200, { ...saved, rendering: false });
      if (b.render) startRender(b.project.slug);
      return send(res, 200, { ...saved, rendering: !!b.render });
    }
    if (req.method === "GET" && url.pathname === "/api/project") {
      if (!SLUG_RX.test(url.searchParams.get("slug") || "")) return send(res, 400, { error: "bad slug" });  // never a path ("../x")
      return send(res, 200, await ask({ cmd: "project", slug: url.searchParams.get("slug") }));
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      let names = {};
      try { names = JSON.parse(readFileSync(join(ROOT, "shared", "looks.json"), "utf8")); } catch { /* names are a nicety */ }
      const pick = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, { label: v.label, ja: v.ja, what: v.what }]));
      return send(res, 200, { media: MEDIA, mezz: join(ROOT, "public", "mezz"), data: DATA, audienceTz: AUDIENCE_TZ, workspace: WORKSPACE, looks: pick(names.looks), recipes: pick(names.recipes),
        // What Settings › Use with Claude or Cursor shows: this computer's real paths, never the token itself.
        // The Tsumagoi workspace (its reels in ./projects, with the ranch overlay) uses ranch words; any other project does not.
        ranch: RANCH,
        connect: { node: process.execPath, mcp: join(ROOT, "server", "mcp.mjs"), port: PORT, token: !!API_TOKEN, api: "/api/openapi.yaml", docs: "docs/mcp.md" } });
    }
    /* The HTTP API's own description (OpenAPI 3.1), for tools and people who call the studio from a script. */
    if (req.method === "GET" && url.pathname === "/api/openapi.yaml") {
      return sendText(res, 200, readFileSync(join(ROOT, "docs", "openapi.yaml"), "utf8"), { "content-type": "application/yaml; charset=utf-8", "cache-control": "no-store" });
    }
    /* ---------- performance: how reels did, what worked, what to try next (docs/perf-api.md); nothing here posts ---------- */
    const perfGet = { "/api/perf": "get", "/api/perf/summary": "summary", "/api/perf/suggest": "suggest", "/api/perf/status": "status", "/api/perf/predictions": "predictions", "/api/perf/scores": "scores" }[url.pathname];
    if (req.method === "GET" && perfGet) {
      // Scores and predictions need the whole reel list: the warm studio service has it cached (0.4 s); a fresh
      // Python process rebuilt it cold every time (17 s, and past the time limit while a long render ran).
      if (perfGet === "scores" || perfGet === "predictions") {
        try { return send(res, 200, await ask({ cmd: "perf_read", action: perfGet })); }
        catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
      }
      try { return send(res, 200, await perf(perfGet, perfQuery(perfGet, url.searchParams))); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    const perfPost = { "/api/perf/collect": "collect", "/api/perf/manual": "manual", "/api/perf/import": "import" }[url.pathname];
    if (req.method === "POST" && perfPost) {
      if (Number(req.headers["content-length"] || 0) > 2_500_000) return send(res, 413, { error: "csv: the file is over 2 MB; export a shorter date range", code: "too_big" });
      try { return send(res, 200, await perf(perfPost, perfInput(perfPost, await body(req)))); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    /* ---------- research (Firecrawl): read-only suggestions for a person; nothing here posts ---------- */
    if (req.method === "GET" && url.pathname === "/api/research") {
      try { return send(res, 200, await research("status", url.searchParams.get("fresh") === "1" ? { fresh: true } : {})); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    const researchAction = /^\/api\/research\/(ideas|site-check|page|events|links)$/.exec(url.pathname);
    if (req.method === "POST" && researchAction) {
      try { return send(res, 200, await research(researchAction[1], researchInput(researchAction[1], await body(req)))); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    /* ---------- AI assist (fal.ai, OpenRouter, Together): opt-in, priced first, inside the caps (docs/ai-api.md) ---------- */
    /* What each AI service says is left on its key, next to what the studio spent with it (read-only; cached 10 min). */
    if (req.method === "GET" && url.pathname === "/api/ai/credits") {
      try { return send(res, 200, await ai("credits", { fresh: url.searchParams.get("fresh") === "1" })); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/ai") {
      try { return send(res, 200, await ai("status")); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/ai/estimate") {
      try { return send(res, 200, await ai("estimate", aiInput(await body(req)))); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/ai/run") {
      try {
        const b = await body(req);
        const input = aiInput(b);
        // Priced and checked against the caps here, so a refusal comes back at once instead of as a failed job.
        const est = await ai("estimate", input);
        if (!est.fits) return send(res, 402, { error: est.refusal, code: "cap", estimate: est });
        if (b.render) diskGuard();
        return send(res, 200, { job: jobView(startAi(input, b.render === true)), estimate: est });
      } catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/ai/review") {
      try { return send(res, 200, await ai("last-review", aiInput({ slug: url.searchParams.get("slug") }, { needTools: false }))); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/ai/review") {
      try {
        const b = await body(req);
        const input = aiInput(b, { needTools: false });
        if (b.fresh === true) input.fresh = true;
        return send(res, 200, await ai("review", input));
      } catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      // Plain settings from the setup wizard, written where this project keeps them (no .env editing by hand).
      const b = await body(req);
      /* The Firecrawl key (Settings › Keys & AI): checked with Firecrawl's free credit call, then upserted into the
         studio's .env (every project shares it). Never echoed back. "" removes it. No restart: research reads .env each time. */
      let researchView = null;
      if (b.firecrawl_key !== undefined) {
        if (typeof b.firecrawl_key !== "string" || b.firecrawl_key.length > 300) return send(res, 400, { error: "Paste the Firecrawl key as text.", code: "bad_key" });
        const fk = b.firecrawl_key.replace(/[\r\n\0]/g, "").trim();  // one .env line: a line break must never add another setting
        let checked = null;
        if (fk) {
          try { checked = await research("check-key", { key: fk }); }
          catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code || "bad_key" }); }
        }
        const p = join(ROOT, ".env"), lines = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
        const i = lines.findIndex((l) => /^\s*FIRECRAWL_API_KEY\s*=/.test(l));
        if (!fk) { if (i >= 0) lines.splice(i, 1); }
        else if (i >= 0) lines[i] = `FIRECRAWL_API_KEY=${fk}`;
        else lines.push(`FIRECRAWL_API_KEY=${fk}`);
        writeFileSync(p, lines.join("\n").replace(/\n*$/, "\n"));
        // The key in .env wins over a machine-wide FIRECRAWL_API_KEY (py/studio/research.py api_key), so this takes effect at once.
        researchView = { ready: !!fk || !!process.env.FIRECRAWL_API_KEY, credits: checked?.credits || null };
        if (b.tz === undefined && !AI_SETTINGS.some((k) => b[k] !== undefined)) return send(res, 200, { ok: true, research: researchView });
      }
      /* AI keys (Settings › AI): each checked with the provider's free call, then upserted into the studio's .env by
         py/studio/ai.py under the name the AI tools read (fal_key -> FAL_KEY, together_key -> TOGETHER_API_KEY,
         openrouter_key -> OPENROUTER_API_KEY_PARKED, which keeps the old paid tagging off). Never echoed; "" removes
         it; a wrong key leaves .env untouched. Caps: ai_reel_cap_usd / ai_total_cap_usd in US dollars. No restart. */
      if (AI_SETTINGS.some((k) => b[k] !== undefined)) {
        const saved = {};
        try {
          for (const [field, provider] of [["fal_key", "fal"], ["openrouter_key", "openrouter"], ["together_key", "together"]]) {
            if (b[field] === undefined) continue;
            if (typeof b[field] !== "string" || b[field].length > 400) return send(res, 400, { error: `Paste the ${provider} key as text.`, code: "bad_key", field });
            saved[field] = await ai("save-key", { provider, key: b[field].trim() });
          }
          if (b.ai_reel_cap_usd !== undefined || b.ai_total_cap_usd !== undefined || b.daily_usd_budget !== undefined) {
            saved.caps = await ai("save-caps", { ai_reel_cap_usd: b.ai_reel_cap_usd, ai_total_cap_usd: b.ai_total_cap_usd, daily_usd_budget: b.daily_usd_budget });
          }
        } catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code || "bad_key", saved }); }
        const status = await ai("status").catch(() => null);
        const view = { saved: Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, k === "caps" ? v.saved : { saved: v.saved, removed: v.removed }])),
          keys: status?.keys || null, caps: status?.caps || null };
        if (b.tz === undefined) return send(res, 200, { ok: true, ai: view, ...(researchView ? { research: researchView } : {}) });
      }
      const tz = String(b.tz || "").trim();
      try { if (!tz) throw 0; new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return send(res, 400, { error: "Pick a time zone from the list, for example Asia/Tokyo." }); }
      if (ACTIVE_WS) {
        const w = readWorkspaces(), it = w.list.find((x) => x.id === ACTIVE_WS.id);
        if (it) { it.env = { ...(it.env || {}), STUDIO_TZ: tz }; writeWorkspaces(w); }
      } else {
        const p = join(ROOT, ".env"), lines = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
        const i = lines.findIndex((l) => /^\s*STUDIO_TZ\s*=/.test(l));
        if (i >= 0) lines[i] = `STUDIO_TZ=${tz}`; else lines.push(`STUDIO_TZ=${tz}`);
        writeFileSync(p, lines.join("\n").replace(/\n*$/, "\n"));
      }
      if (process.env.STUDIO_TZ) return send(res, 200, { ok: true, note: "Saved. This computer also sets STUDIO_TZ itself, which still wins." });
      send(res, 200, { ok: true, restarting: true });
      return setTimeout(() => restartSelf(), 300);
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.add(res);
      for (const job of jobs.values()) if (job.status === "queued" || job.status === "running") writeEvent("job", jobView(job));
      const beat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    /* Every piece of work in one list, for the studio's live board: queued, running, and what ended in the last 6 hours
       (renders, AI touches and scoring, posting and swaps, footage checks, picking footage for new reels). */
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const now = Date.now(), RECENT = 6 * 3600e3;
      const list = [...jobs.values()].filter((j) => ["queued", "running"].includes(j.status) || (j.ended && now - j.ended < RECENT));
      return send(res, 200, { now, queue: queue.map((j) => j.slug), jobs: list.map((j) => ({ ...jobView(j), started: j.started || null, ended: j.ended || null, queued: j.queued || null })) });
    }
    /* Score every rendered reel that has no AI review yet, one after another, as one job the board shows (the AI
       reviewer is priced and checked against the limits for each reel; the first refusal stops the run). */
    if (req.method === "POST" && url.pathname === "/api/perf/score-all") {
      return send(res, 200, jobView(startScoreAll()));
    }
    if (req.method === "GET" && url.pathname === "/api/job") {
      return send(res, 200, jobView(jobs.get(url.searchParams.get("slug"))));
    }
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const o = await ask({ cmd: "overview" });
      o.reels.forEach((r) => { r.job = jobView(jobs.get(r.slug)); });
      const known = new Set(o.reels.map((r) => r.slug));
      // Only a reel being built is a card; footage scans, folder checks and imports are not reels.
      for (const [slug, job] of jobs) if (!known.has(slug) && ["build", "remix"].includes(job.kind)) o.reels.unshift({ slug, title: "", status: "draft", job: jobView(job), seconds: 0, clips: 0 });
      return send(res, 200, o);
    }
    if (req.method === "POST" && url.pathname === "/api/alternate") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "bad slug" });
      diskGuard();
      const made = await ask({ cmd: "alternate", slug: b.slug });
      startRender(made.slug);
      return send(res, 200, made);
    }
    if (req.method === "POST" && url.pathname === "/api/cover") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !Number.isFinite(b.t)) return send(res, 400, { error: "slug and time" });
      return send(res, 200, await ask({ cmd: "cover", slug: b.slug, t: b.t }));
    }
    if (req.method === "POST" && url.pathname === "/api/autopilot") {
      const b = await body(req);
      diskGuard();
      // One theme per helper call, each render queued as soon as its reel exists: a big batch never waits past the
      // helper's 10-minute limit, and a reel that was made is never left without its render.
      const made = [];
      const themesIn = (Array.isArray(b.themes) ? b.themes : []).filter((x) => typeof x === "string").slice(0, 40);
      const mk = { slug: `make-${Date.now().toString(36)}`, kind: "make", status: "running", queued: Date.now(), started: Date.now(), lines: [], stage: 0, stages: 1, done: 0, of: themesIn.length, label: "picking footage" };
      jobs.set(mk.slug, mk); broadcast("job", mk, true);
      for (const t of themesIn) {
        mk.label = `picking footage for ${t}`; broadcast("job", mk, true);
        try { for (const m of await ask({ cmd: "autopilot", themes: [t], since: b.since || null, faces: !!b.faces, cut: b.cut === "long" ? "long" : "short", vary: b.vary !== false, learned: b.learned === true })) { made.push(m); startRender(m.slug); } }
        catch (e) { console.error(`[autopilot] ${t}: ${e.message || e}`); mk.lines.push(`${t}: ${String(e.message || e).split(/\r?\n/)[0]}`); }
        mk.done++; broadcast("job", mk, true);
      }
      Object.assign(mk, { status: made.length || !themesIn.length ? "done" : "error", ended: Date.now(), label: `${made.length} new reel${made.length === 1 ? "" : "s"} queued`, result: { made } });
      broadcast("job", mk, true);
      return send(res, 200, { made, failed: mk.lines });  // failed: "theme: why" for each theme that made nothing
    }
    if (req.method === "POST" && url.pathname === "/api/remix") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "bad slug" });
      return send(res, 200, jobView(startRender(b.slug, "remix")));
    }
    if (req.method === "POST" && url.pathname === "/api/veto") {
      const b = await body(req);
      return send(res, 200, await ask({ cmd: "veto", id: Number(b.id), on: b.on !== false, note: String(b.note || "").slice(0, 200) }));
    }
    if (req.method === "GET" && url.pathname === "/api/audio") {
      return send(res, 200, await ask({ cmd: "audio_list" }));
    }
    if (req.method === "POST" && url.pathname === "/api/audio/fetch") {
      const b = await body(req);
      if (!["music", "sfx"].includes(b.kind)) return send(res, 400, { error: "kind: music or sfx" });
      return send(res, 200, await ask({ cmd: "audio_fetch", kind: b.kind, query: String(b.query || "").slice(0, 120), n: 4 }));
    }
    if (req.method === "GET" && url.pathname === "/proxy") {
      const id = Number(url.searchParams.get("id"));
      const asset = await ask({ cmd: "asset", id });
      if (asset.kind === "photo") return sendFile(req, res, asset.thumbs[0] || asset.path);
      const out = await proxyFor(id, asset.path);
      return sendFile(req, res, out);
    }
    if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
      const name = url.pathname.slice(7);
      if (!/^[A-Za-z0-9_.-]+\.ttf$/.test(name)) return send(res, 404, "no", "text/plain");
      const full = join(ROOT, "public", "fonts", name);
      if (!existsSync(full)) return send(res, 404, "no", "text/plain");
      res.writeHead(200, { "content-type": "font/ttf", "cache-control": "max-age=86400" });
      return createReadStream(full).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const p = url.searchParams.get("p") || "", w = Number(url.searchParams.get("w"));
      if (w >= 60 && w <= 720 && /\.(jpe?g|png|webp)$/i.test(p) && allowed(p) && existsSync(resolve(p))) return sendFile(req, res, await thumbOf(p, Math.round(w)));
      return sendFile(req, res, p);
    }
    if (req.method === "GET" && url.pathname === "/api/drafts") {
      return send(res, 200, (await reviewRows()));
    }
    /* ---------- YouTube and the posting log ---------- */
    if (req.method === "GET" && url.pathname === "/api/youtube") {
      return send(res, 200, await ask({ cmd: "yt_status" }));
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/accounts") {
      // Every YouTube account this project has connected: main (Shorts post there) first, then a2, a3, ...
      try { return send(res, 200, await pyResult(["youtube", "accounts"], null, 60_000)); }
      catch (err) { return send(res, 200, { accounts: [], error: String(err.message || err).split(/\r?\n/)[0] }); }
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/connect") {
      // Google's account chooser always shows; ?hint=<email> preselects an account. Google returns to this port.
      // ?account=new connects another channel beside the main one (main, or a2, a3, ... signs that one in again).
      const hint = url.searchParams.get("hint") || "", account = url.searchParams.get("account") || "main";
      if (!/^(main|new|a\d{1,3})$/.test(account)) return send(res, 400, { error: "account: main, new, or a2, a3, ..." });
      const args = ["youtube", "auth-url", "--port", String(PORT), "--account", account, ...(/^[^\s@]+@[^\s@]+$/.test(hint) ? ["--hint", hint] : [])];
      try {
        const { url: to } = await pyResult(args);
        res.writeHead(302, { location: to, "cache-control": "no-store" });  // a fresh sign-in each press (Chrome kept an old error redirect)
      } catch (err) {
        res.writeHead(302, { location: `/?ytError=${encodeURIComponent(String(err.message || err).slice(0, 200))}#/keys`, "cache-control": "no-store" });
      }
      return res.end();
    }
    /* The Google app the studio signs in with: see it, replace it with your own (the JSON Google gives you), or forget it. */
    if (req.method === "GET" && url.pathname === "/api/youtube/app") {
      return send(res, 200, await pyResult(["youtube", "app"]));
    }
    if (req.method === "POST" && url.pathname === "/api/youtube/app") {
      const b = await body(req);
      try {
        if (b.forget) return send(res, 200, await pyResult(["youtube", "forget-app"]));
        if (typeof b.share === "boolean") return send(res, 200, await pyResult(["youtube", b.share ? "share-app" : "unshare-app"]));
        if (typeof b.json !== "string" || b.json.length > 20000) return send(res, 400, { error: "Pick the .json file Google gave you." });
        return send(res, 200, await pyResult(["youtube", "set-app"], b.json));
      } catch (err) { return send(res, 400, { error: String(err.message || err).split(/\r?\n/)[0] }); }
    }
    if (req.method === "POST" && url.pathname === "/api/youtube/disconnect") {
      const b = await body(req), account = b.account || "main";
      if (!/^(main|a\d{1,3})$/.test(account)) return send(res, 400, { error: "account: main, or a2, a3, ..." });
      try { return send(res, 200, await pyResult(["youtube", "disconnect", "--account", account])); }
      catch (err) { return send(res, 400, { error: String(err.message || err).split(/\r?\n/)[0] }); }
    }
    if (req.method === "GET" && url.pathname === "/oauth/youtube") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const problem = url.searchParams.get("error");
      let note;
      try {
        if (problem || !code) throw new Error(problem || "no code from Google");
        const r = await pyResult(["youtube", "exchange", `--code=${code}`, `--state=${state || ""}`]);
        note = `connected=${encodeURIComponent(r.channel?.title || "YouTube")}${r.account && r.account !== "main" ? "&ytAccount=" + encodeURIComponent(r.account) : ""}`;
      } catch (err) { note = `ytError=${encodeURIComponent(String(err.message || err).slice(0, 200))}`; }
      res.writeHead(302, { location: `/?${note}#/` });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/videos") {
      return send(res, 200, await pyResult(["youtube", "list"]));
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/playlists") {
      return send(res, 200, await pyResult(["youtube", "playlists"]));
    }
    if (req.method === "POST" && url.pathname === "/api/youtube/sort") {
      const b = await body(req);
      return send(res, 200, await pyResult(["youtube", "sort", ...(b.dryRun ? ["--dry-run"] : [])], null, 600_000));
    }
    if (req.method === "POST" && url.pathname === "/api/posts/move") {
      // Another day or time for a post the studio sends itself, or a reminder (posting.move refuses the rest).
      const b = await body(req);
      if (!Number.isInteger(b.id) || typeof b.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d([+-]\d\d:\d\d|Z)?$/.test(b.at)) return send(res, 400, { error: "id and at (YYYY-MM-DDTHH:MM)" });
      try { return send(res, 200, await ask({ cmd: "posts", action: "move", id: b.id, at: b.at })); }
      catch (e) { return send(res, 400, { error: String(e.message || e).replace(/^ValueError: /, "").replace(/ \(posting\.py:\d+\)$/, "") }); }
    }
    if (req.method === "POST" && url.pathname === "/api/posts/skip") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "bad slug" });
      return send(res, 200, await ask({ cmd: "posts", action: "skip", slug: b.slug, on: b.on !== false }));
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/meta") {
      const slug = url.searchParams.get("slug") || "";
      if (!SLUG_RX.test(slug)) return send(res, 400, { error: "bad slug" });
      return send(res, 200, await pyResult(["youtube", "meta", slug]));
    }
    if (req.method === "POST" && url.pathname === "/api/youtube/upload") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "")) return send(res, 400, { error: "bad slug" });
      if (b.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}([+-]\d{2}:\d{2})?$/.test(b.at)) return send(res, 400, { error: "time: YYYY-MM-DDTHH:MM, optionally with +HH:MM" });
      if (!["private", "unlisted", "public"].includes(b.privacy || "private")) return send(res, 400, { error: "privacy" });
      const unapproved = approvalRefusal((await reviewRows()), b.slug);  // youtube.upload checks again in the job
      if (unapproved) return send(res, 409, { error: unapproved });
      return send(res, 200, jobView(startUpload(b.slug, { at: b.at || null, privacy: b.privacy || "private" })));
    }
    if (req.method === "GET" && url.pathname === "/api/posts") {
      return send(res, 200, await ask({ cmd: "posts" }));
    }
    if (req.method === "POST" && url.pathname === "/api/posts/plan") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.network || "") || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}([+-]\d{2}:\d{2})?$/.test(b.at || "")) return send(res, 400, { error: "slug, network and time (YYYY-MM-DDTHH:MM)" });
      return send(res, 200, await ask({ cmd: "posts", action: "plan", slug: b.slug, network: b.network, at: b.at }));
    }
    /* ---------- the browser helper: a Chrome window the studio drives (server/helper.mjs) ---------- */
    if (req.method === "GET" && url.pathname === "/api/helper") {
      return send(res, 200, await helperStatus(HOME_DIR));
    }
    if (req.method === "POST" && url.pathname === "/api/helper/signin") {
      // Opens the sign-in page of each network (or of every one not signed in) in the helper window.
      const b = await body(req);
      const nets = Array.isArray(b.networks) ? b.networks.filter((n) => NET_RX.test(n)) : [];
      try {
        const r = await openSignin({ home: HOME_DIR, networks: nets });
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        return send(res, e.status || 500, { error: String(e.message || e).split(/\r?\n/)[0] });
      }
    }
    /* Connect the helper to your own Chrome (docs/helper.md): answers at once with browser state; while it waits for the
       "Allow & select" click, browser.pending says so (poll GET /api/helper). {cancel: true} stops waiting. */
    if (req.method === "POST" && url.pathname === "/api/helper/connect") {
      const b = await body(req);
      try {
        return send(res, 200, { ok: true, browser: b.cancel === true ? cancelConnect() : await beginConnect({ reopen: true }) });
      } catch (e) {
        return send(res, e.status || 500, { error: String(e.message || e).split(/\r?\n/)[0] });
      }
    }
    /* The Chrome link key (PLAYWRIGHT_MCP_EXTENSION_TOKEN from the extension's Welcome page): saved to .env, used at
       once, never sent back. With it the studio links to Chrome by itself after a restart or a dropped link. */
    if (req.method === "POST" && url.pathname === "/api/helper/token") {
      const b = await body(req);
      const raw = b.remove === true ? "" : String(b.token || "").trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, "").replace(/^["']|["']$/g, "");
      if (b.remove !== true && !/^[A-Za-z0-9_\-.=+/]{16,512}$/.test(raw)) return send(res, 400, { error: "That does not look like the key: copy the whole PLAYWRIGHT_MCP_EXTENSION_TOKEN=… line from the Welcome window." });
      const file = join(ROOT, ".env");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/.test(l)) : [];
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (raw) lines.push(`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${raw}`);
      writeFileSync(file, lines.join("\n") + "\n");
      setExtensionToken(raw);
      if (raw) autoReconnect(0);
      return send(res, 200, { ok: true, browser: browserState() });
    }
    if (req.method === "POST" && url.pathname === "/api/helper/install") {
      // One click: the helper's one library, installed into this studio folder (no browser download; it uses Chrome).
      // The exact version package.json pins (it must match chrome-bridge.mjs), never "latest 1.x".
      const pw = /^\d+\.\d+\.\d+$/.test(PKG.dependencies?.["playwright-core"] || "") ? PKG.dependencies["playwright-core"] : "1.64.1";
      const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", `playwright-core@${pw}`, "--save-exact", "--no-audit", "--no-fund"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 300000 });
      if (r.status !== 0) return send(res, 500, { error: "The helper could not be installed. Check the internet connection and try again.", detail: (r.stderr || "").slice(-400) });
      return send(res, 200, { ok: true, ...(await helperStatus()) });
    }
    if (req.method === "POST" && url.pathname === "/api/helper/post") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.network || "")) return send(res, 400, { error: "Pick a reel and a network first." });
      // Only approved reels are handed to a network, even when a person presses Post there.
      const unapproved = approvalRefusal((await reviewRows()), b.slug);
      if (unapproved) return send(res, 409, { error: unapproved });
      const m = manifests().find((x) => x.slug === b.slug);
      if (!m) return send(res, 404, { error: "That reel has no files yet: open it and press Prepare files." });
      const net = b.network, own = net === "youtube" ? "youtube-shorts" : net;
      // A network without its own cut borrows the closest one, with the link tagged for this network.
      const BORROW = { bluesky: ["x", "threads"], gbp: ["facebook", "threads"], "line-voom": ["tiktok", "facebook"], "line-oa": ["facebook", "threads"], pinterest: ["tiktok", "threads"] };
      const ch = [own, ...(BORROW[net] || [])].map((n) => m.channels?.find((c) => c.name === n && c.videos?.length)).find(Boolean);
      if (!ch) return send(res, 404, { error: `This reel has no file for ${net} yet: open it and press Prepare files.` });
      const path = join(ch.dir, ch.videos[0].file);
      if (!allowed(path) || !existsSync(path)) return send(res, 404, { error: "The video file is missing; press Prepare files again." });
      const text = String(ch.post || "").replace(/utm_source=[a-z-]+/g, `utm_source=${net}`);
      const spec = channelsView().channels.find((c) => c.id === own);
      try {
        return send(res, 200, await helperPrepare({ home: HOME_DIR, network: net, url: spec?.upload || "", file: path, text, name: spec?.name || net }));
      } catch (err) {
        console.error(`[helper] ${net}: ${err.stack || err}`);
        return send(res, err.status || 500, { error: err.status ? err.message : `The helper could not finish on ${spec?.name || net}: ${String(err.message || err).split(/\r?\n/)[0]}. The page stays open; finish it there.` });
      }
    }
    /* The helper schedules end to end on X, TikTok, Google Maps and LINE (approved reels only): {slug, network, at, id?, rehearse?}.
       Answers the queued job at once (409 with a plain reason when refused); progress comes over /api/events. */
    if (req.method === "POST" && url.pathname === "/api/helper/schedule") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.network || "")) return send(res, 400, { error: "Pick a reel and a network first." });
      if (b.id !== undefined && !Number.isInteger(b.id)) return send(res, 400, { error: "id: a planned post's number" });
      const slug = b.slug.replace(/^story-/, "");
      const c = await helperScheduleCheck(slug, b.network, String(b.at || ""), { postId: b.id });
      if (c.why) return send(res, 409, { error: c.why });
      return send(res, 200, jobView(startHelperSchedule({ slug, network: b.network, at: b.at, postId: b.id, rehearse: b.rehearse === true })));
    }
    /* Numbers from the networks' own pages, read in your Chrome (read only): {networks?}. Answers the queued job
       ("helper-perf"); its result is {stored, left, summary}. The same job again while it runs is that job. */
    if (req.method === "POST" && url.pathname === "/api/perf/collect-browser") {
      const b = await body(req);
      const asked = Array.isArray(b.networks) ? b.networks.filter((n) => typeof n === "string") : [];
      const nets = asked.filter((n) => PERF_NETWORKS.includes(n));
      if (asked.length && !nets.length) return send(res, 400, { error: `networks: some of ${PERF_NETWORKS.join(", ")}`, code: "bad_input" });
      return send(res, 200, jobView(startPerfBrowser({ networks: nets })));
    }
    /* Plan a week: approved reels spread one per network per day (19:00 in the audience's zone; Maps 12:00 Fri/Sat).
       {slugs?, networks?, start? (YYYY-MM-DD), days? (1-14), confirm?}: a dry run unless confirm is true. */
    if (req.method === "POST" && url.pathname === "/api/helper/schedule-week") {
      const b = await body(req);
      const nets = Array.isArray(b.networks) && b.networks.length ? b.networks.filter((n) => SCHEDULERS.includes(n)) : SCHEDULERS;
      if (!nets.length) return send(res, 400, { error: `networks: some of ${SCHEDULERS.join(", ")}` });
      if (b.start !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.start)) return send(res, 400, { error: "start: YYYY-MM-DD" });
      const days = Number.isInteger(b.days) ? Math.min(14, Math.max(1, b.days)) : 7;
      const rows = (await reviewRows()), posts = await ask({ cmd: "posts" });
      const approved = new Set(rows.filter((r) => r.status === "approved").map((r) => r.slug.replace(/^story-/, "")));
      const asked = Array.isArray(b.slugs) && b.slugs.length ? [...new Set(b.slugs.map((s) => String(s).replace(/^story-/, "")))] : null;
      const reels = manifests().filter((m) => approved.has(m.slug) && (!asked || asked.includes(m.slug)))
        .map((m) => ({ slug: m.slug, headline: headlineOf(m, m.channels?.[0]), networks: nets.filter((n) => postFor(m, n)) }));
      const notApproved = asked ? asked.filter((s) => !approved.has(s)) : [];
      const tz = AUDIENCE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = planWeek({ reels, networks: nets, posts, start: b.start, days, timeZone: tz });
      if (b.confirm !== true) return send(res, 200, { dryRun: true, ...r, notApproved });
      const batch = { signin: new Set() };
      for (const p of r.plan) {
        const c = await helperScheduleCheck(p.slug, p.network, p.at, { known: { rows, posts } });
        if (c.why) { p.refused = c.why; continue; }
        p.job = jobView(startHelperSchedule({ slug: p.slug, network: p.network, at: p.at, batch }));
      }
      return send(res, 200, { dryRun: false, ...r, notApproved });
    }
    if (req.method === "POST" && url.pathname === "/api/share") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !NET_RX.test(b.channel || "")) return send(res, 400, { error: "slug and channel" });
      const m = manifests().find((x) => x.slug === b.slug);
      const ch = m?.channels?.find((c) => c.name === b.channel);
      const v = ch?.videos?.[Number.isInteger(b.index) ? b.index : 0];
      if (!v) return send(res, 404, { error: "no file for that network yet: Prepare files first" });
      const path = join(ch.dir, v.file);
      if (!allowed(path) || !existsSync(path)) return send(res, 404, { error: "file missing" });
      // fit: a size cap in MB (an upload tool's limit). Over it, a lighter copy at the same size and frame
      // rate is made once (H.264 at a lower bitrate) and shared instead; the original is untouched.
      let file = path, name = v.file, mb = v.mb;
      const fit = Number(b.fit) || 0;
      if (fit > 0 && statSync(path).size > fit * 1e6) {
        const lite = join(RENDERS, "share-cache", `${b.slug}_${b.channel}_${name.replace(/\.mp4$/i, "")}_fit${fit}.mp4`);
        if (!existsSync(lite) || statSync(lite).mtimeMs < statSync(path).mtimeMs) {
          const kbps = Math.max(1500, Math.floor((fit * 0.9 * 8e3) / Math.max(1, v.sec || 30)) - 160);
          // Async: a spawnSync here froze every other request (and the live progress stream) for up to 10 minutes.
          try { await lighterCopy(path, lite, kbps); } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
        }
        file = lite; name = name.replace(/\.mp4$/i, "_web.mp4"); mb = Math.round(statSync(lite).size / 1e5) / 10;
      }
      const token = shareLink(file);
      return send(res, 200, { url: `http://127.0.0.1:${PORT}/share/${token}/${encodeURIComponent(name)}`, name, type: "video/mp4", mb, until: Date.now() + 15 * 60e3 });
    }
    if (req.method === "POST" && url.pathname === "/api/package") {
      const b = await body(req);
      if (!SLUG_RX.test(b.slug || "") || !Array.isArray(b.channels) || !b.channels.every((c) => NET_RX.test(c))) return send(res, 400, { error: "slug and channels" });
      diskGuard();
      return send(res, 200, await ask({ cmd: "package", slug: b.slug, channels: b.channels.slice(0, 20) }));
    }
    if (req.method === "POST" && ["/api/posts/done", "/api/posts/drop", "/api/posts/booked", "/api/posts/link"].includes(url.pathname)) {
      const b = await body(req);
      if (!Number.isInteger(b.id)) return send(res, 400, { error: "id" });
      const action = url.pathname.split("/").pop();
      if (b.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}([+-]\d{2}:\d{2})?$/.test(b.at)) return send(res, 400, { error: "time: YYYY-MM-DDTHH:MM" });
      return send(res, 200, await ask({ cmd: "posts", action, id: b.id, url: String(b.url || "").slice(0, 500), at: b.at || null }));
    }
    if (req.method === "GET" && url.pathname === "/api/posts/ics") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id)) return send(res, 400, "id", "text/plain");
      const r = await py(["posts", "ics", String(id)]);
      if (r.code !== 0) return send(res, 404, lastError(r.err) || "no such plan", "text/plain");
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="tsumagoi-post-${id}.ics"` });
      return res.end(r.out);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const payload = await body(req);
      const act = url.pathname.slice(5);
      if (!["approve", "consent", "reject", "reroll"].includes(act)) return send(res, 404, "unknown action", "text/plain");
      if (!SLUG_RX.test(payload.slug || "")) return send(res, 400, "bad slug", "text/plain");
      const args = [act, payload.slug];
      if (act === "reject" || act === "reroll") args.push(String(payload.note || "").slice(0, 500));
      const result = await py(args, 600_000);  // approve copies the packages to Drive: room for a slow copy, never forever
      return send(res, result.code === 0 ? 200 : 400, result.code === 0 ? result.out : result.err, "text/plain; charset=utf-8");
    }
    send(res, 404, "no", "text/plain");
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: String(err.message || err) });
  }
});

/* Start: retry while a previous copy lets go of the port (a restart), and if another studio is
   already serving, say so plainly instead of a stack trace. */
function listen(attempt = 0) {
  server.once("error", async (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (attempt < 24) return setTimeout(() => listen(attempt + 1), 250);
    let other = null;
    try { other = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json(); } catch { other = null; }
    console.error(other?.build
      ? `The studio is already running at http://127.0.0.1:${PORT} (build ${other.build}). Open that, or stop it first.`
      : `Port ${PORT} is taken by another program. Close it, then run npm run review again.`);
    process.exit(other?.build ? 0 : 1);
  });
  server.listen(PORT, "127.0.0.1");  // no callback: a failed attempt would leave it queued and fire it again later
}
/* An error thrown inside an event handler (a stream, a timer) would end the whole process, and with it every booked post
   and render. Log it and keep serving; a broken start (the port, a missing file) still ends through its own exit. */
process.on("uncaughtException", (err) => console.error(`${new Date().toISOString()} uncaught: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => console.error(`${new Date().toISOString()} unhandled: ${err?.stack || err}`));
// Registered once, so a start that retried several times still starts one helper.
server.once("listening", () => {
  // The token is shown only in a terminal: when this output goes to server.log (a restart, autostart) it would sit in a file
  // that backups of the data folder and the studio's own file route can read (SECURITY.md: never in a log).
  const tokenPart = !API_TOKEN ? "" : process.stdout.isTTY ? `?token=${encodeURIComponent(API_TOKEN)}` : "?token=<STUDIO_API_TOKEN in .env>";
  console.log(`review http://127.0.0.1:${PORT}/${tokenPart} (build ${BUILD})`);
  startHelper();
});
listen();
