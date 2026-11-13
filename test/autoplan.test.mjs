// Runs by itself: which approved reels are booked where and when (server/autoplan.mjs), and the start-at-sign-in
// file (scripts/autostart.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTO_NETS, fitsNetwork, planAhead, todayIn } from "../server/autoplan.mjs";
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
  const reels = Array.from({ length: 30 }, (_, i) => ({ slug: `r-${i}`, headline: `h${i}`, networks: ["x", "tiktok", "facebook", "bluesky"] }));
  const r = planAhead({ reels, networks: ["x", "tiktok", "facebook", "bluesky"], posts: [], now: NOW, aheadDays: 14, tiktokAheadDays: 9 });
  const by = (n) => r.plan.filter((p) => p.network === n);
  assert.equal(by("x").length, 14, "X: today 19:00 through 13 days ahead");
  assert.equal(by("x")[0].at, "2026-11-11T19:00+09:00");
  assert.ok(by("tiktok").every((p) => Date.parse(p.at) <= NOW + 9 * 86400e3), "TikTok inside its 9 days");
  assert.equal(by("tiktok").length, 9);
  for (const n of ["x", "facebook"]) assert.equal(new Set(by(n).map((p) => p.day)).size, by(n).length, `${n}: one a day`);
  for (const n of ["x", "bluesky"]) assert.equal(new Set(by(n).map((p) => p.slug)).size, by(n).length, `${n}: never the same reel twice`);
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
