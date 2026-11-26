/**
 * FILE: test/auto-drafts.test.mjs
 * PURPOSE: Drafts from new footage (BL-142, 26 Nov): a look-only studio (STUDIO_QUIET=1) never makes reels by itself,
 *          even after a person adds a folder or presses Look for new files; and the day's count is kept per project
 *          (<data>/auto-drafts.json), so one project's drafts never use up another's day. The old shared
 *          STUDIO_HOME/auto-drafts.json is read safely and never written.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { draftsFile, draftsRoom, nextDraftsState, readDraftsState, writeDraftsState } from "../server/auto-drafts.mjs";

const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (name) => { const at = server.indexOf(`async function ${name}(`); assert.ok(at > 0, name); return server.slice(at, server.indexOf("\n}", at) + 2); };
const today = "2026-11-26";

test("a look-only studio never drafts: no room whatever the setting, and autoDrafts stops before anything is asked", () => {
  assert.equal(draftsRoom({ quiet: true, perDay: 2, state: {}, today }), 0);
  assert.equal(draftsRoom({ quiet: true, perDay: 10, state: { day: "2026-11-01", n: 9 }, today }), 0);
  assert.equal(draftsRoom({ quiet: false, perDay: 2, state: {}, today }), 2);
  const body = fn("autoDrafts");
  const first = body.split("\n")[1].trim();
  assert.match(first, /^if \(QUIET\) return;/, "the QUIET check is the first thing autoDrafts does");
  assert.ok(body.indexOf("if (QUIET) return;") < body.indexOf('cmd: "autopilot"'), "before any reel is asked for");
  assert.match(body, /draftsRoom\(\{ quiet: QUIET,/);
  // Both person-pressed paths still end in autoDrafts (they catalogue footage in a quiet studio too); the guard is in it.
  assert.match(server, /startTask\("footage", "watch", \["sources", "watch"\], \(job\) => \{ if \(\(job\.result\?\.added \|\| 0\) > 0\) autoDrafts\(/);
});

test("the day's cap: room is what is left today, a new day starts again, off is off", () => {
  assert.equal(draftsRoom({ quiet: false, perDay: 2, state: { day: today, n: 1 }, today }), 1);
  assert.equal(draftsRoom({ quiet: false, perDay: 2, state: { day: today, n: 2 }, today }), 0);
  assert.equal(draftsRoom({ quiet: false, perDay: 2, state: { day: today, n: 7 }, today }), 0);
  assert.equal(draftsRoom({ quiet: false, perDay: 2, state: { day: "2026-11-25", n: 2 }, today }), 2);
  assert.equal(draftsRoom({ quiet: false, perDay: 0, state: {}, today }), 0);
  const next = nextDraftsState({ day: "2026-11-25", n: 2, themeAt: 3, total: 5 }, { today, made: [{ slug: "a-1", steer: { mode: "explore" } }], picked: 2, themeCount: 4, why: "3 new files", at: "2026-11-26T10:00:00Z" });
  assert.deepEqual(next, { day: today, n: 1, themeAt: 1, total: 6, last: "2026-11-26T10:00:00Z", lastWhy: "3 new files", lastMade: ["a-1"], lastSteer: [{ mode: "explore" }] });
});

test("the count is per project: each project's data folder has its own file, and the old shared file is never written", () => {
  const home = mkdtempSync(join(tmpdir(), "lazycow-drafts-"));
  try {
    const a = join(home, "projects", "a"), b = join(home, "projects", "b"), legacy = join(home, "auto-drafts.json");
    for (const d of [a, b]) mkdirSync(d, { recursive: true });
    assert.equal(draftsFile(a), join(a, "auto-drafts.json"));
    assert.ok(writeDraftsState(draftsFile(a), nextDraftsState({}, { today, made: [{ slug: "x-1" }, { slug: "x-2" }], picked: 2, themeCount: 3, why: "t" })));
    assert.equal(draftsRoom({ quiet: false, perDay: 2, state: readDraftsState(draftsFile(a), { legacy, today }), today }), 0, "project a used its day");
    assert.equal(draftsRoom({ quiet: false, perDay: 2, state: readDraftsState(draftsFile(b), { legacy, today }), today }), 2, "project b still has its own");
    assert.ok(!existsSync(legacy), "nothing is written to STUDIO_HOME");
    // The review server keeps the file in the project's data folder, not in STUDIO_HOME.
    assert.match(server, /const AUTO_DRAFTS_FILE = draftsFile\(DATA\);/);
    assert.doesNotMatch(server, /writeFileSync\([^)]*AUTO_DRAFTS_LEGACY/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the old shared file: only today's count carries over to a project with no file yet; junk is ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "lazycow-drafts-"));
  try {
    const legacy = join(home, "auto-drafts.json"), mine = join(home, "p", "auto-drafts.json");
    writeFileSync(legacy, JSON.stringify({ day: today, n: 1, themeAt: 2, total: 40, last: "2026-11-26T01:00:00Z", lastMade: ["other-1"] }));
    assert.deepEqual(readDraftsState(mine, { legacy, today }), { day: today, n: 1 }, "today's count only: total and last run were another project's");
    assert.deepEqual(readDraftsState(mine, { legacy, today: "2026-11-27" }), {}, "yesterday's count is no count");
    writeFileSync(legacy, "{not json");
    assert.deepEqual(readDraftsState(mine, { legacy, today }), {});
    writeFileSync(legacy, "[1,2]");
    assert.deepEqual(readDraftsState(mine, { legacy, today }), {});
    assert.deepEqual(readDraftsState(mine, { today }), {}, "no old file at all");
    const before = readFileSync(legacy, "utf8");
    readDraftsState(mine, { legacy, today });
    assert.equal(readFileSync(legacy, "utf8"), before, "reading never changes the old file");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

