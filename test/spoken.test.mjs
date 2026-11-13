// Word-by-word captions: which word of a spoken line is being said (shared/spoken.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { spokenStates, spokenWords } from "../shared/spoken.mjs";

test("a line not spoken has no states", () => {
  assert.equal(spokenStates("標高1444m", undefined, 1), null);
  assert.equal(spokenStates("標高1444m", { from: 2, to: 2 }, 1), null);
});

test("words light up in order across the voice's span", () => {
  const text = "朝は、霧の中";
  const span = { from: 1, to: 3 };
  const before = spokenStates(text, span, 0.5), mid = spokenStates(text, span, 2), after = spokenStates(text, span, 3.2);
  assert.ok(before.every((s) => s === "next"));
  assert.ok(after.every((s) => s === "done"));
  assert.equal(mid[0], "done", "the first word is said by the middle");
  assert.equal(mid.at(-1), "next", "the last word is still to come");
  assert.ok(mid.includes("now"), "one word is being said");
  // never goes backwards
  let last = -1;
  for (let t = 0.9; t <= 3.1; t += 0.05) {
    const n = spokenStates(text, span, t).filter((s) => s === "done").length;
    assert.ok(n >= last); last = n;
  }
});

test("line breaks and punctuation are kept and cost little time", () => {
  const words = spokenWords("星空\nの下で、");
  assert.equal(words.map((w) => w.text).join(""), "星空\nの下で、");
  assert.equal(words.find((w) => w.text.includes("\n")).weight, 0);
  assert.ok(words.find((w) => w.text === "、").weight < 1);
  assert.equal(spokenStates("星空\nの下で、", { from: 0, to: 1 }, 0.5).length, [..."星空\nの下で、"].length);
});
