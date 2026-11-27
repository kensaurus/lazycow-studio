/* ---------- Home (#/home and #/, BL-115, BL-131) ----------
   What a person needs first. A project with no footage yet gets one box (BL-131, 26 Nov: "Drop your videos here and we
   make your first reel": drop, Choose a folder or Choose files, the same way in as Footage › Add) and a row of starter
   stories under it. Once footage is in, the setup steps live in the header chip (paintStartChip: the same essentials of
   startSteps) and never stack on Home as cards: someone new sees what needs them and what goes out next, someone
   returning the loop, what goes out next, what needs them and last week in one line. Built from the renderers and data
   the other pages already use; ≤ 1.5 screens. */
let homeAsked = false;
// The essentials of the one setup list (startSteps in 08-palette-wizard.js), as the header chip counts them.
function homeSteps() { return essentialSteps(); }
/* Starter stories: the gallery is on Make reels. When the page has its list (mkStarterStories(): [{id, title, icon?}] in
   the page's language), Home shows its first four as cards; without it, one link. Each opens Make reels, the story's id in
   data-starter for the maker to pick up. */
function homeStoriesHtml() {
  let list = [];
  try {
    // The first four kinds of business, then the first story for any kind of place (BL-145: "Any place", the story a
    // place that is none of those starts from).
    const all = typeof mkStarterStories === "function" ? (mkStarterStories() || []).filter((s) => s?.id && s?.title) : [];
    list = all.filter((s) => !s.any).slice(0, 4).concat(all.filter((s) => s.any).slice(0, 1));
  } catch { list = []; }
  const head = `<h3>${ico("film", "sm")}<span>${esc(tr("hm.st.title"))}</span></h3>`;
  if (!list.length) return `<section class="hm-stories" aria-label="${esc(tr("hm.st.title"))}">${head}<p><a class="btn" href="#/reels" data-openmaker="1">${ico("clapper", "sm")}${esc(tr("hm.st.pick"))} ›</a><span class="meta">${esc(tr("hm.st.hint"))}</span></p></section>`;
  return `<section class="hm-stories" aria-label="${esc(tr("hm.st.title"))}">${head}
    <ul class="hm-storyrow">${list.map((s) => `<li${s.any ? ' class="any"' : ""}><a href="#/reels" data-openmaker="1" data-starter="${esc(s.id)}"${s.any ? ` title="${esc(s.title)}"` : ""}>${ico(s.icon || "film", "sm")}<b>${esc(s.any ? tr("fr.any") : s.title)}</b></a></li>`).join("")}</ul>
    <p><a href="#/reels" data-openmaker="1">${esc(tr("hm.st.pick"))} ›</a></p></section>`;
}
/* BL-144: footage already in the project's folders and not read yet (a new project pointed at a full folder, or a
   look-only studio, which reads nothing by itself). GET /api/sources?look=1 diffs the folders now (names only), at most
   every 20 s while Home shows the one box; the card reads them in one press (POST /api/sources/watch). */
function homeLookLoad() {
  const l = foot.look;
  if (l?.busy || (l && Date.now() - l.at < 20_000)) return;
  foot.look = { ...(l || {}), busy: true, at: Date.now() };
  api("/api/sources?look=1").then((v) => { foot.look = { at: Date.now(), new: v?.last?.new || 0, sources: v?.last?.sources || [] }; },
    () => { foot.look = { at: Date.now(), new: 0, sources: [] }; })
    .finally(() => { if (atHome() && page === "home" && foot.look?.new) renderHome(true); });
}
function homeFoundHtml() {
  homeLookLoad();
  const n = foot.look?.new || 0, job = foot.job, reading = job?.status === "running" && job.kind === "watch";
  if (!n && !reading) return "";
  const where = (foot.look?.sources || []).filter((s) => s.new > 0).map((s) => srcName(s)).join(", ");
  const progress = `${esc(job?.label || tr("fr.reading"))}${job?.of ? ` · ${job.done || 0}/${job.of}` : ""}`;
  return `<section class="hm-first hm-found" aria-labelledby="hmFoundT"><span class="hm-firstico" aria-hidden="true">${ico("layers")}</span>
    <div><h3 id="hmFoundT">${esc(reading ? tr("fr.foundreading") : tr(n === 1 ? "fr.found1" : "fr.found", { n }))}</h3>
      <p class="meta" role="status">${reading ? `${ico("clock", "sm")} ${progress}` : esc(tr("fr.foundsub", { w: where || tr("src.l.rootAny") }))}</p></div>
    ${reading ? "" : `<button type="button" class="primary hm-firstgo" data-srcwatch="1" data-srcread="1">${ico("download", "sm")}${esc(tr(n === 1 ? "fr.read1" : "fr.readn", { n }))}</button>`}</section>`;
}
/* The one box for a project with no footage: the Footage › Add drop zone, larger. A drop anywhere on the page uploads
   (takeFiles), and the upload bars show on Footage › Add, where uploadFiles goes. Files already in the project's folder
   come first (BL-144). */
function homeOneHtml() {
  return `${homeFoundHtml()}<section class="hm-one" aria-labelledby="hmOneT">${addDropHtml(`<span id="hmOneT">${esc(tr("hm.one.title"))}</span>`, esc(tr("hm.one.sub")), "hm-drop")}</section>${homeStoriesHtml()}`;
}
/* The next step once footage is in and no reel is made yet (the setup cards are the header chip's, BL-131): one box,
   "Make your first reel", that opens the maker on Reels. A project with no themes gets the starter stories under it (the
   maker shows them too). It goes once any reel of the project's own exists, made or being made. */
function homeFirstHtml() {
  const lib = overview.library || {}, n = lib.ranch || lib.total || 0;
  const none = !!themes && !Object.keys(themes).length;
  return `<section class="hm-first" aria-labelledby="hmFirstT"><span class="hm-firstico" aria-hidden="true">${ico("clapper")}</span>
    <div><h3 id="hmFirstT">${esc(tr("hm.first.title"))}</h3><p class="meta">${esc(tr(none ? "hm.first.subnone" : "hm.first.sub", { n: n.toLocaleString() }))}</p></div>
    <a class="btn primary hm-firstgo" href="#/reels" data-openmaker="1">${ico("clapper", "sm")}${esc(tr("hm.first.go"))}</a></section>${none ? homeStoriesHtml() : ""}`;
}
function renderHomePage() {
  const L = lang === "ja" ? "ja-JP" : "en-GB";
  const head = `<div class="pagehead">${crumbs([tr("nav.home")])}<span class="meta">${esc(new Date().toLocaleDateString(L, { weekday: "long", day: "numeric", month: "long", timeZone: audTz() }))}</span><span class="grow"></span>
    ${uiLevel === "simple" ? `<a class="btn ghost" href="#/more">${ico("grid", "sm")}${esc(tr("nav.more"))}</a>` : ""}</div>`;
  if (!overviewLoaded || !postsLoaded) { $("#home").innerHTML = head + loadingHtml(tr("nav.home")); return; }
  if (!homeAsked) {
    homeAsked = true;
    if (!Object.keys(connections || {}).length) api("/api/connections").then((c) => { connections = c || {}; if (page === "home" && atHome()) renderHome(true); }).catch(() => {});
  }
  loadToday();
  const steps = homeSteps(), isNew = steps.slice(0, -1).some((s) => !s.ok);  // all but the last (booking / YouTube) done = returning
  // No footage yet: the one box (BL-131); the header chip counts the steps.
  if (!steps.find((s) => s.id === "footage")?.ok) { $("#home").innerHTML = head + homeOneHtml(); return; }
  // Next posts: what goes out today, else the next few booked.
  const today = wallOf(Date.now()).slice(0, 10), outs = laneData([today]).items.filter((x) => x.state !== "posted");
  const next = outs.length ? outs.slice(0, 4).map((x) => ({ at: null, hm: x.hm, network: x.row, slug: x.slug }))
    : upcomingPosts(4).map((p) => ({ at: p.at, network: p.network, slug: p.slug }));
  const postRow = (p) => `<li><a href="#/posting"><b class="hm-when">${esc(p.hm ? `${tr("hm.today")} ${p.hm}` : whenText(p.at))}</b>${netLogo(chOf(p.network), "sm")}<span class="hm-net">${esc(NET_NAME[p.network] || p.network)}</span><span class="hm-reel" lang="ja">${esc(reelName(p.slug))}</span></a></li>`;
  const nextBox = `<section class="hm-box"><h3>${ico("send", "sm")}<span>${esc(tr("hm.next"))}</span><a class="hm-link" href="#/posting">${esc(tr("nav.posting"))} ›</a></h3>
    ${next.length ? `<ol class="hm-list">${next.map(postRow).join("")}</ol>` : `<p class="meta">${esc(tr("hm.nonext"))}</p>`}</section>`;
  // What needs you: the same list as the strip under the header (problems first, then to-dos), its first four.
  const wn = WN.items(), needBox = `<section class="hm-box"><h3>${ico("alert", "sm")}<span>${esc(tr("hm.needs"))}</span>${wn.length > 4 ? `<span class="meta">${esc(tr("hm.more", { n: wn.length - 4 }))}</span>` : ""}</h3>
    ${wn.length ? `<ul class="hm-list hm-needs">${wn.slice(0, 4).map((x) => `<li class="${x.lv}"><i class="wn-dot" aria-hidden="true"></i><span title="${esc(x.detail || x.text)}">${esc(x.text)}</span>${WN.fixHtml(x.fix)}</li>`).join("")}</ul>` : `<p class="meta">${ico("check", "sm")} ${esc(tr("hm.noneeds"))}</p>`}</section>`;
  // Last week in one line (the same number as Today and Results: weekViews).
  const wk = weekViews(), num = (n) => Math.round(n || 0).toLocaleString(L);
  const week = `<a class="hm-week" href="#/results">${ico("wave", "sm")}<b>${esc(tr("hm.week"))}</b><span>${wk ? `${esc(tr("hm.weekline", { n: num(wk.now) }))} · <span class="td-delta ${wk.tone}">${esc(wk.label)}</span>` : todayPerf ? esc(tr("hm.noweek")) : "…"}</span><span class="grow"></span>${esc(tr("nav.results"))} ›</a>`;
  // Footage is in: the setup steps are the header chip's, not cards here (BL-131), whatever is still to do; with no reel
  // of the project's own yet, the one next step on top.
  const first = steps.some((s) => s.id === "reel") && !overview.reels.some((r) => !r.house);
  $("#home").innerHTML = isNew
    ? `${head}${first ? homeFirstHtml() : ""}<div class="hm-grid">${needBox}${nextBox}</div>`
    : `${head}${lpaStripHtml()}<div class="hm-grid">${nextBox}${needBox}</div>${week}`;
}
/* ---------- More tools (#/more, BL-118): the full-mode tools, one step away ----------
   One card per tool from FEATURES: its icon, name, one line on what it is for and how often this project used it
   (the private counts, BL-120). The "Show all tools" switch puts them back in the menus. */
const uiAgo = (iso) => {
  if (!iso) return "";
  const d = Math.floor((new Date(new Date().toDateString()) - new Date(new Date(iso).toDateString())) / 864e5);
  return d <= 0 ? tr("mt.today") : d === 1 ? tr("mt.yday") : tr("mt.days", { n: d });
};
const uiUsedLine = (id) => { const c = uiUsage[id]; return c?.n ? tr("mt.used", { n: c.n, t: uiAgo(c.last) }) : tr("mt.unused"); };
function uiSwitchHtml() {
  return `<div class="uix-switch" role="group" aria-label="${esc(tr("uix.label"))}"><label class="switch"><input type="checkbox" data-uilevel="1" ${uiLevel === "full" ? "checked" : ""}><span>${esc(tr("uix.showall"))}</span></label>
    <span class="meta">${esc(tr(uiLevel === "full" ? "uix.fullnote" : "uix.simplenote"))}</span></div>`;
}
function renderMore() {
  const ids = Object.keys(FEATURES).filter((id) => FEATURES[id].level === "full");
  const card = (id) => `<li><a class="mt-card" href="${ftHref(id)}">${kTile({ icon: ftIcon(id), hue: { reels: 28, posting: 215, results: 145, settings: 262 }[FEATURES[id].sec] ?? 198 })}
    <span class="mt-txt"><b>${esc(ftName(id))}</b><span class="meta mt-help">${esc(tr(FEATURES[id].help))}</span><span class="meta mt-use">${esc(uiUsedLine(id))}</span></span></a></li>`;
  // BL-139: one short group per section (its name said once, not on every card), so the page fits two phone screens.
  const SECS = ["reels", "posting", "results", "settings"];
  const groups = SECS.map((s) => [s, ids.filter((id) => FEATURES[id].sec === s)]).concat([["", ids.filter((id) => !SECS.includes(FEATURES[id].sec))]]).filter(([, l]) => l.length);
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.more")])}<span class="meta">${esc(tr("mt.lead"))}</span></div>
    ${uiSwitchHtml()}
    ${groups.map(([s, l]) => `<section class="mt-sec">${s ? `<h3 class="mt-h">${esc(tr("nav." + s))}<span class="count">${l.length}</span></h3>` : ""}<ul class="mt-grid">${l.map(card).join("")}</ul></section>`).join("")}
    <p class="meta mt-private">${ico("shield", "sm")} ${esc(tr("mt.private"))}</p>`;
}
/* A full-mode tool opened by its address in simple mode: it works as always, with one slim line saying so. */
function ftNote() {
  const id = ftNow();
  if (ftShown(id)) return;
  const html = `<p class="uix-note" role="note">${ico("grid", "sm")}<span>${esc(tr("uix.note"))}</span><button type="button" class="linkbtn" data-uilevelset="full">${esc(tr("uix.showall"))}</button><a href="#/more">${esc(tr("nav.more"))} ›</a></p>`;
  const head = $("#home .pagehead");
  if (head) head.insertAdjacentHTML("afterend", html); else $("#home").insertAdjacentHTML("afterbegin", html);
}
/* The level from the server (GET /api/ui), a switch (POST /api/ui), and the usage counts (POST /api/ui/usage). */
function uiApply(v) {
  if (!v || !["simple", "full"].includes(v.level)) return;
  uiDefaulted = !!v.defaulted; uiUsage = v.usage || {};
  const changed = v.level !== uiLevel;
  uiLevel = v.level; lsSet("lc.ui.level", uiLevel); uiChrome();
  if (changed && atHome()) renderHome(true);
}
function uiLoad() { api("/api/ui").then(uiApply).catch(() => { /* an older server: everything shows, as before */ }); }
async function uiSetLevel(level) {
  const was = uiLevel;
  uiLevel = level; lsSet("lc.ui.level", level); uiChrome(); if (atHome()) renderHome(true);
  try { uiApply(await post("/api/ui", { level })); toast(`${ico(level === "full" ? "grid" : "check", "sm")} ${esc(tr(level === "full" ? "uix.nowfull" : "uix.nowsimple"))}`, 3500); }
  catch (err) { uiLevel = was; lsSet("lc.ui.level", was); uiChrome(); if (atHome()) renderHome(true); toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
}
document.addEventListener("change", (e) => { const s = e.target.closest?.("[data-uilevel]"); if (s) uiSetLevel(s.checked ? "full" : "simple"); });
document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-uilevelset]"); if (b) uiSetLevel(b.dataset.uilevelset); });
/* One count per page or tool opened (not per redraw), and per key action ("review:approve"). Only to this computer's
   studio; a refusal (an id the server does not know, an older server) is ignored. */
function uiCount(id) {
  if (!id || !FEATURES[id.split(":")[0]]) return;
  if (!id.includes(":")) { if (uiCount.last === id) return; uiCount.last = id; }
  const c = uiUsage[id] || (uiUsage[id] = { n: 0, last: null }); c.n++; c.last = new Date().toISOString();
  fetch("/api/ui/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
}
/* ---------- the theme: Auto follows the system, Light and Dark override it (localStorage studio.theme) ----------
   The attribute is set before the first paint by the script in <head>; the CSS keys its dark tokens on it. */
function themePref() { let v = null; try { v = localStorage.getItem("studio.theme"); } catch { /* private window */ } return v === "light" || v === "dark" ? v : "auto"; }
function themeApply(v) {
  try { if (v === "auto") localStorage.removeItem("studio.theme"); else localStorage.setItem("studio.theme", v); } catch { /* private window: this visit only */ }
  if (v === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  themeColor(); themeBtnPaint(); if (atHome()) renderHome(true); else renderAll();
  requestAnimationFrame(() => { drawWires(); drawLanes(); });
}
/* The top bar's colour button (owner, 18 Nov: the Colours setting was hard to find and Auto followed a dark system):
   one click switches Light ⇄ Dark; from Auto it goes to the opposite of what shows. The icon is where a click goes.
   Same setting as Settings › Colours (themePref / themeApply), so the radio there stays in step. */
function themeBtnPaint() {
  const b = document.getElementById("themeBtn"); if (!b) return;
  const p = themePref(), dark = themeDark();
  const tip = `${tr(p === "auto" ? (dark ? "fb_th.autodark" : "fb_th.autolight") : dark ? "fb_th.dark" : "fb_th.light")} ${tr("fb_th.where")}`;
  b.title = tip; b.setAttribute("aria-label", tip); b.setAttribute("aria-pressed", String(dark));
  b.innerHTML = ico(dark ? "sun" : "moon", "sm");
}
function themeToggle() {
  const v = themeDark() ? "light" : "dark";
  themeApply(v);
  toast(`${ico(v === "dark" ? "moon" : "sun", "sm")} ${esc(tr("d_th.saved", { v: tr("d_th." + v) }))}`, 2500);
}
document.getElementById("themeBtn")?.addEventListener("click", themeToggle);
document.getElementById("lang")?.addEventListener("click", () => setTimeout(themeBtnPaint, 0));
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", themeBtnPaint);
themeBtnPaint();
function themeDark() { const v = themePref(); return v === "dark" || (v === "auto" && matchMedia("(prefers-color-scheme: dark)").matches); }
function themeColor() { document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeDark() ? "#13140f" : "#fffdf6"); }
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (themePref() === "auto") { themeColor(); if (atHome() && page === "keys") renderHome(true); } });
function themeFieldset() {
  const p = themePref();
  const opt = (v) => `<label class="moopt${p === v ? " on" : ""}"><input type="radio" name="studio-theme" value="${v}" data-themepick ${p === v ? "checked" : ""}><b>${ico({ auto: "refresh", light: "sun", dark: "moon" }[v], "sm")} ${esc(tr("d_th." + v))}</b><span class="meta">${esc(tr("d_th." + v + "d"))}</span></label>`;
  return `<fieldset class="moset" data-anchor="theme"><legend>${esc(tr("d_th.label"))}</legend>${["auto", "light", "dark"].map(opt).join("")}</fieldset>
    <p class="meta">${ico("info", "sm")} ${esc(tr(matchMedia("(prefers-color-scheme: dark)").matches ? "d_th.sysdark" : "d_th.syslight"))} ${esc(tr(themeDark() ? "d_th.nowdark" : "d_th.nowlight"))}</p>`;
}
document.addEventListener("change", (e) => {
  const r = e.target.closest?.("[data-themepick]"); if (!r) return;
  themeApply(r.value);
  toast(`${ico("check", "sm")} ${esc(tr("d_th.saved", { v: tr("d_th." + r.value) }))}`, 3000);
});
