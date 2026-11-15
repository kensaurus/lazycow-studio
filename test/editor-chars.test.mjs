/**
 * FILE: test/editor-chars.test.mjs
 * PURPOSE: No invisible control character in the page: a scripted edit once put two backspaces (\x08) into a regex
 *          where \b was meant, and the page still parsed (15 Nov).
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("editor.html has no control characters but tab and line ends", () => {
  const html = readFileSync(new URL("../server/editor.html", import.meta.url), "utf8");
  const bad = [...html.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g)].map((m) => `${html.slice(0, m.index).split("\n").length}:${m[0].charCodeAt(0)}`);
  assert.deepEqual(bad, []);
});
