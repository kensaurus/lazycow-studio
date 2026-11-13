/*
 * FILE: server/swap.mjs
 * PURPOSE: The rules of the automatic swap (a booking made before its reel got new words is swapped for the newest
 *          render at the same time slot), kept apart from the server so they can be tested: why a booking is not
 *          swapped yet, which one goes next, and what a finished swap does to the day's state.
 * NOTES: A swap counts as done only when it succeeded. A failed booking waits (10 min, then 1 h) before it is tried
 *        again and stops after 3 failures; the stale list shows it so a person can look. YouTube uploads have their own
 *        allowance since 1 June 2026 (100 a day per Google app, 1 unit each; the old 1,600 units made it about 6); the
 *        swap takes at most YT_PER_DAY of them, leaving the rest for new posts and long videos. It is spent when an
 *        upload starts, since a failed upload can still use it. Bare times (no offset) are
 *        read as this computer's local time, the same rule as py/studio/posting.py.
 * USAGE: classify(booking, reel, ctx) · pickNext(list, state, now) · noteResult(state, booking, ok, now, error)
 */
export const REPLACEABLE = ["facebook", "youtube", "x", "tiktok"];
export const YT_PER_DAY = 20;  // of YouTube's 100 uploads a day per Google app (developers.google.com/youtube/v3/getting-started)
export const MAX_TRIES = 3;
export const RETRY_AFTER_MIN = [10, 60];
const SOON_MS = 30 * 60e3;

const stampMs = (c) => Date.parse(String(c).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(c)) ? "" : "Z"));  // the log's created stamps are UTC

/* Why a booking still holds older words and is not swapped yet, or null when it does not (or is no longer) need one:
   ready · review (the new render waits for a person) · rendering · soon (out within 30 min) · elsewhere (booked inside
   LINE, LinkedIn or Google Maps) · failed (stopped after MAX_TRIES). A booking whose time has passed is out: null. */
export function classify(p, reel, { needsReview, busy, now = Date.now(), fails = {} }) {
  if (p.status !== "scheduled" || !p.created || !p.at || p.network === "all") return null;  // queued: sent from the newest render
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || at <= now) return null;
  // New words (wordsAt) or the same reel with its sound fixed (soundAt, studio.levels): either makes a booking older.
  const changed = Math.max(Date.parse(reel?.wordsAt || "") || 0, Date.parse(reel?.soundAt || "") || 0, Date.parse(reel?.versionAt || "") || 0);
  if (!changed || !(changed > stampMs(p.created) + 60e3)) return null;
  if (!REPLACEABLE.includes(p.network)) return "elsewhere";
  if (needsReview) return "review";
  if (reel.wordsPending || busy) return "rendering";
  if (at < now + SOON_MS) return "soon";
  if ((fails[p.id]?.n || 0) >= MAX_TRIES) return "failed";
  return "ready";
}

/* The next booking to swap: the soonest ready one that is not waiting after a failure, YouTube within its allowance. */
export function pickNext(list, state, now = Date.now()) {
  const fails = state.fails || {};
  return list.find((x) => x.why === "ready" && !(fails[x.id]?.next > now) && (x.network !== "youtube" || (state.yt || 0) < YT_PER_DAY)) || null;
}

/* A swap was started: YouTube's allowance is spent now. */
export function noteStart(state, booking, now = Date.now()) {
  if (booking.network === "youtube") state.yt = (state.yt || 0) + 1;
  state.last = { slug: booking.slug, network: booking.network, at: booking.at, when: new Date(now).toISOString() };
  return state;
}

/* A swap ended: a success is counted and clears the booking's failures; a failure waits, then stops after MAX_TRIES. */
export function noteResult(state, booking, ok, now = Date.now(), error = "") {
  state.fails = state.fails || {};
  if (ok) {
    state.done = (state.done || 0) + 1;
    delete state.fails[booking.id];
    return state;
  }
  const n = (state.fails[booking.id]?.n || 0) + 1;
  state.failed = (state.failed || 0) + 1;
  state.fails[booking.id] = { n, slug: booking.slug, network: booking.network, error: String(error || "failed").slice(0, 200),
    next: n >= MAX_TRIES ? null : now + RETRY_AFTER_MIN[Math.min(n - 1, RETRY_AFTER_MIN.length - 1)] * 60e3, when: new Date(now).toISOString() };
  return state;
}
