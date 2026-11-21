// Runs by itself: which approved reels are booked where and when (server/autoplan.mjs), and the start-at-sign-in
// file (scripts/autostart.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTO_NETS, fitsNetwork, planAhead, todayIn } from "../server/autoplan.mjs";
import { openerOf, YT_GATE } from "../server/helper.mjs";
import { setStartup, startupDir, startupScript, startupState } from "../scripts/autostart.mjs";

const spec = { channels: [
  { id: "x", variant: "c-silent" }, { id: "tiktok", variant: "a-loop" }, { id: "linkedin", variant: "b-explainer" },
  { id: "gbp", variant: "c-silent" }, { id: "facebook", variant: "b-explainer" }, { id: "youtube-shorts", variant: "a-loop" },
  { id: "bluesky", variant: "c-silent" }, { id: "line-oa", variant: "a-loop" }, { id: "instagram", off: true },
] };
// Wednesday 2026-11-11 09:00 JST.
const NOW = Date.parse("2026-11-11T09:00:00+09:00");

test("which reel may go where follows the page planner", () => {
  const short = { slug: "fire-1111", stats: { faces: 0 } }, long = { slug: "fire-1111-long", stats: { faces: 0 } }, people = { slug: "team-1111", stats: { faces: 2 } };
  assert.equal(fitsNetwork(short, "x", spec), true);
  assert.equal(fitsNetwork(short, "linkedin", spec), false, "LinkedIn takes long cuts only");
  assert.equal(fitsNetwork(long, "linkedin", spec), true);
  assert.equal(fitsNetwork(long, "tiktok", spec), false, "a long cut only where the channel takes explainers");
  assert.equal(fitsNetwork(long, "facebook", spec), true);
  assert.equal(fitsNetwork(people, "gbp", spec), false, "Google Maps never shows people");
  assert.equal(fitsNetwork(short, "youtube", spec), true, "youtube reads the youtube-shorts channel");
  assert.equal(fitsNetwork(short, "instagram", spec), false, "a network switched off is never planned");
  assert.equal(fitsNetwork(short, "pinterest", spec), false, "a network missing from the spec is never planned");
});

test("plans from today, one a day per network, each within its own limit", () => {
  // Thirty themes (r0-..., r29-...): the theme rule (3 days on every network, BL-055) never runs out of reels here.
  const reels = Array.from({ length: 30 }, (_, i) => ({ slug: `r${i}-1111`, headline: `h${i}`, networks: ["x", "tiktok", "facebook", "bluesky"] }));
  const r = planAhead({ reels, networks: ["x", "tiktok", "facebook", "bluesky"], posts: [], now: NOW, aheadDays: 14, tiktokAheadDays: 9 });
  const by = (n) => r.plan.filter((p) => p.network === n);
  assert.equal(by("x").length, 14, "X: today 19:00 through 13 days ahead");
  assert.equal(by("x")[0].at, "2026-11-11T19:00+09:00");
  assert.ok(by("tiktok").every((p) => Date.parse(p.at) <= NOW + 9 * 86400e3), "TikTok inside its 9 days");
  assert.equal(by("tiktok").length, 9);
  for (const n of ["x", "facebook"]) assert.equal(new Set(by(n).map((p) => p.day)).size, by(n).length, `${n}: one a day`);
  for (const n of ["x", "bluesky"]) assert.equal(new Set(by(n).map((p) => p.slug)).size, by(n).length, `${n}: never the same reel twice`);
});

test("Facebook books every other day and never a theme it had within 3 days (16 Nov: one of 8 daily reels was shown)", () => {
  const themes = ["aerial", "carstay", "fire", "autumn", "aerial", "connect", "office", "aerial", "warm", "pov"];
  const reels = themes.map((t, i) => ({ slug: `${t}-11${10 + i}`, headline: `h${i}`, networks: ["facebook"] }));
  const r = planAhead({ reels, networks: ["facebook"], posts: [], now: NOW, aheadDays: 14 });
  const days = r.plan.map((p) => p.day);
  assert.ok(days.length >= 5, `about half the days (${days.length})`);
  for (let i = 1; i < days.length; i++) assert.ok(Date.parse(days[i]) - Date.parse(days[i - 1]) >= 2 * 86400e3, `${days[i - 1]} then ${days[i]}`);
  for (let i = 0; i < r.plan.length; i++) for (let j = i + 1; j < r.plan.length; j++) {
    const gap = (Date.parse(r.plan[j].day) - Date.parse(r.plan[i].day)) / 86400e3;
    if (gap <= 3) assert.notEqual(r.plan[i].slug.split("-")[0], r.plan[j].slug.split("-")[0], `${r.plan[i].slug} and ${r.plan[j].slug}`);
  }
  assert.ok(r.skipped.some((s) => s.why === "Facebook posts every other day"));
  // Other networks keep one a day.
  const x = planAhead({ reels: reels.map((p) => ({ ...p, networks: ["x"] })), networks: ["x"], now: NOW, aheadDays: 5 });
  assert.equal(x.plan.length, 5);
});

test("days that already hold a post and reels a network already had are skipped", () => {
  const reels = [{ slug: "a", headline: "A", networks: ["x"] }, { slug: "b", headline: "B", networks: ["x"] }, { slug: "c", headline: "C", networks: ["x"] }];
  const posts = [{ slug: "a", network: "x", status: "scheduled", at: "2026-11-11T19:00+09:00" }];
  const r = planAhead({ reels, networks: ["x"], posts, now: NOW, aheadDays: 3 });
  assert.deepEqual(r.plan.map((p) => [p.day, p.slug]), [["2026-11-12", "b"], ["2026-11-13", "c"]]);
});

test("YouTube books no more than the day's uploads left", () => {
  const reels = Array.from({ length: 10 }, (_, i) => ({ slug: `r-${i}`, headline: `h${i}`, networks: ["youtube"] }));
  const r = planAhead({ reels, networks: ["youtube"], now: NOW, aheadDays: 10, youtubeLeft: 2 });
  assert.equal(r.plan.length, 2);
  assert.ok(r.skipped.some((s) => /uploads for today/.test(s.why)));
});

test("weekly networks keep their day: LinkedIn Sunday, LINE Saturday", () => {
  const reels = [{ slug: "a-long", headline: "A", networks: ["linkedin", "line-oa"] }, { slug: "b-long", headline: "B", networks: ["linkedin", "line-oa"] }];
  const r = planAhead({ reels, networks: ["linkedin", "line-oa"], now: NOW, aheadDays: 14 });
  for (const p of r.plan) assert.equal(new Date(`${p.day}T00:00:00Z`).getUTCDay(), p.network === "linkedin" ? 0 : 6);
  assert.equal(r.plan.filter((p) => p.network === "linkedin").length, 2);
});

test("every network keeps a theme off for 3 days, and the best-scored reel goes first, not the first by id (BL-055)", () => {
  // 21 Nov: TikTok was booked eight aerial-* reels in a row: reels came in id order and only Facebook had a theme rule.
  const reels = ["aerial-1", "aerial-2", "aerial-3", "aerial-4", "autumn-1", "carstay-1", "fire-1", "field-1"].map((slug, i) =>
    ({ slug, headline: `h${i}`, networks: ["tiktok", "x"], score: slug === "fire-1" ? 90 : slug === "field-1" ? 80 : 50 }));
  for (const net of ["tiktok", "x"]) {
    const r = planAhead({ reels, networks: [net], posts: [], now: NOW, aheadDays: 8 });
    const rows = r.plan;
    assert.equal(rows[0].slug, "fire-1", `${net}: the best score first`);
    assert.equal(rows[1].slug, "field-1");
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const gap = (Date.parse(rows[j].day) - Date.parse(rows[i].day)) / 86400e3;
      if (gap <= 3) assert.notEqual(rows[i].slug.split("-")[0], rows[j].slug.split("-")[0], `${net}: ${rows[i].slug} and ${rows[j].slug}`);
    }
    assert.ok(rows.filter((p) => p.slug.startsWith("aerial")).length <= 2, `${net}: no run of aerial reels`);
  }
  // themeDays: 0 switches the general rule off (Facebook keeps its own).
  const off = planAhead({ reels: reels.map((p) => ({ ...p, score: undefined })), networks: ["x"], posts: [], now: NOW, aheadDays: 4, themeDays: 0 });
  assert.deepEqual(off.plan.map((p) => p.slug), ["aerial-1", "aerial-2", "aerial-3", "aerial-4"]);
});

test("a stalled network is not booked, and says why (BL-055)", () => {
  const reels = Array.from({ length: 6 }, (_, i) => ({ slug: `t${i}-1111`, headline: `h${i}`, networks: ["tiktok", "youtube"] }));
  const r = planAhead({ reels, networks: ["tiktok", "youtube"], posts: [], now: NOW, aheadDays: 3, stalled: ["tiktok"] });
  assert.ok(r.plan.length && r.plan.every((p) => p.network === "youtube"));
  const why = r.skipped.find((s) => s.network === "tiktok");
  assert.ok(why && why.stalled && /0 views/.test(why.why) && /stalled/.test(why.why));
});

test("the YouTube gate: 18 s or more first, no title again within 14 days, no opener again within 7 (BL-056)", () => {
  assert.equal(openerOf("不便だからこそ、尾根まで見渡せる。｜嬬恋牧場"), "不便だからこそ");
  assert.deepEqual(YT_GATE, { minSec: 18, openerDays: 7, titleDays: 14 });
  const reels = [
    { slug: "a1-1111", headline: "短い一本。", seconds: 14, score: 95, networks: ["youtube"] },
    { slug: "b1-1111", headline: "不便だからこそ、景色がいい。", seconds: 20, score: 60, networks: ["youtube"] },
    { slug: "c1-1111", headline: "不便だからこそ、星が近い。", seconds: 22, score: 70, networks: ["youtube"] },
    { slug: "d1-1111", headline: "同じ題。", seconds: 21, score: 99, networks: ["youtube"] },
    { slug: "e1-1111", headline: "区画がないからこそ、好きな場所に。", seconds: 19, score: 10, networks: ["youtube"] },
  ];
  // d1's title already went out on YouTube 10 days ago under another reel: never booked again inside 14 days.
  const posts = [{ slug: "old-1101", network: "youtube", status: "posted", at: "2026-11-01T19:00+09:00" }];
  const r = planAhead({ reels: [...reels, { slug: "old-1101", headline: "同じ題。", networks: [] }], networks: ["youtube"], posts, now: NOW, aheadDays: 5 });
  const order = r.plan.map((p) => p.slug);
  assert.ok(!order.includes("d1-1111"), "an exact title repeat within 14 days");
  assert.equal(order[0], "c1-1111", "18 s or more beats a higher-scored 14 s Short");
  assert.equal(order[1], "e1-1111", "the same opener as the day before waits");
  assert.equal(order[2], "b1-1111");
  assert.equal(order[3], "a1-1111", "the 14 s Short goes last");
  // Other networks are not gated: the 14 s reel with the best score goes first on X.
  const x = planAhead({ reels: reels.map((p) => ({ ...p, networks: ["x"] })), networks: ["x"], now: NOW, aheadDays: 1 });
  assert.equal(x.plan[0].slug, "d1-1111");
});

test("every network the studio books by itself is known", () => {
  assert.deepEqual([...AUTO_NETS].sort(), ["bluesky", "facebook", "gbp", "line-oa", "linkedin", "tiktok", "x", "youtube"]);
  assert.equal(todayIn("Asia/Tokyo", Date.parse("2026-11-11T16:00:00Z")), "2026-11-12");
});

test("start at sign-in writes one small file and removes it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazycow-startup-"));
  assert.equal(startupState(dir).on, false);
  const on = setStartup(true, dir, "C:\\studio", "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(on.on, true);
  const text = readFileSync(on.file, "utf8");
  assert.match(text, /start "" \/min "C:\\Program Files\\nodejs\\node\.exe" "C:\\studio[\\/]scripts[\\/]launch\.mjs" --at-signin/);
  assert.equal(setStartup(false, dir, "C:\\studio").on, false);  // the same studio folder that switched it on (test/autostart.test.mjs: another folder's file is left alone)
  assert.equal(existsSync(on.file), false);
  assert.equal(startupDir({}, "linux"), null);
  assert.equal(startupState(null).supported, false);
  assert.throws(() => setStartup(true, null));
  assert.match(startupScript("C:\\s", "node"), /\r\n/);
});
