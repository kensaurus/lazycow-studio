/**
 * FILE: test/first-run.test.mjs
 * PURPOSE: Guards for what tripped a first-time user (a cafe owner, simple mode, no keys) on the walk of 26 Nov:
 *   the folder picker's invisible title, sign-in before the first reel, "theme-2" instead of the headline, a double
 *   click making two batches, "only 1 usable assets", a schedule nag before anything was approved, the phone setup
 *   header squeezed to one word a line, a stale "not answering" page after the studio came back, and "npm run review"
 *   as the only way back for someone with no terminal.
 * USAGE: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePage } from "../server/ui.mjs";
import { fileURLToPath } from "node:url";

const html = assemblePage(fileURLToPath(new URL("..", import.meta.url))).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const css = html.slice(0, html.indexOf("<script>"));
const body = (name) => { const at = script.indexOf(`function ${name}(`); assert.ok(at > 0, name); return script.slice(at, script.indexOf("\n}", at) + 2); };
const strings = (lang) => {
  // The two dictionaries, in order: English first, then Japanese (01-i18n.js: `en: {` … `ja: {`).
  const at = script.indexOf("\n  ja: {\n");
  assert.ok(at > 0, "the Japanese dictionary");
  return lang === "en" ? script.slice(0, at) : script.slice(at);
};
const str = (lang, key) => { const m = new RegExp(`"${key.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`).exec(strings(lang)); assert.ok(m, `${lang} ${key}`); return m[1]; };

test("the folder picker's title is readable: paper-coloured words only on the planner's ink bar", () => {
  const rules = [...css.matchAll(/([^{}]*\.pk-head h3[^{}]*)\{([^}]*)\}/g)].map(([, sel, decl]) => ({ sel: sel.trim(), decl }));
  for (const r of rules.filter((x) => /color:\s*var\(--bg\)/.test(x.decl))) {
    for (const sel of r.sel.split(",").map((s) => s.trim()).filter((s) => s.includes(".pk-head h3"))) {
      assert.match(sel, /\.planner/, `"${sel}" paints the title in the background colour outside the planner's ink bar`);
    }
  }
});

test("a first reel comes before signing in to a network (setup cards, header chip and wizard)", () => {
  const steps = body("startSteps").split("return [").pop();
  const at = (id) => steps.indexOf(`id: "${id}"`);
  assert.ok(at("footage") < at("reel") && at("reel") < at("network") && at("network") < at("book"), "footage → reel → network → book");
  assert.ok(steps.indexOf('key: "setup.review"') < at("network"), "reviewing the first reel comes before the sign-in too");
});

test("a theme is named from its headline in either box, and the page says its headline, not its key", () => {
  const save = body("saveThemeForm");
  assert.match(save, /themeSlug\(theme\.hook\.en \|\| theme\.hook\.ja/, "an English headline typed in the first box names the theme");
  assert.match(save, /th\.saved", \{ k: themeTitle\(key\)/);
  assert.match(body("openThemeEditor"), /th\.edittitle", \{ k: themeTitle\(key\)/);
  assert.match(body("openThemeEditor"), /hookJa\.placeholder = tr\("th\.hookph"\)/, "an example in the empty headline box");
  for (const l of ["en", "ja"]) for (const k of ["th.hookph", "th.shotsph", "mk.fewclips", "src.nofiles"]) assert.ok(str(l, k).length > 10, `${l} ${k}`);
});

test("'only N usable assets' reads as what to do, with the theme's headline", () => {
  const themes = { "theme-2": { title: "Lunch above the clouds." } };
  const tr = (k, v) => `${k}|${v.t}|${v.n}`;
  // eslint-disable-next-line no-new-func
  const make = new Function("tr", "themes", `const themeTitle = (k) => String(themes?.[k]?.title || "").split("\\n")[0].trim() || k;\n${body("makeWhy")}\nreturn makeWhy;`)(tr, themes);
  assert.equal(make("theme-2: only 1 usable assets for this theme"), "mk.fewclips|Lunch above the clouds.|1");
  assert.equal(make("theme-2: no footage folder"), "Lunch above the clouds.: no footage folder");
  assert.equal(make("something else"), "something else");
  assert.match(body("runAutopilot"), /\.map\(makeWhy\)/);
  assert.match(body("runAutopilot"), /themeTitle\(m\.theme\)/, "the queued toast names reels by their theme's headline");
});

test("a double click on Make reels queues one batch", () => {
  const at = script.indexOf('e.target.closest("#autoGo")');
  assert.ok(at > 0);
  assert.match(script.slice(at, at + 400), /Date\.now\(\) - \(autopilot\.lastGo \|\| 0\) < 1500\) return;/);
});

test("'ready to review' names the reel by its headline", () => {
  assert.match(script, /tr\("job\.readyreview", \{ s: reelName\(j\.slug\) \}\)/);
});

test("'schedule a post' waits until a reel is approved (Plan posts books approved reels only)", () => {
  const gap = script.split("\n").filter((l) => l.includes('tr("next.gap")'));
  assert.ok(gap.length >= 1);
  for (const l of gap) assert.match(l, /r\.status === "approved"/, l.trim().slice(0, 120));
});

test("on a phone the setup header keeps its words on one row and the bar under them", () => {
  const phone = css.slice(css.indexOf("@media (max-width: 700px) {\n    .hm-grid"));
  assert.match(phone.slice(0, 600), /\.hm-setup \.fw-head \{ grid-template-columns: auto minmax\(0, 1fr\); \} \.hm-setup \.fw-bar \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
});

test("back from 'not answering': the page loads again by itself, and the way back is not only a terminal command", () => {
  const off = script.slice(script.indexOf("  offline(on) {"), script.indexOf("  paintDot() {"));
  assert.match(off, /includes\(tr\("sys\.noserver"\)\)/);
  assert.match(off, /location\.reload\(\)/);
  for (const k of ["sys.noserver", "sys.offline", "sys.restartfail"]) {
    assert.match(str("en", k), /Start Lazycow/, `en ${k}`);
    assert.match(str("ja", k), /Start Lazycow/, `ja ${k}`);
  }
});

test("an empty folder says why it cannot be added", () => {
  assert.match(body("reportHtml"), /disabled aria-describedby="fsNone"/);
  assert.match(body("reportHtml"), /tr\("src\.nofiles"\)/);
});
