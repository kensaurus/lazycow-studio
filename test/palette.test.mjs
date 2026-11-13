/**
 * FILE: test/palette.test.mjs
 * PURPOSE: The find-anything palette, help and tooltips keep their accessible structure, and every help
 *          article and plain-language rule stays bilingual.
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../server/editor.html", import.meta.url), "utf8");

test("the palette follows the WAI-ARIA combobox pattern", () => {
  for (const s of ['role="combobox"', 'aria-controls="palList"', 'aria-autocomplete="list"', 'role="listbox"', 'role="option"', "aria-activedescendant", 'aria-modal="true"']) {
    assert.ok(html.includes(s), `palette is missing ${s}`);
  }
  assert.match(html, /e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === "k"/, "Ctrl/Cmd+K opens it");
});

test("tooltips are real tooltips that Esc can hide (WCAG 1.4.13)", () => {
  assert.ok(html.includes('tipEl.setAttribute("role", "tooltip")'));
  assert.ok(html.includes('setAttribute("aria-describedby", "tip")'));
  assert.match(html, /e\.key === "Escape" && !tipEl\.hidden/);
});

test("every help article has English and Japanese", () => {
  const block = html.slice(html.indexOf("const HELP = ["), html.indexOf("const KEYS = ["));
  const ids = [...block.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `only ${ids.length} help articles`);
  assert.equal([...block.matchAll(/\n    en: \["/g)].length, ids.length, "an article lacks English");
  assert.equal([...block.matchAll(/\n    ja: \["/g)].length, ids.length, "an article lacks Japanese");
});
