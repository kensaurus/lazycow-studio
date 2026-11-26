/* ---------- Track A (24 Nov): the loop, Plan → Do → Check → Act, and back to Plan ----------
   The owner, 24 Nov: automate "footage collect to generation to posting and analyzing and optimizing — a PDCA cycle, so
   we know what went good and what didn't and feed it to the loop". One strip on Reels › Today: each stage a tile with its
   live numbers and one next step, and one line saying what runs by itself (or what is off). Its switches live in
   Settings › Workflow › Runs by itself: making reels (lpaFoldHtml); Make reels has the per-batch "Use what worked" box.
   Data: GET /api/loop (drafts by itself, learn settings), /api/autopost (Plan posts), /api/perf/summary (measured posts,
   each theme's result), /api/perf/reach (where the views come from), /api/perf/table through weekNumbers() (Track B owns
   the weekly number, BL-108: shown here, never worked out again) and /api/words (headlines retired). */
const LPA = { loop: null, words: null, at: 0, busy: false, saving: false };
function lpaLoad(force) {
  if (LPA.busy || (!force && LPA.at && Date.now() - LPA.at < 5 * 60e3)) return;
  LPA.busy = true; LPA.at = Date.now();
  const got = (p, set) => api(p).then(set, () => {});
  Promise.all([
    got("/api/loop", (v) => { LPA.loop = v; }),
    perfView === null ? got("/api/perf/summary", (v) => { if (!perfView) perfView = v; }) : null,
    reachView === null ? got("/api/perf/reach", (v) => { if (!reachView) reachView = v; }) : null,
    tableView === null ? got("/api/perf/table?days=90", (v) => { if (!tableView) tableView = v; }) : null,
    LPA.words ? null : got("/api/words", (v) => { LPA.words = v; }),
    autoView === null && !autoLoading ? got("/api/autopost", (v) => { if (!autoView) autoView = v; }) : null,
  ]).finally(() => { LPA.busy = false; if (["today", "reels", "workflow", "home"].includes(page) && atHome()) renderHome(true); });
}
const lpaNeed = () => perfView?.needed || 15;
const lpaMeasured = () => (typeof perfView?.measured === "number" ? perfView.measured : null);
const lpaExplore = () => LPA.loop?.learn?.explore ?? 30;
// WEEKLY VIEWS: Track B's weekViews() (one definition for Today and Results, BL-108): shown here, never summed again.
const lpaWeek = () => (typeof weekViews === "function" ? weekViews() : null);
/* Bookings still to go out at one of their network's test hours (helper.mjs planWeek: 1 in 4 at another listed hour). */
function lpaTests() {
  return bookedAhead().filter((p) => {
    const h = amcHours(p.network), hm = wallOf(new Date(p.at).getTime()).slice(11, 16);
    return (h.others || []).includes(hm) && hm !== h.usual && new Date(p.at).getTime() > Date.now();
  }).map((p) => ({ ...p, hm: wallOf(new Date(p.at).getTime()).slice(11, 16), usual: amcHours(p.network).usual }));
}
/* Each theme's result for Make reels: its measured multiple (studio.learn, all networks), "not tried", or "worn" when its
   headline is worn by Words' rule (cWearData: out on 60 % of the networks within two weeks either side of today). */
function lpaThemeRes(k, v) {
  const nets = Math.max(1, PLAN_NETS().length), wornAt = Math.max(2, Math.ceil(nets * 0.6)), now = Date.now();
  const key = cNorm(v?.title || ""), slugs = new Set(key ? overview.reels.filter((r) => !r.house && cNorm(r.hookText) === key).map((r) => r.slug) : []);
  const near = new Set(postsLog.filter((p) => slugs.has(p.slug) && p.network !== "all" && holdsSlot(p) && Math.abs(new Date(p.at).getTime() - now) <= 14 * 864e5).map((p) => p.network));
  if (near.size >= wornAt) return { cls: "worn", text: tr("lpa_a.r.worn"), tip: tr("lpa_a.r.worntip", { k: wornAt }), rank: -1 };
  const rows = perfView?.features?.theme;
  if (!Array.isArray(rows)) return null;
  const r = rows.find((x) => x.level === k);
  if (!r || !r.posts) return { cls: "new", text: tr("lpa_a.r.new"), tip: tr("lpa_a.r.newtip"), rank: 1 };
  // The colour is whether it beats the other themes (pBetter), not the multiple: a network whose typical post is at
  // nothing makes every multiple look big (perf summary zeroMedian).
  const m = Number(r.mult) || 1, p = Number(r.pBetter);
  return { cls: p >= 0.75 ? "good" : p <= 0.25 ? "low" : "", text: tr("lpa_a.r.x", { m: m.toFixed(1) }), tip: tr("lpa_a.r.tip", { n: r.posts, m: m.toFixed(1), v: r.verdict || "" }), rank: m };
}
const lpaResHtml = (k, v) => { const r = lpaThemeRes(k, v); return r ? `<span class="lpa-res ${r.cls}" title="${esc(r.tip)}">${esc(r.text)}</span>` : ""; };
/* Good first, then not tried, then the weaker ones, worn last; the order stays as written where nothing is measured. */
const lpaSortThemes = (entries) => entries.map((e, i) => ({ e, i, r: lpaThemeRes(e[0], e[1])?.rank ?? 1 })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.e);
/* Make reels › "Use what worked": on by default once enough posts are measured and the setting is on; a click changes
   only this batch (autoLearned), the default is in Settings › Workflow. Simple mode hides Workflow (a full-mode tool), so
   there the default is a switch on this line (the same POST /api/autopost as Workflow's), not a link to a hidden page. */
let autoLearned = null;
function lpaLearnedNow() {
  const m = lpaMeasured();
  if (m == null || m < lpaNeed()) return undefined;  // not enough to learn from: the setting decides (random either way)
  return autoLearned ?? (LPA.loop?.learn?.steer !== false);
}
function lpaUseHtml() {
  lpaLoad();
  const m = lpaMeasured(), need = lpaNeed(), ready = m != null && m >= need, on = !!lpaLearnedNow();
  if (m == null) return "";
  return `<div class="lpa-use"><label class="${ready ? "" : "dis"}" title="${esc(tr("lpa_a.use.tip"))}"><input type="checkbox" id="lpaUse" ${on ? "checked" : ""} ${ready ? "" : "disabled"}> ${esc(tr("lpa_a.use"))}</label>
    <span class="meta">${esc(ready ? tr("lpa_a.use.n", { m, x: lpaExplore() }) : tr("lpa_a.use.wait", { need, m }))}${lpaDefaultHtml()}</span></div>`;
}
function lpaDefaultHtml() {
  if (ftShown("workflow")) return ` · <a href="#/workflow" data-lpafold="1">${esc(tr("lpa_a.use.how"))}</a>`;
  const ln = LPA.loop?.learn;
  if (!ln) return "";
  return ` · <button type="button" class="linkbtn" role="switch" aria-checked="${!!ln.steer}" data-lpaset="learn.steer" ${LPA.saving ? "disabled" : ""}>${esc(tr("lpa_a.use.def", { v: tr(ln.steer ? "lpa_a.on" : "lpa_a.off") }))}</button>`;
}
document.addEventListener("change", (e) => { if (e.target.id === "lpaUse") { autoLearned = e.target.checked; renderHome(true); } });
/* Results' "Make a reel like this" (Track B's makeLike keeps it in window.makerPreset): said above Make them, sent with the
   batch (the look, layout and recipe it names win over the drawn ones; the reel's why says so), then cleared. */
function lpaPresetHtml() {
  const p = window.makerPreset; if (!p) return "";
  const what = typeof rbPresetWords === "function" ? rbPresetWords(p) : [p.look, p.style, p.recipe].filter(Boolean).join(", ");
  const applies = !!(p.look || p.style || p.recipe);
  return `<p class="lpa-use"><span class="lpa-tag on">${esc(tr("lpa_a.pre.tag"))}</span><span>${esc(tr(applies ? "lpa_a.pre" : "lpa_a.pre.byhand", { w: what }))}</span>
    <button type="button" class="linkbtn" data-lpapreclear="1">${esc(tr("lpa_a.pre.clear"))}</button></p>`;
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-lpapreclear]")) { window.makerPreset = null; renderHome(true); } });
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-lpafold]")) lsSet("lc.lpa.fold", "1"); });
/* The strip. Null until the first numbers are in (the Footage runway line stands in until then). */
function lpaStripHtml() {
  lpaLoad();
  if (!LPA.loop || !overviewLoaded || !postsLoaded) return "";
  const L = lang === "ja" ? "ja-JP" : "en-GB", num = (n) => Math.round(n || 0).toLocaleString(L);
  const dr = LPA.loop.drafts || {}, ln = LPA.loop.learn || {}, plan = autoView?.settings?.plan;
  const m = lpaMeasured(), need = lpaNeed(), x = lpaExplore();
  // The one line: what runs by itself, or what is off.
  const make = dr.perDayNow > 0 ? tr("lpa_a.make.on", { n: dr.perDayNow }) : tr("lpa_a.make.off");
  const book = plan ? (plan.on ? tr("lpa_a.book.on", { h: `${String(plan.hour ?? 9).padStart(2, "0")}:00` }) : tr("lpa_a.book.off")) : tr("lpa_a.book.on", { h: "09:00" });
  const learn = ln.steer === false ? tr("lpa_a.learn.off") : m != null && m < need ? tr("lpa_a.learn.wait", { need, m }) : tr("lpa_a.learn.on", { m: m ?? "…", x });
  const offs = [dr.perDayNow > 0, !plan || plan.on, ln.steer !== false].filter((b) => !b).length;
  // Plan: themes with fresh footage, the runway, what to film.
  const keys = Object.keys(themes || {}), ready = keys.filter((k) => footageOf(k)?.left !== 0).length, thin = keys.length - ready, h = foot.h || {};
  // Do: being made, to review, how far bookings reach, the last drafts made by itself.
  const review = needsReview().length, making = overview.reels.filter(busyJob).length;
  const last = bookedAhead().map((p) => p.at).sort().pop(), ahead = last ? Math.max(0, Math.round((Date.parse(last) - Date.now()) / 864e5)) : 0;
  const autoLine = dr.perDayNow > 0 ? (dr.last ? tr("lpa_a.d.auto", { n: dr.lastN || 0, d: postDayLabel(dayOf(dr.last)) }) : tr("lpa_a.d.autonone")) : tr("lpa_a.d.autooff");
  // Check: the week (Track B's number), measured posts, where the views come from.
  const wk = lpaWeek(), nets = (reachView?.networks || []).filter((n) => n.views > 0).sort((a, b) => b.views - a.views);
  const tot = reachView?.totals?.views || 0, best = nets[0];
  const trend = wk ? wk.label : "", tone = wk?.tone || "";
  // Act: the lesson in use, headlines retired, the hours being tested, the next test.
  const retired = (LPA.words?.lines || []).filter((l) => l.kind === "hook" && l.status === "retired").length, tests = lpaTests(), nt = tests[0];
  const stage = (cls, key, big, lines, btn) => `<li class="lpa-st ${cls}"><h3>${esc(tr("lpa_a." + key))} <span class="lpa-k">${esc(tr("lpa_a.k." + key))}</span></h3>
    ${big}<ul class="lpa-lines">${lines.filter(Boolean).map((l) => `<li>${l}</li>`).join("")}</ul>${btn}</li>`;
  const bigN = (n, words) => `<p class="lpa-big"><b>${esc(String(n))}</b><span title="${esc(words)}">${esc(words)}</span></p>`;
  return `<section class="lpa" aria-label="${esc(tr("lpa_a.aria"))}">
    <div class="lpa-head"><i class="lpa-dot ${offs === 0 ? "" : offs >= 3 ? "off" : "part"}" aria-hidden="true"></i><b class="lpa-t">${esc(tr("lpa_a.title"))}</b>
      <span class="lpa-say">${esc(tr("lpa_a.say", { make, book, learn }))}${dr.quiet ? ` <span class="meta">${esc(tr("lpa_a.quiet"))}</span>` : ""}</span>
      ${ftShown("workflow") ? `<a href="#/workflow" data-lpafold="1">${ico("shield", "sm")} ${esc(tr("lpa_a.settings"))} ›</a>` : ""}</div>
    <ol class="lpa-row">
      ${stage("plan", "plan", themes ? bigN(`${ready}`, tr("lpa_a.p.big", { of: keys.length })) : `<div class="skel skel-line"></div>`, [
        h.reelsLeft != null ? `<a href="#/footage">${esc(h.more ? tr("lpa_a.p.runway", { n: h.reelsLeft, a: h.more.low, b: h.more.high }) : tr("mk.est.runway", { n: h.reelsLeft }))}</a>` : "",
        h.fresh != null ? esc(tr("lpa_a.p.clips", { n: num(h.fresh) })) : "",
        thin ? `<button type="button" class="linkbtn" data-goto="footage">${esc(tr("lpa_a.p.thin", { n: thin }))}</button>` : esc(tr("lpa_a.p.nothin"))],
        `<button type="button" class="primary lpa-go" data-openmaker="1">${ico("clapper", "sm")}${esc(tr("lpa_a.p.go"))}</button>`)}
      ${stage("do", "do", bigN(review, tr("lpa_a.d.big")), [
        esc(making ? tr("lpa_a.d.making", { n: making }) : tr("lpa_a.d.idle")),
        last ? `<a href="#/posting" data-pview="lanes">${esc(tr("lpa_a.d.booked", { n: ahead, d: postDayLabel(dayOf(last)) }))}</a>` : esc(tr("lpa_a.d.nobook")),
        esc(autoLine)],
        review ? `<a class="btn primary lpa-go" href="#/review">${ico("eye", "sm")}${esc(tr("lpa_a.d.review", { n: review }))}</a>`
          : `<a class="btn lpa-go" href="#/posting" data-pview="lanes">${ico("cal", "sm")}${esc(tr("lpa_a.d.week"))}</a>`)}
      ${stage("check", "check", wk ? bigN(num(wk.now), tr("lpa_a.c.big")) : `<div class="skel skel-line"></div>`, [
        trend ? `<span class="${tone}" title="${esc(wk.def || "")}">${esc(trend)}</span>` : "",
        m != null ? esc(tr("lpa_a.c.measured", { n: m })) : "",
        best && tot ? esc(tr("lpa_a.c.best", { net: NET_NAME[chOf(best.network)] || NET_NAME[best.network] || best.network, p: Math.round(100 * best.views / tot) })) : ""],
        `<a class="btn lpa-go" href="#/results">${ico("wave", "sm")}${esc(tr("lpa_a.c.go"))}</a>`)}
      ${stage("act", "act", `<p class="lpa-big"><span class="lpa-tag ${ln.steer === false ? "off" : m != null && m < need ? "off" : "on"}">${esc(ln.steer === false ? tr("lpa_a.a.off") : m != null && m < need ? tr("lpa_a.a.wait", { need }) : tr("lpa_a.a.on"))}</span></p>`, [
        LPA.words ? `<a href="#/words">${esc(tr("lpa_a.a.retired", { n: retired }))}</a>` : "",
        // Looks sent back in review twice in 30 days are left out of learned picks (studio.learn.paused_looks).
        (() => { const l = LPA.loop?.lessons; const n = l ? l.reel + l.retired + l.testHour : 0; return n ? `<span title="${esc(tr("lpa_a.a.lessonstip", { r: l.reel, h: l.retired, t: l.testHour }))}">${esc(tr("lpa_a.a.lessons", { n }))}</span>` : ""; })(),
        ln.paused?.looks?.length ? `<a href="#/review" title="${esc(tr("lpa_a.a.pausedtip", { list: ln.paused.looks.join(", "), n: ln.paused.after, d: ln.paused.days }))}">${esc(tr("lpa_a.a.paused", { n: ln.paused.looks.length }))}</a>` : "",
        esc(tests.length ? tr("lpa_a.a.tests", { n: tests.length }) : tr("lpa_a.a.notests")),
        nt ? esc(tr("lpa_a.a.next", { net: NET_NAME[chOf(nt.network)] || NET_NAME[nt.network] || nt.network, h: nt.hm, u: nt.usual,
          d: new Date(nt.at).toLocaleDateString(L, { weekday: "short", day: "numeric", month: "short", timeZone: audTz() }) }))
          : ln.steer !== false ? esc(tr("lpa_a.a.explore", { x })) : ""],
        `<a class="btn lpa-go" href="#/results/next">${ico("flow", "sm")}${esc(tr("lpa_a.a.go"))}</a>`)}
    </ol>
    <p class="lpa-back" aria-hidden="true"><i class="lpa-up">▲</i><span>↺ ${esc(tr("lpa_a.back"))}</span></p></section>`;
}
/* Settings › Workflow › Runs by itself: making reels. One fold; the controls write POST /api/autopost {set: {drafts|learn}}
   (py/studio/live.py validates). A .env line, when set, wins and is said here. */
function lpaFoldHtml() {
  lpaLoad();
  const lp = LPA.loop;
  if (!lp) return `<details class="sheet ly-fold lpa-fold"><summary><h2>${ico("clapper", "sm")} ${esc(tr("lpa_a.f.h"))}</h2></summary><div class="skel skel-line"></div></details>`;
  const dr = lp.drafts, ln = lp.learn, need = lpaNeed(), dis = LPA.saving ? "disabled" : "";
  const sw = (id, on, label) => `<button type="button" class="ab-sw${on ? " on" : ""}" role="switch" aria-checked="${on}" data-lpaset="${id}" ${dis} aria-label="${esc(label)}"><i aria-hidden="true"></i><span>${esc(tr(on ? "d_wf.on" : "d_wf.off"))}</span></button>`;
  const lastTxt = !dr.last ? tr("lpa_a.f.never") : dr.lastExact ? tr("lpa_a.f.last", { t: whenText(dr.last), n: dr.lastN }) : tr("lpa_a.f.lastday", { d: postDayLabel(dr.last.slice(0, 10)), n: dr.lastN });
  const open = (() => { try { return localStorage.getItem("lc.lpa.fold") === "1"; } catch { return false; } })();
  return `<details class="sheet ly-fold lpa-fold" data-anchor="making" ${open ? "open" : ""}><summary><h2>${ico("clapper", "sm")} ${esc(tr("lpa_a.f.h"))}</h2>
      <span class="meta">${esc(tr("lpa_a.f.sum", { d: tr(dr.perDayNow > 0 ? "lpa_a.on" : "lpa_a.off"), u: tr(ln.steer ? "lpa_a.on" : "lpa_a.off") }))} · ${esc(lastTxt)}</span></summary>
    <div class="lpa-set">
      <div class="row"><b>${esc(tr("lpa_a.f.drafts"))}</b>${sw("drafts.on", dr.on !== false, tr("lpa_a.f.drafts"))}
        <label class="meta">${esc(tr("lpa_a.f.perday"))} <select data-lpaset="drafts.perDay" ${dis}>${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${n === dr.perDay ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <span class="meta">${esc(tr("lpa_a.f.today", { n: dr.today || 0, m: dr.perDayNow || 0 }))}</span></div>
      <p class="meta">${esc(tr("lpa_a.f.draftshint"))}${dr.env ? ` <b>${esc(tr("lpa_a.f.env", { k: "STUDIO_AUTO_DRAFTS" }))}</b>` : ""}${dr.quiet ? ` ${esc(tr("lpa_a.quiet"))}` : ""}</p>
      <div class="row"><b>${esc(tr("lpa_a.f.use"))}</b>${sw("learn.steer", !!ln.steer, tr("lpa_a.f.use"))}
        <label class="meta">${esc(tr("lpa_a.f.explore"))} <select data-lpaset="learn.explore" ${dis}>${[0, 10, 20, 30, 40, 50].map((n) => `<option value="${n}" ${n === ln.explore ? "selected" : ""}>${n}%</option>`).join("")}</select></label></div>
      <p class="meta">${esc(tr("lpa_a.f.usehint", { need }))} ${esc(tr("lpa_a.f.explorehint"))}${ln.env ? ` <b>${esc(tr("lpa_a.f.env", { k: "STUDIO_PERF_STEER" }))}</b>` : ""}</p>
    </div></details>`;
}
async function lpaSave(path, value) {
  const [k, f] = path.split(".");
  LPA.saving = true; renderHome(true);
  try { await post("/api/autopost", { set: { [k]: { [f]: value } } }); toast(`${ico("check", "sm")} ${esc(tr("lpa_a.f.saved"))}`, 2500); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  LPA.saving = false; autoView = null; lpaLoad(true);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("button[data-lpaset]"); if (!b || LPA.saving) return;
  lpaSave(b.dataset.lpaset, b.getAttribute("aria-checked") !== "true");
});
document.addEventListener("change", (e) => { const s = e.target.closest?.("select[data-lpaset]"); if (s && !LPA.saving) lpaSave(s.dataset.lpaset, Number(s.value)); });
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("lpa-fold")) lsSet("lc.lpa.fold", e.target.open ? "1" : "0"); }, true);
/* ---------- Reels › Today (batch A, 17 Nov) ----------
   The day on one page: what goes out today (time, network, reel, state), what waits for you, what finished overnight
   (renders, AI touches, imports, and anything that failed), this week's views against last week's, and the footage
   runway in one line. Every row is a link or a button. Read from the posting log, the job board and /api/log, and
   /api/perf/table for the views (by the day each post went out). */
let todayLog = null, todayPerf = null, todayAt = 0;
function loadToday() {
  if (todayLog === undefined || (todayLog && Date.now() - todayAt < 5 * 60e3)) return;
  todayLog = undefined; todayAt = Date.now();
  Promise.all([api("/api/log").catch(() => ({ jobs: [] })), api("/api/perf/table?days=14").catch(() => ({ rows: [] }))])
    .then(([l, p]) => { todayLog = l || { jobs: [] }; todayPerf = p || { rows: [] }; if ((page === "today" || page === "home") && atHome()) renderHome(true); });
}
function renderToday() {
  const head = `<div class="pagehead">${crumbs([tr("nav.reels"), "#/"], [tr("nav.today")])}<span class="meta">${esc(new Date().toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: audTz() }))}</span></div>`;
  if (!overviewLoaded || !postsLoaded) { $("#home").innerHTML = head + loadingHtml(tr("nav.today")); return; }
  loadToday(); loadFootHealth(); if (!board.at) loadJobs();
  // "Overnight": since 18:00 yesterday in the audience's zone.
  const now = Date.now(), today = wallOf(now).slice(0, 10), since = Date.parse(zonedIso(`${wallOf(now - 864e5).slice(0, 10)}T18:00`)), L = lang === "ja" ? "ja-JP" : "en-GB";
  const num = (n) => Math.round(n).toLocaleString(L);
  const reelLink = (slug, cls = "") => { const r = overview.reels.find((x) => x.slug === slug);
    return `<span class="td-th ${cls}" style="background-image:url('${r?.hook ? thumb(r.hook, 60) + "&v=" + (r.updated || 0) : ""}')" aria-hidden="true"></span><span class="td-name" lang="ja">${esc(reelName(slug))}</span>`; };
  // Goes out today: every post of today, in time order, with its state (out, booked, the studio sends it, a reminder, failed).
  const outs = laneData([today]).items;
  const goes = outs.length ? `<ol class="td-list">${outs.map((x) => `<li><button type="button" class="td-row s-${x.state}" data-tdpost="${x.id}" data-slug="${esc(x.slug)}" data-net="${esc(x.row)}">
      <b class="td-time">${esc(x.hm)}</b>${netLogo(chOf(x.row), "sm")}<span class="td-net">${esc(NET_NAME[x.row] || x.row)}</span>${reelLink(x.slug)}<span class="td-st"><i class="k s-${x.state}" aria-hidden="true"></i>${esc(lnStateName(x.state))}</span></button></li>`).join("")}</ol>`
    : `<p class="td-empty">${esc(tr("td.nonetoday"))}</p>`;
  const tomorrow = laneData([nextDay(today)]).items.length;
  // Waits for you: the reels to review, and how many other things the strip under the header holds.
  const review = needsReview(), strip = WN.items().filter((x) => x.key !== "review");
  const waits = `${review.length ? `<a class="td-big" href="#/review"><b>${review.length}</b><span>${esc(tr("td.toreview", { t: span(review.length * 60) }))}</span></a>
      <div class="td-thumbs">${review.slice(0, 5).map((r) => `<a href="#/reel/${esc(r.slug)}" title="${esc(reelName(r.slug))}" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></a>`).join("")}</div>`
      : `<p class="td-empty">${esc(tr("td.noreview"))}</p>`}
    ${strip.length ? `<button type="button" class="td-more" data-tdstrip="1"><i class="wn-dot ${strip[0].lv}" aria-hidden="true"></i>${esc(tr("td.strip", { n: strip.length }))} ›</button>` : ""}`;
  // Finished overnight: the job board (last 6 hours) and the job log, since yesterday evening.
  const seen = new Set(), jobs = [];
  for (const j of [...board.jobs.values()].filter((x) => x.ended).map((x) => ({ ...x, endedAt: x.ended })).concat((todayLog?.jobs || []).map((x) => ({ ...x, endedAt: Date.parse(x.ended) })))) {
    const k = `${j.slug}|${Math.round((j.endedAt || 0) / 60e3)}`;
    if (!j.endedAt || j.endedAt < since || seen.has(k)) continue;
    seen.add(k); jobs.push(j);
  }
  const made = jobs.filter((j) => j.kind === "build" && j.status === "done"), ai = jobs.filter((j) => j.kind === "ai" && j.status === "done");
  const imported = jobs.filter((j) => ["import", "gphotos"].includes(j.kind) && j.status === "done"), failed = jobs.filter((j) => j.status === "error");
  const went = postsLog.filter((p) => p.network !== "all" && isLive(p) && p.at && new Date(p.at).getTime() >= since && new Date(p.at).getTime() <= now);
  const night = [
    went.length ? `<li><a href="#/posting/sent"><b>${went.length}</b>${esc(tr("td.went", { list: [...new Set(went.map((p) => NET_NAME[p.network] || p.network))].join(", ") }))}</a></li>` : "",
    made.length ? `<li><a href="#/reel/${esc(made[0].slug)}"><b>${made.length}</b>${esc(tr("td.made", { list: made.slice(0, 3).map((j) => reelName(j.slug)).join(" · ") }))}</a></li>` : "",
    ai.length ? `<li><a href="#/log/activity"><b>${ai.length}</b>${esc(tr("td.ai"))}</a></li>` : "",
    imported.length ? `<li><a href="#/footage"><b>${imported.length}</b>${esc(tr("td.imported"))}</a></li>` : "",
    // one line per job that failed, however often it ran
    ...[...failed.reduce((m, j) => m.set(j.slug, [...(m.get(j.slug) || []), j]), new Map()).values()].slice(0, 3).map((js) => `<li class="bad"><a href="#/log/activity"><b>${js.length > 1 ? js.length + "×" : "!"}</b>${esc(tr("td.failed", { s: boardName(js[0]), w: plainFail(js[0].last || (js[0].lines || []).slice(-1)[0] || js[0].label || "") }))}</a></li>`),
  ].filter(Boolean);
  const nightHtml = todayLog === undefined && !night.length ? `<div class="skel skel-line"></div>` : night.length ? `<ul class="td-night">${night.join("")}</ul>` : `<p class="td-empty">${esc(tr("td.quiet"))}</p>`;
  // This week against last week: views on the posts that went out in each week (the numbers come in over a few days).
  const rows = todayPerf?.rows || [], dayMs = 864e5, start = Date.parse(today + "T00:00:00Z");
  const daily = Array.from({ length: 14 }, (_, i) => { const d = wallOf(start - (13 - i) * dayMs, "UTC").slice(0, 10); return rows.filter((r) => dayOf(r.at) === d).reduce((a, r) => a + (+r.views || 0), 0); });
  const wv = weekViews(), thisW = wv ? wv.now : 0, lastW = wv ? wv.before : 0, delta = wv ? wv.pct : null;  // WEEKLY VIEWS: weekViews() (Track B)
  const byNet = {}; for (const r of rows) { const t = Date.parse(r.at); if (t >= now - 7 * dayMs) byNet[r.network] = (byNet[r.network] || 0) + (+r.views || 0); }
  const top = Object.entries(byNet).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const views = todayPerf === null || todayPerf === undefined ? `<div class="skel skel-line"></div>` : `<a class="td-views" href="#/results">
      <span class="td-big"><b>${num(thisW)}</b><span>${esc(tr("td.viewsweek"))}</span></span>
      <span class="td-delta ${delta == null ? "" : delta >= 0 ? "up" : "down"}">${delta == null ? esc(tr("td.nolast")) : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% · ${esc(tr("td.lastweek", { n: num(lastW) }))}`}</span>
      ${spark(daily, { w: 220, h: 40, label: tr("td.sparkl"), cls: "td-spark" })}
      ${top.length ? `<span class="td-nets">${top.map(([n, v]) => `<span>${netLogo(chOf(n), "sm")}${num(v)}</span>`).join("")}</span>` : ""}</a>`;
  // The runway: fresh footage left, and how far the bookings reach.
  const h = foot.h || {}, last = bookedAhead().map((p) => p.at).sort().pop();
  const runway = `<a class="td-runway" href="#/footage">${ico("layers", "sm")}<span>${h.reelsLeft != null ? esc(h.more ? tr("td.runway", { n: h.reelsLeft, a: h.more.low, b: h.more.high }) : tr("mk.est.td", { n: h.reelsLeft })) : esc(tr("td.runwayread"))}</span>${last ? `<span class="meta">· ${esc(tr("td.bookedto", { d: postDayLabel(dayOf(last)) }))}</span>` : ""}<span class="grow"></span>${ico("chev-r", "sm")}</a>`;
  const fresh = !moCalm() && !moState().shown.has("today");
  if (fresh) moState().shown.add("today");
  const card = (i, cls, icon, title, body, extra = "") => `<section class="td-card ${cls}" style="--i:${i}"><h3>${ico(icon, "sm")}<span>${esc(title)}</span>${extra}</h3>${body}</section>`;
  $("#home").innerHTML = `${head}${lpaStripHtml() || runway}
    <div class="tdy-grid${fresh ? " in" : ""}">
      <div class="td-col">${card(0, "td-goes", "send", tr("td.goes"), goes, `<b class="td-n">${outs.length}</b><a class="td-h-link" href="#/posting" data-pview="lanes">${esc(tomorrow ? tr("td.tomorrow", { n: tomorrow }) : tr("td.week"))} ›</a>`)}
        ${card(2, "td-week", "wave", tr("td.vs"), views)}</div>
      <div class="td-col">${card(1, "td-wait", "eye", tr("td.waits"), waits)}
        ${card(3, "td-night", "clock", tr("td.night"), nightHtml, `<span class="meta td-since">${esc(tr("td.since", { t: whenText(new Date(since).toISOString()) }))}</span>`)}</div>
    </div>`;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-tdpost], [data-tdstrip]"); if (!t) return;
  if (t.dataset.tdstrip) { WN.open = true; WN.draw(); return; }
  const slug = t.dataset.slug, net = t.dataset.net;
  LANES.focus = { net, day: wallOf(Date.now()).slice(0, 10) }; postView = "lanes"; postTab = "schedule"; postNet = "all";
  location.hash = "#/posting";
  setTimeout(() => openDrawer(slug, net), 350);
});
function renderReels() {
  if (!overviewLoaded) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.reels")])}</div>${loadingHtml(tr("nav.reels"))}`; return; }
  loadFootHealth();
  const R = overview.reels, review = needsReview(), none = !R.some((r) => !r.house);
  if (none) homeFilter = "all";
  if (!autoThemes && themes) autoThemes = new Set();  // nothing ticked: one click never queues every theme by surprise
  mkPicksSync(); mkFootWatch();  // the ticks are kept per project (BL-136); the footage numbers follow new reels (BL-134)
  if (!SEGMENTS.includes(homeFilter)) homeFilter = "all";
  const counts = stateCounts(R);
  const shown = R.filter((r) => !r.house && (homeFilter === "all" || reelState(r) === homeFilter) && reelPicked(r))
    .sort((a, b) => STATE_ORDER.indexOf(reelState(a)) - STATE_ORDER.indexOf(reelState(b)));
  const house = homeFilter === "all" && !rTheme && !rNet ? R.filter((r) => r.house) : [];
  $("#home").innerHTML = `
    <div class="pagehead rhead">${crumbs([tr("nav.reels"), homeFilter === "all" ? null : "#/"], ...(homeFilter === "all" ? [] : [[tr(STATE_KEY[homeFilter])]]))}
      <span class="meta">${trR("home.sum", { n: counts.all, f: overview.library?.ranch ?? "…" })}${foot.h?.more ? ` · <a href="#/footage">${tr("fh.moreest", { r: moreReels() })}</a>` : ""}</span>
      <span class="grow"></span>
      ${review.length ? `<button data-act="review">${ico("eye", "sm")}${tr("act.review")} <span class="meta">${review.length}</span></button>` : ""}
      ${review.length > 1 ? `<button id="approveAll" ${approveBusy ? "disabled" : ""}>${ico("check", "sm")}${approveBusy ? esc(approveBusy) : tr(approveArm ? "act.approveallsure" : "act.approveall", { n: review.length })}</button>` : ""}
      <button id="toggleMaker" class="${showMaker ? "on" : ""}">${ico("clapper", "sm")}${tr("act.make")}</button>
    </div>
    ${homeFilter === "all" && !showMaker ? (none ? firstHtml() : leadHtml()) : ""}
    ${showMaker ? makerHtml() : ""}
    <div id="queueBox">${queueBoxHtml()}</div>
    ${homeFilter === "all" ? vlogRowHtml() : ""}
    ${none ? "" : `<div class="reeltools">${segBar(counts)}${reelPickBar(R)}${shown.length ? groupBar() : ""}</div>
    ${shown.length ? groupReels(shown).map(groupHtml).join("") : `<div class="reels"><div class="empty mascot" style="grid-column:1/-1">${kenji("point")}<b>${tr("home.emptyfilter")}</b><span>${tr("home.emptyfilterhint")}</span>
        <button data-hf="all" data-rpickclear="1">${tr("st.all")}</button></div></div>`}`}
    ${house.length ? groupHtml({ key: "house", items: house, house: true }, 99) : ""}`;
}
/* ---------- layout pass (18 Nov): Reels filters by theme and network (beside the state filter), and the groups past
   the newest two folded to one line each with their counts and first pictures: 242 reels were a 9-screen stack. ---------- */
let rTheme = "", rNet = "";
const reelOpen = new Set();  // groups opened by hand this visit (past the second, a group starts folded)
const reelPicked = (r) => (!rTheme || r.theme === rTheme) && (!rNet || !!postState(r.slug)[rNet]);
function reelPickBar(R) {
  const own = R.filter((r) => !r.house), ths = [...new Set(own.map((r) => r.theme).filter(Boolean))].sort();
  const nets = POST_NETS.filter((n) => own.some((r) => postState(r.slug)[n]));
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
  return `<div class="rpick"><label><span class="sr-only">${esc(tr("ly_r.theme"))}</span><select data-rpick="theme" class="${rTheme ? "on" : ""}">${opt("", tr("ly_r.alltheme"), !rTheme)}${ths.map((k) => opt(k, themes?.[k]?.title || k, rTheme === k)).join("")}</select></label>
    <label><span class="sr-only">${esc(tr("ly_r.net"))}</span><select data-rpick="net" class="${rNet ? "on" : ""}">${opt("", tr("ly_r.allnet"), !rNet)}${nets.map((n) => opt(n, NET_NAME[n] || n, rNet === n)).join("")}</select></label>
    ${rTheme || rNet ? `<button type="button" class="linkbtn" data-rpickclear="1">${esc(tr("ly_r.clear"))}</button>` : ""}</div>`;
}
document.addEventListener("change", (e) => { const s = e.target.closest?.("[data-rpick]"); if (!s) return; if (s.dataset.rpick === "theme") rTheme = s.value; else rNet = s.value; renderHome(true); });
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-rpickclear]")) { rTheme = ""; rNet = ""; renderHome(true); } });
/* Reels in groups, so 60+ reels are not one long list: by kind of content (each kind has its own colour
   and icon), by stage (what needs a person first), or by the week they were made. Remembered per browser. */
const KINDS = {
  views: { icon: "drone", hue: 198, label: "kind.views" }, stay: { icon: "pin", hue: 28, label: "kind.stay" },
  work: { icon: "phone", hue: 222, label: "kind.work" }, night: { icon: "moon", hue: 262, label: "kind.night" },
  sound: { icon: "volume", hue: 330, label: "kind.sound" }, other: { icon: "film", hue: 150, label: "kind.other" },
};
const THEME_KIND = { aerial: "views", autumn: "views", altitude: "views", seasons: "views", view: "views", winter: "views",
  carstay: "stay", field: "stay", warm: "stay", day: "stay", office: "work", focus: "work", connect: "work", reasons: "work", pov: "work",
  fire: "night", nightfire: "night", lookup: "night", loud: "sound" };
const kindOf = (r) => THEME_KIND[r.theme] || "other";
/* Stages for grouping: "to post" is split into "needs your review" and "approved, ready to post". */
const STAGES = {
  making: { icon: "clapper", hue: 265, label: "st.making" },
  review: { icon: "eye", hue: 35, label: "st.review" }, topost: { icon: "send", hue: 145, label: "grp.ready" },
  scheduled: { icon: "cal", hue: 215, label: "st.scheduled" }, posted: { icon: "check", hue: 135, label: "st.posted" },
  draft: { icon: "hourglass", hue: 30, label: "st.draft" },
  skip: { icon: "x", hue: 0, label: "st.skip" }, house: { icon: "film", hue: 150, label: "st.house" },
};
const stageOf = (r) => { const s = reelState(r); return s === "topost" && r.status === "rendered" ? "review" : s; };
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: keep it for this visit only */ } };
let reelGroup = lsGet("lc.reels.group", "week");  // by day: the newest two days open, the rest one line each
const reelFold = new Set(JSON.parse(lsGet("lc.reels.fold", "[]") || "[]"));
const kTile = (t, cls = "") => `<span class="ktile ${cls}" style="--h:${t.hue}" aria-hidden="true">${ico(t.icon, "sm")}</span>`;
// When a reel was made: being made counts as now (it showed under "January 1970", 14 Nov); never made, no time at all.
const madeAt = (r) => r.updated || (busyJob(r) ? 1e12 : 0);
/* By day for the last week, then last week, then by month. 17 Nov: by week, 216 of 240 reels sat in one "This week"
   group (the studio makes dozens a day), so the grouping divided nothing. */
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function weekKey(r) {
  if (!r.updated && !busyJob(r)) return "wnone";
  const t = (r.updated || Date.now() / 1000) * 1000, days = (Date.now() - t) / 864e5;
  if (days < 7) return `d${localDay(t)}`; if (days < 14) return "w1";
  const d = new Date(t); return `m${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function weekLabel(k) {
  if (k.startsWith("d")) {
    const day = k.slice(1), today = localDay(Date.now()), yest = localDay(Date.now() - 864e5);
    if (day === today) return tr("grp.today"); if (day === yest) return tr("grp.yesterday");
    return new Date(`${day}T12:00:00`).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
  }
  if (k === "w0") return tr("grp.thisweek"); if (k === "w1") return tr("grp.lastweek"); if (k === "wnone") return tr("st.draft");
  const [y, m] = k.slice(1).split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { year: "numeric", month: "long" });
}
function groupReels(list) {
  if (reelGroup === "none") return [{ key: "all", items: list }];
  const by = new Map();
  for (const r of list) {
    const k = reelGroup === "kind" ? kindOf(r) : reelGroup === "stage" ? stageOf(r) : weekKey(r);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  // newest group first, and the newest reels first inside it (the ones being made at the very top)
  // reels being made first, in their place in line (the one rendering now leads); then the newest made
  const newest = (a, b) => madeAt(b) - madeAt(a) || (a.job?.position ?? 0) - (b.job?.position ?? 0);
  if (reelGroup === "week") return [...by.entries()].map(([key, items]) => ({ key, items: [...items].sort(newest) }))
    .sort((a, b) => Math.max(...b.items.map(madeAt)) - Math.max(...a.items.map(madeAt)));
  const order = Object.keys(reelGroup === "kind" ? KINDS : STAGES);
  return order.filter((k) => by.has(k)).map((key) => ({ key, items: by.get(key) }));
}
const reelMore = new Set();
const REELS_SHOWN = 8;  // one row on a desktop (layout pass, 18 Nov); "Show all" opens the rest
/** The first cards of a group, and a button for the rest: 110 reels were one 11,000 px page. */
function groupCards(id, items) {
  const all = reelMore.has(id), shown = all ? items : items.slice(0, REELS_SHOWN);
  return `<div class="reels">${shown.map(reelCard).join("")}</div>${items.length > REELS_SHOWN ? `<button class="rg-more" data-rmore="${esc(id)}" aria-expanded="${all}">${ico(all ? "chev-u" : "plus", "sm")}${tr(all ? "grp.less" : "grp.more", { n: items.length })}</button>` : ""}`;
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-rmore]"); if (!b) return; const id = b.dataset.rmore; reelMore.has(id) ? reelMore.delete(id) : reelMore.add(id); renderHome(true); });
function groupHtml(g, i = 0) {
  if (reelGroup === "none" && !g.house) return groupCards("none", g.items);
  const id = g.house ? "house" : `${reelGroup}:${g.key}`, fold = reelFold.has(id) || (i >= tdOpenGroups() && !reelOpen.has(id));
  const t = g.house ? STAGES.house : reelGroup === "kind" ? KINDS[g.key] : reelGroup === "stage" ? STAGES[g.key] : { icon: "cal", hue: 45 };
  const name = g.house ? tr("st.house") : reelGroup === "week" ? weekLabel(g.key) : tr(t.label);
  // Folded: the group's first pictures on its one line, so a folded day still shows what is in it.
  const thumbs = fold ? `<span class="rg-thumbs" aria-hidden="true">${g.items.slice(0, 8).map((r) => `<i style="background-image:url('${r.hook ? thumb(r.hook, 60) + "&v=" + (r.updated || 0) : ""}')"></i>`).join("")}</span>` : "";
  // What is inside, at a glance: how many need review, are ready, are out.
  const mix = reelGroup === "stage" ? "" : ["review", "topost", "scheduled", "posted"].map((k) => {
    const n = g.items.filter((r) => stageOf(r) === k).length;
    return n ? `<span class="rg-mix" style="--h:${STAGES[k].hue}">${ico(STAGES[k].icon, "sm")}${n} ${esc(tr(STAGES[k].label))}</span>` : "";
  }).join("");
  return `<section class="rgroup${fold ? " folded" : ""}" style="--h:${t.hue}">
    <button class="rg-head" data-rfold="${esc(id)}" data-ri="${i}" aria-expanded="${!fold}">${kTile(t)}<h2>${esc(name)}</h2><span class="rg-n">${tr(g.items.length === 1 ? "grp.n1" : "grp.n", { n: g.items.length })}</span>${mix}<span class="rg-rule"></span>${thumbs}${ico(fold ? "chev-r" : "chev-u", "sm")}</button>
    ${fold ? "" : groupCards(id, g.items)}</section>`;
}
function groupBar() {
  const opts = [["kind", "layers", "grp.kind"], ["stage", "send", "grp.stage"], ["week", "cal", "grp.week"], ["none", "list", "grp.none"]];
  return `<div class="grpbar" role="radiogroup" aria-label="${esc(tr("grp.by"))}"><span class="meta">${tr("grp.by")}</span>${opts.map(([k, i, l]) =>
    `<button role="radio" aria-checked="${reelGroup === k}" class="${reelGroup === k ? "on" : ""}" data-rgroup="${k}">${ico(i, "sm")}${tr(l)}</button>`).join("")}</div>`;
}
document.addEventListener("click", (e) => {
  const g = e.target.closest?.("[data-rgroup]"), f = e.target.closest?.("[data-rfold]");
  if (g) { reelGroup = g.dataset.rgroup; lsSet("lc.reels.group", reelGroup); renderHome(true); return; }
  if (f) {
    const id = f.dataset.rfold, folded = f.getAttribute("aria-expanded") === "false";
    if (folded) { reelFold.delete(id); reelOpen.add(id); } else { reelFold.add(id); reelOpen.delete(id); }
    lsSet("lc.reels.fold", JSON.stringify([...reelFold])); renderHome(true);
  }
});
/* Make reels, in two steps anyone can follow: pick themes (none is picked to start, each with its own colour
   and icon, and a footage badge), then one big button. The rest has safe defaults and sits under
   "More options". Footage problems are said up front, before anything renders. */
const THEME_HUE = { office: 212, carstay: 32, autumn: 18, fire: 4, field: 108, warm: 192, loud: 282, lookup: 238, focus: 160, connect: 330, aerial: 198, reasons: 46, day: 52, seasons: 120, pov: 262, nightfire: 12, altitude: 190 };
const footageOf = (k) => (overview.filmNext || []).find((g) => g.theme === k);
function themePill(k, v) {
  const on = !!autoThemes?.has(k), f = footageOf(k), left = f ? f.left : null;
  const badge = left === 0 ? `<span class="tbadge used" title="${esc(tr("make.nofreshtip", { w: mkNeed(f) }))}">${tr("make.nofresh")}</span>`
    : left != null && left < 1 ? `<span class="tbadge warn" title="${esc(tr("make.lowtip", { w: mkNeed(f) }))}">${tr("make.low", { n: left })}</span>` : "";
  const pill = `<button class="tpill ${on ? "on" : ""}" style="--h:${THEME_HUE[k] ?? 140}" data-auto-theme="${k}" aria-pressed="${on}" title="${esc(v.title)}">
    <span class="tcheck">${ico(on ? "check" : THEME_ICON[k] || "film", "sm")}</span><span class="tname"><b class="clamp" lang="ja">${esc(v.title || k)}${Object.entries(themes || {}).some(([k2, v2]) => k2 !== k && v2.title === v.title) ? ` <small class="meta">(${esc(k)})</small>` : ""}</b></span>${lpaResHtml(k, v)}${badge}</button>`;
  return v.own ? `<span class="tpwrap">${pill}<button class="chip tedit" data-theme-edit="${esc(k)}" title="${esc(tr("th.edit"))}" aria-label="${esc(tr("th.edit"))}: ${esc(k)}">${ico("type", "sm")}</button></span>` : pill;
}
function makerHtml() {
  const keys = Object.keys(themes || {}), n = autoThemes?.size || 0;
  const thin = keys.filter((k) => footageOf(k)?.left === 0);
  const lib = overview.library?.ranch ?? 0;
  const tooLittle = overviewLoaded && lib < 40;
  return `<div class="hero maker">
      <div style="flex:1;min-width:0">
        <h2>${tr("act.make")}</h2>
        <p class="mk-lead">${tr("make.lead")}</p>
        ${tooLittle ? `<p class="warnline">${ico("alert", "sm")} ${tr("make.toolittle", { n: lib })} <button data-goto="footage">${tr("make.addfootage")}</button></p>` : ""}
        <div class="mk-step mk-picks"><span class="mk-num">1</span><b>${tr("make.step1")}</b><span class="meta">${tr("make.picked", { n, of: keys.length })}</span><span class="grow"></span>
          ${keys.length ? `<button class="chip" data-auto-pick="all">${ico("check", "sm")}${tr("make.all")}</button>
          ${thin.length ? `<button class="chip" data-auto-pick="fresh" title="${esc(tr("make.freshtip"))}">${ico("camera", "sm")}${tr("make.fresh")}</button>` : ""}
          <button class="chip" data-auto-pick="none">${ico("x", "sm")}${tr("make.clear")}</button>
          <button class="chip dice" data-auto-pick="dice" title="${esc(tr("make.dicetip"))}"><span class="die" aria-hidden="true">⚄</span>${tr("make.dice")}</button>` : ""}
          <button class="chip" data-theme-new="1">${ico("plus", "sm")}${tr("th.new")}</button>
          ${keys.length ? mkStoriesChip() : ""}${mkIdeasChip()}</div>
        ${themes && !keys.length ? mkStoriesHtml(true)
          : `<div class="tpills lpa-2" role="group" aria-label="${tr("make.themes")}">${themes ? lpaSortThemes(Object.entries(themes)).map(([k, v]) => themePill(k, v)).join("") : `<span class="skel skel-line" style="width:320px"></span>`}</div>${MK.gallery && keys.length ? mkStoriesHtml(false) : ""}`}
        ${foot.h?.more ? `<p class="note">${tr("fh.moreest", { r: moreReels() })} ${tr("fh.morewhy", { c: foot.h.more.cap })}</p>` : ""}
        ${themes && perfView?.features?.theme ? `<p class="note">${esc(tr("lpa_a.r.key"))}</p>` : ""}
        ${thin.length ? `<p class="note">${ico("camera", "sm")} ${tr("make.thinnote", { n: thin.length })} <button class="linkbtn" data-goto="footage">${tr("make.seewhat")}</button></p>` : ""}
        <div class="mk-step"><span class="mk-num">2</span><b>${tr("make.step2")}</b></div>
        ${lpaPresetHtml()}${lpaUseHtml()}${makerEstimate()}
        <button class="primary big" id="autoGo" ${n && sys.health?.verdict !== "blocked" ? "" : "disabled"}>${ico("clapper")}${n ? tr(n === 1 ? "make.go1" : "make.go", { n }) : tr("make.pickfirst")}${autoWaiting ? ` <span class="meta">· ${tr("make.waiting", { n: autoWaiting })}</span>` : ""}</button>
        <details class="mk-more"><summary class="meta">${ico("layers", "sm")} ${tr("make.more")} <span class="meta">· ${esc(tr(autoCut === "long" ? "make.cutlong" : "make.cutshort"))}${autoVary ? " · " + esc(tr("make.vary")) : ""}${autoFaces ? " · " + esc(tr("make.facesshort")) : ""}</span></summary>
          <div class="row" role="radiogroup" aria-label="${esc(tr("make.cut"))}"><span class="meta">${tr("make.cut")}</span>
            <label class="toggle ${autoCut === "short" ? "on" : ""}"><input type="radio" name="autoCut" value="short" ${autoCut === "short" ? "checked" : ""}>${ico("film", "sm")}${tr("make.cutshort")}</label>
            <label class="toggle ${autoCut === "long" ? "on" : ""}"><input type="radio" name="autoCut" value="long" ${autoCut === "long" ? "checked" : ""}>${ico("list", "sm")}${tr("make.cutlong")}</label>
            <span class="meta">${tr(autoCut === "long" ? "make.cutlonghint" : "make.cutshorthint")}</span></div>
          <div class="row">
            <label class="meta" title="${esc(tr("make.varytip"))}"><input type="checkbox" id="autoVary" ${autoVary ? "checked" : ""}> ${tr("make.vary")}</label>
            <label class="meta"><input type="checkbox" id="autoFaces" ${autoFaces ? "checked" : ""}> ${tr("make.faces")}</label>
            <span class="meta">${tr("make.since")}</span>
            <select id="autoDays">${[30, 60, 90, 365].map((d) => `<option value="${d}" ${d === autoDays ? "selected" : ""}>${tr(d === 365 ? "make.year" : "make.days", { n: d })}</option>`).join("")}</select>
            <button id="newReelInline">${ico("plus", "sm")}${tr("act.one")}…</button></div>
        </details>
      </div>
    </div>`;
}

/* The render queue in one panel: how many, total time left and when it finishes, what each one is doing,
   and what went wrong (the last line of the error) with Try again. Stop one or stop all. */
function queueBoxHtml() {
  const failed = overview.reels.some((r) => r.job?.status === "error" && !r.rendered);
  return failed ? queueHtml() : "";
}
function queueHtml() {
  const R = overview.reels;
  const live = R.filter((r) => r.job && ["queued", "running"].includes(r.job.status));
  const failed = R.filter((r) => r.job?.status === "error" && !r.rendered);
  if (!live.length && !failed.length) return "";
  const left = Math.max(0, ...live.map((r) => r.job.eta || 0));
  const run = live.find((r) => r.job.status === "running");
  const order = [...live].sort((a, b) => (a.job.status === "running" ? -1 : b.job.status === "running" ? 1 : (a.job.position || 0) - (b.job.position || 0)));
  const finish = left ? new Date(Date.now() + left * 1000).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const row = (r) => {
    const j = r.job, st = j.status;
    const pill = st === "running" ? mp("clapper", `${tr("q.running")} ${j.pct || 0}%`, "s-scheduled") : st === "queued" ? mp("hourglass", tr("q.queued", { n: j.position }), "") : mp("alert", tr("q.failed"), "bad");
    const err = st === "error" ? esc(plainFail((j.lines || []).filter(Boolean).slice(-1)[0])) : "";
    return `<div class="qrow st-${st}"><span class="mthumb sm" style="background-image:url('${r.hook ? thumb(r.hook, 120) : ""}')"></span>
      <span class="grow" style="min-width:0" title="${esc(r.slug)}${st === "error" ? " · " + esc((j.lines || []).filter(Boolean).slice(-1)[0] || "") : ""}"><b lang="ja" class="clamp">${esc(reelName(r.slug))}</b>${psStrip(r) || `<span class="meta clamp">${st === "error" ? err : esc(jobLabel(j.label))}</span>`}</span>
      ${pill}<span class="meta qeta" title="${esc(j.typical ? tr("c_ps.usual", { t: mmss(j.typical) }) : "")}">${j.eta != null && st !== "error" && j.typical ? mins(j.eta) : ""}</span>
      ${st === "error" ? `<button data-render="${esc(r.slug)}">${ico("refresh", "sm")}${tr("q.retry")}</button>` : j.cancellable ? `<button class="icon" data-cancel="${esc(r.slug)}" title="${tr("job.stop")}" aria-label="${tr("job.stop")}">${ico("x", "sm")}</button>` : ""}</div>`;
  };
  return `<section class="panel queue"><div class="row"><h3>${ico("clapper")} ${tr("q.title")}</h3>
      <span class="mps">${live.length ? mp("film", tr("q.count", { n: live.length }), "s-scheduled") : ""}${left ? mp("clock", tr("q.left", { t: span(left) }), "") : ""}${finish ? mp("cal", tr("q.finish", { t: finish }), "") : ""}${failed.length ? mp("alert", tr("q.errors", { n: failed.length }), "bad") : ""}</span>
      <span class="grow"></span>${live.length > 1 ? `<button data-stopall="1">${ico("x", "sm")}${tr("q.stopall")}</button>` : ""}</div>
    ${run ? `<p class="meta">${tr("q.now", { s: esc(run.slug), l: esc(run.job.label || "") })}</p>` : ""}
    <details class="qlist" ${page === "making" || live.length + failed.length <= 6 ? "open" : ""}><summary class="meta">${tr("q.details")}</summary>${[...failed, ...order].map(row).join("")}</details>
    <p class="meta">${tr("make.keepworking")}</p></section>`;
}
document.addEventListener("click", async (e) => {
  const pk = e.target.closest("[data-auto-pick]");
  if (pk) {
    const keys = Object.keys(themes || {});
    if (pk.dataset.autoPick === "dice") {
      // Surprise me: a random handful of themes (with footage left), a random footage window and cut, variety on.
      const pool = keys.filter((k) => footageOf(k)?.left !== 0);
      const from = pool.length ? pool : keys;
      const n = Math.max(1, Math.min(from.length, 6 + Math.floor(Math.random() * Math.max(1, from.length - 5))));
      autoThemes = new Set([...from].sort(() => Math.random() - 0.5).slice(0, n));
      autoDays = [30, 60, 90, 365][Math.floor(Math.random() * 4)];
      autoCut = Math.random() < 0.75 ? "short" : "long";
      autoVary = true;
      pk.classList.remove("rolled"); void pk.offsetWidth; pk.classList.add("rolled");
      toast(`<span aria-hidden="true">⚄</span> ${esc(tr("make.rolled", { n: autoThemes.size, d: autoDays === 365 ? tr("make.year") : tr("make.days", { n: autoDays }), c: tr(autoCut === "long" ? "make.cutlong" : "make.cutshort") }))}`, 4000);
      return renderHome(true);
    }
    autoThemes = new Set(pk.dataset.autoPick === "all" ? keys : pk.dataset.autoPick === "fresh" ? keys.filter((k) => footageOf(k)?.left !== 0) : []);
    return renderHome(true);
  }
  if (e.target.closest("[data-stopall]")) {
    const live = overview.reels.filter((r) => r.job?.cancellable);
    if (!confirm(tr("q.stopallask", { n: live.length }))) return;
    for (const r of live.slice().reverse()) { try { await post("/api/job/cancel", { slug: r.slug }); } catch { /* already finished */ } }
    toast(`${ico("x", "sm")} ${tr("q.stopped", { n: live.length })}`); loadOverview();
  }
});
/* ---------- the theme editor: a project's own themes (POST /api/themes). Words typed here are this project's
   approved words; the server checks them against the project's own rules and says which field is wrong. ---------- */
let themeEditing = null;
const themeSlug = (s) => String(s || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 24);
/** A theme as a person reads it: the first line of its title (the key, "theme-2", is only the studio's own name for it). */
const themeTitle = (k) => String(themes?.[k]?.title || themes?.[k]?.edit?.hook?.ja || "").split("\n")[0].trim() || k;
function themeLineRow(ja = "", en = "") {
  return `<div class="tline"><input name="lineJa" maxlength="80" value="${esc(ja)}" aria-label="${esc(tr("th.line"))}" placeholder="${esc(tr("th.line"))}">
    <input name="lineEn" maxlength="120" value="${esc(en)}" aria-label="${esc(tr("th.second"))}" placeholder="${esc(tr("th.second"))}">
    <button type="button" class="chip" data-th-rmline="1" aria-label="${esc(tr("th.rmline"))}">${ico("x", "sm")}</button></div>`;
}
function openThemeEditor(key) {
  const t = key ? themes?.[key]?.edit : null;
  if (key && !t) return toast(`${ico("alert", "sm")} ${esc(tr("th.builtin"))}`, 5000);
  themeEditing = key;
  const f = $("#themeForm");
  f.reset();
  $("#themeTitleText").textContent = key ? tr("th.edittitle", { k: themeTitle(key) }) : tr("th.new");
  f.hookJa.value = t?.hook?.ja || ""; f.hookEn.value = t?.hook?.en || "";
  $("#themeLines").innerHTML = (t?.lines?.length ? t.lines : [{}, {}]).map((l) => themeLineRow(l.ja || "", l.en || "")).join("");
  f.shots.value = (t?.shots || []).join("\n");
  // An example in the empty boxes, so a first theme is not a blank page (hints only: nothing is saved from them).
  f.hookJa.placeholder = tr("th.hookph"); f.shots.placeholder = tr("th.shotsph");
  f.tags.value = (t?.tags || []).join(" ");
  f.style.value = t?.style || "column";
  $("#themeDelete").hidden = !key;
  $("#themeErr").hidden = true;
  $("#themeModal").classList.add("on");
  f.hookJa.focus();
}
function closeThemeEditor() { $("#themeModal").classList.remove("on"); themeEditing = null; }
async function saveThemeForm() {
  const f = $("#themeForm");
  const lines = [...f.querySelectorAll(".tline")].map((r) => ({ ja: r.querySelector("[name=lineJa]").value.trim(), en: r.querySelector("[name=lineEn]").value.trim() })).filter((l) => l.ja);
  const theme = { hook: { ja: f.hookJa.value.trim(), en: f.hookEn.value.trim() }, lines,
    shots: f.shots.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), tags: f.tags.value.split(/\s+/).filter(Boolean), style: f.style.value };
  let key = themeEditing;
  if (!key) {
    // Named from the headline in either box: an English headline typed in the first box made "theme", "theme-2"…
    const base = themeSlug(theme.hook.en || theme.hook.ja || theme.lines[0]?.en || theme.lines[0]?.ja || "") || "theme";
    key = base; for (let n = 2; themes && themes[key]; n++) key = `${base.slice(0, 20)}-${n}`;
  }
  const err = $("#themeErr");
  // The one field every theme needs, said in the page's language and with the cursor in it (the server's own check
  // answers "hook: the headline the reel opens with", which reads like a label, not a refusal).
  if (!theme.hook.ja) { err.textContent = tr("th.needhook"); err.hidden = false; f.hookJa.focus(); return; }
  try {
    await post("/api/themes", { key, theme });
    themes = await api("/api/themes");
    themesChanged();
    autoThemes?.add(key);
    closeThemeEditor();
    toast(`${ico("check", "sm")} ${esc(tr("th.saved", { k: themeTitle(key) }))}`, 4000);
    renderHome(true);
  } catch (e2) { err.textContent = e2.message; err.hidden = false; }
}
/* A theme saved or deleted: the badges (overview.filmNext: "no new opening shot") and the footage runway are per theme.
   The server works them out again at once (py/studio/service.py _themes_changed); the page reads them again. */
function themesChanged() { foot.h = null; loadOverview().catch(() => {}); }
document.addEventListener("submit", (e) => { if (e.target.id === "themeForm") { e.preventDefault(); saveThemeForm(); } });
document.addEventListener("click", async (e) => {
  if (e.target.closest("#themeCancel") || e.target === $("#themeModal")) return closeThemeEditor();
  if (e.target.closest("#themeAddLine")) { if ($("#themeLines").children.length < 6) $("#themeLines").insertAdjacentHTML("beforeend", themeLineRow()); return; }
  const rm = e.target.closest("[data-th-rmline]");
  if (rm) return rm.closest(".tline").remove();
  if (e.target.closest("#themeDelete") && themeEditing) {
    const k = themeEditing;
    try { await post("/api/themes/delete", { key: k }); themes = await api("/api/themes"); themesChanged(); autoThemes?.delete(k); closeThemeEditor(); toast(`${ico("check", "sm")} ${esc(tr("th.deleted", { k }))}`, 4000); renderHome(true); }
    catch (e2) { $("#themeErr").textContent = e2.message; $("#themeErr").hidden = false; }
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#themeModal")?.classList.contains("on")) closeThemeEditor(); });

/* Before anything starts: how long it will take on this computer, and whether the disk has room. */
function makerEstimate() {
  const n = autoThemes?.size || 0, h = sys.health;
  if (!n || !h) return "";
  const busy = overview.reels.filter(busyJob).length;
  const total = (n * (autoCut === "long" ? 2.2 : 1) + busy) * (h.buildSeconds || 400);
  const disk = h.checks.find((c) => c.id === "disk");
  const room = /about (\d+) more/.exec(disk?.found || "")?.[1];
  const blocked = h.verdict === "blocked";
  return `<div class="maker-foot">${ico("clock", "sm")}<span>${tr(n === 1 ? "make.eta1" : "make.eta", { n, t: span(total) })}${busy ? ` ${tr("make.ahead", { n: busy })}` : ""} · ${tr(h.buildSecondsSource === "measured" ? "sys.measured" : "sys.estimated")}</span>
    ${room && +room < n ? `<span class="warnline">${ico("alert", "sm")} ${tr("make.noroom", { n: room })}</span>` : ""}
    ${blocked ? `<span class="warnline">${ico("alert", "sm")} ${tr("sys.blockedmsg")} <button data-sysopen="1">${tr("sys.why")}</button></span>` : ""}
    <span class="meta">${tr("make.keepworking")}</span></div>`;
}
const NET_NAME = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", threads: "Threads", x: "X", linkedin: "LinkedIn", "line-voom": "LINE VOOM", "line-oa": "LINE", pinterest: "Pinterest", bluesky: "Bluesky", xiaohongshu: "小红书",
  // Two names the networks write in Japanese themselves (batch D): read in the page's language at each use.
  get "instagram-story"() { return lang === "ja" ? "Instagram ストーリーズ" : "Instagram Story"; },
  get "photo-story"() { return lang === "ja" ? "ストーリーズ（写真投稿）" : "Story (photo post)"; }, get gbp() { return lang === "ja" ? "Google マップ" : "Google Maps"; } };
/* Where a reel is out, in one line: seven squares (one per network) and a sentence. */
function netStrip(r) {
  const st = postState(r.slug);
  const posted = POST_NETS.filter((n) => st[n]?.status === "posted").length;
  const next = POST_NETS.map((n) => st[n] && st[n].status !== "posted" ? { n, ...st[n] } : null).filter(Boolean).sort((a, b) => (a.at || "").localeCompare(b.at || ""))[0];
  const words = next ? `${NET_NAME[next.n]} ${next.at ? whenText(next.at) : ""}` : posted ? tr("card.postedof", { n: posted, of: POST_NETS.filter((n) => !chanOf(n)?.off).length }) : tr("card.notposted");
  const tip = POST_NETS.map((n) => `${NET_NAME[n]}: ${st[n] ? tr(st[n].status === "posted" ? "st.posted" : st[n].status === "scheduled" ? "st.scheduled" : "st.reminder") + (st[n].at ? " " + whenText(st[n].at) : "") : tr("st.notyet")}`).join("\n");
  return `<button class="netsum" data-net="${r.slug}" title="${esc(tip)}" aria-label="${esc(tr("card.netlabel") + ": " + words)}">
    ${POST_NETS.some((n) => st[n]) ? `<span class="sq" aria-hidden="true">${POST_NETS.filter((n) => st[n]).map((n) => netLogo(n, "xs").replace('class="logo-ch xs"', `class="logo-ch xs ${st[n].status || ""}"`)).join("")}</span>` : ""}<span class="nwords">${esc(words)}</span></button>`;
}
function stateLine(r, s) {
  if (s === "topost" && r.status !== "approved") return tr("sub.review");  // made, but nobody has approved it yet
  const st = Object.values(postState(r.slug));
  if (s === "posted") return `${tr("st.posted")} · ${st.filter((p) => p.status === "posted").length}`;
  if (s === "scheduled") { const n = st.filter((p) => p.status !== "posted").sort((a, b) => (a.at || "").localeCompare(b.at || ""))[0]; return n?.at ? whenText(n.at) : tr("st.scheduled"); }
  // "Not posting" said nothing about why (17 Nov): rejected in review, a newer cut made instead, or set aside by hand.
  if (s === "skip") return tr(r.status === "rejected" ? "skip.rejected" : r.status === "reroll" ? "skip.reroll" : "skip.aside");
  return tr(STATE_KEY[s]);
}
function reelCard(r) {
  const s = reelState(r), j = r.job || {};
  const pct = busyJob(r) && j.status === "running" ? Math.round(100 * Math.max(0.03, (j.stage - 1 + 0.5) / j.stages)) : 0;
  // "7 to check" is a way in, not a tooltip: it opens the reel on the first clip to look at.
  const looks = lookChecks(r);
  const flags = looks.length && r.status === "rendered" ? `<button class="checkbtn" data-checks="${esc(r.slug)}" title="${esc(looks.map((c) => `clip ${c.i + 1} ${c.file}: ${c.flags.join(", ")}`).join("\n"))}">${ico("alert", "sm")} ${tr(looks.length === 1 ? "card.check1" : "card.checkn", { n: looks.length })}</button>` : "";
  // A badge on the picture, not a text line: on 17 Nov "faces: consent?" filled most cards and buried what needed
  // doing. Only where the reel can still go out (a rejected, replaced or posted reel has nothing left to decide).
  const consent = r.faces > 0 && !r.consent && !r.blurFaces && !consentAll() && !["skip", "posted", "house"].includes(s)
    ? `<span class="consent-dot" title="${esc(tr("card.consenttip"))}">${ico("user", "sm")}</span>` : "";
  const unreviewed = r.status === "rendered" && !r.house && s !== "making";
  const ready = !r.house && r.rendered && !busyJob(r);
  const vid = !busyJob(r) ? reelVid(r) : "";
  return `<article class="rcard st-${s}" data-open="${r.slug}"${vid ? ` data-vid="${esc(vid)}"` : ""} tabindex="0" role="link" title="${esc(`${r.house ? "★ " : ""}${tr(KINDS[kindOf(r)].label)} · ${r.slug}${r.sameHook > 2 ? " · " + tr("w.samehook", { n: r.sameHook }) : ""}`)}" aria-label="${esc(`${r.title || r.slug} · ${stateLine(r, s)}${unreviewed ? " · " + tr("st.review") : ""}`)}">
    <div class="thumb" style="background-image:url('${r.hook ? thumb(r.hook, 360) + "&v=" + (r.updated || 0) : ""}')">
      <span class="spill s-${s}">${s === "posted" ? ico("check", "sm") : s === "scheduled" ? ico("cal", "sm") : ""}${esc(stateLine(r, s))}</span><span class="chip dur">${r.seconds}s</span>${r.rendered && !busyJob(r) ? scoreBadge(r.slug) : ""}
      ${unreviewed ? `<span class="review-dot" title="${tr("st.review")}">${ico("eye", "sm")}</span>` : ""}${consent}
      ${quickPlayHtml(r)}
      ${busyJob(r) ? `<div class="ring"><div>${ico(j.status === "queued" ? "hourglass" : j.kind === "youtube" ? "send" : "clapper")}<div class="meta live-label" style="margin-top:6px">${esc(j.status === "queued" ? tr("job.queued", { n: j.position }) : j.label || "")}</div>
        ${j.status === "running" ? `<div class="sbar"><i class="live-bar" style="width:${j.pct || pct}%"></i></div>` : ""}
        <div class="meta live-sec eta">${j.eta != null ? `${j.status === "running" ? j.pct + "% · " : ""}${mins(j.eta)}` : j.status === "running" ? `${j.seconds || 0}s` : ""}</div>
        ${j.cancellable ? `<button data-cancel="${esc(r.slug)}" style="margin-top:8px">${ico("x", "sm")}${tr("job.stop")}</button>` : ""}</div></div>` : ""}
      ${r.job?.status === "error" ? `<div class="ring"><div class="meta" style="color:var(--bad)" title="${esc((j.lines || []).slice(-1)[0] || "")}">${ico("alert")}<br>${esc(plainFail((j.lines || []).slice(-1)[0]))}</div></div>` : ""}
    </div>
    <div class="body">
      <div class="t clamp" lang="ja">${esc(r.title || r.slug)}</div>
      ${flags ? `<div class="meta row-tight">${flags}</div>` : ""}
      ${wordsLine(r)}
      ${r.rendered && !r.house ? netStrip(r) : ""}
      ${s === "draft" ? `<div class="card-acts"><button class="go" data-render="${esc(r.slug)}">${ico("clapper", "sm")}${tr("act.makeit")}</button></div>` : ""}
      ${ready ? `<div class="card-acts">
        <button class="go ${unreviewed ? "review" : ""}" data-go="${esc(r.slug)}">${ico(unreviewed ? "eye" : "send", "sm")}${tr(unreviewed ? "act.reviewone" : "act.post")}</button>
        <button class="mini" data-remake="${esc(r.theme || "")}" title="${esc(tr("act.newversiontip"))}">${ico("refresh", "sm")}${tr("act.newversion")}</button>
        <button class="mini" data-alt="${esc(r.slug)}" title="${esc(tr("act.openingtip"))}">${ico("clapper", "sm")}${tr("act.opening")}</button>
        <button class="mini ${isSkipped(r.slug) ? "on" : ""}" data-skip="${r.slug}">${ico("x", "sm")}${tr(isSkipped(r.slug) ? "act.unskip" : "act.skip")}</button></div>` : ""}
    </div></article>`;
}

/* What a reel says, against the others: new words waiting for a render, the same words as another reel, or a much-used headline. */
function wordsLine(r) {
  if (r.house || busyJob(r)) return "";
  if (r.wordsPending) return `<div class="meta row-tight words-line"><span class="w-new">${ico("type", "sm")} ${tr("w.pending")}</span><button class="linkbtn" data-render="${esc(r.slug)}">${tr("w.rendernow")}</button></div>`;
  if (r.sameWords > 0) return `<div class="meta row-tight words-line"><span class="warnline" title="${esc(r.hookText || "")}">${ico("alert", "sm")} ${tr("w.same", { n: r.sameWords })}</span><button class="linkbtn" data-reword="${esc(r.slug)}">${tr("w.reword")}</button></div>`;
  return "";
}
/* Posting: one row per reel, one square per network. */
/* Posting health: one chip per network that says how it gets posted and whether anything needs a person. */
function healthStrip() {
  const DAY = 864e5, now = Date.now();
  let needs = 0;
  const chips = POST_NETS.filter((n) => !chanOf(n)?.off).map((n) => {
    const c = connections[n === "youtube" ? "youtube" : n];
    const out = postsLog.filter((p) => p.network === n && (p.status === "posted" || p.status === "scheduled" || p.status === "queued") && p.at);
    const next = out.filter((p) => new Date(p.at).getTime() > now).map((p) => p.at).sort()[0];
    const last = out.filter((p) => new Date(p.at).getTime() <= now).map((p) => p.at).sort().pop();
    const lastTxt = next ? tr("hl.next", { t: whenText(next) }) : last ? tr("hl.last", { t: whenText(last) }) : tr("hl.none");
    let cls = "hand", label = tr("hl.helper"), go = "";
    const attention = () => { if (go) needs++; };
    if (n === "youtube") { cls = yt.connected ? "ok" : "todo"; label = yt.connected ? tr("hl.studio") : tr("hl.connect"); go = yt.connected ? "" : "accounts"; }
    else if (c?.connected && c.until && new Date(c.until).getTime() - now < 3 * DAY) { cls = "warn"; label = tr("hl.soon"); go = "accounts"; }
    else if (c?.connected) { cls = "ok"; label = tr("hl.studio"); }
    else if (c?.error) { cls = "bad"; label = tr("hl.fix"); go = "accounts"; }
    else if (c) { cls = "todo"; label = tr("hl.connect"); go = "accounts"; }
    const newest = postsLog.filter((p) => p.network === n).sort((x, y) => (y.id || 0) - (x.id || 0))[0];  // a token that died shows up as a refused post
    if (newest?.status === "failed" && /expired|revoked|connect \S+ again/i.test(newest.note || "")) { cls = "bad"; label = tr("hl.fix"); go = "accounts"; }
    attention();
    return `<${go ? `button data-goto="${go}"` : "span"} class="hchip h-${cls}" title="${esc(c?.error || lastTxt)}">${netLogo(n, "sm")}<span><b>${esc(NET_NAME[n] || n)}</b><span class="meta">${label} · ${lastTxt}</span></span></${go ? "button" : "span"}>`;
  });
  const open = hsOpen ?? needs > 0;
  return `<details class="pfold hfold" ${open ? "open" : ""}><summary>${tr("hl.sum", { n: chips.length })}${needs ? ` · <span class="warnline">${tr(needs === 1 ? "hl.attn1" : "hl.attn", { n: needs })}</span>` : ""}</summary><div class="hstrip" role="list" aria-label="${esc(tr("hl.title"))}">${chips.join("")}</div></details>`;
}
/* Posting in three tabs (#/posting/<tab>[/<network>]): what goes out and when, every reel against every network,
   and what has gone out. Each list is short by default: days fold after the first week, tables come 20 rows at a time. */
let postView = (() => { try { return localStorage.getItem("lc.post.view2") || "lanes"; } catch { return "lanes"; } })();  // Week (lanes) is the first view; Month and List stay
let postTab = "schedule", postNet = "all", postQ = "", postPage = 0, postFocus = false, postSeen = "all", postTimer = null, hsOpen = null;
/* Track C (24 Nov): each schedule view's address word, and back. */
const TC_POST_VIEWS = { week: "lanes", calendar: "cal", list: "days" };
const tcViewSlug = (v) => Object.keys(TC_POST_VIEWS).find((k) => TC_POST_VIEWS[k] === v) || "week";
/* Posting › List, three days at a time with a pager (Track C, 24 Nov: seven open days ran 3.9 screens; owner: no long
   pages). The first page is today and the next two days; ‹ › walk on, and the count says how far the list goes. */
let tcListPage = 0;
function tcListHtml(all, dayCard) {
  if (!all.length) return `<p class="note">${tr("posting.none")}</p>`;
  const per = 3, pages = Math.ceil(all.length / per);
  tcListPage = Math.max(0, Math.min(tcListPage, pages - 1));
  const shown = all.slice(tcListPage * per, tcListPage * per + per), n = shown.reduce((a, [, ps]) => a + ps.length, 0);
  const day = (d) => postDayLabel(d).replace(/^.* · /, "");
  const pager = pages < 2 ? "" : `<div class="pager tc-lpager"><button data-tclist="${tcListPage - 1}" ${tcListPage ? "" : "disabled"} aria-label="${esc(tr("tc.list.prev"))}" title="${esc(tr("tc.list.prev"))}">${ico("chev-l", "sm")}</button>
    <span class="meta">${esc(tr("tc.list.page", { a: day(shown[0][0]), b: day(shown[shown.length - 1][0]), n, i: tcListPage + 1, m: pages }))}</span>
    <button data-tclist="${tcListPage + 1}" ${tcListPage < pages - 1 ? "" : "disabled"} aria-label="${esc(tr("tc.list.next"))}" title="${esc(tr("tc.list.next"))}">${ico("chev-r", "sm")}</button>
    ${tcListPage ? `<button data-tclist="0">${esc(tr("cal.today"))}</button>` : ""}</div>`;
  return `${pager}<div class="pdays">${shown.map(dayCard).join("")}</div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-tclist]"); if (!b || b.disabled) return;
  tcListPage = Math.max(0, +b.dataset.tclist || 0); renderHome(true);
});
/** A booking at one of its network's other listed hours (channels.json postTimesJst; the usual one is 19:00 when listed,
    else the first: server/autoplan.mjs postSlots): the hour test that Results › Best time compares (BL-102, BL-109).
    Returns the usual hour, or "" when it is not a test. */
function tcTestHour(p) {
  const hours = [...new Set((chanOf(p?.network)?.postTimesJst || []).filter((h) => /^\d{2}:\d{2}$/.test(h)))];
  if (hours.length < 2 || !p?.at) return "";
  const usual = hours.includes("19:00") ? "19:00" : hours[0];
  const hm = new Date(p.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
  return hm !== usual && hours.includes(hm) ? usual : "";
}
const POST_PAGE = 20;
function postPager(total, size = POST_PAGE) {
  const pages = Math.max(1, Math.ceil(total / size)); postPage = Math.min(postPage, pages - 1);
  return pages < 2 ? "" : `<div class="pager"><button data-ppage="${postPage - 1}" ${postPage ? "" : "disabled"} aria-label="${esc(tr("posting.prev"))}">${ico("chev-l", "sm")}</button><span class="meta">${tr("log.page", { i: postPage + 1, n: pages, t: total })}</span><button data-ppage="${postPage + 1}" ${postPage < pages - 1 ? "" : "disabled"} aria-label="${esc(tr("posting.next"))}">${ico("chev-r", "sm")}</button></div>`;
}
/* One button per network that has something in this list, with its count; a link, so Back and sharing work. */
function postNetBar(list) {
  const nets = [...new Set(list.map((p) => p.network))].sort((a, b) => POST_NETS.indexOf(a) - POST_NETS.indexOf(b));
  if (nets.length < 2 && postNet === "all") return "";
  const tab = postTab === "schedule" ? tcViewSlug(postView) : postTab;  // a network inside Week/Calendar/List keeps the view
  const link = (key, label, n) => `<a class="${postNet === key ? "on" : ""}" aria-current="${postNet === key}" href="#/posting/${tab}${key === "all" ? "" : "/" + key}">${label}<span>${n}</span></a>`;
  return `<div class="pnets" role="toolbar" aria-label="${esc(tr("posting.bynet"))}">${link("all", esc(tr("st.all")), list.length)}${nets.map((n) => link(n, `${netLogo(chOf(n), "sm")}${esc(NET_NAME[n] || n)}`, list.filter((p) => p.network === n).length)).join("")}</div>`;
}
function postDayLabel(day) {
  const today = wallOf(Date.now()).slice(0, 10), text = new Date(day + "T12:00Z").toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return day === today ? `${tr("posting.today")} · ${text}` : day === nextDay(today) ? `${tr("posting.tomorrow")} · ${text}` : text;
}
function loadingHtml(what) {
  // A 1997 "Please wait" window (16 Nov): the line in a small silver window with a block bar that runs while it waits.
  return `<div class="loading-block w9win w9wait" role="status" aria-live="polite"><div class="w9title"><img src="/brand/icon-16.png" alt="" width="16" height="16"><b>${esc(tr("wait.title"))}</b></div>
    <div class="w9waitbody"><span class="w9hour" aria-hidden="true">⌛</span><span>${esc(postsFailed ? tr("load.retry") : tr("load.wait", { w: what }))}</span><span class="w9bar sm run"><i></i></span></div></div>
    <div class="skel"><i></i><i></i><i></i></div>`;
}
/* ---------- Runs by itself (GET /api/autopost; py/studio/live.py settings, server/autoplan.mjs rules) ----------
   Every switch the studio uses when nobody is looking, when each part last ran, what it could not do, and the
   posts that need a person: not found after their time, or refused. */
let autoView = null, autoLoading = false, autoPreview = null;
// The person's own choice of open or folded wins for this visit; until then it opens only when something needs them.
let autoOpen = (() => { try { const v = sessionStorage.getItem("lc.auto.open"); return v === null ? null : v === "1"; } catch { return null; } })();
document.addEventListener("toggle", (e) => {
  if (!e.target.matches?.("[data-autofold]")) return;
  autoOpen = e.target.open;
  try { sessionStorage.setItem("lc.auto.open", autoOpen ? "1" : "0"); } catch { /* private window */ }
}, true);
async function loadAuto() {
  if (autoLoading) return; autoLoading = true;
  try { autoView = await api("/api/autopost"); signinNews(autoView.runs?.health?.items || []); } catch { /* the panel waits for the next load */ }
  autoLoading = false; if (page === "posting" || page === "keys") renderHome(true);
}
/* A sign-in that stopped (or stops soon) rings the bell once a day per network. */
function signinNews(items) {
  // Track C (24 Nov): a sign-in is a problem, shown once in Needs you (Sign-ins); the bell stays news only.
  if (items) return;
  const day = new Date().toLocaleDateString("sv");
  for (const it of items.filter((x) => x.level !== "ok")) {
    const k = `lc.signin.${it.network}.${day}`;
    if (lsGet(k, "")) continue;
    lsSet(k, "1");
    addNews(it.level === "bad" ? "bad" : "info", tr("news.signin", { n: NET_NAME[it.network] || it.network, f: it.found }), "#/accounts");
  }
}
/* The same rule as the server's "Posts that did not go out" (server/problems.mjs #2), so "Needs a look (N)" here and
   Needs you count the same posts: not out in the last two weeks, unless booked again on that network since (Track C,
   24 Nov: a Bluesky post booked again as row 343 stayed in "Needs a look" after Needs you had dropped it). */
const autoNeedsLook = () => {
  const now = Date.now(), holds = ["scheduled", "queued", "posted"];
  return postsLog.filter((p) => {
    const t = p.at ? new Date(p.at).getTime() : NaN;
    if (p.network === "all" || !["failed", "missed", "missing"].includes(p.status) || !(t > now - 14 * 864e5) || t > now) return false;
    return !postsLog.some((o) => o !== p && o.slug === p.slug && o.network === p.network && holds.includes(o.status) && new Date(o.at).getTime() >= t);
  });
};
/* part "attention": what needs a person (a post not seen live, a sign-in to renew), shown first on Posting; no
   part: the settings, folded unless opened (it used to open itself, with the one thing to do at its bottom). */
function autoHtml(part = "") {
  const v = autoView;
  if (!v) { loadAuto(); return ""; }
  const s = v.settings, runs = v.runs || {}, plan = runs.plan, check = runs.check, health = runs.health;
  const val = (path) => { const [g, k] = path.split("."); return s[g][k]; };
  const box = (path, label) => `<label class="sb-auto"><input type="checkbox" data-auto="${path}" ${val(path) ? "checked" : ""}> ${label}</label>`;
  const num = (path, label, min, max) => `<label class="ab-num"><span>${label}</span><input type="number" inputmode="numeric" data-auto-num="${path}" value="${esc(val(path))}" min="${min}" max="${max}"></label>`;
  const when = (r) => (r?.when ? ago(r.when) : "");
  const netName = (n) => esc(NET_NAME[n] || n);
  const chips = v.networks.map((n) => { const on = !s.plan.networks.length || s.plan.networks.includes(n);
    return `<button class="chip ${on ? "on" : ""}" aria-pressed="${on}" data-auto-net="${esc(n)}">${netLogo(chOf(n), "sm")}${netName(n)}</button>`; }).join("");
  const planLine = plan ? [tr("ab.lastplan", { t: when(plan), n: plan.booked || 0 }), plan.refused?.length ? tr("ab.notbooked", { n: plan.refused.length }) : "",
    plan.open ? tr("ab.openslots", { n: plan.open }) : "", plan.waiting?.length ? tr("ab.waitchrome", { list: plan.waiting.map((n) => NET_NAME[n] || n).join(", ") }) : ""].filter(Boolean).join(" · ") : tr("ab.never");
  const bad = (health?.items || []).filter((x) => x.level !== "ok");
  const look = autoNeedsLook();
  const short = (at) => (at ? esc(whenText(at)) : "");
  // Track C (24 Nov): one row per booking in columns (when · where · the reel's headline · test hour), not text that
  // wrapped one word a line in .stalebox's 3.2em column; and the networks it skips because nobody sees them, said once.
  const paused = (autoPreview?.skipped || []).filter((x) => x.stalled).map((x) => NET_NAME[x.network] || x.network);
  const prev = autoPreview ? `${autoPreview.plan?.length
    ? `<div class="ab-prev"><b>${tr("ab.prevh", { n: autoPreview.plan.length })}</b><ul class="tc-prev">${autoPreview.plan.map((p) => `<li><span class="tc-prev-at">${short(p.at)}</span><span class="tc-prev-net">${netLogo(chOf(p.network), "sm")}${netName(p.network)}</span><span class="tc-prev-h" lang="ja" title="${esc(p.slug)}">${esc(reelName(p.slug))}</span>${p.test === "hour" ? `<span class="tc-test" title="${esc(tr("tc.testwhy", { h: p.usual || "19:00" }))}">${esc(tr("tc.test"))}</span>` : "<span></span>"}</li>`).join("")}</ul></div>`
    : `<p class="meta">${tr("ab.prevnone")}</p>`}${paused.length ? `<p class="meta tc-paused">${ico("alert", "sm")} ${esc(tr("tc.prev.paused", { list: paused.join(", ") }))}</p>` : ""}` : "";
  const needs = look.length || bad.length || (plan?.refused?.length || 0) > 0;
  const open = autoOpen ?? false;
  if (part === "attention") return `${bad.length ? `<ul class="ab-health">${bad.map((x) => `<li class="h-${esc(x.level)}">${netLogo(chOf(x.network), "sm")}<b>${netName(x.network)}</b><span>${esc(x.found)}</span>${x.fix ? `<button data-goto="accounts">${esc(x.fix)}</button>` : ""}</li>`).join("")}</ul>` : ""}${look.length ? `<div class="ab-look"><b>${ico("alert", "sm")} ${tr("ab.look", { n: look.length })}</b><ul>${look.map((p) => `<li>${netLogo(chOf(p.network), "sm")}<span class="grow"><b lang="ja" title="${esc(p.slug)}">${esc(reelName(p.slug))}</b> <span class="meta">${netName(p.network)} · ${short(p.at)} · ${tr(p.status === "missing" ? "st.missing" : "log.failed")}: ${esc(String(p.note || "").split(" · ").pop().replace(/^not found\s*/i, "").slice(0, 160))}</span></span>
      <button data-net="${esc(p.slug)}" data-ch="${esc(chOf(p.network))}">${tr("ab.again")}</button>${p.status === "missing" ? `<button data-auto-out="${p.id}">${tr("ab.isout")}</button>` : ""}<button data-auto-aside="${p.id}">${tr("ab.aside")}</button></li>`).join("")}</ul></div>` : ""}`;
  const sum = [s.plan.on ? tr("ab.sumplan", { t: plan?.when ? when(plan) : tr("ab.never") }) : tr("ab.sumoff"),
    check?.when ? tr("ab.sumcheck", { t: when(check), n: check.seen || 0 }) : "", look.length ? tr("ab.look", { n: look.length }) : ""].filter(Boolean).join(" · ");
  return `<details class="stalebox autobox" ${open ? "open" : ""} data-autofold="1" aria-label="${esc(tr("ab.h"))}">
    <summary class="ab-sum"><b>${tr("ab.h")}</b><span class="meta ${needs ? "bad" : ""}">${esc(sum)}</span></summary>
    <div class="sb-head">
      <span class="ab-acts"><button data-auto-run="check" ${v.checking ? "disabled" : ""}>${ico("refresh", "sm")}${tr(v.checking ? "ab.checking" : "ab.checknow")}</button>
      <button data-auto-run="preview">${ico("eye", "sm")}${tr("ab.preview")}</button>
      <button class="primary" data-auto-run="plan" ${v.planning ? "disabled" : ""}>${ico("cal", "sm")}${tr(v.planning ? "ab.running" : "ab.booknow")}</button></span></div>
    <ul class="ab-list">
      <li>${box("plan.on", tr("ab.plan"))}<span class="ab-opts">${num("plan.hour", tr("ab.hour"), 0, 23)}${num("plan.aheadDays", tr("ab.ahead"), 1, 60)}${num("plan.tiktokAheadDays", tr("ab.tiktok"), 1, 10)}${num("plan.tiktokPerDay", tr("ab.tiktokday"), 1, 4)}</span><span class="meta">${planLine}</span></li>
      <li class="ab-nets" role="group" aria-label="${esc(tr("ab.nets"))}">${chips}</li>
      <li>${box("verify.on", tr("ab.verify"))}<span class="ab-opts">${num("verify.missingAfterH", tr("ab.after"), 1, 72)}</span><span class="meta">${check ? tr("ab.lastcheck", { t: when(check), n: check.seen || 0 }) : tr("ab.never")}</span></li>
      <li>${box("catchUp.on", tr("ab.catch"))}<span class="ab-opts">${num("catchUp.graceH", tr("ab.grace"), 0, 48)}</span></li>
      <li>${box("tidy.on", tr("ab.tidy"))}</li>
      ${staleView ? `<li><label class="sb-auto"><input type="checkbox" data-autoreplace ${staleView.on ? "checked" : ""}> ${tr("stl.auto")}</label></li>` : ""}
      <li>${box("health.on", tr("ab.health"))}<span class="meta">${health ? when(health) : ""}</span></li>
      <li>${v.startup?.other ? `<span class="meta">${ico("info", "sm")} ${tr("ab.startupother")}</span>` : v.startup?.supported ? `<label class="sb-auto"><input type="checkbox" data-startup ${v.startup.on ? "checked" : ""}> ${tr("ab.startup")}</label>` : `<span class="meta">${esc(v.startup?.why || "")}</span>`}</li>
    </ul>
    ${v.waiting?.length ? `<p class="meta">${tr("ab.unseen", { n: v.waiting.length })}</p>` : ""}
    ${plan?.refused?.length ? `<details class="pfold"><summary>${tr("ab.notbooked", { n: plan.refused.length })}</summary><ul class="ab-prev">${plan.refused.map((x) => `<li>${short(x.at)} · ${netName(x.network)} · ${esc(x.slug)}: <span class="meta">${esc(x.why)}</span></li>`).join("")}</ul></details>` : ""}
    ${prev}
  </details>`;
}
async function autoSet(set) {
  try { autoView = { ...autoView, ...(await post("/api/autopost", { set })) }; toast(`${ico("check", "sm")} ${tr("ab.saved")}`, 2500); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  loadAuto();
}
document.addEventListener("change", async (e) => {
  const box = e.target.closest("[data-auto]"), n = e.target.closest("[data-auto-num]"), st = e.target.closest("[data-startup]");
  if (box) { const [g, k] = box.dataset.auto.split("."); return autoSet({ [g]: { [k]: box.checked } }); }
  if (n) {
    const [g, k] = n.dataset.autoNum.split("."); const v = Number(n.value);
    // Out of range or not a whole number: say so and show the saved value again (it was ignored without a word, or
    // answered with the setting's internal name, "plan.aheadDays: from 1 to 60").
    if (n.value.trim() === "" || !Number.isInteger(v) || v < Number(n.min) || v > Number(n.max)) { toast(`${ico("alert", "sm")} ${esc(tr("ab.range", { a: n.min, b: n.max }))}`, 5000); loadAuto(); return; }
    return autoSet({ [g]: { [k]: v } });
  }
  if (st) {
    try { await post("/api/autopost/startup", { on: st.checked }); toast(`${ico("check", "sm")} ${tr("ab.saved")}`, 2500); }
    catch (err) { st.checked = !st.checked; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    loadAuto();
  }
});
document.addEventListener("click", async (e) => {
  const net = e.target.closest("[data-auto-net]"), run = e.target.closest("[data-auto-run]"), out = e.target.closest("[data-auto-out]"), aside = e.target.closest("[data-auto-aside]");
  if (net && autoView) {
    const all = autoView.networks, cur = autoView.settings.plan.networks.length ? autoView.settings.plan.networks : all;
    let next = cur.includes(net.dataset.autoNet) ? cur.filter((x) => x !== net.dataset.autoNet) : [...cur, net.dataset.autoNet];
    if (!next.length) return;  // at least one network; switching Plan off is the box above
    if (next.length === all.length) next = [];  // all = follow every network, new ones included
    return autoSet({ plan: { networks: next } });
  }
  if (run) {
    const what = run.dataset.autoRun; run.disabled = true;
    try {
      const r = await post("/api/autopost/run", { what });
      if (what === "preview") autoPreview = r;
      else if (what === "plan") toast(`${ico("cal", "sm")} ${tr("ab.started")}`, 6000);
      else toast(`${ico("check", "sm")} ${tr("ab.checked", { n: r.check?.seen?.length || 0, m: r.check?.missing?.length || 0 })}`, 6000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    loadAuto(); if (what !== "preview") pollPosts();
    return;
  }
  if (out || aside) {
    try { await post("/api/autopost/post", { id: Number((out || aside).dataset[out ? "autoOut" : "autoAside"]), action: out ? "out" : "aside" }); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    pollPosts(); loadAuto();
  }
});
