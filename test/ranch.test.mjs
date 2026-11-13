// Which checkout is the owner's ranch workspace (shared/ranch.mjs), and that the server and Python agree on the marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProjectsDir, isRanch, RANCH_MARKER, ranchOverlay } from "../shared/ranch.mjs";

const ROOT = join("C:", "studio");
const DATA = join(ROOT, "data");

test("a clone without the ranch overlay is neutral and keeps its reels in its data folder", () => {
  const none = () => false;
  assert.equal(ranchOverlay(ROOT, "", none), false);
  assert.equal(defaultProjectsDir(ROOT, DATA, false), join(DATA, "projects"));
  assert.equal(isRanch(ROOT, defaultProjectsDir(ROOT, DATA, false), false), false);
});

test("the owner's checkout (overlay present) is the ranch only for its main project", () => {
  const seen = [];
  const has = (p) => (seen.push(p), true);
  assert.equal(ranchOverlay(ROOT, "", has), true);
  assert.equal(seen[0], join(ROOT, "shared", "reels.json"));
  assert.equal(isRanch(ROOT, defaultProjectsDir(ROOT, DATA, true), true), true);
  assert.equal(isRanch(ROOT, join(DATA, "projects"), true), false);
});

test("STUDIO_RANCH decides when set", () => {
  assert.equal(ranchOverlay(ROOT, "1", () => false), true);
  assert.equal(ranchOverlay(ROOT, "off", () => true), false);
  assert.equal(ranchOverlay(ROOT, " ", () => true), true);
});

test("Python reads the same marker", () => {
  const py = readFileSync(new URL("../py/studio/config.py", import.meta.url), "utf8");
  assert.equal(RANCH_MARKER, join("shared", "reels.json"));
  assert.match(py, /RANCH_MARKER = ROOT \/ "shared" \/ "reels\.json"/);
  assert.match(py, /\(root \/ "shared" \/ "reels\.json"\)\.is_file\(\)/);
});
