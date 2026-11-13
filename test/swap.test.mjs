// The automatic swap's rules (server/swap.mjs): which bookings still need one, which goes next, and that only a
// success counts while a failing booking waits and then stops instead of being tried forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, pickNext, noteStart, noteResult, MAX_TRIES, YT_PER_DAY } from "../server/swap.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const reel = { wordsAt: "2026-11-10T09:00:00Z" };
const booking = (o = {}) => ({ id: 1, slug: "a", network: "x", status: "scheduled", created: "2026-11-09 10:00:00", at: "2026-11-20T19:00:00+09:00", ...o });

test("which bookings still need a swap, and why not yet", () => {
  const ctx = { needsReview: false, busy: false, now: NOW };
  assert.equal(classify(booking(), reel, ctx), "ready");
  assert.equal(classify(booking({ at: "2026-11-09T19:00:00+09:00" }), reel, ctx), null, "already past: out, not 'soon'");
  assert.equal(classify(booking({ at: new Date(NOW + 10 * 60e3).toISOString() }), reel, ctx), "soon");
  assert.equal(classify(booking({ created: "2026-11-10 10:00:00" }), reel, ctx), null, "booked after the new words");
  assert.equal(classify(booking({ status: "queued" }), reel, ctx), null, "the studio sends it from the newest render");
  assert.equal(classify(booking({ network: "line-oa" }), reel, ctx), "elsewhere");
  assert.equal(classify(booking(), reel, { ...ctx, needsReview: true }), "review");
  assert.equal(classify(booking(), { ...reel, wordsPending: true }, ctx), "rendering");
  assert.equal(classify(booking(), reel, { ...ctx, fails: { 1: { n: MAX_TRIES } } }), "failed");
});

test("a reel whose sound was fixed after a booking swaps it too; words or sound, the later one counts", () => {
  const ctx = { needsReview: false, busy: false, now: NOW };
  assert.equal(classify(booking(), { soundAt: "2026-11-10T09:00:00Z" }, ctx), "ready", "sound fixed after the booking");
  assert.equal(classify(booking(), { soundAt: "2026-11-08T09:00:00Z" }, ctx), null, "fixed before the booking: it already holds the fixed sound");
  assert.equal(classify(booking(), { wordsAt: "2026-11-08T09:00:00Z", soundAt: "2026-11-10T09:00:00Z" }, ctx), "ready");
  assert.equal(classify(booking(), {}, ctx), null, "nothing changed");
  assert.equal(classify(booking(), { versionAt: "2026-11-10T09:00:00Z" }, ctx), "ready", "a person chose a better version after the booking");
});

test("only a success counts; a failure waits, then stops after the last try", () => {
  const s = { yt: 0, done: 0 };
  const b = { id: 7, slug: "a", network: "x", why: "ready" };
  noteStart(s, b, NOW); noteResult(s, b, false, NOW, "the helper stopped");
  assert.equal(s.done, 0);
  assert.equal(pickNext([b], s, NOW + 5 * 60e3), null, "waits after a failure");
  assert.equal(pickNext([b], s, NOW + 11 * 60e3), b, "tried again after the wait");
  noteResult(s, b, false, NOW + 11 * 60e3, "again");
  assert.equal(pickNext([b], s, NOW + 30 * 60e3), null, "the second wait is longer");
  noteResult(s, b, false, NOW + 2 * 3600e3, "third");
  assert.equal(s.fails[7].n, MAX_TRIES); assert.equal(s.fails[7].next, null);
  assert.equal(classify(booking({ id: 7 }), reel, { now: NOW, fails: s.fails }), "failed", "stopped: listed, never picked");
  const ok = { id: 8, slug: "b", network: "x", why: "ready" };
  noteStart(s, ok, NOW); noteResult(s, ok, true, NOW);
  assert.equal(s.done, 1); assert.equal(s.fails[8], undefined);
});

test("YouTube's allowance is spent when an upload starts and caps the day", () => {
  const s = { yt: 0 };
  const yt = { id: 3, slug: "c", network: "youtube", why: "ready" }, x = { id: 4, slug: "d", network: "x", why: "ready" };
  for (let i = 0; i < YT_PER_DAY; i++) noteStart(s, yt, NOW);
  assert.equal(s.yt, YT_PER_DAY);
  assert.equal(pickNext([yt, x], s, NOW), x, "YouTube is skipped once the day's allowance is used");
});
