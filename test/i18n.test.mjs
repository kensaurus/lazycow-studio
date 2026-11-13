/**
 * FILE: test/i18n.test.mjs
 * PURPOSE: The studio's two languages stay in step: every English label has a Japanese one, and back.
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../server/editor.html", import.meta.url), "utf8");
const block = (name) => {
  const start = html.indexOf(`  ${name}: {`, html.indexOf("const I18N = {"));
  const end = html.indexOf("\n  },", start);
  assert.ok(start > 0 && end > start, `no ${name} block`);
  return new Set([...html.slice(start, end).matchAll(/"([a-z]+\.[a-zA-Z.]+)":/g)].map((m) => m[1]));
};

test("every label exists in English and Japanese", () => {
  const en = block("en"), ja = block("ja");
  assert.ok(en.size > 60, `only ${en.size} English labels`);
  assert.deepEqual([...en].filter((k) => !ja.has(k)), [], "missing in Japanese");
  assert.deepEqual([...ja].filter((k) => !en.has(k)), [], "missing in English");
});

test("every label the page asks for is defined", () => {
  const en = block("en");
  const used = new Set([...html.matchAll(/\btr\("([a-z]+\.[a-zA-Z.]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/data-t="([a-z]+\.[a-zA-Z.]+)"/g)) used.add(m[1]);
  // Both labels of a choice, tr(on ? "a.b" : "c.d"): four swap labels had gone missing inside one (one even showed the
  // status bar's sentence instead).
  for (const m of html.matchAll(/\btr\([^()"]{1,60}\?\s*"([a-z]+\.[a-zA-Z.]+)"\s*:\s*"([a-z]+\.[a-zA-Z.]+)"/g)) { used.add(m[1]); used.add(m[2]); }
  assert.deepEqual([...used].filter((k) => !en.has(k)), []);
});

test("no label is defined twice (a later copy would silently replace the first wording)", () => {
  for (const name of ["en", "ja"]) {
    const start = html.indexOf(`  ${name}: {`, html.indexOf("const I18N = {"));
    const end = html.indexOf("\n  },", start);
    const seen = new Map();
    for (const m of html.slice(start, end).matchAll(/"([a-z]+\.[a-zA-Z.]+)":/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([k]) => k), [], `${name}: defined twice`);
  }
});
