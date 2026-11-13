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
const MISSED = new Set(["failed", "missed", "missing"]);  // "missing": booked, but not seen live hours later (py/studio/live.py)
const NET = { youtube: "YouTube", facebook: "Facebook", bluesky: "Bluesky", x: "X", tiktok: "TikTok", linkedin: "LinkedIn",
  gbp: "Google Maps", "line-oa": "LINE", pinterest: "Pinterest", threads: "Threads", instagram: "Instagram" };
const netName = (n) => NET[n] || n;
// Where a person checks a post with their own eyes, per network (the post's own link wins when the studio has one).
const LOOK = { gbp: "https://business.google.com/locations", x: "https://x.com/compose/post/unsent/scheduled",
  tiktok: "https://www.tiktok.com/tiktokstudio/content", linkedin: "https://www.linkedin.com/feed/", "line-oa": "https://manager.line.biz/",
  facebook: "https://business.facebook.com/latest/content_calendar", youtube: "https://studio.youtube.com/" };
// Where to see why a network shows nobody the posts.
const REACH = { tiktok: { label: "Open TikTok Studio", href: "https://www.tiktok.com/tiktokstudio" },
  facebook: { label: "Open Meta Business Suite insights", href: "https://business.facebook.com/latest/insights/" },
  bluesky: { label: "Open your Bluesky profile", href: "https://bsky.app/profile/me" },
  x: { label: "Open X analytics", href: "https://x.com/i/account_analytics" } };
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
export function findProblems({ posts = [], reviews = [], parts = [], connections = {}, perf = null, now = Date.now() } = {}) {
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
    const missing = p.status === "missing", look = /^https?:\/\//.test(p.url || "") ? p.url : LOOK[p.network];
    out.push({
      id: `missed:${p.id ?? `${p.slug}:${p.network}:${p.at}`}`, level: "red",
      title: missing ? `${p.slug} was not seen on ${netName(p.network)}` : `${p.slug} did not go out on ${netName(p.network)}`,
      detail: missing
        ? `It was booked for ${when(p.at)}, and the studio has not found it live since${p.note ? ` (${String(p.note).slice(0, 140)})` : ""}. Look on ${netName(p.network)}: if it is there, press "It's out" on Posting; if not, book it again.`
        : `It was booked for ${when(p.at)}${p.note ? `: ${String(p.note).slice(0, 160)}` : ""}. Book it again, or post it by hand.`,
      fix: { label: "See Posting", href: "#/posting" },
      ...(missing && look ? { also: { label: `Look on ${netName(p.network)}`, href: look } } : {}),
      dismissable: true,
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
  // 4. A sign-in that ends while posts are still booked after it: those posts would not go out (Bluesky's session
  //    lasts about two weeks; the studio's own check warned only a day ahead, with 29 posts queued past it, 13 Nov).
  for (const [n, c] of Object.entries(connections || {})) {
    const end = Date.parse(c?.until || "");
    if (!c?.connected || !Number.isFinite(end) || end - now > 14 * DAY) continue;
    const after = posts.filter((p) => p.network === n && SENT.has(p.status) && Date.parse(p.at) > end);
    const days = Math.max(0, Math.ceil((end - now) / DAY));
    if (!after.length && end - now > 3 * DAY) continue;
    out.push({
      id: `signin:${n}`, level: after.length || end - now < DAY ? "red" : "amber",
      title: end <= now ? `${netName(n)} is signed out` : `${netName(n)} signs out in ${days} day${days === 1 ? "" : "s"}`,
      detail: `${end <= now ? "The sign-in ended" : "The sign-in ends"} ${when(c.until)}.${after.length ? ` ${after.length} booked post${after.length === 1 ? "" : "s"} after that will not go out until you sign in again.` : ""} Sign in again on Settings › Accounts: it takes a minute.${n === "bluesky" ? " Signing in with an App password instead (Bluesky › Settings › Privacy and security › App passwords) does not run out." : ""}`,
      fix: { label: `Sign in to ${netName(n)} again`, href: "#/accounts" }, dismissable: false,
    });
  }
  // 5. A network where the posts measured so far reached nobody: worth a look on the network itself (a new or
  //    restricted account, or a number the studio cannot read).
  for (const [n, v] of Object.entries(perf?.networks || {})) {
    if (!(Number(v?.posts) >= 2) || Number(v?.median) !== 0) continue;
    const metric = v.metric === "engagements" ? "likes, reposts or replies" : "views";
    out.push({
      id: `reach:${n}`, level: "amber",
      title: `Your ${netName(n)} posts are not being seen yet`,
      detail: `The ${v.posts} ${netName(n)} posts measured so far have 0 ${metric} about three days after they went out. A new account, a restricted account or a missing profile often does this; so can a number the studio cannot read. Check the account on ${netName(n)}, and compare its own numbers.`,
      fix: { label: "Results", href: "#/results" }, ...(REACH[n] ? { also: REACH[n] } : {}), dismissable: true,
    });
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
