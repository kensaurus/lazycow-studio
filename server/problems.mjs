/**
 * FILE: server/problems.mjs
 * PURPOSE: What went wrong, kept until it is fixed. The bell's notes pass by (a page that was closed never sees them);
 *          a problem stays in <STUDIO_HOME>/problems.json and in the page's Problems list until its cause is gone.
 * OVERVIEW: findProblems() looks at the studio's data as it is now (bookings, approvals, long videos) and returns what
 *           is wrong; it is pure and tested. A store merges those with one-off events (a version that could not be
 *           used, a project switch), keeps first/last seen, drops a checked problem once its cause is gone, and lets a
 *           person dismiss what may be dismissed.
 * LEVELS: red = something will not happen (a post, a render) until it is fixed; amber = it happens, but worse than it
 *         could; info = worth knowing. A red problem about the future cannot be dismissed, only fixed.
 * Found 13 Nov: a reel left unapproved by a failed "Use the new version", 13 long videos that repeated days, and a
 * project switch, all of which the studio never showed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RANK = { red: 0, amber: 1, info: 2 };
const SENT = new Set(["scheduled", "queued", "planned"]);
const MISSED = new Set(["failed", "missed"]);
const DAY = 86400e3;

const when = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : String(iso || "");
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const listNums = (ns) => (ns.length <= 1 ? String(ns[0] ?? "") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** A reel's review status, as approvalRefusal reads it: "story-<slug>" first, then the bare slug. */
function statusOf(reviews, slug) {
  const row = reviews.find((r) => r?.slug === `story-${slug}`) || reviews.find((r) => r?.slug === slug);
  return row ? row.status : null;
}

/**
 * The problems that are true now. posts: /api/posts rows; reviews: review-list rows; parts: /api/vlogs parts.
 * Returns [{ id, level, title, detail, fix: { label, href }, dismissable }].
 */
export function findProblems({ posts = [], reviews = [], parts = [], now = Date.now() } = {}) {
  const out = [];
  // 1. Booked, but the reel is not approved: the studio posts and swaps only approved reels.
  const ahead = posts.filter((p) => SENT.has(p.status) && Date.parse(p.at) > now && !/^vlog-/.test(p.slug || ""));
  const bySlug = new Map();
  for (const p of ahead) (bySlug.get(p.slug) || bySlug.set(p.slug, []).get(p.slug)).push(p);
  for (const [slug, list] of bySlug) {
    const st = statusOf(reviews, slug);
    if (st === "approved") continue;
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = list[0];
    out.push({
      id: `unapproved:${slug}`, level: "red",
      title: `${slug} is booked but not approved`,
      detail: `${list.length} booked post${list.length === 1 ? "" : "s"}, the next on ${first.network} at ${when(first.at)}. The studio only posts and updates approved reels, so ${list.length === 1 ? "it waits" : "they wait"} until you approve it${st ? ` (now "${st}")` : ""}. If it shows people, press Consent OK first.`,
      fix: { label: "Open the reel", href: `#/reel/${slug}` }, dismissable: false,
    });
  }
  // 2. Posts that did not go out in the last two weeks.
  for (const p of posts) {
    const t = Date.parse(p.at);
    if (!MISSED.has(p.status) || !(t > now - 14 * DAY) || t > now) continue;
    out.push({
      id: `missed:${p.id ?? `${p.slug}:${p.network}:${p.at}`}`, level: "red",
      title: `${p.slug} did not go out on ${p.network}`,
      detail: `It was booked for ${when(p.at)}${p.note ? `: ${String(p.note).slice(0, 160)}` : ""}. Book it again, or post it by hand.`,
      fix: { label: "See Posting", href: "#/posting" }, dismissable: true,
    });
  }
  // 3. Long videos that repeat the same days, or vary a lot in length: viewers see the same moments again, and a
  //    series reads as random (a travel series' parts, 13 Nov).
  const built = parts.filter((p) => Array.isArray(p.days) && p.days.length);
  if (built.length >= 2) {
    const seen = new Map();
    for (const p of built) for (const d of p.days) seen.set(d, [...(seen.get(d) || []), p.n]);
    const shared = [...new Set([...seen.values()].filter((ns) => ns.length > 1).flat())].sort((a, b) => a - b);
    const secs = built.map((p) => Number(p.built?.seconds) || 0).filter((s) => s > 0);
    const lo = Math.min(...secs), hi = Math.max(...secs);
    const uneven = secs.length >= 3 && lo > 0 && hi / lo >= 2;
    if (shared.length || uneven) {
      const why = [];
      if (shared.length) why.push(`parts ${listNums(shared)} show some of the same days`);
      if (uneven) why.push(`lengths run from ${mmss(lo)} to ${mmss(hi)}`);
      out.push({
        id: "vlog-shape", level: "amber",
        title: "Your long videos do not read as one series",
        detail: `${why.join("; ").replace(/^./, (c) => c.toUpperCase())}. Plan them as a series: each day once, in order, about the same length.`,
        fix: { label: "Long videos", href: "#/videos" }, dismissable: true,
      });
    }
  }
  return sort(out);
}

export function sort(items) {
  return [...items].sort((a, b) => (RANK[a.level] ?? 3) - (RANK[b.level] ?? 3) || String(a.title).localeCompare(String(b.title)));
}

/** The kept list: checks replaced every run, events kept until they expire or are dismissed. */
export function createStore(file, { now = () => Date.now() } = {}) {
  let state = { items: {} };
  try { state = JSON.parse(readFileSync(file, "utf8")); if (!state.items) state = { items: {} }; } catch { /* first run */ }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${file}.tmp`, file);
  };
  const stamp = () => new Date(now()).toISOString();
  return {
    /** Replace every checked problem with what the checks found now. Returns true when the open list changed. */
    checked(found) {
      const before = JSON.stringify(this.open());
      const ids = new Set(found.map((f) => f.id));
      for (const [id, it] of Object.entries(state.items)) if (it.source === "check" && !ids.has(id)) delete state.items[id];
      for (const f of found) {
        const old = state.items[f.id];
        state.items[f.id] = { ...f, source: "check", first: old?.first || stamp(), last: stamp(), dismissed: old?.dismissed && old.detail === f.detail ? old.dismissed : null };
      }
      save();
      return JSON.stringify(this.open()) !== before;
    },
    /** A one-off problem (it has no check to clear it): kept for `days`, or until dismissed. */
    record(item, days = 7) {
      const old = state.items[item.id];
      state.items[item.id] = { dismissable: true, ...item, source: "event", first: old?.first || stamp(), last: stamp(), count: (old?.count || 0) + 1,
        expires: new Date(now() + days * DAY).toISOString(), dismissed: null };
      save();
    },
    dismiss(id) {
      const it = state.items[id];
      if (!it) return "missing";
      if (!it.dismissable) return false;
      it.dismissed = stamp(); save();
      return true;
    },
    open() {
      const t = now();
      return sort(Object.values(state.items).filter((it) => !it.dismissed && !(it.expires && Date.parse(it.expires) < t)));
    },
  };
}
