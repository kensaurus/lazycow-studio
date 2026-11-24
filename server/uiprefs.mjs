/**
 * FILE: server/uiprefs.mjs
 * PURPOSE: The page's per-project choices kept by the server: how much of the studio shows (simple or full,
 *          <data>/ui.json) and the private usage counts (<data>/usage.json: how often each page or key action was used,
 *          and when last). Counts never leave this computer; they only help a person see what they really use.
 * DEPENDENCIES: node:fs, node:path
 * USAGE: import { featureIds, createUsage, readLevel, writeLevel, NETWORK_TIERS, tierOf } from "./uiprefs.mjs" (server/review.mjs).
 * NOTES: The feature list has one home, the FEATURES registry in server/ui/js/02-nav-tools.js (part of the page, server/ui.mjs); featureIds() reads its ids from
 *        there, so the server accepts exactly the pages and actions the page knows. Pure enough to test without a
 *        server (test/uiprefs.test.mjs).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEVELS = ["simple", "full"];

/* The networks most people post to: on by default in a new project and listed first on Settings › Accounts. A channel in
   shared/channels.json may say "tier": "common" | "more"; one that does not is "more" unless it is one of these. */
export const NETWORK_TIERS = { common: ["youtube-shorts", "tiktok", "instagram", "facebook", "x", "linkedin"] };
export const tierOf = (c) => (c?.tier === "common" || c?.tier === "more" ? c.tier : NETWORK_TIERS.common.includes(c?.id) ? "common" : "more");

/**
 * The ids the usage counter accepts, read from the page's registry (server/ui/js/02-nav-tools.js) between its FEATURES-BEGIN and FEATURES-END
 * marks: each feature id (one entry per line, `  id: { ... }`) and each of its actions as `id:action` (`acts: [...]`).
 */
export function featureIds(html) {
  const a = html.indexOf("FEATURES-BEGIN"), b = html.indexOf("FEATURES-END", a);
  const ids = new Set();
  if (a < 0 || b < 0) return ids;
  for (const line of html.slice(a, b).split("\n")) {
    const m = /^\s{2}([a-z][a-z0-9]*):\s*\{(.*)\},?\s*$/.exec(line);
    if (!m) continue;
    ids.add(m[1]);
    const acts = /acts:\s*\[([^\]]*)\]/.exec(m[2]);
    for (const x of acts ? acts[1].match(/[a-z][a-z0-9]*/g) || [] : []) ids.add(`${m[1]}:${x}`);
  }
  return ids;
}

const readJsonFile = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);  // a crash mid-write never leaves half a file
}

/**
 * Has this project made anything, judged from its files: a reel (<projects>/<slug>.json), a photo post (a set in
 * <data>/stills, its "_" folders are working space) or a long-video plan (<data>/vlog-plan.json). Booked and posted rows
 * live in the database: the caller passes `posted` for those. The same test as py/studio/reels.py _made_before.
 */
export function madeBefore(dataDir, projectsDir) {
  const any = (dir, ok) => { try { return readdirSync(dir).some(ok); } catch { return false; } };
  return any(projectsDir, (f) => /^[a-z0-9-]+\.json$/.test(f)) || any(join(dataDir, "stills"), (f) => !f.startsWith("_") && !f.startsWith("."))
    || existsSync(join(dataDir, "vlog-plan.json"));
}

/**
 * An upgrade keeps a project's networks (0.27, BL-116). Before, a project with no networks.json posted to every channel
 * not marked off in channels.json; now such a project starts with the common ones only. A project that already made
 * something (madeBefore, or `posted`: any booked or posted row) and never chose gets its old set written once, so
 * nothing it posted to stops. Returns the file written, or null (already chose, nothing made yet, or the ranch, which
 * keeps its own rule).
 */
export function keepNetworksOnUpgrade({ dataDir, projectsDir, channels, ranch = false, posted = false }) {
  if (ranch) return null;
  const own = join(dataDir, "networks.json");
  if (existsSync(own)) return null;
  if (!posted && !madeBefore(dataDir, projectsDir)) return null;
  const list = Array.isArray(channels) ? channels : [];
  writeJsonFile(own, { on: list.filter((c) => !c.off).map((c) => c.id), off: list.filter((c) => c.off).map((c) => c.id), accounts: {},
    note: "Kept on the upgrade to 0.27: the networks this project posted to before. Change them on Settings › Accounts." });
  return own;
}

/** The level saved for this project: {level, chosen} or null when the person never chose and nothing was stored. */
export function readLevel(file) {
  const v = readJsonFile(file, null);
  return v && LEVELS.includes(v.level) ? { level: v.level, chosen: v.chosen === true } : null;
}
export function writeLevel(file, level, chosen = true) {
  if (!LEVELS.includes(level)) throw Object.assign(new Error("level: simple or full"), { status: 400 });
  const v = { ...readJsonFile(file, {}), level, chosen };
  writeJsonFile(file, v);
  return { level, chosen };
}

/**
 * Usage counts per id: {id: {n, last}} with `last` an ISO date. hit() takes only an id from `allowed` (anything else is
 * refused, so the file can never grow with made-up names) and writes at most once per `delayMs` (the page reports
 * every page it opens). flush() writes now (tests, shutdown).
 */
export function createUsage(file, allowed, { delayMs = 5000, now = () => new Date(), persist = true } = {}) {
  const raw = readJsonFile(file, {});
  const counts = {};
  for (const [id, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (allowed.has(id) && Number.isFinite(v?.n)) counts[id] = { n: Math.max(0, Math.floor(v.n)), last: typeof v.last === "string" ? v.last : null };
  }
  let timer = null, dirty = false;
  // persist: false (a look-only studio on someone else's data folder) counts in memory only.
  const flush = () => { clearTimeout(timer); timer = null; if (dirty && persist) { dirty = false; writeJsonFile(file, counts); } };
  return {
    allowed: (id) => typeof id === "string" && allowed.has(id),
    hit(id) {
      if (!this.allowed(id)) return false;
      const c = counts[id] || (counts[id] = { n: 0, last: null });
      c.n += 1; c.last = now().toISOString(); dirty = true;
      if (!timer && persist) { timer = setTimeout(flush, delayMs); timer.unref?.(); }
      return true;
    },
    view: () => JSON.parse(JSON.stringify(counts)),
    flush,
  };
}
