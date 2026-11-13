/**
 * FILE: test/autostart.test.mjs
 * PURPOSE: "Start the studio when I sign in" only ever changes the Startup file of the studio folder it is pressed in:
 *          a second checkout or a test copy never removes or re-points the one that starts the real studio.
 * USAGE: npm test (uses a temporary folder, never the real Startup folder)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_NAME, setStartup, startupScript, startupState } from "../scripts/autostart.mjs";

const mine = join(tmpdir(), "studio-a"), theirs = join(tmpdir(), "studio-b");

test("on and off for this folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-"));
  assert.equal(startupState(dir, mine).on, false);
  assert.equal(setStartup(true, dir, mine, "node").on, true);
  assert.match(readFileSync(join(dir, FILE_NAME), "utf8"), /studio-a/);
  assert.equal(setStartup(false, dir, mine, "node").on, false);
  assert.equal(existsSync(join(dir, FILE_NAME)), false);
});

test("a file that starts another studio folder is shown as another's and is never removed or re-pointed", () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-"));
  writeFileSync(join(dir, FILE_NAME), startupScript(theirs, "node"));
  const st = startupState(dir, mine);
  assert.equal(st.on, false);
  assert.equal(st.other, true);
  assert.throws(() => setStartup(false, dir, mine, "node"), /Another studio folder/);
  assert.throws(() => setStartup(true, dir, mine, "node"), /Another studio folder/);
  assert.match(readFileSync(join(dir, FILE_NAME), "utf8"), /studio-b/);
  assert.equal(startupState(dir, theirs).on, true);
});
