/**
 * FILE: test/make-first-run.test.mjs
 * PURPOSE: Make reels on a project's first run (the 26 Nov first-run walk). BL-130: the starter stories
 *          (shared/starter-stories.json) are complete in English and Japanese, fit the theme editor's limits, name no
 *          one's business and go out with the public repository. BL-136: the ticked themes are saved per project and
 *          read back. BL-141: simple mode never links to Research, a tool it hides. BL-137: What to film shows the
 *          Japanese words on the Japanese page. Every story also passes the real theme check: py/tests/test_make_first_run.py.
 * USAGE: npm test
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assemblePage } from "../server/ui.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { stories } = JSON.parse(read("shared/starter-stories.json"));
const html = assemblePage(ROOT).replace(/\r\n/g, "\n");
const server = read("server/review.mjs");
const JA = /[\u3040-\u30ff\u3400-\u9fff]/;
const KEY = /^[a-z][a-z0-9-]{0,23}$/;  // py/studio/assemble.py THEME_KEY

test("starter stories: 6 to 8, one per kind of business plus general ones, each with a unique theme key", () => {
  assert.ok(stories.length >= 6 && stories.length <= 8, `${stories.length} stories`);
  const ids = stories.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.match(id, KEY, `${id}: a theme key, so it can be saved as one`);
  for (const kind of ["cafe", "guesthouse", "campsite", "shop", "restaurant"]) assert.ok(ids.includes(kind), `a ${kind} story`);
  assert.ok(ids.length - 5 >= 1, "and at least one for any kind of place");
});

test("every story is a theme the editor would save, in English and Japanese (headline at most 80, lines, 4+ shots)", () => {
  const icons = new Set([...html.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const s of stories) {
    const t = s.theme, where = s.id;
    for (const f of ["kind", "about"]) assert.ok(s[f]?.en && JA.test(s[f]?.ja || ""), `${where}: ${f} in both languages`);
    assert.ok(icons.has(s.icon), `${where}: icon ${s.icon} is in the page's sprite`);
    for (const lang of ["en", "ja"]) {
      assert.ok(t.title?.[lang] && t.title[lang].length <= 60, `${where}: title.${lang}`);
      assert.ok(t.hook?.[lang] && t.hook[lang].length <= 80, `${where}: hook.${lang} at most 80 characters`);
    }
    assert.ok(JA.test(t.hook.ja) && !JA.test(t.hook.en), `${where}: hook.ja is Japanese, hook.en English`);
    assert.ok(t.lines.length >= 1 && t.lines.length <= 6, `${where}: 1 to 6 lines`);
    for (const l of t.lines) for (const lang of ["en", "ja"]) assert.ok(l[lang] && l[lang].length <= 80, `${where}: line.${lang} "${l[lang]}"`);
    assert.ok(t.shots.length >= 4 && t.shots.length <= 12, `${where}: 4 to 12 shots`);
    assert.equal(t.shotsJa.length, t.shots.length, `${where}: a Japanese word for every shot`);
    for (const x of t.shots) assert.ok(x.length <= 120 && !JA.test(x), `${where}: shot "${x}" is the English search form`);
    for (const x of t.shotsJa) assert.ok(JA.test(x), `${where}: shotsJa "${x}" is Japanese`);
    for (const x of t.tags) assert.match(x, /^#\S+$/, `${where}: tag ${x}`);
    assert.ok(["column", "centre", "lower", "split"].includes(t.style), `${where}: style`);
  }
});

test("the stories name no one's business and no price, and go out with the public repository", async () => {
  const text = read("shared/starter-stories.json");
  assert.doesNotMatch(text, /[¥$€£]\s?\d|\d\s?(円|yen)\b/i, "no prices");
  const manifest = new URL("../scripts/public-export.json", import.meta.url);
  if (!existsSync(manifest)) return;  // the public repository itself has no export manifest
  // The export's own forbidden-word rules (the owner's business by name, real ids, addresses), not a copy of them here:
  // spelling those words in this file would make the export refuse the test itself.
  const { loadManifest, scanText } = await import("../scripts/public-export.mjs");
  assert.deepEqual(scanText(text, loadManifest(), "shared/starter-stories.json"), [], "passes the export's word scan");
  const { exclude } = JSON.parse(readFileSync(manifest, "utf8"));
  const globRe = (g) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
  assert.deepEqual(exclude.filter((g) => globRe(g).test("shared/starter-stories.json")), [], "not excluded from the export");
});

test("Make reels offers the stories when a project has no themes, and saves one as the project's own theme", () => {
  assert.match(server, /url\.pathname === "\/api\/themes\/stories"\) \{\s*try \{ return send\(res, 200, \{ stories: JSON\.parse\(readFileSync\(join\(ROOT, "shared", "starter-stories\.json"\)/);
  assert.match(html, /themes && !keys\.length \? mkStoriesHtml\(true\)/, "no themes: the gallery stands where the theme pills go");
  assert.match(html, /await post\("\/api\/themes", \{ key, theme: mkStoryTheme\(s\) \}\)/, "one press saves it");
  assert.match(html, /autoThemes\.add\(key\);[\s\S]{0,400}autopilot\(\[key\]\)/, "ticked, and its first reel made when there is footage");
});

test("simple mode links to no hidden tool from Make reels (Ideas for new themes is Research, a full-mode tool: BL-141)", () => {
  assert.match(html, /const mkIdeasChip = \(\) => \(ftShown\("ideas"\) \?/);
  assert.doesNotMatch(html.slice(html.indexOf("function makerHtml()"), html.indexOf("function queueBoxHtml()")), /href="#\/ideas\/ideas"/, "the maker itself has no fixed link to Research");
  assert.match(html, /^\s{2}ideas: \{ level: "full"/m, "Research is still a full-mode tool");
});

test("simple mode: Use what worked › its default is a switch on the line, not a link to Workflow (a hidden full-mode tool)", () => {
  const src = /\nfunction lpaDefaultHtml\(\) \{[\s\S]*?\n\}\n/.exec(html)?.[0];
  assert.ok(src, "lpaDefaultHtml() is in the page");
  const make = (level, learn) => new Function("ftShown", "LPA", "tr", "esc", `${src}; return lpaDefaultHtml();`)(
    (id) => level === "full" || id !== "workflow", { loop: learn === undefined ? null : { learn }, saving: false }, (k, v) => (v ? `${k}|${v.v}` : k), (s) => String(s));
  assert.match(make("full", { steer: true }), /<a href="#\/workflow" data-lpafold="1">lpa_a\.use\.how<\/a>/, "full mode: the link to Workflow, as before");
  const on = make("simple", { steer: true }), off = make("simple", { steer: false });
  for (const h of [on, off]) assert.doesNotMatch(h, /#\/workflow/, "simple mode sends no one to a hidden tool");
  assert.match(on, /<button type="button" class="linkbtn" role="switch" aria-checked="true" data-lpaset="learn\.steer" >lpa_a\.use\.def\|lpa_a\.on<\/button>/);
  assert.match(off, /aria-checked="false" data-lpaset="learn\.steer" >lpa_a\.use\.def\|lpa_a\.off</);
  assert.equal(make("simple"), "", "the setting not read yet: nothing to switch");
  // The switch is Workflow's own: one click saves the opposite (POST /api/autopost through lpaSave).
  assert.match(html, /const b = e\.target\.closest\?\.\("button\[data-lpaset\]"\); if \(!b \|\| LPA\.saving\) return;\s*lpaSave\(b\.dataset\.lpaset, b\.getAttribute\("aria-checked"\) !== "true"\);/);
  assert.doesNotMatch(/\nfunction lpaUseHtml\(\) \{[\s\S]*?\n\}\n/.exec(html)[0], /#\/workflow/, "Make reels' box has no fixed link to Workflow");
  assert.match(html, /^\s{2}workflow: \{ level: "full"/m, "Workflow is still a full-mode tool");
  const said = [...html.matchAll(/"lpa_a\.use\.def": "([^"]*)"/g)].map((m) => m[1]);
  assert.equal(said.length, 2, "in English and Japanese");
  assert.ok(said.every((s) => s.includes("{v}")) && said.some((s) => JA.test(s)) && said.some((s) => !JA.test(s)));
});

test("Reels on a phone: each reel is a row (picture left, every action on one line), none hidden", () => {
  const css = html.slice(0, html.indexOf("<script>"));
  const at = css.indexOf("/* Reels on a phone with 3 reels"), phone = css.slice(at, css.indexOf("\n  }\n", at));
  assert.ok(at > 0, "the rule is there");
  assert.equal(css.slice(css.lastIndexOf("@media", at)).split("{")[0].trim(), "@media (max-width: 640px)", "for phones only");
  assert.match(phone, /\.reels \.rcard \{ display: grid; grid-template-columns: 96px minmax\(0, 1fr\);/);
  assert.match(phone, /\.reels \.rcard \.card-acts \{ position: static; opacity: 1; pointer-events: auto; flex-wrap: nowrap;/, "on one line, always shown (not a hover panel)");
  assert.doesNotMatch(phone, /display: none|visibility: hidden/, "no action hidden");
  // The small actions keep their words as their name and tip (font-size 0 hides only the letters).
  const card = /\nfunction reelCard\(r\) \{[\s\S]*?\n\}\n/.exec(html)[0];
  for (const a of ["data-remake", "data-alt", "data-skip"]) assert.match(card, new RegExp(`<button class="mini[^>]*${a}=[^>]*>\\$\\{ico\\([^)]*\\)\\}\\$\\{tr\\(`), a);
  assert.match(phone, /\.reels \.rcard \.card-acts \.mini \{[^}]*font-size: 0;/);
  // Reels' head: its buttons share one row on a phone (a long label wraps inside its button), none hidden.
  assert.match(html, /<div class="pagehead rhead">/);
  assert.match(phone, /\.rhead > button \{ flex: 1 1 0; min-width: 0;[^}]*white-space: normal;/);
});

test("the ticked themes are restored from the project's saved picks and saved again when they change (BL-136)", () => {
  assert.match(html, /mkPicksSync\(\); mkFootWatch\(\);/, "Reels keeps them in step on every draw");
  assert.match(html, /api\("\/api\/ui"\)\.then\(\(v\) => \{\s*const saved = Array\.isArray\(v\?\.picks\) \? v\.picks : \[\];/);
  assert.match(html, /post\("\/api\/ui", \{ picks: JSON\.parse\(now\) \}\)/);
});

test("What to film shows the Japanese words on the Japanese page wherever it is said (BL-137)", () => {
  assert.match(html, /const mkNeed = \(t\) => \(lang === "ja" && t\?\.needJa\) \|\| t\?\.need \|\| "";/);
  const raw = [...html.matchAll(/\b(?:thin\[0\]|t|f)\.need\b(?!Ja)/g)].length;
  assert.equal(raw, 0, "every place reads it through mkNeed");
});

test("Home's starters: mkStarterStories() is in the page, in the page's language, and its ids are the gallery's (BL-131)", () => {
  const src = /\nfunction mkStarterStories\(\) \{[\s\S]*?\n\}\n/.exec(html)?.[0];
  const line = /\nfunction mkLine\(text, L\) \{.*\}\n/.exec(html)?.[0];
  assert.ok(src && line, "mkStarterStories() is defined in the assembled page");
  for (const lang of ["en", "ja"]) {
    const MK = { stories };
    const list = new Function("MK", "lang", "mkLoadStories", `${src}${line}; return mkStarterStories();`)(MK, lang, () => {});
    assert.ok(list.every((x) => !x.headline.includes("\n")) && (lang === "en" || list.every((x) => !/、 /.test(x.headline))), "one line, no stray space in Japanese");
    assert.deepEqual(list.map((x) => x.id), stories.map((s) => s.id), "every story, in gallery order");
    for (const x of list) {
      const s = stories.find((y) => y.id === x.id);
      assert.equal(x.title, s.kind[lang], `${x.id}: titled by its kind of place in ${lang}`);
      assert.ok(x.headline && x.icon, x.id);
    }
  }
  // A [data-starter] press outside the gallery applies that story; the gallery's own card applies the same id.
  assert.match(html, /const a = e\.target\.closest\?\.\("\[data-starter\]"\);\s*if \(a && !a\.closest\("\.mk-stories"\)\) mkStarterGo\(a\.dataset\.starter\);/);
  assert.match(html, /async function mkStarterGo\(id\) \{[\s\S]*?return mkUseStory\(id\);/);
  assert.match(html, /data-mkstory="\$\{esc\(s\.id\)\}"/);
});

test("a theme saved, deleted or taken from a story reads its badges again at once (the server keeps them ten minutes otherwise)", () => {
  assert.match(html, /\nfunction themesChanged\(\) \{ foot\.h = null; loadOverview\(\)\.catch\(\(\) => \{\}\); \}\n/);
  const after = (re) => assert.match(html, re);
  after(/await post\("\/api\/themes", \{ key, theme \}\);\s*themes = await api\("\/api\/themes"\);\s*themesChanged\(\);/);  // the theme editor
  after(/await post\("\/api\/themes\/delete", \{ key: k \}\); themes = await api\("\/api\/themes"\); themesChanged\(\);/);
  after(/await post\("\/api\/themes", \{ key, theme: mkStoryTheme\(s\) \}\);\s*themes = await api\("\/api\/themes"\);\s*themesChanged\(\);/);  // a starter story
  // The server side: py/tests/test_make_first_run.py test_a_saved_or_deleted_theme_is_in_what_to_film_next_at_once.
  assert.match(read("py/studio/service.py").replace(/\r\n/g, "\n"), /saved = save_theme\([^\n]*\n\s*_themes_changed\(\)/);
});

test("simple mode never links to Workflow, a tool it hides: every #/workflow link is behind ftShown(\"workflow\")", () => {
  const script = html.slice(html.indexOf("<script>"));
  const links = [...script.matchAll(/href="#\/workflow[^"]*"/g)].map((m) => m.index);
  assert.ok(links.length >= 3, `${links.length} links found`);
  // The workflow page's own renderer may link to itself; everywhere else the link sits in a ftShown("workflow") guard
  // on the same line (Reels' loop strip, Use what worked, AI blocks on Keys & AI).
  for (const at of links) {
    const line = script.slice(script.lastIndexOf("\n", at) + 1, script.indexOf("\n", at));
    const before = script.slice(Math.max(0, at - 400), at);
    assert.ok(/ftShown\("workflow"\)/.test(line) || /ftShown\("workflow"\)/.test(before), `unguarded: ${line.trim().slice(0, 140)}`);
  }
});
