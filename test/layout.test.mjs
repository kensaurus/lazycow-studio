/**
 * FILE: test/layout.test.mjs
 * PURPOSE: Caption boxes stay inside the safe zone, and the fact guard holds.
 * OVERVIEW: node --test
 * DEPENDENCIES: shared/layout.mjs, shared/guard.mjs, budoux
 * USAGE: npm test
 * NOTES: Japanese lines are broken with BudouX before the box is measured.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadDefaultJapaneseParser } from "budoux";
import { captionBox, insideSafe } from "../shared/layout.mjs";
import { copyProblems } from "../shared/guard.mjs";

const parser = loadDefaultJapaneseParser();

function wrap(text) {
  const parts = parser.parse(text);
  if (parts.join("").length <= 12) return text;
  const mid = Math.ceil(parts.length / 2);
  return `${parts.slice(0, mid).join("")}\n${parts.slice(mid).join("")}`;
}

test("every format keeps a two-line caption inside the safe box", () => {
  const canvases = [[1080, 1920], [1080, 1350], [1920, 1080]];
  const line = wrap("デッキに、夕方。窯の前。");
  for (const [w, h] of canvases) {
    const box = captionBox(line, w, h);
    assert.equal(insideSafe(box, w, h), true, `${w}x${h} ${JSON.stringify(box)}`);
  }
});

test("fact guard rejects a price and a bare ranch word", () => {
  assert.deepEqual(copyProblems("デッキに、夕方。"), []);
  assert.ok(copyProblems("大人 ¥2600").includes("price"));
  assert.ok(copyProblems("牧場の夕方").includes("bare-bokujo"));
  assert.deepEqual(copyProblems("嬬恋牧場Work&Camp"), []);
});
