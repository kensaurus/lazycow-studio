/**
 * FILE: test/inputs-review.test.mjs
 * PURPOSE: The review queue's Send back reasons and the other "inputs" labels (Track D, 24 Nov 2026; editor.html td_*):
 *          one list of reasons in the page, the server and Python; every td_ label in English and Japanese; every td_
 *          label the page asks for is defined. (test/i18n.test.mjs reads only the main I18N block, not these packs.)
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REJECT_REASONS } from "../server/trust.mjs";
import { assemblePage } from "../server/ui.mjs";
import { fileURLToPath } from "node:url";

const html = assemblePage(fileURLToPath(new URL("..", import.meta.url)));
const py = readFileSync(new URL("../py/studio/review_actions.py", import.meta.url), "utf8");

/** The td_ keys of the Object.assign(I18N.<lang>, {...}) pack that holds them. */
function pack(langName) {
  const keys = new Set();
  for (const m of html.matchAll(new RegExp(`Object\\.assign\\(I18N\\.${langName}, \\{([\\s\\S]*?)\\n\\}\\);`, "g"))) {
    for (const k of m[1].matchAll(/"(td_[a-z]+\.[a-zA-Z.-]+)":/g)) keys.add(k[1]);
  }
  return keys;
}

test("the Send back reasons are one list in the page, the server and Python", () => {
  const page = /const TD_REASONS = (\[[^\]]+\])/.exec(html)?.[1];
  assert.ok(page, "TD_REASONS in editor.html");
  assert.deepEqual(JSON.parse(page), REJECT_REASONS);
  const pyList = /^REASONS = \(([^)]+)\)/m.exec(py)?.[1];
  assert.deepEqual(pyList.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean), REJECT_REASONS);
});

test("every td_ label exists in English and Japanese", () => {
  const en = pack("en"), ja = pack("ja");
  assert.ok(en.size >= 25, `only ${en.size} td_ labels`);
  assert.deepEqual([...en].filter((k) => !ja.has(k)), [], "missing in Japanese");
  assert.deepEqual([...ja].filter((k) => !en.has(k)), [], "missing in English");
  for (const r of REJECT_REASONS) assert.ok(en.has(`td_rv.r.${r}`), `a label for the reason ${r}`);
});

test("every td_ label the page asks for is defined", () => {
  const en = pack("en");
  const used = new Set([...html.matchAll(/\btr\("(td_[a-z]+\.[a-zA-Z.-]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\["[a-z0-9]+", "(td_[a-z]+\.[a-zA-Z.-]+)"\]/g)) used.add(m[1]);  // segment labels
  assert.ok(used.size > 10);
  // tr("td_rv.r." + reason) is built from REJECT_REASONS: the reason labels are checked in the test above
  assert.deepEqual([...used].filter((k) => !k.endsWith(".") && !en.has(k)), []);
});
