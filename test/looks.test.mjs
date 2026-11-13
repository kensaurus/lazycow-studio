/**
 * FILE: test/looks.test.mjs
 * PURPOSE: The looks and recipes (src/looks.tsx) keep their words in the safe zone and off each other,
 *          and their pure helpers do what the composition relies on.
 * DEPENDENCIES: shared/story-layout.mjs, shared/looks.mjs, shared/reels.json
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { STYLES, chipBoxes, inside, kickerBox, lineBox, meterBox, numeralBox, overlaps, railBox, storyLayout } from "../shared/story-layout.mjs";
import { LOOKS, RECIPES, parseMeter, splitGroups } from "../shared/looks.mjs";

// A neutral sample always; the ranch's real reels too where the ranch overlay is (the owner's checkout).
const read = (u) => JSON.parse(readFileSync(u, "utf8"));
const OWN = new URL("../shared/reels.json", import.meta.url);
const reels = [...read(new URL("./fixtures/reels.sample.json", import.meta.url)), ...(existsSync(OWN) ? read(OWN) : [])];
const canvases = [[1080, 1920], [1080, 1350], [1920, 1080]];
const hooks = [...new Set(reels.map((r) => r.beats.find((b) => b.kind === "hook").ja)), "山で働く。\n冬でも、夜通しでも。", "標高1,444m。"];

test("looks and recipes are the ones the composition draws", () => {
  assert.deepEqual(LOOKS, ["film", "punch", "split", "ember", "whip", "zoom", "ridge", "slats", "iris", "jump", "mono", "pulse", "mix", "spin", "cube", "glitch", "burn", "bars", "window", "print", "steps", "hold", "mirror", "impact", "letters"]);
  assert.deepEqual(RECIPES, ["countdown", "timeline", "pov", "altitude"]);
});

test("kicker, countdown number, rail, meter and chips stay in the safe zone on every canvas and style", () => {
  for (const ja of hooks) {
    for (const [w, h] of canvases) {
      for (const style of STYLES) {
        const L = storyLayout(w, h, ja.split("\n"), style);
        const boxes = { kicker: kickerBox(L), rail: railBox(L), meter: meterBox(L) };
        for (const side of [undefined, "left", "right"]) boxes[`numeral-${side}`] = numeralBox(L, side);
        chipBoxes(L, w, h).forEach((b, i) => { boxes[`chip${i}`] = b; });
        for (const [name, b] of Object.entries(boxes)) assert.ok(inside(b, L.safe), `${w}x${h} ${style} ${name} ${JSON.stringify(b)} (${ja})`);
      }
    }
  }
});

test("the kicker never covers the headline, and the number and rail never cover a line", () => {
  for (const ja of hooks) {
    for (const [w, h] of canvases) {
      for (const style of STYLES) {
        const L = storyLayout(w, h, ja.split("\n"), style);
        const K = kickerBox(L);
        assert.ok(!overlaps(K, L.hook) && !overlaps(K, L.hookEn), `${w}x${h} ${style} kicker on the hook (${ja})`);
        for (const side of [undefined, "left", "right"]) {
          assert.ok(!overlaps(numeralBox(L, side), lineBox(L, side)), `${w}x${h} ${style} ${side} number on its line`);
          assert.ok(!overlaps(railBox(L), lineBox(L, side)), `${w}x${h} ${style} ${side} rail on a line`);
        }
      }
    }
  }
});

test("the altitude counter reads its number from the approved line", () => {
  assert.deepEqual(parseMeter("標高1,444m。"), { label: "標高", value: 1444, unit: "m" });
  assert.deepEqual(parseMeter("標高1,444m、\n100Mbpsの光回線。"), { label: "標高", value: 1444, unit: "m" });
  assert.equal(parseMeter("不便だからこそ、\n景色がいい。"), null);
});

test("split pairs every shot once and leaves the last alone under the end card", () => {
  assert.deepEqual(splitGroups(9), [[0, 1], [2, 3], [4, 5], [6, 7], [8]]);
  assert.deepEqual(splitGroups(6), [[0, 1], [2, 3], [4], [5]]);
  assert.deepEqual(splitGroups(1), [[0]]);
  for (const n of [4, 5, 7, 8, 9, 14]) assert.deepEqual(splitGroups(n).flat(), [...Array(n).keys()]);
});
