/*
 * FILE: server/autoplan.mjs
 * PURPOSE: The rules of "Runs by itself › Plan posts": which approved reels the studio books on its own, on which
 *          network and when. Kept apart from the server so the rules can be tested without a browser or a network.
 * OVERVIEW: One post per network per day at the network's hour (helper.mjs planWeek: the usual hour from channels.json
 *           postTimesJst, 19:00 when listed, and every 4th booking at one of its other listed hours as a test, BL-102;
 *           Google Maps Fri/Sat 12:00; LINE Saturday 10:00 and LinkedIn Sunday 19:00, once a week), never the same reel twice on one
 *           network, each site only as far ahead as it accepts a booking. Which reel may go where follows the
 *           page planner (server/editor.html planFits): a long cut only where the channel takes explainers and on
 *           LinkedIn only long cuts; Google Maps never shows people (Google refused one post); a network switched
 *           off in Settings is never planned.
 * USAGE: fitsNetwork(manifest, network, spec) · postSlots(spec, timeZone) · planAhead({reels, networks, posts, slots, ...}) · todayIn(timeZone)
 * NOTES: Only approved reels reach here (the server filters); approving stays with a person.
 */
import { planWeek, MAX_DAYS_AHEAD, THEME_DAYS_ALL } from "./helper.mjs";

/* The networks the studio can book by itself, and how many days ahead each accepts (Facebook refuses reels beyond
   29 days; YouTube and Bluesky have no limit of their own, so two months keeps the queue honest). */
export const AUTO_LIMITS = { ...MAX_DAYS_AHEAD, facebook: 29, bluesky: 60, youtube: 60 };
export const AUTO_NETS = Object.keys(AUTO_LIMITS);
export const CHROME_NETS = ["x", "tiktok", "gbp", "line-oa", "linkedin", "pinterest"];
const CHANNEL_ID = { youtube: "youtube-shorts" };
const NET_NAMES = { youtube: "YouTube", facebook: "Facebook", bluesky: "Bluesky", x: "X", tiktok: "TikTok", linkedin: "LinkedIn", gbp: "Google Maps", "line-oa": "LINE", pinterest: "Pinterest" };

export const isLong = (slug) => /-long(-\d+)?$/.test(slug || "");

/** May this reel go out on this network? spec: channels.json as this project sees it (channelsView). */
export function fitsNetwork(manifest, network, spec) {
  const ch = (spec?.channels || []).find((c) => c.id === (CHANNEL_ID[network] || network));
  if (!ch || ch.off) return false;
  const long = isLong(manifest?.slug);
  if (long && ch.variant !== "b-explainer") return false;
  if (network === "linkedin" && !long) return false;
  if (network === "gbp" && (manifest?.stats?.faces || 0) > 0) return false;
  return true;
}

/** Each daily network's hours from channels.json postTimesJst (BL-070): {network: {usual, others}}. The usual hour is
    19:00 when listed (the hour the studio always used), else the first; an entry with a weekday ("Sun 19:00") is a
    weekly slot and stays with planWeek's fixed rules. The hours are Japan time, so another audience zone gets {} and
    keeps 19:00. */
export function postSlots(spec, timeZone = "Asia/Tokyo") {
  if (timeZone !== "Asia/Tokyo") return {};
  const out = {};
  for (const ch of spec?.channels || []) {
    const hours = [...new Set((ch.postTimesJst || []).filter((h) => /^\d{2}:\d{2}$/.test(h)))];
    if (ch.off || !hours.length) continue;
    const net = Object.keys(CHANNEL_ID).find((n) => CHANNEL_ID[n] === ch.id) || ch.id;
    const usual = hours.includes("19:00") ? "19:00" : hours[0];
    out[net] = { usual, others: hours.filter((h) => h !== usual) };
  }
  return out;
}

/** networks.json after a network's account name is set: a different name than before (an account replaced, 24 Nov:
    the Singapore-region TikTok deleted for a Japan one) starts that network's "since", so whether the network shows
    the posts (perf.reach, Plan posts' stalled rule, Needs you) is judged on the new account's posts only. The first
    name, the same name, or a cleared one keeps the old date. Returns a new object. */
export function withAccount(o = {}, id, account, now = new Date()) {
  const next = { ...o, accounts: { ...(o.accounts || {}) }, since: { ...(o.since || {}) } };
  const before = String(o.accounts?.[id] || "").trim().replace(/^@/, "").toLowerCase();
  const name = String(account || "").trim();
  if (name) next.accounts[id] = name; else delete next.accounts[id];
  const after = name.replace(/^@/, "").toLowerCase();
  if (before && after && before !== after) next.since[id] = new Date(now).toISOString();
  if (!Object.keys(next.since).length) delete next.since;
  return next;
}

/** The audience's calendar day now, YYYY-MM-DD. */
export function todayIn(timeZone, now = Date.now()) {
  return new Date(now).toLocaleDateString("sv", { timeZone });
}

/** The bookings to make: planWeek over every chosen network from today, `aheadDays` long, each network capped at
    its own limit (TikTok at `tiktokAheadDays`, a day inside its 10 so a slow upload never lands past it).
    YouTube takes at most `youtubeLeft` new uploads (its daily upload allowance, shared with the automatic swap).
    stalled: networks Results › Reach marks stalled (every measured post at 0 views, days out: perf.reach), not booked
    at all (BL-055: TikTok showed nobody anything and kept being booked). themeDays: the theme rule for every network.
    slots: each network's hours (postSlots); a booking at a test hour carries test: "hour", usual and why. */
export function planAhead({ reels = [], networks = AUTO_NETS, posts = [], timeZone = "Asia/Tokyo", now = Date.now(),
  aheadDays = 14, tiktokAheadDays = 9, youtubeLeft = Infinity, stalled = [], themeDays = THEME_DAYS_ALL, slots = {}, perDay = {} } = {}) {
  const limits = { ...AUTO_LIMITS, tiktok: Math.min(AUTO_LIMITS.tiktok, tiktokAheadDays) };
  const quiet = new Set(stalled);
  const nets = networks.filter((n) => n in limits && !quiet.has(n));
  const start = todayIn(timeZone, now);
  const r = planWeek({ reels, networks: nets, posts, start, days: aheadDays, timeZone, now, limits, themeDays, slots, perDay });
  let yt = 0;
  // Said the same way as Needs you (server/problems.mjs reachProblems): one rule, one sentence, so the page shows why.
  const plan = [], skipped = [...networks.filter((n) => n in limits && quiet.has(n)).map((n) => ({ day: start, network: n, stalled: true,
    why: `${NET_NAMES[n] || n} paused until a post is seen: every post measured on the account in use now is at 0 views (Results › Reach: stalled); the studio books it again when one is seen` })),
  ...r.skipped.filter((s) => s.why !== "already past" && s.why !== "already has a post that day")];
  for (const p of r.plan) {
    if (p.network === "youtube" && ++yt > youtubeLeft) { skipped.push({ day: p.day, network: "youtube", why: "YouTube's uploads for today are used; the next run books it" }); continue; }
    plan.push(p);
  }
  return { ...r, plan, skipped };
}
