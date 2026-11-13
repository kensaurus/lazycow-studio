// The Problems list (server/problems.mjs): what went wrong stays shown until its cause is gone. The three cases are the
// ones the studio never showed on 13 Nov.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { findProblems, createStore } = await import("../server/problems.mjs");
const NOW = Date.parse("2026-11-13T09:00:00+08:00");

test("a booked reel that is not approved is red and cannot be dismissed (focus-1107)", () => {
  const posts = [
    { id: 130, slug: "focus-1107", network: "line-oa", status: "scheduled", at: "2026-12-05T10:00+09:00" },
    { id: 131, slug: "ok-1", network: "x", status: "scheduled", at: "2026-12-05T19:00+09:00" },
    { id: 132, slug: "vlog-3", network: "youtube", status: "scheduled", at: "2026-12-05T19:00+09:00" },
    { id: 133, slug: "old-1", network: "x", status: "scheduled", at: "2026-11-01T19:00+09:00" },
  ];
  const reviews = [{ slug: "story-focus-1107", status: "rendered" }, { slug: "story-ok-1", status: "approved" }, { slug: "story-old-1", status: "rendered" }];
  const found = findProblems({ posts, reviews, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["unapproved:focus-1107"], "approved, long-video and past bookings are fine");
  assert.equal(found[0].level, "red");
  assert.equal(found[0].dismissable, false);
  assert.match(found[0].detail, /line-oa/);
  assert.equal(found[0].fix.href, "#/reel/focus-1107");
});

test("a post that did not go out in the last two weeks is red; older ones are not shown", () => {
  const posts = [
    { id: 1, slug: "a", network: "bluesky", status: "missed", at: "2026-11-11T19:00+09:00" },
    { id: 2, slug: "b", network: "x", status: "failed", at: "2026-10-01T19:00+09:00" },
  ];
  const found = findProblems({ posts, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["missed:1"]);
  assert.equal(found[0].dismissable, true, "the past can be let go");
});

test("long videos that repeat days or vary a lot in length are amber (the 13 Kenya parts)", () => {
  const parts = [
    { n: 1, days: ["2015-09-13", "2015-09-14", "2015-09-15"], built: { seconds: 190 } },
    { n: 2, days: ["2015-09-13", "2015-09-14"], built: { seconds: 713 } },
    { n: 3, days: ["2015-09-16"], built: { seconds: 622 } },
  ];
  const [f] = findProblems({ parts, now: NOW });
  assert.equal(f.id, "vlog-shape"); assert.equal(f.level, "amber");
  assert.match(f.detail, /parts 1 and 2 show some of the same days/i);
  assert.match(f.detail, /3:10 to 11:53/);
  const series = [1, 2, 3, 4].map((n) => ({ n, days: [`2015-09-1${n}`], built: { seconds: 590 + n * 5 } }));
  assert.deepEqual(findProblems({ parts: series, now: NOW }), [], "a real series: nothing to say");
});

test("the store keeps a problem until its cause is gone, and honours dismissals", () => {
  const file = join(mkdtempSync(join(tmpdir(), "problems-")), "problems.json");
  let t = NOW;
  const store = createStore(file, { now: () => t });
  const red = { id: "unapproved:x", level: "red", title: "x", detail: "d", fix: { label: "f", href: "#/" }, dismissable: false };
  const amber = { id: "vlog-shape", level: "amber", title: "v", detail: "d", fix: { label: "f", href: "#/videos" }, dismissable: true };
  assert.equal(store.checked([red, amber]), true);
  assert.equal(store.dismiss("unapproved:x"), false, "a red problem about the future cannot be dismissed");
  assert.equal(store.dismiss("vlog-shape"), true);
  assert.equal(store.dismiss("nope"), "missing");
  assert.deepEqual(store.open().map((i) => i.id), ["unapproved:x"]);
  store.record({ id: "switch", level: "info", title: "Switched", detail: "d", fix: { label: "f", href: "#/" } }, 1);
  assert.equal(createStore(file, { now: () => t }).open().length, 2, "kept on disk");
  store.checked([]);
  assert.deepEqual(store.open().map((i) => i.id), ["switch"], "the cause is gone: the checked problems go; the event stays");
  t += 2 * 86400e3;
  assert.deepEqual(store.open(), [], "an event expires");
});

test("a post booked but not seen live is red, with a link to look on the network (carstay-1108, Google Maps, 13 Nov)", () => {
  const posts = [{ id: 7, slug: "carstay-1108", network: "gbp", status: "missing", at: "2026-11-13T12:00+09:00", note: "not seen 6 h after its time" }];
  const [p] = findProblems({ posts, now: NOW + 10 * 3600e3 });
  assert.equal(p.id, "missed:7");
  assert.match(p.title, /carstay-1108 was not seen on Google Maps/);
  assert.match(p.detail, /It's out/);
  assert.equal(p.also.href, "https://business.google.com/locations");
});

test("a sign-in that ends before booked posts is red two weeks ahead; with nothing booked after it, only near the end", () => {
  const connections = { bluesky: { connected: true, until: "2026-11-22T23:35+00:00" }, facebook: { connected: true } };
  const posts = [
    { id: 1, slug: "a", network: "bluesky", status: "queued", at: "2026-11-20T19:00+09:00" },
    { id: 2, slug: "b", network: "bluesky", status: "queued", at: "2026-11-25T19:00+09:00" },
    { id: 3, slug: "c", network: "bluesky", status: "queued", at: "2026-12-12T19:00+09:00" },
  ];
  const reviews = [{ slug: "story-a", status: "approved" }, { slug: "story-b", status: "approved" }, { slug: "story-c", status: "approved" }];
  const [p] = findProblems({ posts, reviews, connections, now: NOW });
  assert.equal(p.id, "signin:bluesky");
  assert.equal(p.level, "red");
  assert.equal(p.dismissable, false);
  assert.match(p.title, /Bluesky signs out in 10 days/);
  assert.match(p.detail, /2 booked posts after that will not go out/);
  assert.match(p.detail, /App password/);
  assert.equal(p.fix.href, "#/accounts");
  assert.deepEqual(findProblems({ posts: posts.slice(0, 1), reviews, connections, now: NOW }), [], "nothing after the end, 10 days left: quiet");
  const late = findProblems({ posts: [], connections, now: Date.parse("2026-11-21T00:00:00Z") });
  assert.equal(late[0]?.level, "amber", "2 days left with nothing booked after: a heads-up");
});

test("a network whose measured posts reached nobody is amber, with where to look (TikTok and Facebook, 0 views)", () => {
  const perf = { networks: { tiktok: { name: "TikTok", metric: "views", median: 0, posts: 2 }, youtube: { median: 16.5, posts: 2 },
    facebook: { metric: "views", median: 0, posts: 1 } } };
  const found = findProblems({ perf, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["reach:tiktok"], "one measured post is not a pattern");
  assert.equal(found[0].also.href, "https://www.tiktok.com/tiktokstudio");
});
