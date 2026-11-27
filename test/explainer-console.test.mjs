/**
 * FILE: test/explainer-console.test.mjs
 * PURPOSE: One console for every video type (server/ui/js/22-console.js) and explainers riding the reels' pipeline:
 *   the type filter's data (each record's type, the counts, the filter), each reel's key numbers from Results' rows,
 *   the daily plan booking an approved explainer like a reel, and the server's explainer routes (the render queue,
 *   no network shares, nothing approved or posted there).
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fitsNetwork, planAhead } from "../server/autoplan.mjs";
import { assemblePage } from "../server/ui.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = assemblePage(ROOT).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const body = (name) => { const at = script.indexOf(`function ${name}(`); assert.ok(at > 0, name); return script.slice(at, script.indexOf("\n}", at) + 2); };
const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const channels = JSON.parse(readFileSync(new URL("../shared/channels.json", import.meta.url), "utf8"));
// eslint-disable-next-line no-new-func
const vx = new Function(`${body("vxType")}\n${body("vxCounts")}\n${body("vxFilter")}\n${body("vxNumbers")}\nreturn { vxType, vxCounts, vxFilter, vxNumbers };`)();

const REELS = [
  { slug: "cafe-a", type: "reel" }, { slug: "cafe-walk", variant: "site-walk" }, { slug: "cafe-a-long", variant: "b-explainer" },
  { slug: "cafe-why", type: "explainer" }, { slug: "cafe-how", type: "explainer" }, { slug: "view", house: true },
];

test("each record has one video type; an old overview without it reads it from the cut", () => {
  assert.deepEqual(REELS.map(vx.vxType), ["reel", "walk", "long", "explainer", "explainer", "reel"]);
});

test("the type filter counts every kind and keeps one kind; house reels are counted nowhere", () => {
  assert.deepEqual(vx.vxCounts(REELS, 2, 7), { all: 5, reel: 1, walk: 1, explainer: 2, long: 1, vlog: 2, photo: 7 });
  assert.deepEqual(vx.vxFilter(REELS, "explainer").map((r) => r.slug), ["cafe-why", "cafe-how"]);
  assert.equal(vx.vxFilter(REELS, "all").length, REELS.length);
  assert.deepEqual(vx.vxFilter(REELS, "vlog"), []);
});

test("each card's numbers: YouTube views and the share kept, Instagram plays; a swapped-out post is left out", () => {
  const rows = [
    { slug: "cafe-why", network: "youtube", views: 1000, engaged: 80 }, { slug: "cafe-why", network: "youtube", views: 200, engaged: 40 },
    { slug: "cafe-why", network: "instagram", views: 350 }, { slug: "cafe-why", network: "facebook", views: 9 },
    { slug: "cafe-how", network: "youtube", views: 50, engaged: null }, { slug: "cafe-old", network: "youtube", views: 999, engaged: 1, retired: "replaced" },
  ];
  const n = vx.vxNumbers(rows);
  assert.deepEqual(n["cafe-why"], { yt: { views: 1200, engaged: 120, kept: 10 }, ig: { plays: 350 } });
  assert.deepEqual(n["cafe-how"], { yt: { views: 50, engaged: 0, kept: null } }, "no engaged views read yet: no share");
  assert.equal(n["cafe-old"], undefined);
  assert.deepEqual(vx.vxNumbers(null), {});
});

test("an approved explainer is planned like any short reel, on Shorts, Reels, Facebook and Bluesky, never on LinkedIn", () => {
  const spec = { channels: channels.channels.map((c) => ({ ...c, off: undefined })) };
  const m = { slug: "cafe-why", kind: "explainer", stats: { faces: 0 } };
  for (const n of ["youtube", "instagram", "facebook", "bluesky"]) assert.equal(fitsNetwork(m, n, spec), true, n);
  assert.equal(fitsNetwork(m, "linkedin", spec), false);
  const now = Date.parse("2026-11-27T09:00:00+09:00");
  const r = planAhead({ reels: [{ slug: "cafe-why", headline: "Why", networks: ["youtube", "instagram"] }], networks: ["youtube", "instagram"], now, aheadDays: 1 });
  assert.deepEqual(r.plan.map((p) => [p.slug, p.network]).sort(), [["cafe-why", "instagram"], ["cafe-why", "youtube"]]);
});

test("the page sends an explainer's editor address to its own page, and the console sits on Reels", () => {
  assert.match(script, /r\.slug === m\[1\] && r\.type === "explainer"\)\) \{ location\.replace\(`#\/explainer\/\$\{m\[1\]\}`\)/);
  assert.match(script, /explainer: renderExplainer/);
  assert.match(body("renderReels"), /vxFilter\(R, vxSel\)/);
  assert.match(body("renderReels"), /vxTypeBar\(R\)/);
  assert.match(body("reelCard"), /vxChip\(r\)/);
});

test("the explainer routes queue renders one at a time, refuse network shares, and never approve or post", () => {
  const at = server.indexOf('url.pathname === "/api/explainers"');
  const block = server.slice(at, server.indexOf('url.pathname === "/api/stills/file"'));
  assert.ok(at > 0 && block.length > 500);
  assert.match(block, /startRender\(r\.slug\)/, "Save & render goes through the render queue");
  assert.match(block, /made\.map\(\(s\) => startRender\(s\)\.slug\)/, "a folder's drafts too, one at a time");
  assert.match(block, /\/\^\(\\\\\\\\\|\\\/\\\/\)\/\.test\(path\)/, "a network share is refused");
  assert.doesNotMatch(block, /approve|publish|youtube\/upload|helper/i);
});
