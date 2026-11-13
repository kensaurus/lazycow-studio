/**
 * FILE: test/typekits.test.mjs
 * PURPOSE: The reel styles (shared/type-kits.json) render: every font is shipped with its licence, the composition
 *          reads the style props, and the lists match what src/typekit.ts and the Python draw expect.
 * USAGE: npm test
 */
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const t = JSON.parse(readFileSync(new URL("shared/type-kits.json", root), "utf8"));

test("every font a kit uses is in public/fonts with its licence", () => {
  for (const k of t.kits) {
    for (const [file] of [...k.jaFaces, ...k.enFaces]) {
      assert.ok(existsSync(new URL(`public/fonts/${file}`, root)), `${k.id}: ${file} missing`);
      const base = file.replace(/\.ttf$/, "").split("-")[0].toLowerCase();
      const lic = ["OFL", "LICENSE"].some((p) => existsSync(new URL(`public/fonts/${p}-${base}.txt`, root)));
      assert.ok(lic, `${k.id}: no licence file for ${file} (public/fonts/OFL-${base}.txt)`);
    }
    assert.ok(k.enScale >= 0.6 && k.enScale <= 1.1, `${k.id}: enScale ${k.enScale} would crowd or shrink the English line`);
  }
});

test("the composition reads the style props instead of fixed fonts and colours", () => {
  const story = readFileSync(new URL("src/Story.tsx", root), "utf8");
  for (const prop of ["typeKit", "palette", "motion"]) assert.match(story, new RegExp(`${prop}\\??:`), `StoryProps.${prop}`);
  const drawn = story.slice(story.indexOf("const Hook"));
  assert.doesNotMatch(drawn, /fontFamily: "(Shippori Mincho|Cormorant)"/, "a hard-coded font is left in the words");
  const kit = readFileSync(new URL("src/typekit.ts", root), "utf8");
  const union = /export type Motion = ([^;]+);/.exec(kit)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(union.sort(), t.motions.map((m) => m.id).sort());
});

test("every palette has its colours and every grade only grades", () => {
  for (const p of t.palettes) for (const c of ["text", "accent", "rule", "bar", "enColor"]) assert.match(p[c] || "", /^#[0-9a-f]{6}$/, `${p.id}.${c}`);
  for (const g of t.grades) {
    const names = (g.filter || "").split(",").filter(Boolean).map((f) => f.split("=")[0]);
    assert.ok(names.every((n) => ["colorbalance", "curves", "eq"].includes(n)), `${g.id}: ${names}`);
  }
});

test("each kit, palette, motion and grade has an English and a Japanese name", () => {
  for (const list of ["kits", "palettes", "motions", "grades"]) for (const x of t[list]) assert.ok(x.en && x.ja, `${list}.${x.id}`);
});
