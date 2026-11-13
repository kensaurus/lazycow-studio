/*
 * FILE: server/autoplan.mjs
 * PURPOSE: The rules of "Runs by itself › Plan posts": which approved reels the studio books on its own, on which
 *          network and when. Kept apart from the server so the rules can be tested without a browser or a network.
 * OVERVIEW: One post per network per day at the network's hour (helper.mjs planWeek: 19:00; Google Maps Fri/Sat
 *           12:00; LINE Saturday 10:00 and LinkedIn Sunday 19:00, once a week), never the same reel twice on one
 *           network, each site only as far ahead as it accepts a booking. Which reel may go where follows the
 *           page planner (server/editor.html planFits): a long cut only where the channel takes explainers and on
 *           LinkedIn only long cuts; Google Maps never shows people (Google refused one post); a network switched
 *           off in Settings is never planned.
 * USAGE: fitsNetwork(manifest, network, spec) · planAhead({reels, networks, posts, ...}) · todayIn(timeZone)
 * NOTES: Only approved reels reach here (the server filters); approving stays with a person.
 */
import { planWeek, MAX_DAYS_AHEAD } from "./helper.mjs";

/* The networks the studio can book by itself, and how many days ahead each accepts (Facebook refuses reels beyond
   29 days; YouTube and Bluesky have no limit of their own, so two months keeps the queue honest). */
export const AUTO_LIMITS = { ...MAX_DAYS_AHEAD, facebook: 29, bluesky: 60, youtube: 60 };
export const AUTO_NETS = Object.keys(AUTO_LIMITS);
export const CHROME_NETS = ["x", "tiktok", "gbp", "line-oa", "linkedin"];
const CHANNEL_ID = { youtube: "youtube-shorts" };

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

/** The audience's calendar day now, YYYY-MM-DD. */
export function todayIn(timeZone, now = Date.now()) {
  return new Date(now).toLocaleDateString("sv", { timeZone });
}

/** The bookings to make: planWeek over every chosen network from today, `aheadDays` long, each network capped at
    its own limit (TikTok at `tiktokAheadDays`, a day inside its 10 so a slow upload never lands past it).
    YouTube takes at most `youtubeLeft` new uploads (its daily upload allowance, shared with the automatic swap). */
export function planAhead({ reels = [], networks = AUTO_NETS, posts = [], timeZone = "Asia/Tokyo", now = Date.now(),
  aheadDays = 14, tiktokAheadDays = 9, youtubeLeft = Infinity } = {}) {
  const limits = { ...AUTO_LIMITS, tiktok: Math.min(AUTO_LIMITS.tiktok, tiktokAheadDays) };
  const nets = networks.filter((n) => n in limits);
  const r = planWeek({ reels, networks: nets, posts, start: todayIn(timeZone, now), days: aheadDays, timeZone, now, limits });
  let yt = 0;
  const plan = [], skipped = [...r.skipped.filter((s) => s.why !== "already past" && s.why !== "already has a post that day")];
  for (const p of r.plan) {
    if (p.network === "youtube" && ++yt > youtubeLeft) { skipped.push({ day: p.day, network: "youtube", why: "YouTube's uploads for today are used; the next run books it" }); continue; }
    plan.push(p);
  }
  return { ...r, plan, skipped };
}
