/**
 * FILE: test/first-run-2.test.mjs
 * PURPOSE: The fresh-user walk of 27 Nov (BL-144, BL-145, BL-146, BL-149). Footage already in the project's folder is
 *   read on a first start, and in one press from Home and from the folder picker (BL-144). Make reels is greyed with the
 *   reason while too few clips fit, a too-few failure stays on the page with an "Any place" story one press away, and
 *   Home shows an Any place card (BL-145). Before the first approval, What needs you holds the networks' sign-in
 *   reminders and puts the first review on top, and Posting counts the same sign-ins (BL-146). Problems are put into the
 *   page's language when read, so a switch back to English leaves no Japanese button (BL-149). The Python side (the
 *   clip count, the Japanese shot words): py/tests/test_first_run_2.py.
 * USAGE: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assemblePage } from "../server/ui.mjs";
import { firstStartRead } from "../server/first-start.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = assemblePage(ROOT).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { stories } = JSON.parse(readFileSync(new URL("../shared/starter-stories.json", import.meta.url), "utf8"));
/** One top-level function of the page, `async` kept. */
const body = (name) => {
  let at = script.indexOf(`\nasync function ${name}(`);
  if (at < 0) at = script.indexOf(`\nfunction ${name}(`);
  assert.ok(at >= 0, name);
  return script.slice(at + 1, script.indexOf("\n}", at + 1) + 2);
};
/** A top-level `const NAME = {...};` object of the page. */
const object = (name) => {
  const at = script.indexOf(`\nconst ${name} = {`);
  assert.ok(at >= 0, name);
  return script.slice(at + 1, script.indexOf("\n};\n", at) + 3);
};
const make = (names, env, src, ret) => new Function(...names, `${src}\nreturn ${ret};`)(...names.map((k) => env[k]));
const trV = (k, v) => (v ? `${k}|${JSON.stringify(v)}` : k);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const JA = /[\u3040-\u30ff\u3400-\u9fff]/;
/** The page's labels in one language (the main `  en: {` / `  ja: {` block of I18N), read as key → text. */
const labels = (lang) => {
  const start = script.indexOf(`  ${lang}: {`, script.indexOf("const I18N = {"));
  const end = script.indexOf("\n  },", start);
  const out = {};
  for (const p of script.slice(start, end).matchAll(/"([a-z_]+\.[a-zA-Z0-9.]+)": "((?:[^"\\]|\\.)*)"/g)) out[p[1]] = p[2];
  return out;
};

/* ---------- BL-144: footage already in the folder is read ---------- */
test("BL-144: a project never read before is read a few seconds after the studio starts; a look-only studio never reads by itself", () => {
  const data = join(tmpdir(), "lc-first-start");
  const none = () => false, read = () => true;
  assert.deepEqual(firstStartRead({ quiet: false, watchMinutes: 30, data, exists: none }), { read: true, why: "first start" });
  assert.equal(firstStartRead({ quiet: false, watchMinutes: 30, data, exists: read }).read, false, "read before: the 30-minute watcher keeps it");
  assert.equal(firstStartRead({ quiet: true, watchMinutes: 30, data, exists: none }).read, false, "STUDIO_QUIET starts nothing by itself");
  assert.equal(firstStartRead({ quiet: false, watchMinutes: 0, data, exists: none }).read, false, "STUDIO_WATCH_MINUTES=0 turns it off");
  let asked = "";
  firstStartRead({ quiet: false, watchMinutes: 30, data, exists: (p) => { asked = p; return false; } });
  assert.equal(asked, join(data, "sources_state.json"), "the file every read writes (py/studio/sources.py STATE)");
  assert.match(server, /if \(firstStartRead\(\{ quiet: QUIET, watchMinutes: WATCH_MINUTES, data: DATA \}\)\.read\) setTimeout\(\(\) => startWatch\("first start"\), 5_000\);/);
  assert.match(server, /"first-start\.mjs"\]/, "a change to it marks the server stale");
});

test("BL-144: GET /api/sources?look=1 diffs the folders now, so Home can count what is not read yet", () => {
  assert.match(server, /if \(url\.searchParams\.get\("look"\) === "1"\) \{\s*const \[list, last\] = await Promise\.all\(\[pyResult\(\["sources", "list"\]\), pyResult\(\["sources", "diff"\]\)\]\);\s*return send\(res, 200, \{ \.\.\.list, last, watch: watchView\(\) \}\);/);
});

function pickerReport(r) {
  const env = { foot: { picker: { mode: "gps" } }, tr: trV, trR: (k) => k, esc, ico: () => "", bytes: (n) => `${n} B` };
  return make(Object.keys(env), env, `${body("reportHtml")}\n${body("srcName")}\n${body("includedHtml")}`, "reportHtml")(r);
}

test("BL-144: the picker on a folder already added: Read these N files now, not a dead end", () => {
  const r = { path: "C:/footage", total: 9, new: 9, already: 0, kinds: { video: 7, photo: 2 }, formats: {}, years: {}, newest: [], included: { label: "Footage folder", labelKey: "root" } };
  const got = pickerReport(r);
  assert.match(got, /<button class="primary" id="fsRead" data-srcwatch="1" data-srcread="1">fr\.readn\|\{"n":9\}<\/button>/);
  assert.match(got, /fr\.isfolder\|\{"s":"src\.l\.root"\}/, "the folder by the page's name for it");
  assert.doesNotMatch(got, /id="fsInclude"|name="srcMode"/, "nothing to add again");
  assert.match(pickerReport({ ...r, new: 1 }), /fr\.read1/);
  const done = pickerReport({ ...r, new: 0, already: 9 });
  assert.doesNotMatch(done, /data-srcread/);
  assert.match(done, /fr\.allread\|\{"n":9\}/);
  assert.match(pickerReport({ ...r, included: null }), /id="fsInclude"/, "a new folder is added as before");
  assert.match(body("pickerHtml"), /\$\{tr\(l\.included \? "fr\.lookin" : "src\.look"\)\}/, "the folder's own button says what it does");
});

test("BL-144: Read these N files now closes the picker, reads, and Home shows the reading", () => {
  const at = script.indexOf('if (e.target.closest("#srcWatch, [data-srcwatch]")) {');
  assert.ok(at > 0);
  const handler = script.slice(at, script.indexOf("return renderHome(true);", at));
  assert.match(handler, /const read = e\.target\.closest\("\[data-srcread\]"\);\s*if \(read\) \{ read\.disabled = true; foot\.picker = null; foot\.job = \{ status: "running", kind: "watch", label: tr\("fr\.reading"\) \}; renderHome\(true\); \}/);
  assert.match(handler, /foot\.job = await post\("\/api\/sources\/watch", \{\}\)/);
  assert.match(script, /foot\.look = null; loadFootage\(\); loadOverview\(\); loadSources\(\);/, "read: Home counts again");
  assert.match(script, /if \(atHome\(\) && \(page === "footage" \|\| page === "home"\)\) renderHome\(true\);/);
});

function homeFound(foot, calls = []) {
  const env = { foot, tr: trV, esc, ico: () => "", api: (u) => { calls.push(u); return new Promise(() => {}); }, atHome: () => true, page: "home", renderHome: () => {}, srcName: (s) => s.label };
  return make(Object.keys(env), env, `${body("homeLookLoad")}\n${body("homeFoundHtml")}`, "homeFoundHtml")();
}

test("BL-144: Home with no footage read yet says how many files are already in the folder and reads them in one press", () => {
  const calls = [];
  const found = homeFound({ look: { at: Date.now(), new: 9, sources: [{ label: "Footage folder", new: 9 }, { label: "imports", new: 0 }] } }, calls);
  assert.match(found, /^<section class="hm-first hm-found" aria-labelledby="hmFoundT">/);
  assert.match(found, /<h3 id="hmFoundT">fr\.found\|\{&quot;n&quot;:9\}<\/h3>/);
  assert.match(found, /fr\.foundsub\|\{&quot;w&quot;:&quot;Footage folder&quot;\}/, "only the folders with new files");
  assert.match(found, /<button type="button" class="primary hm-firstgo" data-srcwatch="1" data-srcread="1">fr\.readn\|\{&quot;n&quot;:9\}<\/button>/);
  assert.deepEqual(calls, [], "counted 0 s ago: not asked again");
  const reading = homeFound({ look: { at: Date.now(), new: 9, sources: [] }, job: { status: "running", kind: "watch", label: "adding 9 new files to the catalog", done: 1, of: 3 } });
  assert.match(reading, /fr\.foundreading/);
  assert.match(reading, /adding 9 new files to the catalog · 1\/3/);
  assert.doesNotMatch(reading, /data-srcread/, "no second press while it reads");
  assert.equal(homeFound({ look: { at: Date.now(), new: 0, sources: [] } }), "", "nothing new: no box");
  const asked = [];
  homeFound({}, asked);
  assert.deepEqual(asked, ["/api/sources?look=1"], "never counted: asked");
  const old = [];
  homeFound({ look: { at: Date.now() - 30_000, new: 0, sources: [] } }, old);
  assert.deepEqual(old, ["/api/sources?look=1"], "files put in the folder later are seen (every 20 s at most)");
  assert.match(body("homeOneHtml"), /return `\$\{homeFoundHtml\(\)\}<section class="hm-one"/, "it stands above the drop box");
});

/* ---------- BL-145: Make only when a reel can be made ---------- */
const STORIES = stories;
function makeModel({ ranch = 9, fit = null } = {}) {
  const MK = { need: 4, fit, stories: STORIES, fail: null, busy: null };
  const env = { MK, overviewLoaded: true, overview: { library: { ranch }, reels: [] }, tr: trV, themeTitle: (k) => `T:${k}` };
  env.mkIsAny = (key) => STORIES.some((s) => s.any && (key === s.id || String(key).startsWith(s.id + "-")));
  const fns = make(Object.keys(env), env, `${body("mkFew")}\n${body("mkMakeBlock")}`, "{ mkFew, mkMakeBlock }");
  return { ...fns, MK };
}

test("BL-145: Make is greyed with the reason while the library holds fewer clips than a reel needs", () => {
  const zero = makeModel({ ranch: 0 }).mkMakeBlock(["cafe"]);
  assert.equal(zero.why, 'fr.lib0|{"n":0,"need":4}');
  assert.equal(zero.any, true, "an Any place story is offered");
  assert.equal(makeModel({ ranch: 2 }).mkMakeBlock(["cafe"]).why, 'fr.lib|{"n":2,"need":4}');
  assert.equal(makeModel({ ranch: 0 }).mkMakeBlock([]), null, "nothing ticked: Pick themes first says it");
});

test("BL-145: Make is greyed while every ticked theme counts fewer than 4 clips that fit; one that fits is enough", () => {
  const m = makeModel({ fit: { cafe: 2, "day-here": 5, shop: 1 } });
  const one = m.mkMakeBlock(["cafe"]);
  assert.equal(one.why, 'fr.few|{"t":"T:cafe","n":2,"need":4}');
  assert.equal(one.key, "cafe"); assert.equal(one.any, true);
  assert.equal(m.mkMakeBlock(["cafe", "shop"]).why, 'fr.fewn|{"m":2,"need":4}');
  assert.equal(m.mkMakeBlock(["cafe", "day-here"]), null, "the one that fits is made; the other says why after");
  assert.equal(makeModel({ fit: { cafe: 2 } }).mkMakeBlock(["cafe", "new-one"]), null, "a theme not counted yet never blocks");
  assert.equal(makeModel({ fit: null }).mkMakeBlock(["cafe"]), null, "no count (a big library): as before");
  assert.equal(makeModel({ fit: { "day-here-2": 1 } }).mkMakeBlock(["day-here-2"]).any, false, "already an Any place story: no fallback to itself");
  assert.equal(makeModel({ fit: { "day-here-2": 1 } }).mkMakeBlock(["day-here-2"]).why, 'fr.fewadd|{"t":"T:day-here-2","n":1,"need":4}', "and it asks for other footage, not for itself");
  const maker = body("makerHtml");
  assert.match(maker, /const block = mkMakeBlock\(\[\.\.\.\(autoThemes \|\| \[\]\)\]\.filter\(\(k\) => themes\?\.\[k\]\)\);/);
  assert.match(maker, /\$\{mkWhyHtml\(block\)\}\s*<button class="primary big" id="autoGo" \$\{n && !block && sys\.health\?\.verdict !== "blocked" \? "" : "disabled"\}\$\{block \|\| MK\.fail \? ' aria-describedby="mkWhy"' : ""\}>/);
  assert.match(server, /url\.pathname === "\/api\/themes\/fit"\) \{[\s\S]{0,400}await ask\(\{ cmd: "fit", themes: keys, faces: url\.searchParams\.get\("faces"\) === "1" \}\)/);
});

function storyModel(fit) {
  const calls = { made: [], toasts: [] };
  const MK = { need: 4, fit: null, stories: STORIES, fail: null, busy: null, gallery: true };
  const env = { MK, overviewLoaded: true, overview: { library: { ranch: 9 }, reels: [] }, tr: trV, esc, ico: () => "", themeTitle: (k) => `T:${k}`,
    renderHome: () => {}, post: async () => ({}), api: async () => ({ cafe: { title: "Coffee" } }), themesChanged: () => {}, themes: {}, autoThemes: null,
    showMaker: false, sys: { health: { verdict: "ok" } }, toast: (t) => calls.toasts.push(t), autopilot: (k) => calls.made.push(k),
    mkFitOf: async () => fit, mkStoryTheme: (s) => s.theme };
  env.mkIsAny = (key) => STORIES.some((s) => s.any && (key === s.id || String(key).startsWith(s.id + "-")));
  const fn = make(Object.keys(env), env, `${body("mkFew")}\n${body("mkUseStory")}`, "mkUseStory");
  return { run: () => fn("cafe"), MK, calls };
}

test("BL-145: a starter story makes its first reel only when 4 clips fit; otherwise it waits, ticked, and says why with a way on", async () => {
  const short = storyModel(2);
  await short.run();
  assert.deepEqual(short.calls.made, [], "no reel started that cannot be made");
  assert.equal(short.MK.fail.why, 'fr.few|{"t":"T:cafe","n":2,"need":4}');
  assert.equal(short.MK.fail.any, true, "with one press to an Any place story");
  const ok = storyModel(6);
  await ok.run();
  assert.deepEqual(ok.calls.made, [["cafe"]]);
  assert.equal(ok.MK.fail, null);
});

test("BL-145: a too-few failure after Make stays on the page (not only a toast)", async () => {
  const MK = { need: 4, fit: null, stories: STORIES, fail: null };
  const toasts = [];
  const env = { MK, overview: { library: { ranch: 9 }, reels: [] }, tr: trV, esc, ico: () => "", themeTitle: (k) => `T:${k}`, toast: (t) => toasts.push(t),
    post: async () => ({ made: [], failed: ["cafe: only 2 usable assets for this theme"] }), loadOverview: async () => {}, homeFilter: "", showMaker: false };
  env.mkIsAny = () => false;
  const run = make(Object.keys(env), env, `${body("makeWhy")}\n${body("mkFew")}\n${body("runAutopilot")}`, "runAutopilot");
  await run(["cafe"], {});
  assert.equal(MK.fail?.key, "cafe");
  assert.equal(MK.fail.why, 'mk.fewclips|{"t":"T:cafe","n":"2"}');
  assert.equal(MK.fail.any, true);
  assert.ok(toasts.some((t) => t.includes("mk.nonemade")), "the toast still says it too");
  const html2 = make(["MK", "tr", "esc", "ico", "mkAnyId"], { MK, tr: trV, esc, ico: () => "", mkAnyId: () => "day-here" }, body("mkWhyHtml"), "mkWhyHtml")(null);
  assert.match(html2, /<p class="mk-why warnline" id="mkWhy" role="alert">/);
  assert.match(html2, /data-mkany="1">fr\.useany<\/button>/);
  assert.match(html2, /data-goto="footage">make\.addfootage<\/button>/);
  assert.match(html2, /data-mkfailx="1"/, "and can be put away");
  // On Reels the stories are read only with the gallery: the reason reads them, so its Any place button can appear
  // (the live walk found it missing).
  let loads = 0;
  const bare = { need: 4, fail: null };
  make(["MK", "tr", "esc", "ico", "mkAnyId", "mkLoadStories"], { MK: bare, tr: trV, esc, ico: () => "", mkAnyId: () => null, mkLoadStories: () => { loads++; } }, body("mkWhyHtml"), "mkWhyHtml")({ why: "short", any: true, key: "cafe" });
  assert.equal(loads, 1, "the story list is asked for");
});

test("BL-145: Home shows an Any place card after Cafe, Guesthouse, Campsite and Shop", () => {
  const any = stories.filter((s) => s.any);
  assert.ok(any.length >= 1 && any[0].id === "day-here", "the first Any place story is the fallback");
  assert.deepEqual(stories.filter((s) => !s.any).slice(0, 4).map((s) => s.id), ["cafe", "guesthouse", "campsite", "shop"]);
  const list = stories.map((s) => ({ id: s.id, title: s.kind.en, any: !!s.any }));
  const env = { tr: (k) => k, esc, ico: () => "", mkStarterStories: () => list };
  const row = make(Object.keys(env), env, body("homeStoriesHtml"), "homeStoriesHtml")();
  assert.deepEqual([...row.matchAll(/data-starter="([^"]+)"/g)].map((m) => m[1]), ["cafe", "guesthouse", "campsite", "shop", "day-here"]);
  assert.match(row, /<li class="any"><a href="#\/reels" data-openmaker="1" data-starter="day-here" title="Any place: a day here"><b>fr\.any<\/b><\/a><\/li>/);
  assert.match(body("mkStarterStories"), /any: !!s\.any \}\)\);/);
});

/* ---------- BL-146: the first review before sign-ins ---------- */
function wnModel({ approved = false, booked = false } = {}) {
  const prob = [{ id: "check:tiktok", level: "amber", title: "TikTok needs a one-time sign-in check" }, { id: "check:x", level: "amber", title: "X needs a one-time sign-in check" }];
  const PROB = { items: prob, cause: (id) => (String(id).startsWith("check:") ? "signin" : String(id).split(":")[0]), nice: (t) => t, causeName: (c) => c };
  const env = { PROB, lang: "en", tr: trV, esc, overviewLoaded: true,
    overview: { reels: [{ slug: "a-1127", status: approved ? "approved" : "rendered", rendered: true }] },
    postsLog: booked ? [{ network: "youtube", status: "scheduled", at: "2026-12-01T10:00:00Z" }] : [] };
  const WN = make(Object.keys(env), env, object("WN"), "WN");
  WN.local = () => [{ lv: "amber", key: "sys", text: "This browser is not ideal" }, { lv: "todo", key: "review", text: "1 reel waits for your review" }];
  return WN;
}

test("BL-146: before the first approval, no sign-in reminders and the first review on top", () => {
  const before = wnModel();
  assert.equal(before.held(), true);
  const items = before.items();
  assert.deepEqual(items.map((x) => x.key), ["review", "sys"], "review first, the sign-ins held");
  assert.equal(before.signinCount(), 0);
  const after = wnModel({ approved: true });
  assert.equal(after.held(), false);
  assert.deepEqual(after.items().map((x) => x.key), ["p:signin", "sys", "review"], "once approved: as before, worst first");
  assert.equal(after.signinCount(), 2, "one line per network");
  assert.equal(wnModel({ booked: true }).held(), false, "something booked counts as past the first approval");
});

test("BL-146: Posting's 'N need attention' is What needs you's sign-in count", () => {
  const strip = body("healthStrip");
  assert.match(strip, /const needs = WN\.signinCount\(\), open = hsOpen \?\? needs > 0;/);
  assert.doesNotMatch(strip, /needs\+\+/, "no second way of counting");
});

test("BL-146: Bluesky stays under More networks; the user guide says so, and that sign-ins wait for the first approval", () => {
  const channels = JSON.parse(readFileSync(new URL("../shared/channels.json", import.meta.url), "utf8")).channels;
  assert.equal(channels.find((c) => c.id === "bluesky").tier, "more");
  const guide = readFileSync(new URL("../docs/user-guide.md", import.meta.url), "utf8");
  assert.match(guide, /no sign-in stands before the first reel: until you approve your first reel, What needs you and Posting hold back sign-in and connect reminders/);
  assert.match(guide, /Bluesky, which the studio posts to itself, is under \*\*More networks\*\*/);
});

/* ---------- BL-149: Japanese everywhere it should be, and only there ---------- */
test("BL-149: problems are put into the page's language when read: back in English, no Japanese button", async () => {
  const server = [{ id: "signin:bluesky", level: "red", title: "Bluesky is signed out", fix: { label: "Sign in to Bluesky again", href: "#/accounts" }, ja: { title: "Blueskyのサインインが切れています", fix: "Blueskyにもう一度サインイン" } }];
  const env = { sort3: (x) => [...x], fetch: async () => ({ json: async () => ({ items: server }) }), channelsSpec: { channels: [{ id: "x" }] },
    helperView: { signins: {} }, api: async () => ({ signins: {} }), chanOf: (n) => (n === "x" ? { id: "x" } : null), lsGet: () => 0, NET_NAME: { x: "X" },
    $: () => null, WN: { draw() {} }, overview: { reels: [] }, reelName: (s) => s };
  const names = Object.keys(env);
  const m = new Function(...names, `let lang = "ja";\n${object("PROB")}\nreturn { PROB, set: (l) => { lang = l; } };`)(...names.map((k) => env[k]));
  m.PROB.helperAt = Date.now();
  await m.PROB.load();
  const ja = m.PROB.items;
  assert.equal(ja.find((i) => i.id === "check:x").fix.label, "アカウントを開く");
  assert.equal(ja.find((i) => i.id === "signin:bluesky").fix.label, "Blueskyにもう一度サインイン");
  m.set("en");  // the header's language button; no new load yet
  const en = m.PROB.items;
  assert.equal(en.find((i) => i.id === "check:x").fix.label, "Open Accounts");
  assert.equal(en.find((i) => i.id === "check:x").title, "X needs a one-time sign-in check");
  assert.equal(en.find((i) => i.id === "signin:bluesky").fix.label, "Sign in to Bluesky again");
  for (const i of en) assert.ok(!JA.test(`${i.title} ${i.fix?.label}`), `${i.id} in English`);
});

test("the new labels are in English and Japanese, and the Japanese ones are Japanese", () => {
  const en = labels("en"), ja = labels("ja");
  const mine = Object.keys(en).filter((k) => k.startsWith("fr."));
  assert.ok(mine.length >= 16, mine.join());
  assert.deepEqual(mine.filter((k) => !(k in ja)), [], "missing in Japanese");
  assert.deepEqual(Object.keys(ja).filter((k) => k.startsWith("fr.") && !(k in en)), [], "missing in English");
  for (const k of mine) {
    assert.ok(JA.test(ja[k]) && !JA.test(en[k]), k);
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(vars(ja[k]), vars(en[k]), `${k}: the same {placeholders}`);
  }
  const used = new Set([...script.matchAll(/"(fr\.[a-z0-9]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((k) => !(k in en)), [], "every fr label the page asks for is defined");
});
