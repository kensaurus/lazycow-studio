/**
 * FILE: test/uiprefs.test.mjs
 * PURPOSE: Simple or full and the private usage counts (server/uiprefs.mjs, BL-114 and BL-120): the counter takes only
 *          ids from the page's FEATURES registry, keeps them on this computer, and the level is saved per project. Also
 *          the network tiers a new project starts with (BL-116).
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUsage, featureIds, keepNetworksOnUpgrade, madeBefore, readLevel, tierOf, writeLevel } from "../server/uiprefs.mjs";
import { assemblePage } from "../server/ui.mjs";
import { fileURLToPath } from "node:url";

const html = assemblePage(fileURLToPath(new URL("..", import.meta.url)));
const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8");
const scratch = () => mkdtempSync(join(tmpdir(), "lc-uiprefs-"));

test("the registry ids are read from the page (server/ui/js/02-nav-tools.js): every page, and each counted action as page:action", () => {
  const ids = featureIds(html);
  for (const id of ["home", "more", "reels", "review", "posting", "results", "accounts", "keys", "words", "log", "resnext", "bluesky"]) assert.ok(ids.has(id), id);
  for (const id of ["review:approve", "posting:book", "reels:make"]) assert.ok(ids.has(id), id);
  assert.ok(!ids.has("settings") && !ids.has("approve"), "only registry entries, not sections or bare actions");
  // Every page the router knows is in the registry (one list: no page outside it can be hidden or counted wrongly).
  const pages = /const PAGES = \{([\s\S]*?)\};/.exec(html)[1];
  for (const [, p] of pages.matchAll(/(\w+): \["/g)) assert.ok(ids.has(p), `PAGES.${p} is missing from FEATURES`);
});

test("the usage route only accepts registry ids, and counts stay in the project's own file", () => {
  const dir = scratch();
  try {
    const file = join(dir, "usage.json"), allowed = featureIds(html);
    let t = new Date("2026-11-20T10:00:00Z");
    const u = createUsage(file, allowed, { delayMs: 60_000, now: () => t });
    assert.equal(u.hit("words"), true);
    t = new Date("2026-11-24T09:00:00Z");
    assert.equal(u.hit("words"), true);
    assert.equal(u.hit("review:approve"), true);
    for (const bad of ["nope", "../etc", "", null, 42, "words:delete", "__proto__", "constructor", "Words"]) assert.equal(u.hit(bad), false, String(bad));
    assert.deepEqual(u.view(), { words: { n: 2, last: "2026-11-24T09:00:00.000Z" }, "review:approve": { n: 1, last: "2026-11-24T09:00:00.000Z" } });
    assert.equal(existsSync(file), false, "writes wait for the debounce");
    u.flush();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.words.n, 2);
    // A file edited by hand with a made-up id: dropped on read, never shown.
    writeFileSync(file, JSON.stringify({ words: { n: 3, last: null }, madeup: { n: 9 } }));
    assert.deepEqual(Object.keys(createUsage(file, allowed).view()), ["words"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a look-only studio counts in memory and never writes the file", () => {
  const dir = scratch();
  try {
    const file = join(dir, "usage.json"), u = createUsage(file, featureIds(html), { persist: false });
    u.hit("home"); u.flush();
    assert.equal(existsSync(file), false);
    assert.equal(u.view().home.n, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the level is simple or full, saved per project with whether the person chose it", () => {
  const dir = scratch();
  try {
    const file = join(dir, "ui.json");
    assert.equal(readLevel(file), null);
    assert.deepEqual(writeLevel(file, "simple", false), { level: "simple", chosen: false });
    assert.deepEqual(readLevel(file), { level: "simple", chosen: false });
    writeLevel(file, "full");
    assert.deepEqual(readLevel(file), { level: "full", chosen: true });
    assert.throws(() => writeLevel(file, "expert"), /simple or full/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the server wires /api/ui and /api/ui/usage to the registry, and a refused id answers 400", () => {
  assert.ok(server.includes("featureIds(assemblePage(ROOT))"), "the ids come from the whole page (shell + parts, server/ui.mjs)");
  assert.match(server, /url\.pathname === "\/api\/ui\/usage"\) \{\s*const b = await body\(req\);\s*if \(!USAGE\.hit\(b\.id\)\) return send\(res, 400/);
  assert.match(server, /url\.pathname === "\/api\/ui"\) \{\s*const b = await body\(req\);\s*if \(!\["simple", "full"\]\.includes\(b\.level\)\) return send\(res, 400/);
});

test("network tiers: the six common networks are on in a new project, a channel's own tier wins", () => {
  const spec = JSON.parse(readFileSync(new URL("../shared/channels.json", import.meta.url), "utf8")).channels;
  const common = spec.filter((c) => tierOf(c) === "common").map((c) => c.id).sort();
  assert.ok(common.length >= 1 && common.every((id) => ["facebook", "instagram", "linkedin", "tiktok", "x", "youtube-shorts"].includes(id) || spec.find((c) => c.id === id).tier === "common"), common.join());
  assert.equal(tierOf({ id: "bluesky" }), "more");
  assert.equal(tierOf({ id: "bluesky", tier: "common" }), "common");
  assert.equal(tierOf({ id: "tiktok", tier: "more" }), "more");
  assert.equal(tierOf({ id: "zenn" }), "more", "an id no longer in the public list is simply 'more'");
});

test("an upgrade keeps the networks of a project that already made reels; a new or a chosen project is left alone", () => {
  const dir = scratch();
  try {
    const projects = join(dir, "projects");
    const channels = [{ id: "tiktok" }, { id: "bluesky" }, { id: "instagram", off: true }];
    mkdirSync(projects, { recursive: true });
    assert.equal(keepNetworksOnUpgrade({ dataDir: dir, projectsDir: projects, channels }), null, "nothing made yet: the new default applies");
    writeFileSync(join(projects, "first-reel.json"), "{}");
    assert.equal(keepNetworksOnUpgrade({ dataDir: dir, projectsDir: projects, channels, ranch: true }), null, "the ranch keeps its own rule");
    const file = keepNetworksOnUpgrade({ dataDir: dir, projectsDir: projects, channels });
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([kept.on, kept.off], [["tiktok", "bluesky"], ["instagram"]], "every network it posted to stays on");
    writeFileSync(file, JSON.stringify({ on: ["x"], off: [] }));
    assert.equal(keepNetworksOnUpgrade({ dataDir: dir, projectsDir: projects, channels }), null, "a choice already made is never rewritten");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).on, ["x"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("photo posts, a long-video plan or a booked post also count as made before: their networks are kept too", () => {
  for (const made of ["photo post", "long-video plan", "booked post", "only working folders"]) {
    const dir = scratch();
    try {
      const projects = join(dir, "projects");  // no reel in any of these
      const channels = [{ id: "tiktok" }, { id: "bluesky" }, { id: "instagram", off: true }];
      if (made === "photo post") mkdirSync(join(dir, "stills", "cafe-kumo-autumn"), { recursive: true });
      if (made === "long-video plan") writeFileSync(join(dir, "vlog-plan.json"), "{\"videos\": []}");
      if (made === "only working folders") mkdirSync(join(dir, "stills", "_pub"), { recursive: true });
      const posted = made === "booked post";  // the server asks the engine for booked and posted rows
      assert.equal(madeBefore(dir, projects), made === "photo post" || made === "long-video plan", made);
      const file = keepNetworksOnUpgrade({ dataDir: dir, projectsDir: projects, channels, posted });
      if (made === "only working folders") { assert.equal(file, null, "nothing made: the new default applies"); continue; }
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).on, ["tiktok", "bluesky"], made);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
