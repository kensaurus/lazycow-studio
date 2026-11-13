/**
 * FILE: test/helper.test.mjs
 * PURPOSE: The browser helper's scheduling rules (server/helper.mjs), without a browser: the time a site
 *          must show (JST -> the PC's clock), the week planner's cadence and spacing, and the refusals
 *          that keep an unapproved or duplicate post from ever being scheduled.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  BUFFER_LIMIT, countOf, filePayload, linkedinLabel, gbpLabels, labelledNumbers, localParts, matchPost, parseXLabel, planWeek, postFor, postObjects,
  scheduleRefusal, splitTags, tiktokLabels, wallClock, xLabel, zonedIso,
} from "../server/helper.mjs";
import { fileURLToPath } from "node:url";

/* ---------- your Chrome: files go to the page as bytes ---------- */
test("in your Chrome a file goes to the page as bytes (no disk access needed); big files and the own window use the path", () => {
  const me = fileURLToPath(import.meta.url);
  const v = filePayload(me, { extension: true, size: 1000 });
  assert.equal(v.name, "helper.test.mjs");
  assert.equal(v.mimeType, "application/octet-stream");
  assert.ok(Buffer.isBuffer(v.buffer) && v.buffer.length > 100);
  assert.equal(filePayload("C:\\r\\a_1080x1920.mp4", { extension: false, size: 10 }), "C:\\r\\a_1080x1920.mp4");
  assert.equal(filePayload("C:\\r\\a.mp4", { extension: true, size: BUFFER_LIMIT + 1 }), "C:\\r\\a.mp4");
});

/* ---------- performance readers ---------- */
test("counts read the way sites print them", () => {
  assert.deepEqual(["1,234", "1.2K", "3.4M", "1.5万", "2億", "12", "", "abc", null].map(countOf), [1234, 1200, 3400000, 15000, 200000000, 12, null, null, null]);
});

test("X's action bar label gives replies, reposts, likes, bookmarks and views, in English and Japanese", () => {
  assert.deepEqual(parseXLabel("3 replies, 2 reposts, 10 likes, 1 bookmark, 4,567 views"), { comments: 3, shares: 2, likes: 10, saves: 1, views: 4567 });
  assert.deepEqual(parseXLabel("12 likes, 1.2K views"), { likes: 12, views: 1200 });
  assert.deepEqual(parseXLabel("3 件の返信、2 件のリポスト、10 件のいいね、1 件のブックマーク、456 件の表示"), { comments: 3, shares: 2, likes: 10, saves: 1, views: 456 });
  assert.deepEqual(parseXLabel(""), {});
});

test("post objects are found in a site's own data, with counts one level down and rates as percentages", () => {
  const tiktok = { data: { item_list: [
    { item_id: "7570000000000000001", create_time: 1762941600, desc: "不便だからこそ、景色がいい。 #嬬恋", statistics: { play_count: 1500, digg_count: 80, comment_count: 3, share_count: 4, collect_count: 9 }, finish_rate: 0.185 },
    { item_id: "7570000000000000002", create_time: 1762855200, desc: "別の動画", statistics: { play_count: 99 } },
  ] }, extra: { now: 1 } };
  const found = postObjects(tiktok);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { id: "7570000000000000001", time: 1762941600000, text: "不便だからこそ、景色がいい。 #嬬恋",
    numbers: { views: 1500, likes: 80, comments: 3, shares: 4, saves: 9, completion_pct: 18.5 } });
  assert.deepEqual(postObjects({ pin: { id: "550494754478797558", impression_count: "1.2K", save_count: 3 } })[0].numbers, { saves: 3, reach: 1200 });
  // TikTok Studio's list as it really is (2026-11-09): counts as strings, favorite_count = saves, and the time that
  // matters is post_time (when it goes out), not create_time (the upload).
  const studio = postObjects({ item_list: [{ item_id: "7705964232126237972", create_time: "1794184621", post_time: "1794650400", schedule_time: "1794650400",
    desc: "不便だからこそ、景色がいい。", play_count: "12", like_count: "3", comment_count: "0", share_count: "1", favorite_count: "2" }] })[0];
  assert.equal(studio.time, Date.parse("2026-11-14T19:00+09:00"));
  assert.deepEqual(studio.numbers, { views: 12, likes: 3, comments: 0, shares: 1, saves: 2 });
  assert.deepEqual(postObjects({ user: { id: "1", name: "no counts" } }), []);
});

test("a log entry matches by id, else by time (20 min) with text breaking ties, else by unique text", () => {
  const at = "2026-11-12T19:00+09:00", t = Date.parse(at);
  const cands = [
    { id: "a", time: t + 60e3, text: "別の話" },
    { id: "b", time: t + 2 * 60e3, text: "不便だからこそ、景色がいい。" },
    { id: "c", time: t - 3 * 3600e3, text: "標高1,444m の朝" },
  ];
  assert.equal(matchPost(cands, { remoteId: "c", at }).id, "c");
  assert.equal(matchPost(cands, { at, text: "不便だからこそ、景色がいい。\n標高" }).id, "b", "the text breaks a tie in the window");
  assert.equal(matchPost(cands, { at }).id, "a", "else the closest in time");
  assert.equal(matchPost(cands, { at: "2026-11-20T19:00+09:00", text: "標高1,444m の朝" }).id, "c", "outside the window: a unique text");
  assert.equal(matchPost(cands, { at: "2026-11-20T19:00+09:00", text: "nothing like it" }), null);
});

test("labelled numbers in a stats panel's text, label before or after the number", () => {
  const text = "Pin stats\nImpressions\n1,234\nSaves\n12\n3\nComments\nOutbound clicks 4";
  assert.deepEqual(labelledNumbers(text, { reach: /^impressions/i, saves: /^saves/i, comments: /^comments/i }), { reach: 1234, saves: 12, comments: 3 });
  assert.deepEqual(labelledNumbers("表示回数 56", { views: /^(views|表示回数)/i }), { views: 56 });
});

/* ---------- time conversion ---------- */
test("19:00 JST is 18:00 on a Singapore PC, and X shows it the way it does", () => {
  const p = localParts("2026-11-13T19:00+09:00", "Asia/Singapore");
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday, p.hour12, p.ampm], [2026, 11, 13, 18, 0, "Fri", 6, "pm"]);
  assert.equal(xLabel(p), "Will send on Fri, Nov 13, 2026 at 6:00 PM");
  assert.deepEqual(tiktokLabels(p), { date: "2026年11月13日", time: "18:00" });
  const tokyo = localParts("2026-11-13T19:00+09:00", "Asia/Tokyo");
  assert.equal(tokyo.hour, 19);
});

test("conversion crosses midnight and month ends, and keeps 12 AM / 12 PM right", () => {
  const late = localParts("2026-11-14T00:30+09:00", "Asia/Singapore");
  assert.equal(xLabel(late), "Will send on Fri, Nov 13, 2026 at 11:30 PM");
  const monthEnd = localParts("2026-12-01T00:00+09:00", "Asia/Singapore");
  assert.deepEqual([monthEnd.month, monthEnd.day, monthEnd.hour], [11, 30, 23]);
  assert.equal(xLabel(localParts("2026-11-13T01:05+09:00", "Asia/Singapore")), "Will send on Fri, Nov 13, 2026 at 12:05 AM");
  assert.equal(xLabel(localParts("2026-11-13T13:00+09:00", "Asia/Singapore")), "Will send on Fri, Nov 13, 2026 at 12:00 PM");
  assert.equal(localParts("2026-11-13T10:00Z", "Asia/Tokyo").hour, 19);
});

test("a time without a zone is refused, never guessed", () => {
  assert.throws(() => localParts("2026-11-13T19:00", "Asia/Tokyo"), /zone/);
  assert.throws(() => wallClock("2026-11-13 19:00"), /zone/);
});

test("Google Maps keeps the listing's wall clock, shown as DD/MM/YYYY", () => {
  const p = wallClock("2026-11-13T12:00+09:00");
  assert.deepEqual(gbpLabels(p), { date: "13/11/2026", time: "12:00", listed: "Scheduled 13 Nov" });
  assert.equal(p.weekday, "Fri");
});

test("zonedIso puts the audience's offset on a local time, through daylight saving", () => {
  assert.equal(zonedIso("2026-11-16", "19:00", "Asia/Tokyo"), "2026-11-16T19:00+09:00");
  assert.equal(zonedIso("2026-07-01", "19:00", "Europe/London"), "2026-07-01T19:00+01:00");
  assert.equal(zonedIso("2026-12-01", "19:00", "Europe/London"), "2026-12-01T19:00+00:00");
});

/* ---------- what gets posted ---------- */
const DIR = join("I:", "drafts", "autumn");
const manifest = {
  slug: "autumn", title: "不便だからこそ、景色がいい。",
  channels: [
    { name: "x", dir: join(DIR, "x"), videos: [{ file: "a_1068x1900.mp4" }, { file: "a_1920x1080.mp4" }],
      post: "不便だからこそ。\nhttps://t.example/e?utm_source=threads&utm_medium=social\n#嬬恋 #tsumagoicamp\n" },
    { name: "tiktok", dir: join(DIR, "tiktok"), videos: [{ file: "a_1080x1920_no-music.mp4" }, { file: "a_1080x1920.mp4" }],
      post: "一行目\n二行目\n\n#tsumagoicamp #嬬恋 #紅葉\n" },
    { name: "gbp", dir: join(DIR, "gbp"), files: ["cover_1080x1920.jpg", "cover_1200x900.jpg", "post.txt", "a.mp4"], videos: [{ file: "a.mp4" }],
      post: "一行目\n\nフィールドだけ：¥5,200。\n\nボタン：予約 → https://t.example/events?utm_source=gbp&utm_medium=social\n" },
  ],
};

test("postFor takes the music cut, tags the link for the network, and turns the Maps button line into a URL", () => {
  const x = postFor(manifest, "x");
  assert.equal(x.file, join(DIR, "x", "a_1068x1900.mp4"));
  assert.match(x.text, /utm_source=x&/);
  assert.equal(x.headline, "不便だからこそ、景色がいい。");
  assert.equal(postFor(manifest, "tiktok").file, join(DIR, "tiktok", "a_1080x1920.mp4"));
  const g = postFor(manifest, "gbp");
  assert.equal(g.file, join(DIR, "gbp", "cover_1200x900.jpg"));
  assert.equal(g.extra.url, "https://t.example/events?utm_source=gbp&utm_medium=social");
  assert.equal(g.text, "一行目\n\nフィールドだけ：¥5,200。");
  assert.equal(postFor(manifest, "linkedin"), null);
});

test("splitTags separates trailing hashtag lines for TikTok", () => {
  assert.deepEqual(splitTags("一行目\n二行目\n\n#tsumagoicamp #嬬恋 #紅葉\n"), { body: "一行目\n二行目", tags: ["#tsumagoicamp", "#嬬恋", "#紅葉"] });
  assert.deepEqual(splitTags("no tags here"), { body: "no tags here", tags: [] });
});

/* ---------- refusals ---------- */
const NOW = Date.parse("2026-11-09T12:00+09:00");
const ok = { status: "approved", slug: "aerial-1108", network: "x", at: "2026-11-16T19:00+09:00", now: NOW };

test("only approved reels, on the three networks, at a zoned time inside the site's window", () => {
  assert.equal(scheduleRefusal({ ...ok }), null);
  assert.match(scheduleRefusal({ ...ok, status: "rendered" }), /not approved/);
  assert.match(scheduleRefusal({ ...ok, status: null }), /no review record/);
  assert.match(scheduleRefusal({ ...ok, network: "bluesky" }), /X, TikTok, Google Maps, LINE, LinkedIn only/);
  assert.match(scheduleRefusal({ ...ok, at: "2026-11-16T19:00" }), /zone/);
  assert.match(scheduleRefusal({ ...ok, at: "2026-11-09T12:05+09:00" }), /past or less than 15 minutes/);
  assert.match(scheduleRefusal({ ...ok, network: "tiktok", at: "2026-11-25T19:00+09:00" }), /10 days ahead/);
  assert.equal(scheduleRefusal({ ...ok, network: "tiktok", at: "2026-11-18T19:00+09:00" }), null);
});

test("never the same reel on the same network at the same time, however the time is written", () => {
  const posts = [{ id: 7, slug: "aerial-1108", network: "x", status: "scheduled", at: "2026-11-16T18:00+08:00" }];
  assert.match(scheduleRefusal({ ...ok, posts }), /already scheduled on x at that time \(post 7\)/);
  assert.match(scheduleRefusal({ ...ok, posts: [{ ...posts[0], status: "planned" }] }), /already planned/);
  // A dropped or failed post does not hold the slot; another network or another time is fine.
  assert.equal(scheduleRefusal({ ...ok, posts: [{ ...posts[0], status: "failed" }] }), null);
  assert.equal(scheduleRefusal({ ...ok, posts: [{ ...posts[0], network: "tiktok" }] }), null);
  assert.equal(scheduleRefusal({ ...ok, posts: [{ ...posts[0], at: "2026-11-17T19:00+09:00" }] }), null);
  assert.match(scheduleRefusal({ ...ok, busy: true }), /already being scheduled/);
});

/* ---------- plan a week ---------- */
const reels = [
  { slug: "a", headline: "景色", networks: ["x", "tiktok", "gbp"] },
  { slug: "b", headline: "焚き火", networks: ["x", "tiktok", "gbp"] },
  { slug: "c", headline: "星", networks: ["x", "tiktok", "gbp"] },
  { slug: "c2", headline: "星", networks: ["x", "tiktok", "gbp"] },  // a second cut with the same headline
  { slug: "d", headline: "冬", networks: ["x", "tiktok"] },           // no Maps cover
];

function checkPlan({ plan }, existing = []) {
  const seen = new Set();
  const byNet = {};
  for (const p of plan) {
    const key = `${p.network} ${p.day}`;
    assert.ok(!seen.has(key), `two posts on ${key}`);
    seen.add(key);
    (byNet[p.network] ||= []).push(p);
    const wd = new Date(`${p.day}T00:00:00Z`).getUTCDay();
    if (p.network === "gbp") {
      assert.ok(wd === 5 || wd === 6, `Maps only on Fri/Sat, got ${p.day}`);
      assert.equal(p.at, `${p.day}T12:00+09:00`);
    } else assert.equal(p.at, `${p.day}T19:00+09:00`);
  }
  for (const [net, rows] of Object.entries(byNet)) {
    const slugs = rows.map((r) => r.slug);
    assert.equal(new Set(slugs).size, slugs.length, `a reel twice on ${net}`);
    const heads = new Map([...existing.filter((e) => e.network === net).map((e) => [e.day, e.headline]), ...rows.map((r) => [r.day, r.headline])]);
    for (const r of rows) {
      const prev = new Date(Date.parse(`${r.day}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
      assert.notEqual(heads.get(prev), r.headline, `same headline on ${net} on ${prev} and ${r.day}`);
    }
  }
}

test("plan a week: one post per network per day at 19:00 JST, Maps at 12:00 on Fri and Sat only", () => {
  const r = planWeek({ reels, posts: [], now: NOW, timeZone: "Asia/Tokyo" });
  assert.equal(r.start, "2026-11-10");
  checkPlan(r);
  const maps = r.plan.filter((p) => p.network === "gbp").map((p) => p.day);
  assert.deepEqual(maps, ["2026-11-13", "2026-11-14"]);
  // Five reels for X: five days filled, the last two days have none left (each reel once per network).
  assert.equal(r.plan.filter((p) => p.network === "x").length, 5);
  assert.ok(r.skipped.some((s) => s.network === "x" && /no approved reel left/.test(s.why)));
  // c and c2 share a headline: never on consecutive days on one network.
  for (const net of ["x", "tiktok"]) {
    const days = r.plan.filter((p) => p.network === net && ["c", "c2"].includes(p.slug)).map((p) => Date.parse(p.day));
    if (days.length === 2) assert.ok(Math.abs(days[0] - days[1]) > 86400e3, `${net}: 星 on consecutive days`);
  }
});

test("plan a week: skips booked days, reels a network already had, skipped reels, and spaces headlines from existing posts", () => {
  const posts = [
    { id: 1, slug: "a", network: "x", status: "scheduled", at: "2026-11-10T19:00+09:00" },  // x on the 10th is taken
    { id: 2, slug: "b", network: "tiktok", status: "planned", at: "2026-11-10T10:00" },      // naive = this PC's time: the 10th in JST from UTC (CI) to UTC+9
    { id: 3, slug: "c", network: "tiktok", status: "dropped", at: "2026-11-11T19:00+09:00" }, // dropped frees the slot
    { id: 4, slug: "d", network: "all", status: "skipped", at: null },                       // d is not to be posted
    { id: 5, slug: "c", network: "gbp", status: "scheduled", at: "2026-11-13T12:00+09:00" },
  ];
  const r = planWeek({ reels, posts, now: NOW, timeZone: "Asia/Tokyo" });
  checkPlan(r, [{ network: "tiktok", day: "2026-11-10", headline: "焚き火" }, { network: "x", day: "2026-11-10", headline: "景色" }, { network: "gbp", day: "2026-11-13", headline: "星" }]);
  assert.ok(!r.plan.some((p) => p.network === "x" && p.day === "2026-11-10"));
  assert.ok(!r.plan.some((p) => p.network === "tiktok" && p.day === "2026-11-10"));
  assert.ok(r.plan.some((p) => p.network === "tiktok" && p.day === "2026-11-11"));
  assert.ok(!r.plan.some((p) => p.slug === "d"));
  assert.ok(!r.plan.some((p) => p.network === "x" && p.slug === "a"));
  // Maps had 星 (c) on Friday the 13th: Saturday must not be c2 (same headline), and c is not reused.
  const sat = r.plan.find((p) => p.network === "gbp" && p.day === "2026-11-14");
  assert.ok(sat && !["c", "c2"].includes(sat.slug));
  assert.ok(r.skipped.some((s) => s.network === "gbp" && s.day === "2026-11-13" && /already has a post/.test(s.why)));
});

test("plan a week: networks and start can be narrowed, past slots and TikTok's 10-day limit are respected", () => {
  const r = planWeek({ reels, networks: ["tiktok"], posts: [], start: "2026-11-09", days: 14, now: NOW, timeZone: "Asia/Tokyo" });
  assert.ok(r.plan.every((p) => p.network === "tiktok"));
  assert.equal(r.plan[0].day, "2026-11-09");  // 19:00 today is still ahead at noon
  assert.ok(r.plan.every((p) => Date.parse(p.at) <= NOW + 10 * 86400e3));
  const early = planWeek({ reels, networks: ["x"], start: "2026-11-09", days: 1, now: Date.parse("2026-11-09T18:50+09:00") });
  assert.deepEqual(early.plan, []);
  assert.match(early.skipped[0].why, /already past/);
});

test("plan a week: LINE gets one message a week, Saturday 10:00 JST, never within 7 days of another", () => {
  const lineReels = reels.map((r) => ({ ...r, networks: [...(r.networks || []), "line-oa"] }));
  const r = planWeek({ reels: lineReels, networks: ["line-oa"], posts: [], now: NOW, timeZone: "Asia/Tokyo", days: 14 });
  const line = r.plan.filter((p) => p.network === "line-oa");
  assert.ok(line.length >= 1 && line.length <= 2);
  for (const p of line) {
    assert.equal(new Date(`${p.day}T00:00:00Z`).getUTCDay(), 6);
    assert.equal(p.at, `${p.day}T10:00+09:00`);
  }
  const booked = planWeek({ reels: lineReels, networks: ["line-oa"], now: NOW, timeZone: "Asia/Tokyo",
    posts: [{ id: 9, slug: "a", network: "line-oa", status: "scheduled", at: "2026-11-09T19:00+09:00" }] });
  assert.ok(!booked.plan.some((p) => p.day === "2026-11-14"), "a message on the 9th: nothing again on the 14th");
});

test("plan a week: LinkedIn gets one post a week, Sunday 19:00 JST, never within 7 days of another", () => {
  const liReels = reels.map((r) => ({ ...r, networks: [...(r.networks || []), "linkedin"] }));
  const r = planWeek({ reels: liReels, networks: ["linkedin"], posts: [], now: NOW, timeZone: "Asia/Tokyo", days: 14 });
  const li = r.plan.filter((p) => p.network === "linkedin");
  assert.ok(li.length >= 1 && li.length <= 2);
  for (const p of li) {
    assert.equal(new Date(`${p.day}T00:00:00Z`).getUTCDay(), 0);
    assert.equal(p.at, `${p.day}T19:00+09:00`);
  }
});

test("LinkedIn's post box label: weekday, short month, day, 12-hour time in the PC's clock", () => {
  assert.equal(linkedinLabel(localParts("2026-11-15T19:00+09:00", "Asia/Singapore")), "Sun, Nov 15 at 6:00 PM");
  assert.equal(linkedinLabel(localParts("2026-11-30T09:05+09:00", "Asia/Singapore")), "Mon, Nov 30 at 8:05 AM");
});

test("a sign-in tab asked for by name opens even when the studio cannot read that network's sign-in (LINE)", async () => {
  const { signinTabs } = await import("../server/helper.mjs");
  const table = { x: { cookie: "auth_token" }, "line-oa": { cookie: null }, tiktok: { cookie: "sessionid" } };
  const now = { x: true, "line-oa": null, tiktok: false };
  assert.deepEqual(signinTabs(table, now, ["line-oa"]), ["line-oa"]);   // 12 Nov: nothing opened for LINE
  assert.deepEqual(signinTabs(table, now, ["x"]), []);                  // known signed in: no tab
  assert.deepEqual(signinTabs(table, now, []), ["tiktok"]);             // no names: only cookies that show signed out
  assert.deepEqual(signinTabs(table, now, ["nope"]), []);
});

test("LINE: a message delivered a minute after its booked time is that booking's row", async () => {
  const { lineRowFor } = await import("../server/helper.mjs");
  const rows = [{ state: "sent", text: "645329344 車で来て、車で寝る。 すべての友だち 17 2026/11/09 18:01" },
    { state: "booked", text: "645417725 山に… すべての友だち 2026/12/05 09:00 2026/11/09 22:16" }];
  const at = (year, month, day, hour, minute) => ({ year, month, day, hour, minute });
  assert.equal(lineRowFor(rows, at(2026, 11, 9, 18, 0))?.state, "sent");   // 12 Nov: shown as 18:01, booked 18:00
  assert.equal(lineRowFor(rows, at(2026, 12, 5, 9, 0))?.state, "booked");  // exact
  assert.equal(lineRowFor(rows, at(2026, 11, 9, 18, 30)), null);           // not within 5 minutes
});
