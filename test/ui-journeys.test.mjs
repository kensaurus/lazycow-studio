/**
 * FILE: test/ui-journeys.test.mjs
 * PURPOSE: Guards for the bugs found walking every user journey of the page (server/editor.html) by hand:
 *   a click whose server error is never shown (the "dead button"), and lists of the same steps kept twice.
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../server/editor.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("<script>");
const script = html.slice(start, html.lastIndexOf("</script>"));
const lines = script.split("\n");
const base = html.slice(0, start).split("\n").length;  // file line of the script's first line
const asyncFns = new Set([...script.matchAll(/async function ([A-Za-z0-9_]+)\(/g)].map((m) => m[1]));

/* Each event handler: `document.addEventListener("click"|..., async (e) => { ... });` and `$("#x").onclick = async () => { ... };`
   (at any indent; the handler ends at the closing line with the same indent). */
function handlers() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(document\.addEventListener\("(click|change|submit|input|keydown)", async|\$\("#[\w-]+"\)\.on(click|change|submit) = async)/.exec(lines[i]);
    if (!m) continue;
    const end = new RegExp(`^${m[1]}\\}(, true)?\\);|^${m[1]}\\};`);
    let j = i; while (j < lines.length && !end.test(lines[j])) j++;
    out.push({ at: base + i, body: lines.slice(i + 1, j) });
  }
  return out;
}
/* Per character: is a `try {` open there? Template `${}` and "{n}" are balanced, so a plain brace count is enough for
   this file's one-statement-per-line style. */
function tryMask(body) {
  let depth = 0; const tries = [];
  return body.map((line) => {
    const on = [];
    for (let k = 0; k < line.length; k++) {
      if (line.startsWith("try {", k)) { tries.push(depth); depth++; for (let q = 0; q < 5; q++) on.push(true); k += 4; continue; }
      if (line[k] === "{") depth++;
      else if (line[k] === "}") { depth--; if (tries.length && depth === tries[tries.length - 1]) tries.pop(); }
      on.push(tries.length > 0);
    }
    return on;
  });
}
const scan = (pick) => {
  const bad = [];
  for (const { at, body } of handlers()) {
    const mask = tryMask(body);
    body.forEach((line, k) => { const why = pick(line, mask[k]); if (why) bad.push(`${at + k + 1}: ${why}: ${line.trim().slice(0, 110)}`); });
  }
  return bad;
};

test("no handler returns an async call from inside try without await (its error would never be shown)", () => {
  assert.deepEqual(scan((line, on) => {
    const m = [...line.matchAll(/return (?!await )([A-Za-z0-9_]+)\(/g)].find((x) => on[x.index] && (asyncFns.has(x[1]) || x[1] === "post" || x[1] === "api"));
    return m ? m[1] : "";
  }), []);
});

test("every server call a click, change or submit makes is inside try, so a refusal is shown", () => {
  // .catch(...) on the same call handles it too
  assert.deepEqual(scan((line, on) => [...line.matchAll(/await (post|api)\(/g)].some((x) => !on[x.index]) && !/\.catch\(/.test(line) ? "unguarded call" : ""), []);
});

/* An async helper that asks the server to do something (POST) and catches nothing: a handler must call it inside try (or the helper must catch). */
const unguarded = new Set([...asyncFns].filter((name) => {
  const i = lines.findIndex((l) => l.startsWith(`async function ${name}(`));
  let j = i; while (j < lines.length && !/^}/.test(lines[j])) j++;
  const body = lines.slice(i, j + 1).join("\n");
  return /await post\(/.test(body) && !/try \{|\.catch\(/.test(body);
}));

test("no handler calls an async helper that catches nothing outside try", () => {
  assert.deepEqual(scan((line, on) => {
    const m = [...line.matchAll(/\b([A-Za-z0-9_]+)\(/g)].find((x) => !on[x.index] && unguarded.has(x[1]));
    return m ? m[1] : "";
  }), []);
});

test("the Getting started card and the header chip count the same steps", () => {
  const at = script.indexOf("function setupCard()");
  assert.match(script.slice(at, script.indexOf("\n}", at)), /startSteps\(\)/, "setupCard keeps its own copy of the steps");
});

test("choosing a language in the setup wizard redraws the whole page, as the header toggle does", () => {
  const at = script.indexOf("async function wizardAct(");
  assert.match(script.slice(at, script.indexOf("\n}", at)), /setLang\(/);
  assert.match(script, /closest\("#lang"\)\) \{ setLang\(/);
});

test("the setup wizard never opens by itself on top of another dialog (it opened over the Projects panel)", () => {
  const at = script.indexOf("function paintStartChip()");
  assert.match(script.slice(at, script.indexOf("\n}", at)), /setTimeout\(\(\) => \{ if \(!wz && !otherDialogOpen\(\)\) openWizard\(\); \}/);
  assert.match(script, /function otherDialogOpen\(\) \{\n  return !!\(wsPanel \|\| pal \|\| drawer \|\| planner\)/);
});

test("the header's project chip always shows the project name, Main included", () => {
  const at = script.indexOf("function paintWsChip()");
  assert.match(script.slice(at, script.indexOf("\n}", at)), /nm\.hidden = false/);
});

test("footage tags follow the page's language: no chip prints tagsJa directly", () => {
  assert.doesNotMatch(script, /\(i\.tagsJa \|\| \[\]\)\.includes|\(it\.tagsJa \|\| \[\]\)\.map|it\.tagsJa\.slice|for \(const t of i\.tagsJa|\(i\.tagsJa \|\| \[\]\)\[0\]/);
  assert.match(script, /const footTags = \(i\) => i\.tags \? i\.tags\.map\(\(k, n\) => \[k, lang === "ja"/);
});

test("Esc closes the footage viewer and the folder picker, which are real dialogs", () => {
  assert.match(script, /if \(foot\.open != null\) \{ foot\.open = null; renderHome\(true\); \}/);
  assert.match(html, /<div class="lightbox" data-fclose="1"><div class="lb-card" role="dialog" aria-modal="true"/);
  assert.match(html, /<div class="lightbox picker" data-pclose="1"><div class="lb-card pk" role="dialog" aria-modal="true"/);
});

test("Being made with nothing running shows no empty placeholder boxes (they read as loading that never ends)", () => {
  assert.doesNotMatch(html, /ghostq/);
});

test("a tooltip never shows for a button a live re-render removed (it stuck over the project chip and took its clicks)", () => {
  const at = script.indexOf("function tipShow(el)");
  assert.match(script.slice(at, script.indexOf("\n}", at)), /if \(!el\.isConnected\) return;/);
});

test("a waiting project switch follows the project the studio runs, not a downtime it may never see", () => {
  const at = script.indexOf("function waitForSwitch()");
  const body = script.slice(at, script.indexOf("\n}", at));
  assert.match(body, /api\("\/api\/workspaces"\)/);
  assert.match(body, /v\.running !== from/);
  assert.match(script, /if \(wsView\.active !== wsView\.running\) \{ toast\(.*ws\.toolate/);
});

test("phones: one header row with the project's name, tab rows show a fade when there is more, state chips wrap cleanly", () => {
  const phone = html.slice(html.indexOf("/* Phones: the header's first row holds every control"), html.indexOf("/* ==== Monokai accents"));
  assert.match(phone, /\.app\.at-home \.wschip \.wsname \{ display: inline-block; max-width: max\(18vw, 150px\); \}/);
  // The name is never hidden or cut to a few letters: phones give it the room Help and the search prompt took (Help is in
  // Search) and let it wrap at its spaces; no rule anywhere hides it (12 Nov: "● >" with no name at 768 px).
  const last = html.slice(html.lastIndexOf("/* Phones, last so they win"), html.indexOf("</style>"));
  assert.match(last, /header \.wschip \{ max-width: calc\(100vw - 190px\); \}/);
  assert.match(last, /\.app \.wschip \.wsname, \.app\.at-home \.wschip \.wsname \{ display: -webkit-box; -webkit-line-clamp: 2;/);
  assert.doesNotMatch(html, /\.wschip \.wsname[^{}]*\{ display: none; \}/);
  assert.doesNotMatch(html, /\.wsname, [^{}]*\{ display: none; \}/);
  assert.match(phone, /header #syncBtn \{ display: none; \}/);
  assert.match(phone, /header #lang \.lfull \{ display: none; \} header #lang \.lshort \{ display: inline; \}/);
  assert.match(phone, /\.seg \.flow-sep, \.seg \.seg-gap \{ display: none; \}/);
  assert.match(script, /const FADE_ROWS = "\.topnav, \.subtabs, \.posttabs";/);
  assert.match(html, /:is\(header \.topnav, \.subtabs, \.posttabs\)\.more-r \{ mask-image/);
});
