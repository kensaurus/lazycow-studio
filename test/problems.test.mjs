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
  assert.match(p.title, /carstay-1108 may not be live on Google Maps/);
  assert.match(p.detail, /It's out/);
  assert.equal(p.also.href, "https://business.google.com/locations");
});

test("a sign-in that ends before booked posts is amber two weeks ahead and red from 3 days before; never dismissable", () => {
  const connections = { bluesky: { connected: true, until: "2026-11-22T23:35+00:00" }, facebook: { connected: true } };
  const posts = [
    { id: 1, slug: "a", network: "bluesky", status: "queued", at: "2026-11-20T19:00+09:00" },
    { id: 2, slug: "b", network: "bluesky", status: "queued", at: "2026-11-25T19:00+09:00" },
    { id: 3, slug: "c", network: "bluesky", status: "queued", at: "2026-12-12T19:00+09:00" },
  ];
  const reviews = [{ slug: "story-a", status: "approved" }, { slug: "story-b", status: "approved" }, { slug: "story-c", status: "approved" }];
  const [p] = findProblems({ posts, reviews, connections, now: NOW });
  assert.equal(p.id, "signin:bluesky");
  assert.equal(p.level, "amber", "10 days ahead it will become a problem: amber, not red (owner, 17 Nov)");
  assert.equal(p.dismissable, false, "about the future: fixed, never dismissed");
  assert.match(p.title, /Bluesky signs out in 10 days/);
  assert.match(p.detail, /2 booked posts after that will not go out/);
  assert.match(p.detail, /App password/);
  assert.equal(p.fix.href, "#/accounts");
  assert.deepEqual(findProblems({ posts: posts.slice(0, 1), reviews, connections, now: NOW }), [], "nothing after the end, 10 days left: quiet");
  const late = findProblems({ posts: [], connections, now: Date.parse("2026-11-21T00:00:00Z") });
  assert.equal(late[0]?.level, "amber", "2 days left with nothing booked after: a heads-up");
  const near = findProblems({ posts, reviews, connections, now: Date.parse("2026-11-20T00:00:00Z") }).find((f) => f.id === "signin:bluesky");
  assert.equal(near?.level, "red", "3 days left with posts booked after it: red");
  assert.equal(near?.dismissable, false);
  const out = findProblems({ posts: [], connections, now: Date.parse("2026-11-22T12:00:00Z") });
  assert.equal(out[0]?.level, "red", "under a day left: red");
});

test("a network whose measured posts reached nobody is amber, with where to look (TikTok and Facebook, 0 views)", () => {
  const perf = { networks: { tiktok: { name: "TikTok", metric: "views", median: 0, posts: 2 }, youtube: { median: 16.5, posts: 2 },
    facebook: { metric: "views", median: 0, posts: 1 } } };
  const found = findProblems({ perf, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["reach:tiktok"], "one measured post is not a pattern");
  assert.equal(found[0].also.href, "https://www.tiktok.com/tiktokstudio");
});

test("a network with a 0 median but one post that was seen is not 'reaching nobody' (Facebook, 17 Nov)", () => {
  const perf = { networks: { facebook: { metric: "views", median: 0, posts: 7, silent: false },
    bluesky: { metric: "engagements", median: 0, posts: 6, silent: true } } };
  assert.deepEqual(findProblems({ perf, now: NOW }).map((f) => f.id), ["reach:bluesky"]);
});

test("every problem a check finds says itself in Japanese too: title, detail and the fix's label", () => {
  const posts = [
    { id: 1, slug: "a", network: "bluesky", status: "missing", at: "2026-11-11T19:00+09:00" },
    { id: 2, slug: "b", network: "x", status: "scheduled", at: "2026-12-05T19:00+09:00" },
    { id: 3, slug: "c", network: "bluesky", status: "scheduled", at: "2026-12-05T19:00+09:00" },
  ];
  const parts = [{ n: 1, days: ["2015-04-02"], built: { seconds: 190 } }, { n: 2, days: ["2015-04-02"], built: { seconds: 600 } }];
  const connections = { bluesky: { connected: true, until: "2026-11-20T09:00+09:00" } };
  const perf = { networks: { tiktok: { posts: 3, median: 0, metric: "views" } } };
  const found = findProblems({ posts, reviews: [], parts, connections, perf, now: NOW });
  assert.deepEqual(found.map((f) => f.id.split(":")[0]).sort(), ["missed", "reach", "signin", "unapproved", "unapproved", "vlog-shape"]);
  for (const f of found) {
    assert.ok(f.ja?.title && f.ja?.detail && f.ja?.fix, `${f.id}: Japanese title, detail and fix`);
    assert.match(f.ja.title + f.ja.detail, /[぀-ヿ一-鿿]/, `${f.id}: written in Japanese`);
    if (f.also) assert.ok(f.ja.also, `${f.id}: the second link too`);
  }
  assert.match(found.find((f) => f.id === "signin:bluesky").ja.title, /あと7日/);
});

test("a job's failure is cleared when the same job later finishes fine; a check's problem is not an event to clear", () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "prob-")), "p.json"), { now: () => NOW });
  store.record({ id: "job:helper-perf", level: "red", title: "Reading view numbers did not finish", detail: "timeout" });
  store.checked([{ id: "signin:bluesky", level: "amber", title: "x", detail: "y" }]);
  assert.equal(store.clear("job:helper-perf"), true);
  assert.deepEqual(store.open().map((x) => x.id), ["signin:bluesky"]);
  assert.equal(store.clear("signin:bluesky"), false, "a check clears itself when its cause is gone");
  assert.equal(store.clear("job:none"), false);
});

test("an AI service out of credit: amber with the jobs that switched, red for blocks with no backup, Try again and Top up (owner, 18 Nov)", () => {
  const health = {
    providers: [{ id: "fal", name: "fal.ai" }, { id: "runway", name: "Runway" }],
    problems: [{ provider: "fal", name: "fal.ai", kind: "out_of_credit", until: Date.parse("2026-11-18T20:02:00+09:00") / 1000, level: "amber",
      caps: ["img2video", "music"], noBackup: [], backups: ["runway"], switched: [{ provider: "runway", name: "Runway", n: 3 }],
      billing: "https://fal.ai/dashboard/billing" }],
  };
  const [p] = findProblems({ aiHealth: health, now: NOW });
  assert.equal(p.id, "ai:fal");
  assert.equal(p.level, "amber");
  assert.equal(p.title, "fal.ai is out of credit, so 3 jobs used Runway instead");
  assert.deepEqual(p.fix.action, { ai: "retry", provider: "fal" });
  assert.equal(p.fix.label, "Try fal.ai again");
  assert.deepEqual(p.also, { label: "Top up", href: "https://fal.ai/dashboard/billing" });
  assert.equal(p.dismissable, false, "it is fixed by a top-up or Try again, not dismissed");
  assert.match(p.ja.title, /代わりに3件をRunwayで作りました/);
  const red = { ...health, problems: [{ ...health.problems[0], level: "red", noBackup: ["music", "voice"], switched: [] }] };
  const [r] = findProblems({ aiHealth: red, now: NOW });
  assert.equal(r.level, "red");
  assert.equal(r.title, "fal.ai is out of credit and no other service is set up for Music, Voice-over");
  assert.match(r.detail, /Voice-over switches only when you turn it on/);
  assert.deepEqual(findProblems({ aiHealth: null, now: NOW }), [], "no health read: nothing to say");
});

test("a missed post booked again on the same network is not red while the new booking stands (focus-1108-3, row 343, 24 Nov)", () => {
  const posts = [
    { id: 52, slug: "focus-1108-3", network: "bluesky", status: "missed", at: "2026-11-11T19:00+09:00" },
    { id: 343, slug: "focus-1108-3", network: "bluesky", status: "queued", at: "2026-11-20T19:00+09:00" },
    { id: 60, slug: "b", network: "bluesky", status: "failed", at: "2026-11-11T19:00+09:00" },
    { id: 61, slug: "b", network: "x", status: "queued", at: "2026-11-20T19:00+09:00" },       // another network: no help
    { id: 70, slug: "c", network: "bluesky", status: "failed", at: "2026-11-12T19:00+09:00" },
    { id: 71, slug: "c", network: "bluesky", status: "failed", at: "2026-11-12T21:00+09:00" },  // booked again, failed again
    { id: 80, slug: "d", network: "bluesky", status: "failed", at: "2026-11-12T19:00+09:00" },
    { id: 81, slug: "d", network: "bluesky", status: "posted", at: "2026-11-12T20:00+09:00" },  // went out the second time
  ];
  const found = findProblems({ posts, reviews: [{ slug: "focus-1108-3", status: "approved" }, { slug: "b", status: "approved" }], now: NOW });
  assert.deepEqual(found.map((f) => f.id).sort(), ["missed:60", "missed:70", "missed:71"]);
});

test("a booked photo-post Story is not a reel: never 'booked but not approved' (photo sets, 24 Nov)", () => {
  const posts = [
    { id: 400, slug: "1121-130614-07-aura-food", network: "photo-story", status: "queued", at: "2026-11-25T12:15+09:00" },
    { id: 401, slug: "focus-1107", network: "instagram-story", status: "queued", at: "2026-11-25T12:15+09:00" },
  ];
  assert.deepEqual(findProblems({ posts, reviews: [], now: NOW }).map((f) => f.id), ["unapproved:focus-1107"]);
});

test("YouTube's dead sign-in (invalid_grant) is red with the Testing-mode cause; booked Shorts on YouTube still publish (24 Nov)", () => {
  const readErrors = { youtube: { error: "YouTube: Google 400: invalid_grant Token has been expired or revoked.", code: "auth", at: "2026-11-13T08:10:42+08:00" },
    bluesky: { error: "Bluesky 502: getPosts failed", code: "bluesky", at: "2026-11-13T08:10:42+08:00" } };  // not a sign-in: no problem
  const posts = [
    { id: 1, slug: "a", network: "youtube", status: "scheduled", at: "2026-11-20T19:00+09:00" },
    { id: 2, slug: "b", network: "youtube", status: "queued", at: "2026-11-21T19:00+09:00" },
    { id: 3, slug: "c", network: "youtube", status: "queued", at: "2026-11-22T19:00+09:00" },
  ];
  const reviews = ["a", "b", "c"].map((slug) => ({ slug, status: "approved" }));
  const found = findProblems({ posts, reviews, readErrors, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["signin:youtube"]);
  const [p] = found;
  assert.equal(p.level, "red");
  assert.equal(p.dismissable, false);
  assert.equal(p.title, "YouTube is signed out: nothing new uploads and no numbers are read");
  assert.match(p.detail, /1 Short already booked on YouTube itself still publishes/);
  assert.match(p.detail, /2 booked Shorts waiting to upload will not/);
  assert.match(p.detail, /Testing mode.*7 days.*Publish app/);
  assert.equal(p.fix.href, "#/accounts");
  assert.match(p.also.href, /console\.cloud\.google\.com/);
  assert.ok(p.ja.title && p.ja.detail.includes("7日") && p.ja.fix && p.ja.also);
});

test("a Facebook sign-in that stopped working is one red problem, covering Instagram Stories; a never-connected network is not", () => {
  const connections = {
    facebook: { connected: false, account: "Tsumagoi Work&Camp", error: "the token expired" },
    "instagram-story": { connected: false, account: "@tsumagoicamp", error: "the stored Facebook token expired" },
    bluesky: { connected: false, account: null, error: null },
  };
  const found = findProblems({ connections, posts: [{ id: 9, slug: "a", network: "instagram-story", status: "queued", at: "2026-11-20T12:00+09:00" }],
    reviews: [{ slug: "a", status: "approved" }], now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["signin:facebook"]);
  assert.match(found[0].detail, /1 booked post waiting to go out will not/);
  assert.match(found[0].detail, /Instagram Stories use the same sign-in/);
  assert.equal(found[0].title, "Facebook is signed out: nothing new goes out and no numbers are read");
});

test("readErrors reads the collector's files, and drops an error older than the token or after a later channel read worked", async () => {
  const { readErrors } = await import("../server/problems.mjs");
  const { writeFileSync, mkdirSync, utimesSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "readerr-"));
  mkdirSync(join(dir, "perf")); mkdirSync(join(dir, "secrets"));
  const grant = "YouTube: Google 400: invalid_grant Token has been expired or revoked.";
  const state = (p) => writeFileSync(join(dir, "perf", "state.json"), JSON.stringify({ problems: p }));
  const chan = (at, channels) => writeFileSync(join(dir, "perf", "channel.json"), JSON.stringify({ at, channels }));
  const token = (f, at) => { writeFileSync(join(dir, "secrets", f), "x"); utimesSync(join(dir, "secrets", f), new Date(at), new Date(at)); };
  token("youtube_token.bin", "2026-11-10T00:00:00Z");
  state({ youtube: { error: grant, code: "auth", at: "2026-11-24T04:10:42Z" } });
  chan("2026-11-24T03:10:47Z", [{ account: "main", error: grant }]);
  assert.equal(readErrors(dir).youtube.code, "auth");
  chan("2026-11-24T05:00:00Z", [{ account: "main", channel: "Tsumagoi", items: [] }]);  // a later channel read worked
  assert.equal(readErrors(dir).youtube, undefined);
  chan("2026-11-24T05:00:00Z", [{ account: "main", error: grant }]);                   // only the channel read knows
  state({});
  assert.equal(readErrors(dir).youtube.code, "auth");
  token("youtube_token.bin", "2026-11-24T06:00:00Z");                                   // connected again since
  assert.equal(readErrors(dir).youtube, undefined);
  state({ facebook: { error: "Facebook is not connected", code: "auth", at: "2026-11-24T04:10:42Z" } });  // no token file: disconnected on purpose
  chan("2026-11-24T05:00:00Z", []);
  assert.deepEqual(readErrors(dir), {});
  assert.deepEqual(readErrors(join(dir, "nothing-here")), {});
});

// Track C (24 Nov): one rule for "not being seen" (perf.reach stalled, the account in use now), numbers jobs in their
// own group, and a look-only studio that never rewrites the running studio's list.
test("reach problems follow the planner's stalled rule and say booking is paused", async () => {
  const { reachProblems } = await import("../server/problems.mjs");
  const reach = { networks: [
    { network: "tiktok", stalled: true, measured: 4, oldestH: 96, hasViews: true, accountSince: "2026-11-24T19:00+09:00" },
    { network: "facebook", stalled: false, verdict: "none", measured: 2, hasViews: true },  // too few to call
    { network: "bluesky", stalled: true, measured: 3, oldestH: 50, hasViews: false },
  ] };
  const found = findProblems({ reach, perf: { networks: { facebook: { metric: "views", median: 0, posts: 7, silent: true } } }, now: NOW });
  assert.deepEqual(found.map((f) => f.id), ["reach:bluesky", "reach:tiktok"], "with reach, the summary's 'silent' is not asked");
  const tk = found.find((f) => f.id === "reach:tiktok");
  assert.equal(tk.level, "amber"); assert.equal(tk.group, "numbers");
  assert.match(tk.title, /paused/); assert.match(tk.detail, /on the account in use since/); assert.match(tk.detail, /Plan posts books no new TikTok posts/);
  assert.match(tk.ja.title, /予約を止めています/);
  assert.match(found.find((f) => f.id === "reach:bluesky").detail, /likes, reposts or replies/);
  const notPaused = reachProblems(reach, { paused: false });
  assert.ok(notPaused.every((p) => !/paused/.test(p.title) && !/Plan posts books/.test(p.detail)), "skipStalled off: no claim the planner skips it");
  // a new account with only old posts (perf.reach: out 0, history 13) is not stalled: nothing to say
  assert.deepEqual(findProblems({ reach: { networks: [{ network: "tiktok", stalled: false, measured: 0, history: 13 }] }, now: NOW }), []);
});

test("a numbers read that stopped is amber, in Numbers, with the log and the Chrome link as its fix", async () => {
  const { isNumbersJob, numbersJobProblem } = await import("../server/problems.mjs");
  assert.ok(isNumbersJob("helper-perf") && isNumbersJob("perf") && isNumbersJob("perf-collect"));
  assert.ok(!isNumbersJob("perfect-1109") && !isNumbersJob("aerial-1108") && !isNumbersJob("helper-x-tiktok"));
  const p = numbersJobProblem("helper-perf", { detail: "Read 0 of 6 posts in your Chrome." });
  assert.equal(p.id, "job:helper-perf"); assert.equal(p.level, "amber"); assert.equal(p.group, "numbers");
  assert.equal(p.fix.href, "#/log/activity"); assert.equal(p.also.href, "#/accounts");
  assert.match(p.detail, /^Read 0 of 6 posts in your Chrome\. Nothing you made or booked is affected/);
  assert.doesNotMatch(p.detail + p.fix.label, /render/i, "never the render fix");
  assert.ok(p.ja.title && p.ja.fix && p.ja.also);
});

test("a store with saveTo starts from the shared list and never writes it", async () => {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "probsave-"));
  const shared = join(dir, "problems.json"), own = join(dir, "tmp", "problems-4323.json");
  writeFileSync(shared, JSON.stringify({ items: { "job:x": { id: "job:x", level: "red", title: "t", source: "event", dismissable: true } } }));
  const before = readFileSync(shared, "utf8");
  const s = createStore(shared, { saveTo: own, now: () => NOW });
  assert.deepEqual(s.open().map((i) => i.id), ["job:x"], "starts from the running studio's list");
  s.checked([{ id: "reach:tiktok", level: "amber", title: "r", detail: "d" }]);
  s.dismiss("job:x");
  assert.equal(readFileSync(shared, "utf8"), before, "the shared file is untouched");
  assert.ok(existsSync(own));
  assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).items["reach:tiktok"].id, "reach:tiktok");
});
