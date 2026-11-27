/**
 * FILE: test/words-first-frame.test.mjs
 * PURPOSE: The headline stands whole on the first frame and comes back over the loop ending (shared/looks.mjs, used by
 *          src/Story.tsx and src/looks.tsx), and the Site walk cut is offered everywhere a cut is chosen.
 *          27 Nov 2026: 83 % of Shorts viewers swipe away; reels whose headline typed in from 0.1 s opened on a frame
 *          with no words, and reels of 1-3 s cuts kept 5-8 % of feed viewers against 24-35 % for one continuous shot.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LOOP_FRAMES, headlineAlpha, opensShown } from "../shared/looks.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const FPS = 30;
const hook = (startSec) => ({ kind: "hook", ja: "雲の上で、\nランチを。", en: "Lunch above the clouds.", startSec, endSec: 6.8 });

test("a headline that starts at 0 is whole on frame 0; an older one that starts at 0.1 s still arrives", () => {
  assert.equal(opensShown(hook(0)), true);
  assert.equal(opensShown(hook(0.1)), false);
  assert.equal(opensShown({ ...hook(0), kind: "line" }), false, "only the headline");
  assert.deepEqual(headlineAlpha(hook(0), 0, FPS), { alpha: 1, live: true, shown: true });
  const old = headlineAlpha(hook(0.1), 0, FPS);
  assert.equal(old.alpha, 0);
  assert.equal(old.live, false);
  assert.ok(headlineAlpha(hook(0.1), 9, FPS).alpha < 1, "the older headline still fades in");
});

test("it fades out at its end, and with a loop comes back so the last frame matches the first", () => {
  const total = 33 * FPS, tail = { from: total - LOOP_FRAMES, to: total };
  assert.equal(headlineAlpha(hook(0), 6.8 * FPS, FPS).live, false, "gone after its end");
  assert.equal(headlineAlpha(hook(0), total - 1, FPS).alpha, 0, "no loop: not back at the end");
  assert.equal(headlineAlpha(hook(0), total - 1, FPS, { tail }).alpha, 1, "loop: whole on the last frame, as on the first");
  assert.equal(headlineAlpha(hook(0), tail.from - 1, FPS, { tail }).alpha, 0, "only over the loop ending");
  const mid = headlineAlpha(hook(0), tail.from + LOOP_FRAMES / 2, FPS, { tail });
  assert.ok(mid.alpha > 0 && mid.alpha < 1 && mid.live, "it dissolves in with the opening shot");
  assert.equal(headlineAlpha(hook(0.1), total - 1, FPS, { tail }).alpha, 0, "an older typed-in headline does not come back");
});

test("every headline the reel can open on reads the same rule", () => {
  const story = read("src/Story.tsx"), looks = read("src/looks.tsx");
  assert.match(story, /const Hook[\s\S]{0,400}headlineAlpha\(beat, frame, fps, \{ tail: React\.useContext\(LoopTailCtx\) \}\)/);
  assert.match(story, /<LoopTailCtx\.Provider value=\{tail\}>/);
  for (const name of ["KickerLine", "TypedHook", "Meter"]) {
    const at = looks.indexOf(`export const ${name}:`);
    assert.ok(at > 0, name);
    assert.match(looks.slice(at, at + 400), /useHeadline\(beat\)/, `${name} shows the headline whole from frame 0`);
  }
  assert.match(looks, /const n = LOOP_FRAMES;/, "the loop ending and the headline's return share one length");
});

test("Site walk is a cut on Make reels, in the API, the MCP tool and the Review card", () => {
  assert.match(read("server/ui/js/03-loop-reels.js"), /name="autoCut" value="walk"/);
  assert.match(read("server/review.mjs"), /cut: \["long", "walk"\]\.includes\(b\.cut\) \? b\.cut : "short"/);
  assert.match(read("server/mcp.mjs"), /cut: \{ type: "string", enum: \["short", "long", "walk"\]/);
  assert.match(read("docs/openapi.yaml"), /cut: \{ type: string, enum: \[short, long, walk\]/);
  assert.match(read("server/ui/js/09-ideas-words.js"), /tr\(cutKey\(r\.variant\)\)/, "the Review card names the reel's cut");
  const i18n = read("server/ui/js/01-i18n.js");
  for (const key of ["make.cutwalk", "make.cutwalkhint"]) assert.equal(i18n.split(`"${key}":`).length - 1, 2, `${key} in English and Japanese`);
  assert.match(i18n, /"make\.cutwalk": "Site walk \(25-40 s\)"/);
  assert.match(i18n, /"make\.cutwalk": "敷地を歩く（25〜40秒）"/);
  const spec = JSON.parse(read("shared/spec.json"));
  assert.deepEqual(spec.variants["site-walk"].targetSec, [25, 40]);
  assert.deepEqual(spec.variants["site-walk"].shotSec, [5, 9]);
});
