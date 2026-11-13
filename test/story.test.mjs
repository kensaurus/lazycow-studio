/**
 * FILE: test/story.test.mjs
 * PURPOSE: Story words stay in the Instagram-safe box on every canvas, and the
 *          reel copy passes the fact guard.
 * DEPENDENCIES: shared/story-layout.mjs, shared/guard.mjs, py/studio/reels.json
 * USAGE: npm test
 * NOTES: reels.json is written by `python -m studio reels --plan`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { STYLES, lineBox, storyLayout, inside } from "../shared/story-layout.mjs";
import { copyProblems } from "../shared/guard.mjs";

// A neutral sample always; the ranch's real reels too where the ranch overlay is (the owner's checkout).
const read = (u) => JSON.parse(readFileSync(u, "utf8"));
const OWN = new URL("../shared/reels.json", import.meta.url);
const reels = [...read(new URL("./fixtures/reels.sample.json", import.meta.url)), ...(existsSync(OWN) ? read(OWN) : [])];
const canvases = [[1080, 1920], [1080, 1350], [1920, 1080]];

test("hook, line and end card sit in the safe zone for every reel, canvas, style and side", () => {
  for (const reel of reels) {
    const hook = reel.beats.find((b) => b.kind === "hook");
    for (const [w, h] of canvases) {
      for (const style of STYLES) {
        const L = storyLayout(w, h, hook.ja.split("\n"), style);
        for (const name of ["hook", "hookEn", "line", "end"]) {
          assert.ok(inside(L[name], L.safe), `${reel.slug} ${w}x${h} ${style} ${name} ${JSON.stringify(L[name])}`);
        }
        for (const side of [undefined, "left", "right"]) {
          assert.ok(inside(lineBox(L, side), L.safe), `${reel.slug} ${w}x${h} ${style} line ${side}`);
        }
      }
    }
  }
});

test("styles really move the words", () => {
  const spots = new Set(STYLES.map((s) => { const L = storyLayout(1080, 1920, ["不便だからこそ、", "景色がいい。"], s); return `${L.hook.x},${L.hook.y},${L.line.y}`; }));
  assert.equal(spots.size, STYLES.length);
  const L = storyLayout(1080, 1920, undefined, "column");
  assert.ok(lineBox(L, "right").x > lineBox(L, "left").x);
});

test("every on-screen and post line passes the fact guard", () => {
  for (const reel of reels) {
    for (const beat of reel.beats) {
      assert.deepEqual(copyProblems(beat.ja), [], `${reel.slug} ${beat.ja}`);
      assert.deepEqual(copyProblems(beat.en), [], `${reel.slug} ${beat.en}`);
    }
  }
});
