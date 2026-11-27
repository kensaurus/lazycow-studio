/**
 * FILE: test/first-run-review.test.mjs
 * PURPOSE: Guards for the second part of the first-run walk of 26 Nov (a cafe owner, simple mode, no keys): simple
 *   mode's top bar (BL-140), Settings › Accounts' connection check counting the networks the header counts (BL-135),
 *   Review saying what Approve does when no network is connected and asking for one (BL-132), and the phone
 *   heights of Settings, More tools and Review (BL-139).
 * USAGE: npm test
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePage } from "../server/ui.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = assemblePage(ROOT).replace(/\r\n/g, "\n");
const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
const css = html.slice(0, html.indexOf("<body"));
const body = (name) => { const at = script.indexOf(`function ${name}(`); assert.ok(at > 0, name); return script.slice(at, script.indexOf("\n}", at) + 2); };
const dict = (lang) => { const at = script.indexOf("\n  ja: {\n"); assert.ok(at > 0); return lang === "en" ? script.slice(0, at) : script.slice(at); };
const str = (lang, key) => { const m = new RegExp(`"${key.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`).exec(dict(lang)); assert.ok(m, `${lang} ${key}`); return m[1]; };
const server = readFileSync(new URL("../server/review.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* The top bar's own controls: every button in <header> but the brand, the section list, the editor-only ones and the
   project chip (the project's name, not a tool: the walk's list of power chrome did not count it). */
function topBarControls() {
  let h = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  h = h.replace(/<nav class="topnav"[\s\S]*?<\/nav>/, "").replace(/<span class="edit-only"[^>]*>[\s\S]*?<\/button>\s*<\/span>/g, "");  // the editor's queue arrows
  return [...h.matchAll(/<button ([^>]*)>/g)].map(([, a]) => ({ id: /id="([^"]+)"/.exec(a)?.[1], cls: /class="([^"]*)"/.exec(a)?.[1] || "", style: /style="([^"]*)"/.exec(a)?.[1] || "" }))
    .filter((b) => b.id && !/\bedit-only\b/.test(b.cls) && !/display:\s*none/.test(b.style) && b.id !== "wsBtn");
}
const simpleHidden = () => {
  const m = /:root\[data-ui="simple"\] header :is\(([^)]*)\)\s*\{\s*display:\s*none !important;/.exec(css);
  assert.ok(m, "one simple-mode rule hides the power chrome");
  return m[1].split(",").map((s) => s.trim().replace(/^#/, ""));
};

test("BL-140: simple mode's top bar renders at most 5 controls: setup chip, Help, bell, language, More", () => {
  const all = topBarControls().map((b) => b.id), hidden = simpleHidden();
  const simple = all.filter((id) => !hidden.includes(id));
  assert.ok(simple.length <= 5, `simple mode shows ${simple.length}: ${simple.join(", ")}`);
  assert.deepEqual(simple.sort(), ["helpBtn", "lang", "moreBtn", "newsBtn", "startBtn"]);
  for (const id of ["aboutBtn", "palBtn", "syncBtn", "themeBtn", "sysBtn", "probBtn"]) assert.ok(all.includes(id) && hidden.includes(id), `${id}: full mode only`);
  // The setup chip only while setup is unfinished; More only in simple mode; the key hints only in full mode.
  assert.match(body("paintStartChip"), /b\.hidden = done === s\.length;/);
  assert.match(css, /:root:not\(\[data-ui="simple"\]\) \.morewrap \{ display: none !important; \}/);
  assert.match(css, /:root\[data-ui="simple"\] #sbKeys, :root\[data-ui="simple"\] \.rvkeys \{ display: none !important; \}/);
});

test("BL-140: the level is on <html> from the first paint and after every change; More holds the rest", () => {
  assert.match(html.slice(0, html.indexOf("</head>")), /localStorage\.getItem\("lc\.ui\.level"\) === "simple"\) document\.documentElement\.setAttribute\("data-ui", "simple"\)/);
  assert.match(body("uiChrome"), /document\.documentElement\.dataset\.ui = uiLevel;/);
  assert.match(body("paintNav"), /uiChrome\(\);/);
  for (const fn of ["uiApply", "uiSetLevel"]) assert.match(body(fn), /uiChrome\(\)/, fn);
  const menu = body("moreMenuPaint");
  for (const k of ["search", "sync", "theme", "system", "about", "full"]) assert.match(menu, new RegExp(`item\\("${k}"`), k);
  // Each item presses the same thing the full-mode button does; the shortcuts never depended on the buttons.
  assert.match(script, /if \(k === "search"\) palOpen\(\); else if \(k === "sync"\) \$\("#syncBtn"\)\?\.click\(\); else if \(k === "theme"\) themeToggle\(\);/);
  assert.match(script, /else if \(k === "system"\) \$\("#sysBtn"\)\?\.click\(\); else if \(k === "about"\) openAbout\(\); else if \(k === "full"\) uiSetLevel\("full"\);/);
  assert.match(script, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === "k"\) \{ e\.preventDefault\(\); if \(pal\) palClose\(\); else palOpen\(\);/);
  // The problems count rides on the bell when its own button is hidden.
  assert.match(script, /\$\("#newsBtn"\)\?\.setAttribute\("data-prob", r \? "red" : a \? "amber" : ""\)/);
  for (const l of ["en", "ja"]) for (const k of ["rv.more.tip", "rv.more.search", "rv.more.sync", "rv.more.light", "rv.more.dark", "rv.more.system", "rv.more.about"]) assert.ok(str(l, k).length > 1, `${l} ${k}`);
});

test("BL-135: the connection check counts the networks the header counts, each one fine or its one step", () => {
  // eslint-disable-next-line no-new-func
  const ncSteps = new Function(`${body("ncSteps")}\nreturn ncSteps;`)();
  const net = (network, checks) => ({ network, name: network, checks });
  const nets = [net("instagram", []), net("youtube", [{ id: "signin", ok: false }]), net("facebook", [{ id: "signin", ok: false }]),
    net("tiktok", [{ id: "chrome", ok: false }]), net("x", [{ id: "chrome", ok: false }]), net("linkedin", [{ id: "chrome", ok: false }, { id: "lastpost", ok: false }])];
  const todo = new Set(["youtube", "facebook", "tiktok", "x", "linkedin"]);  // the header: 1 Ready, 5 Needs one step
  const out = ncSteps(nets, (n) => todo.has(n.network));
  assert.deepEqual(out.c, { ok: 1, step: 4, warn: 0, bad: 1 });
  assert.equal(out.c.ok + out.c.step + out.c.warn + out.c.bad, nets.length, "every network in use is counted once");
  assert.deepEqual(out.need.map((n) => [n.network, n.checks.map((x) => x.id)]), [["linkedin", ["lastpost"]]], "a step's sign-in finding is its row below, not a second problem");
  // A network not in a step keeps every finding.
  assert.deepEqual(ncSteps([net("bluesky", [{ id: "expires", ok: null }])], () => false).c, { ok: 0, step: 0, warn: 1, bad: 0 });
  // The page sends its list (every network not switched off) and asks again when it changes; the server passes it on.
  assert.match(script, /\$\{netCheckHtml\(by\("todo"\), nets\.filter\(\(n\) => st\[n\]\.group !== "off"\)\)\}/);
  assert.match(body("netCheckHtml"), /if \(\(ncView === null \|\| ncKey !== inUse\.join\(","\)\) && !ncBusy\) runNetCheck\(\);/);
  assert.match(body("runNetCheck"), /"\/api\/connections\/check" \+ \(ncNets\.length \? "\?nets=" \+ encodeURIComponent\(ncNets\.join\(","\)\) : ""\)/);
  assert.match(server, /url\.searchParams\.get\("nets"\) \|\| ""\)\.split\(","\)\.filter\(\(n\) => \/\^\[a-z0-9-\]\{1,40\}\$\/\.test\(n\)\)\.slice\(0, 30\)/);
  assert.match(server, /pyRun\("studio\.netcheck", "check", \{ chrome: extensionConnected\(\), \.\.\.\(nets\.length \? \{ nets \} : \{\}\) \}/);
  for (const l of ["en", "ja"]) for (const k of ["rv.nc.ok", "rv.nc.step", "rv.nc.steptip", "rv.nc.warn", "rv.nc.bad"]) assert.match(str(l, k), /\{(n|list)\}/, `${l} ${k}`);
});

test("BL-132: with no network the plan can book on, nothing is booked, and Review says so and asks where it should go", async () => {
  // What Approve leads to is the daily plan: it books approved reels only on networks ready now. None ready: no plan.
  const { planAhead } = await import("../server/autoplan.mjs");
  const reels = [{ slug: "cafe-lunch", headline: "Lunch", networks: ["x", "tiktok", "facebook"] }];
  assert.deepEqual(planAhead({ reels, networks: [], now: Date.parse("2026-11-26T10:00+09:00") }).plan, []);
  assert.ok(planAhead({ reels, networks: ["x"], now: Date.parse("2026-11-26T10:00+09:00") }).plan.length > 0, "one ready network: booked");
  assert.match(server, /networks: chosen\.filter\(\(n\) => ready\[n\]\)/, "autoPlan books only the ready networks");
  // The page reads the same readiness (GET /api/autopost ready = autoReady()).
  assert.match(server, /\[settings, waiting, ready\] = await Promise\.all\(\[liveSettings\(\), ask\(\{ cmd: "live", action: "waiting" \}\), autoReady\(\)\.catch\(\(\) => null\)\]\)/);
  assert.match(server, /networks: AUTO_NETS\.filter\(\(n\) => !OPTIONAL_NETS\.includes\(n\) \|\| ready\?\.\[n\]\), ready, today: todayIn\(tz\)/);
  // eslint-disable-next-line no-new-func
  const rvSplit = new Function(`${body("rvSplit")}\nreturn rvSplit;`)();
  const all = { x: false, tiktok: false, facebook: false, youtube: false, linkedin: false, bluesky: false };
  const nets = ["youtube", "instagram", "tiktok", "facebook", "x", "linkedin"];
  assert.deepEqual(rvSplit(nets, all), { ready: [], missing: ["youtube", "tiktok", "facebook", "x", "linkedin"] }, "Instagram is posted by hand: nothing to connect for it here");
  assert.deepEqual(rvSplit(nets, { ...all, x: true }).ready, ["x"]);
  assert.equal(rvSplit(nets, null), null, "an older server: Review says what it said before");
  // Wording: no "will be posted" and no landing slot when nothing is ready; the row says it is kept.
  assert.match(body("afterApprove"), /if \(w && !w\.ready\.length\) return tr\(manual \? "rv\.after\.nonemanual" : "rv\.after\.none"\);/);
  assert.match(script, /\$\{where && !where\.ready\.length \? rvNoNetHtml\(r, where\) : cLandsHtml\(r\)\}/);
  assert.match(body("cLandTaken"), /\(!autoView\?\.ready \|\| autoView\.ready\[n\] === true\)/, "Would land on: ready networks only");
  // Approve with none ready: approved (the same POST), then the ask once a visit; Not now only closes it (no request).
  assert.ok(script.includes('if (w && !w.ready.length) { if (rvNotNow()) toast(`${ico("check", "sm")} ${esc(tr("rv.done.kept", { s: reelName(slug) }))}`, 6000); else rvAsk = { slug }; }'));
  assert.ok(script.indexOf('await post("/api/approve", { slug: "story-" + slug });') < script.indexOf("else rvAsk = { slug };"), "approved first, then asked");
  const ask = body("rvAskHtml");
  assert.match(ask, /rvConnectLinks\(w\.missing\)/); assert.match(ask, /data-rvnotnow="1"/);
  assert.match(script, /href="#\/accounts" data-rvconnect="\$\{esc\(n\)\}"/, "Connect goes to Settings › Accounts, at that network");
  const notNow = script.slice(script.indexOf('if (e.target.closest?.("[data-rvnotnow]"))'));
  assert.doesNotMatch(notNow.slice(0, notNow.indexOf("\n")), /post\(|api\(/, "Not now keeps the approval: nothing is sent");
  // What needs you agrees: no "schedule a post" or "booked by themselves" when nothing can book.
  assert.match(script, /if \(!booked && !none && overview\.reels\.some\(/);
  assert.match(script, /if \(approved && none\) add\("todo", "approved", tr\("rv\.wn\.kept"/);
  for (const l of ["en", "ja"]) for (const k of ["rv.after.none", "rv.after.nonemanual", "rv.nonet", "rv.nonet.kept", "rv.nonet.go", "rv.ask.h", "rv.ask.body", "rv.ask.bodymanual", "rv.ask.connect", "rv.ask.notnow", "rv.ask.kept", "rv.done.kept", "rv.notconn", "rv.notconn.tip", "rv.wn.kept"]) assert.ok(str(l, k).length > 1, `${l} ${k}`);
  assert.doesNotMatch(str("en", "rv.after.none"), /will be posted/);
  assert.match(str("en", "rv.ask.notnow"), /^Not now \(keep it approved\)$/);
});

test("BL-139: Settings, More tools and Review fold or tighten on a phone without dropping an action", () => {
  // The BL-139 block of 05-layout.css only: parts after it (Make reels' own phone rules) are not this test's to list.
  const layout = readFileSync(new URL("../server/ui/css/05-layout.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const phone = (() => { const at = layout.indexOf("---- BL-139"); assert.ok(at > 0); return layout.slice(at); })();
  // Settings › Accounts: the map folds under its title, closed on a phone at first; the choice holds through redraws.
  const map = body("accMapHtml");
  assert.match(map, /const mapOpen = accMap\.open \?\? !matchMedia\("\(max-width: 760px\)"\)\.matches;/);
  assert.match(map, /<details class="panel ammap am-fold" data-amfold \$\{mapOpen \? "open" : ""\}><summary class="fh-head">/);
  assert.match(script, /if \(!e\.target\.matches\?\.\("\[data-amfold\]"\)\) return;\s*accMap\.open = e\.target\.open;/);
  assert.match(phone, /\.nchead \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; \}/, "Check again sits on the check's title row");
  // More tools: one group per section, every full-mode tool still a card.
  const more = body("renderMore");
  assert.match(more, /const SECS = \["reels", "posting", "results", "settings"\];/);
  assert.match(more, /\.concat\(\[\["", ids\.filter\(\(id\) => !SECS\.includes\(FEATURES\[id\]\.sec\)\)\]\]\)/, "a tool in another section is never dropped");
  assert.match(more, /<ul class="mt-grid">\$\{l\.map\(card\)\.join\(""\)\}<\/ul>/);
  // Review: the queue is one row to swipe; the picture and its clips are smaller; Approve and the rest stay.
  assert.match(phone, /\.rvq-list \{ display: flex; overflow-x: auto; overflow-y: hidden;/);
  assert.match(phone, /\.rv-md \.rvfocus \.rvposter, \.rv-md \.rvfocus \.rvvid \{ max-width: 180px; \}/);
  // What the phone rules hide is words said twice or a lone icon, never a control.
  const hidden = [...phone.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)].map((m) => m[1].trim().replace(/^\/\*[^]*?\*\/\s*/, ""));
  assert.deepEqual(hidden.sort(), [".accsec .helpnote > svg.i:first-child", ".am-fold > summary::-webkit-details-marker", ".nchead > .grow", ".uix-switch > .meta"].sort());
});
