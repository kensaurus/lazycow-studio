/* ---------- Home (#/home and #/, BL-115) ----------
   What a person needs first. Someone new (no footage, no reel or no network yet) gets four setup cards in order:
   add footage, make a first reel, connect a network, book a first post. Each ticks itself from what the studio sees
   (they replace the old "Your first week" list on Today). Someone returning gets the loop, what goes out next, what
   needs them and last week in one line. Built from the renderers and data the other pages already use; ≤ 1.5 screens. */
let homeAsked = false;
// Home's cards are the essentials of the one setup list (startSteps in 08-palette-wizard.js), as the header chip counts.
function homeSteps() { return essentialSteps(); }
function homeSetupHtml(steps) {
  const done = steps.filter((s) => s.ok).length, next = steps.find((s) => !s.ok), pct = Math.round((100 * done) / steps.length);
  return `<section class="fw hm-setup" aria-labelledby="hmSetupT">
    <div class="fw-head"><span class="fw-ring" style="--p:${pct}" aria-hidden="true"><b>${done}</b></span><div><h3 id="hmSetupT">${esc(tr("hm.title"))}</h3><span class="meta">${esc(tr("hm.sub", { n: done, of: steps.length }))}</span></div>
      <div class="fw-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="${esc(tr("hm.title"))}"><i style="transform:scaleX(${(done / steps.length).toFixed(3)})"></i></div></div>
    <ol class="fw-steps hm-steps">${steps.map((s, n) => {
      const inner = `<span class="fw-tick" aria-hidden="true">${s.ok ? ico("check", "sm") : n + 1}</span><span class="fw-txt">${ico(s.icon)}<b>${esc(tr("d_fw.s." + s.id))}</b><span class="meta">${esc(tr(s.ok ? "d_fw.ok" : "d_fw.d." + s.id))}</span></span>${s.ok ? `<span class="sr-only">${esc(tr("d_fw.ok"))}</span>` : `<span class="btn ${next === s ? "primary" : ""} hm-go">${esc(tr("hm.go"))} ›</span>`}`;
      return `<li class="${s.ok ? "ok" : ""}${next === s ? " next" : ""}">${s.make ? `<a href="#/reels" data-openmaker="1">${inner}</a>` : `<a href="${s.href}">${inner}</a>`}</li>`;
    }).join("")}</ol></section>`;
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
  $("#home").innerHTML = isNew
    ? `${head}${homeSetupHtml(steps)}<div class="hm-grid">${needBox}${nextBox}</div>`
    : `${head}${lpaStripHtml()}<div class="hm-grid">${nextBox}${needBox}</div>${week}${steps.every((s) => s.ok) ? "" : homeSetupHtml(steps)}`;
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
    <span class="mt-txt"><b>${esc(ftName(id))}</b><span class="meta mt-help">${esc(tr(FEATURES[id].help))}</span><span class="meta mt-use">${esc(tr("nav." + FEATURES[id].sec))} · ${esc(uiUsedLine(id))}</span></span></a></li>`;
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.more")])}<span class="meta">${esc(tr("mt.lead"))}</span></div>
    ${uiSwitchHtml()}
    <ul class="mt-grid">${ids.map(card).join("")}</ul>
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
  uiLevel = v.level; lsSet("lc.ui.level", uiLevel);
  if (changed && atHome()) renderHome(true);
}
function uiLoad() { api("/api/ui").then(uiApply).catch(() => { /* an older server: everything shows, as before */ }); }
async function uiSetLevel(level) {
  const was = uiLevel;
  uiLevel = level; lsSet("lc.ui.level", level); if (atHome()) renderHome(true);
  try { uiApply(await post("/api/ui", { level })); toast(`${ico(level === "full" ? "grid" : "check", "sm")} ${esc(tr(level === "full" ? "uix.nowfull" : "uix.nowsimple"))}`, 3500); }
  catch (err) { uiLevel = was; lsSet("lc.ui.level", was); if (atHome()) renderHome(true); toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
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
