/**
 * FILE: test/first-run-home.test.mjs
 * PURPOSE: The first-run rows for Home and Footage from the walk of 26 Nov: Footage never reads "0 clips · 0 places ·
 *   0 files" while the studio is away (BL-138), Footage › Add is one drop zone and Choose a folder with the rest under
 *   Other ways (BL-133), and Home for a project with no footage is one box with starter stories under it, the setup
 *   cards folding into the header chip once footage is in (BL-131).
 * USAGE: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePage } from "../server/ui.mjs";
import { fileURLToPath } from "node:url";

const html = assemblePage(fileURLToPath(new URL("..", import.meta.url))).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
/** One top-level function of the page, `async` kept. */
const body = (name) => {
  let at = script.indexOf(`\nasync function ${name}(`);
  if (at < 0) at = script.indexOf(`\nfunction ${name}(`);
  assert.ok(at >= 0, name);
  return script.slice(at + 1, script.indexOf("\n}", at + 1) + 2);
};
const strings = (lang) => { const at = script.indexOf("\n  ja: {\n"); assert.ok(at > 0); return lang === "en" ? script.slice(0, at) : script.slice(at); };
const has = (lang, key) => strings(lang).includes(`"${key}": "`);

/* ---------- BL-138: no zeros while the studio is away ---------- */
function footageModel() {
  const foot = { items: [], q: "", f: "all", loading: false };
  const sys = { down: false };
  const calls = [];
  let answer = null;
  const post = (path) => { calls.push(path); return answer(); };
  const env = { foot, sys, post, tdFoot: { base: null }, atHome: () => false, page: "footage", renderHome: () => {}, normPath: (p) => p };
  const names = Object.keys(env);
  const fns = new Function(...names, `${body("footKnown")}\n${body("srcKnown")}\n${body("footBack")}\n${body("loadFootage")}\n${body("loadMapLib")}\nreturn { footKnown, srcKnown, footBack, loadFootage, loadMapLib };`)(...names.map((k) => env[k]));
  return { ...fns, foot, sys, calls, answer: (f) => { answer = f; } };
}
const offline = () => Promise.reject(Object.assign(new Error("The studio is not answering"), { offline: true }));

test("BL-138: before an answer and while the studio is away, the counts are unknown, not 0", async () => {
  const m = footageModel();
  assert.equal(m.footKnown(), false, "nothing asked yet: unknown");
  m.sys.down = true; m.answer(offline);
  await m.loadFootage();
  assert.equal(m.foot.itemsOk, false);
  assert.equal(m.foot.away, true);
  assert.equal(m.footKnown(), false, "away: no count");
  m.foot.src = { sources: [], last: {}, error: "The studio is not answering" };
  assert.equal(m.srcKnown(), false, "a failed /api/sources is not 0 places");
  // the map's clip count: a failed read is remembered, not retried on every redraw, and not turned into 0 files
  await m.loadMapLib(); await new Promise((r) => setTimeout(r, 0));
  assert.ok(!Array.isArray(m.foot.mapLib), "no list of 0 clips is made up");
  assert.equal(m.foot.mapLibErr, true);
  const n = m.calls.length; m.loadMapLib(); assert.equal(m.calls.length, n, "no retry loop while away");
});

test("BL-138: back again, everything that failed is asked again, and a real empty library says 0", async () => {
  const m = footageModel();
  m.sys.down = true; m.answer(offline);
  await m.loadFootage();
  m.foot.src = { sources: [], last: {}, error: "x" }; m.foot.h = { error: "x" }; m.foot.mapLibErr = true;
  assert.equal(m.footBack(), false, "still away: nothing changes");
  m.sys.down = false;
  assert.equal(m.footBack(), true);
  assert.equal(m.foot.away, false); assert.equal(m.foot.loadedKey, null); assert.equal(m.foot.src, null); assert.equal(m.foot.h, null); assert.equal(m.foot.mapLibErr, false);
  m.answer(() => Promise.resolve({ items: [] }));
  await m.loadFootage();
  assert.equal(m.footKnown(), true, "an answer of no clips is a count");
  m.foot.src = { sources: [], last: {} };
  assert.equal(m.srcKnown(), true);
  m.sys.down = true;
  assert.equal(m.footKnown(), false, "gone again: unknown again");
});

test("BL-138: every Footage count on screen goes through footKnown / srcKnown", () => {
  const strip = body("footStrip");
  assert.match(strip, /tab\("lib", "layers", tr\("ly_f\.lib"\), !footKnown\(\) \|\| \(foot\.loading && !foot\.items\.length\) \? "…"/);
  assert.match(strip, /tab\("add", "plus", tr\("ly_f\.src"\), \(srcKnown\(\) \? esc\(tr\("fs\.placesinfo"/);
  const page = body("renderFootage");
  assert.match(page, /if \(sys\.down\) foot\.away = true;[^\n]*\n  footBack\(\);/, "a page drawn while away is drawn again once back");
  assert.match(page, /<span class="meta">\$\{!footKnown\(\) \|\| \(foot\.loading && !foot\.items\.length\) \? "…" : tr\("f\.count"/);
  assert.match(body("sourceMap"), /if \(!m \|\| !srcKnown\(\)\) return/);
  assert.match(script, /setInterval\(\(\) => \{ if \(foot\.away && !sys\.down && page === "footage" && atHome\(\)\) renderHome\(true\); \}, 2000\);/);
});

/* ---------- BL-133: Footage › Add is one drop zone and Choose a folder; the rest under Other ways ---------- */
function addModel({ g = { connected: false, app: true }, sources = [], drop = {}, form = {}, addMore = "", otherOpen = false, phone = false, mapSaved = "" } = {}) {
  const foot = { g, src: { sources }, addMore, otherOpen, session: null };
  const env = {
    foot, collect: { drop, form }, tr: (k) => k, trR: (k) => k, esc: (s) => String(s), ico: () => "", gpConnectHref: () => "#g",
    AH_KIND: { cloud: { cls: "k-cloud", icon: "" }, people: { cls: "k-people", icon: "" }, pc: { cls: "k-pc", icon: "" } },
    srcKind: (x) => [x.kind], collectBody: () => "<COLLECT>", sourceMap: () => "<MAP>",
    lsGet: (k, d) => (k === "lc.ah.map" && mapSaved) || d, matchMedia: (q) => ({ matches: phone && q === "(max-width: 640px)" }),
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${body("addCard")}\n${body("addDropHtml")}\n${body("addUsed")}\n${body("addMapOpen")}\n${body("addHub")}\nreturn { addHub };`)(...names.map((k) => env[k]));
  const html = fns.addHub();
  const at = html.indexOf('<details class="ah-other"');
  return { html, top: html.slice(0, at), fold: html.slice(at), foot };
}
const count = (s, re) => (s.match(re) || []).length;

test("BL-133: a first visit shows one drop zone with Choose a folder and Choose files; Cloud, Phones and the map are folded", () => {
  const m = addModel();
  assert.equal(count(m.html, /class="ah-drop /g), 1, "one drop zone");
  assert.equal(count(m.top, /<button/g), 2, "two buttons above the fold");
  assert.match(m.top, /<button type="button" class="primary" data-pickfolder="1">[^<]*hm\.folder<\/button>/);
  assert.match(m.top, /data-choosefiles="1"/);
  assert.doesNotMatch(m.top, /ah-card/, "no way-in cards above the fold");
  assert.match(m.fold, /^<details class="ah-other" >/, "folded by default");
  assert.match(m.fold, /k-cloud/); assert.match(m.fold, /k-people/);
  assert.doesNotMatch(m.html, /<MAP>/, "the map is drawn only when the fold is open (it reads the whole library)");
  assert.match(addModel({ otherOpen: true }).fold, /^<details class="ah-other" open>[\s\S]*<MAP>/, "open, remembered: the map is there");
});

test("BL-133: a returning project keeps what it uses in view (Google Photos or a Drive folder; the drop box or a form)", () => {
  const gp = addModel({ g: { connected: true, app: true } });
  assert.match(gp.top, /k-cloud/); assert.doesNotMatch(gp.fold, /k-cloud/); assert.match(gp.fold, /k-people/);
  assert.doesNotMatch(addModel({ g: { connected: true, app: true, guess: true } }).top, /k-cloud/, "the stand-in before /api/gphotos answers is not use");
  assert.match(addModel({ sources: [{ path: "G:/My Drive/cafe", kind: "drive" }] }).top, /k-cloud/);
  const people = addModel({ form: { url: "https://forms.gle/abcd" }, addMore: "people" });
  assert.match(people.top, /k-people/);
  assert.match(people.top, /id="ahMore"[\s\S]*<COLLECT>/, "its panel opens where its card is");
  const folded = addModel({ addMore: "people" });
  assert.match(folded.fold, /^<details class="ah-other" open>[\s\S]*id="ahMore"/, "a folded way opened by a click opens the fold");
});

test("Footage › Add on a phone: with Other ways open the map folds on its own until opened, and is remembered", () => {
  const map = (o) => /<details class="ah-map" (open)?>/.exec(addModel({ otherOpen: true, ...o }).fold)?.[1] === "open";
  const drawn = (o) => addModel({ otherOpen: true, ...o }).html.includes("<MAP>");
  assert.ok(map({}) && drawn({}), "a wide screen: open and drawn");
  assert.ok(!map({ phone: true }) && !drawn({ phone: true }), "a phone: folded, and not drawn (it reads the whole library)");
  assert.ok(map({ phone: true, mapSaved: "1" }) && drawn({ phone: true, mapSaved: "1" }), "opened on this phone before: open");
  assert.ok(!map({ mapSaved: "0" }) && !drawn({ mapSaved: "0" }), "closed on this browser before: folded on a wide screen too");
  assert.ok(!addModel({ mapSaved: "1" }).html.includes("<MAP>"), "Other ways folded: no map at all");
  assert.match(addModel({ otherOpen: true }).fold, /<details class="ah-map" open><summary class="sm-title">[^<]*src\.title<\/summary>/, "the map's title is its switch");
  assert.match(script, /if \(!e\.target\.matches\?\.\("\.ah-map"\) \|\| e\.target\.open === foot\.mapShown\) return;\s*foot\.mapShown = e\.target\.open; lsSet\("lc\.ah\.map", e\.target\.open \? "1" : "0"\);/);
  // Phones: Cloud and Phones are compact rows; nothing in Add footage is hidden.
  const at = html.indexOf("/* Other ways on a phone"), phone = html.slice(at, html.indexOf("    .smap {", at));
  assert.ok(at > 0 && phone.length < 1500);
  assert.match(phone, /\.ah-card \.ah-ico \{ width: 32px; height: 32px; \}/);
  assert.doesNotMatch(phone.replace(".addhub .sm-hub .sm-hubico { display: none; }", ""), /display: none|visibility: hidden/, "no way in is hidden on a phone (only the hub's picture)");
});

test("BL-133: Placed by GPS or Shot here is asked only when the project has a home place", () => {
  const env = { foot: { picker: { mode: "gps" } }, tr: (k) => k, trR: (k) => k, esc: (s) => String(s), ico: () => "", bytes: (n) => `${n} B` };
  const names = Object.keys(env);
  const reportHtml = new Function(...names, `${body("reportHtml")}\nreturn reportHtml;`)(...names.map((k) => env[k]));
  const r = { path: "C:/cafe", total: 3, kinds: { video: 3 }, formats: {}, years: {}, newest: [] };
  assert.doesNotMatch(reportHtml({ ...r, homePlace: false }), /name="srcMode"/);
  assert.match(reportHtml({ ...r, homePlace: false }), /hm\.noplace/);
  assert.match(reportHtml({ ...r, homePlace: true }), /name="srcMode" value="trusted"/);
  assert.match(reportHtml(r), /name="srcMode" value="trusted"/, "an older engine that does not say: asked as before");
  for (const l of ["en", "ja"]) for (const k of ["hm.folder", "hm.other", "hm.otherd", "hm.noplace"]) assert.ok(has(l, k), `${l} ${k}`);
});

/* ---------- BL-131: Home is one box for a project with no footage; the setup cards never stack on Home ---------- */
function homeModel(mkStarterStories) {
  // foot.look: the folder was looked at and holds nothing new (BL-144's card is then not drawn; test/first-run-2.test.mjs).
  const env = { tr: (k) => k, esc: (s) => String(s).replace(/</g, "&lt;").replace(/"/g, "&quot;"), ico: () => "", mkStarterStories,
    foot: { look: { at: Date.now(), new: 0, sources: [] } }, api: () => new Promise(() => {}), atHome: () => true, page: "home", renderHome: () => {}, srcName: (s) => s.label };
  const names = Object.keys(env);
  return new Function(...names, `${body("addDropHtml")}\n${body("homeStoriesHtml")}\n${body("homeLookLoad")}\n${body("homeFoundHtml")}\n${body("homeOneHtml")}\nreturn { homeStoriesHtml, homeOneHtml };`)(...names.map((k) => env[k]));
}

test("BL-131: no footage yet: Home is the one drop box (Choose a folder, Choose files) and the starter stories under it", () => {
  const page = body("renderHomePage");
  assert.match(page, /if \(!steps\.find\(\(s\) => s\.id === "footage"\)\?\.ok\) \{ \$\("#home"\)\.innerHTML = head \+ homeOneHtml\(\); return; \}/);
  const one = homeModel(undefined).homeOneHtml();
  assert.match(one, /^<section class="hm-one"[^>]*><div class="ah-drop hm-drop">/);
  assert.match(one, /<span id="hmOneT">hm\.one\.title<\/span>/);
  assert.match(one, /data-pickfolder="1"/); assert.match(one, /data-choosefiles="1"/);
  assert.equal((one.match(/class="ah-drop /g) || []).length, 1, "one box");
  assert.match(one, /<section class="hm-stories"/, "the stories row is under the box");
  for (const l of ["en", "ja"]) for (const k of ["hm.one.title", "hm.one.sub", "hm.st.title", "hm.st.pick", "hm.st.hint"]) assert.ok(has(l, k), `${l} ${k}`);
});

test("BL-131: the starter stories row: one link to Make reels until the gallery's list is on the page, then its first four", () => {
  const none = homeModel(undefined).homeStoriesHtml();
  assert.match(none, /<a class="btn" href="#\/reels" data-openmaker="1">hm\.st\.pick ›<\/a>/);
  assert.doesNotMatch(none, /hm-storyrow/);
  assert.doesNotMatch(homeModel(() => { throw new Error("not ready"); }).homeStoriesHtml(), /hm-storyrow/, "a list that fails is no list");
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Story <${i}>` }));
  const row = homeModel(() => [...six, { id: "", title: "no id" }]).homeStoriesHtml();
  assert.equal((row.match(/data-starter="/g) || []).length, 4, "four cards");
  assert.match(row, /<a href="#\/reels" data-openmaker="1" data-starter="s0"><b>Story &lt;0><\/b><\/a>/, "each opens Make reels with its id; titles escaped");
});

test("BL-131: once footage is in, the setup cards are the header chip's, never cards on Home", () => {
  const page = body("renderHomePage");
  assert.ok(!script.includes("function homeSetupHtml("), "no setup cards renderer left");
  assert.doesNotMatch(page, /hm-setup|fw-steps|homeSetupHtml/);
  assert.match(page, /\? `\$\{head\}\$\{first \? homeFirstHtml\(\) : ""\}<div class="hm-grid">\$\{needBox\}\$\{nextBox\}<\/div>`/);
  assert.match(page, /: `\$\{head\}\$\{lpaStripHtml\(\)\}<div class="hm-grid">\$\{nextBox\}\$\{needBox\}<\/div>\$\{week\}`;/);
  assert.match(body("paintStartChip"), /const s = essentialSteps\(\)/, "the chip still counts the same steps");
});

/* ---------- Home's next step once footage is in and no reel is made yet ---------- */
function firstModel(themes) {
  const env = { tr: (k, v) => (v ? `${k}|${v.n}` : k), esc: (s) => String(s), ico: () => "", overview: { library: { ranch: 32 }, reels: [] }, themes, mkStarterStories: undefined };
  const names = Object.keys(env);
  return new Function(...names, `${body("homeStoriesHtml")}\n${body("homeFirstHtml")}\nreturn homeFirstHtml;`)(...names.map((k) => env[k]))();
}

test("Home with footage and no reel: one next step, Make your first reel, that opens the maker; starter stories when there are no themes", () => {
  const withThemes = firstModel({ cafe: { title: "Coffee" } });
  assert.match(withThemes, /^<section class="hm-first" aria-labelledby="hmFirstT">/);
  assert.match(withThemes, /<h3 id="hmFirstT">hm\.first\.title<\/h3><p class="meta">hm\.first\.sub\|32<\/p>/);
  assert.equal(count(withThemes, /<a /g), 1, "one action");
  assert.match(withThemes, /<a class="btn primary hm-firstgo" href="#\/reels" data-openmaker="1">hm\.first\.go<\/a>/, "it opens Make reels on #/reels");
  assert.doesNotMatch(withThemes, /hm-stories/, "a project with themes: no stories row");
  const none = firstModel({});
  assert.match(none, /hm\.first\.subnone\|32/);
  assert.match(none, /<\/section><section class="hm-stories"/, "no themes yet: the starter stories under it");
  assert.doesNotMatch(firstModel(null), /hm-stories/, "themes not read yet: no stories row guessed");
  for (const l of ["en", "ja"]) for (const k of ["hm.first.title", "hm.first.sub", "hm.first.subnone", "hm.first.go"]) assert.ok(has(l, k), `${l} ${k}`);
});

test("Home's next step goes once a reel of the project's own exists, made or being made, and never on the long-video path", () => {
  const cond = /\n  const first = (.+);\n/.exec(body("renderHomePage"))?.[1];
  assert.ok(cond, "the condition is in renderHomePage");
  const first = new Function("steps", "overview", `return ${cond};`);
  const steps = [{ id: "footage", ok: true }, { id: "reel", ok: false }, { id: "network", ok: false }];
  assert.equal(first(steps, { reels: [] }), true);
  assert.equal(first(steps, { reels: [{ house: true, rendered: true }] }), true, "a house reel is not the project's own");
  assert.equal(first(steps, { reels: [{ house: false, rendered: false }] }), false, "one being made: the maker is already open to it");
  assert.equal(first(steps, { reels: [{ house: false, rendered: true }] }), false);
  assert.equal(first([{ id: "footage", ok: true }, { id: "vlogs", ok: false }], { reels: [] }), false, "a trip made into long videos has its own steps");
});
