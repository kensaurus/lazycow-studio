/* ---------- One console for every video type (owner, 27 Nov 2026: "the user should be able to create and see the
   different video type in a single console and how they are doing and posting"). Reels shows every kind together:
   a type filter row (reels, site walks, explainers, long cuts, long videos, photo posts), a type chip and the key
   numbers on each card (YouTube views and the share kept, Instagram plays, from /api/perf/table), the networks it is
   out on as links, and New video (a type picker). Explainers have their own page, #/explainer/<slug>: the script
   library on the left, one script on the right (its video or preview still, the JSON with its checks, Save & render),
   master–detail so nothing scrolls past a screen. Their review, the daily plan, posting and Results are the reels' own
   (py/studio/explainer.py); approving stays in Review. State is `var` (a render can run before this part loads). ---------- */
var VX_TYPES = ["all", "reel", "walk", "explainer", "long", "vlog", "photo"];
var VX_ICON = { all: "grid", reel: "film", walk: "camera", explainer: "info", long: "list", vlog: "play", photo: "image" };
var vxSel = (() => { try { const v = localStorage.getItem("lc.vx.type"); return VX_TYPES.includes(v) ? v : "all"; } catch { return "all"; } })();
var vxNewOpen = false, vxPerf = null, vxPerfAt = 0;

/** What kind of video a reel record is: the overview's own word (py/studio/service.py video_type), else from its cut. */
function vxType(r) {
  if (r?.type) return r.type;
  return r?.variant === "site-walk" ? "walk" : r?.variant === "b-explainer" ? "long" : "reel";
}
/** How many of each type: reel records by vxType (house reels are not counted, as everywhere), long videos and photo
    posts by their own lists. "all" is every reel record the grid can show. */
function vxCounts(reels, vlogs = 0, photos = 0) {
  const c = { all: 0, reel: 0, walk: 0, explainer: 0, long: 0, vlog: vlogs, photo: photos };
  for (const r of reels || []) { if (r.house) continue; const t = vxType(r); c[t] = (c[t] || 0) + 1; c.all++; }
  return c;
}
/** Reel records of one type ("all": every one). Long videos and photo posts are not reel records: their own lists. */
function vxFilter(reels, type) {
  return (reels || []).filter((r) => type === "all" || vxType(r) === type);
}
/** Each reel's key numbers from Results' rows (GET /api/perf/table): YouTube views, engaged views and the share kept
    (engaged ÷ views, %; py/studio/perf.py kept_share), Instagram plays. A post swapped for a newer render (retired) is
    left out, as Results does. {slug: {yt?: {views, engaged, kept}, ig?: {plays}}} */
function vxNumbers(rows) {
  const out = {};
  for (const x of rows || []) {
    if (!x || x.retired || !x.slug) continue;
    const o = out[x.slug] || (out[x.slug] = {});
    if (x.network === "youtube") {
      const y = o.yt || (o.yt = { views: 0, engaged: 0, seen: false });
      y.views += Number(x.views) || 0;
      if (Number.isFinite(x.engaged)) { y.engaged += x.engaged; y.seen = true; }
    } else if (x.network === "instagram") {
      const g = o.ig || (o.ig = { plays: 0 });
      g.plays += Number(x.views) || 0;
    }
  }
  for (const o of Object.values(out)) if (o.yt) { o.yt.kept = o.yt.seen && o.yt.views > 0 ? Math.round((100 * o.yt.engaged) / o.yt.views) : null; delete o.yt.seen; }
  return out;
}
function vxLoadPerf() {
  if (Date.now() - vxPerfAt < 10 * 60e3) return;
  vxPerfAt = Date.now();
  api("/api/perf/table?days=365").then((v) => { vxPerf = vxNumbers(v?.rows); if (page === "reels" && atHome()) renderHome(true); }).catch(() => { vxPerf = vxPerf || {}; });
}
const vxNum = (n) => Number(n || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB");
/** The type chip on a card's picture. */
function vxChip(r) {
  const t = vxType(r);
  return `<span class="chip vxchip vx-${t}" title="${esc(tr(`vx.one.${t}`))}">${ico(VX_ICON[t], "sm")}${esc(tr(`vx.one.${t}`))}</span>`;
}
/** How it is doing: YouTube views and the share kept, Instagram plays; with links, one per network it went out on (the
    card's network strip already shows where it is booked and out, so cards leave the links off). */
function vxNumHtml(r, links = false) {
  const n = vxPerf?.[r.slug], st = postState(r.slug);
  const out = links ? POST_NETS.filter((k) => st[k]?.status === "posted" && st[k].url) : [];
  const nums = [n?.yt ? `<span title="${esc(tr("vx.kepttip"))}">${ico("play", "sm")}${esc(tr("vx.yt", { n: vxNum(n.yt.views) }))}${n.yt.kept != null ? ` · <b>${esc(tr("vx.kept", { n: n.yt.kept }))}</b>` : ""}</span>` : "",
    n?.ig ? `<span>${ico("image", "sm")}${esc(tr("vx.ig", { n: vxNum(n.ig.plays) }))}</span>` : ""].filter(Boolean);
  if (!nums.length && !out.length) return "";
  return `<div class="vxnum meta">${nums.join("")}${out.length ? `<span class="vxlinks" aria-label="${esc(tr("vx.outon"))}">${out.map((k) => `<a href="${escUrl(st[k].url)}" target="_blank" rel="noopener" title="${esc(NET_NAME[k] || k)}">${netLogo(k, "xs")}</a>`).join("")}</span>` : ""}</div>`;
}
/** The type filter row: one button per type with its count. */
function vxTypeBar(R) {
  // Long videos and photo posts are counted from their own lists: read them once, then draw the counts.
  if (!phView && !phLoading) loadPhotos().then(() => { if (page === "reels" && atHome()) renderHome(true); });
  if (!vlogView && !vlogLoading) loadVlogs();
  const c = vxCounts(R, (vlogView?.parts || []).filter((p) => p.built).length, (phView?.sets || []).length);
  return `<div class="vxtypes" role="radiogroup" aria-label="${esc(tr("vx.types"))}">${VX_TYPES.map((t) =>
    `<button role="radio" aria-checked="${vxSel === t}" class="${vxSel === t ? "on" : ""}${c[t] ? "" : " zero"}" data-vxtype="${t}">${ico(VX_ICON[t], "sm")}${esc(tr(t === "all" ? "vx.all" : `vx.${t}`))}<span class="n">${c[t] ?? 0}</span></button>`).join("")}</div>`;
}
/** New video: what to make, in plain words. Reel and site walk open Make reels with that cut; the rest open their page. */
function vxNewHtml() {
  if (!vxNewOpen) return "";
  return `<section class="vxnew panel" aria-label="${esc(tr("vx.newh"))}"><h3>${esc(tr("vx.newh"))}</h3><div class="vxnew-grid">${["reel", "walk", "explainer", "vlog", "photo"].map((t) =>
    `<button class="vxpick vx-${t}" data-vxmake="${t}">${ico(VX_ICON[t])}<b>${esc(tr(`vx.one.${t}`))}</b><span class="meta">${esc(tr(`vx.new.${t}`))}</span></button>`).join("")}</div></section>`;
}
/** Long videos and photo posts in the console: one tile each, opening their own page. */
function vxOtherHtml() {
  if (vxSel === "vlog") {
    if (!vlogView && !vlogLoading) loadVlogs();
    const built = (vlogView?.parts || []).filter((p) => p.built);
    if (!built.length) return vxEmptyHtml();
    return `<div class="reels vxother">${built.map((p) => `<a class="rcard vxtile" href="#/videos" data-vlopen="${p.n}">
      <div class="thumb wide" style="background-image:url('/api/vlogs/file?n=${p.n}&kind=thumb&v=${encodeURIComponent(p.built.made || "")}')">${vxChip({ type: "vlog" })}<span class="chip dur">${mmss(p.built.seconds)}</span></div>
      <div class="body"><div class="t clamp">${esc(p.title)}</div><div class="meta">${esc(tr("vid.part", { n: p.n }))}</div></div></a>`).join("")}</div>`;
  }
  if (!phView && !phLoading) loadPhotos();
  const sets = phView?.sets || [];
  if (!sets.length) return phView ? vxEmptyHtml() : loadingHtml(tr("vx.photo"));
  return `<div class="reels vxother">${sets.slice(0, 24).map((x) => `<a class="rcard vxtile" href="#/photos" data-vxphoto="${esc(x.id)}">
    <div class="thumb" style="background-image:url('${phFile(x, x.slides[0])}')">${vxChip({ type: "photo" })}<span class="spill s-${x.storyPosted ? "posted" : x.storyQueued ? "scheduled" : "topost"}">${esc(tr(x.storyPosted ? "st.posted" : x.storyQueued ? "st.scheduled" : "st.topost"))}</span></div>
    <div class="body"><div class="t clamp">${esc(lang === "ja" ? x.styleJa : x.styleEn)} · ${esc(lang === "ja" ? x.themeJa : x.themeEn)}</div><div class="meta">${esc(tr("ph.slides", { n: x.panels }))}</div></div></a>`).join("")}</div>`;
}
function vxEmptyHtml() {
  return `<div class="reels"><div class="empty mascot" style="grid-column:1/-1">${kenji("point")}<b>${esc(tr("vx.none"))}</b>
    <button class="primary" data-vxmake="${vxSel === "all" ? "reel" : vxSel === "long" ? "reel" : vxSel}">${ico("plus", "sm")}${esc(tr("vx.make"))}</button></div></div>`;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-vxtype]");
  if (t) { vxSel = t.dataset.vxtype; try { localStorage.setItem("lc.vx.type", vxSel); } catch { /* private window */ } renderHome(true); return; }
  if (e.target.closest?.("[data-vxnew]")) { vxNewOpen = !vxNewOpen; renderHome(true); return; }
  const ph = e.target.closest?.("[data-vxphoto]");
  if (ph) { phSel = ph.dataset.vxphoto; return; }
  const m = e.target.closest?.("[data-vxmake]"); if (!m) return;
  const what = m.dataset.vxmake;
  vxNewOpen = false;
  if (what === "reel" || what === "walk") { autoCut = what === "walk" ? "walk" : "short"; showMaker = true; if (page !== "reels") location.hash = "#/reels"; renderHome(true); return; }
  location.hash = what === "explainer" ? "#/explainer/new" : what === "vlog" ? "#/videos" : "#/photos";
});

/* ---------- Explainers (#/explainer/<slug> | new) ---------- */
var EX = { list: null, loading: false, sel: null, text: "", for: null, res: null, busy: "", sheetAt: 0, sheetSlug: null, view: "video", folder: "", added: null, poll: null };
/* A new script starts from this: every field the format has, a cover and an end that need two library ids. */
var EX_TEMPLATE = {
  slug: "explainer-new", title: "タイトル｜テーマ #Shorts", accent: "#c8321f", snow: false, music: "auto",
  scenes: [
    { kind: "cover", sec: 4, src: "lib:0@0+8", kicker: "解説 · Explained", ja: "見出しは2行まで\n*大事な言葉*に印", en: "The headline in English", big: "1,444m" },
    { kind: "number", sec: 5, kicker: "1 / 2", value: 10, unit: "km", ja: "数字の説明\n*約10km*", en: "What the number means", source: "出典 / where it comes from" },
    { kind: "icons", sec: 5.5, kicker: "2 / 2", ja: "ここに*あるもの*", en: "What is here", items: [{ icon: "tent", ja: "テント", en: "tents" }, { icon: "wifi", ja: "光回線", en: "fibre" }, { icon: "fire", ja: "焚き火", en: "campfire" }] },
    { kind: "end", sec: 4.5, src: "lib:0@0+8", mascot: "tr", ja: "最後のひとこと", en: "The last line", lines: ["検索の言葉 · search words"] },
  ],
  yt: "YouTube の説明文（ハッシュタグは tags に）", ig: "Instagram・Facebook の投稿文", tags: ["キャンプ"],
};
/* The scene kinds and their fields, for the help under the editor (py/studio/explainer.py SCENES is the rule). */
var EX_KINDS = [
  ["cover", "src, kicker?, big?, source?, mascot?"], ["number", "value, unit?, decimals?, source?"], ["tally", "count (1-45), source?"],
  ["checklist", "items: [{ja, en}] 1-4, note?"], ["nogo", "items: [{ja, en}] 1-4, note?"], ["card", "src, label?: {ja, en}"],
  ["route", "from: {ja, en}, to: {ja, en}, via?"], ["pair", "left / right: {ja, en, icon | src}"], ["thermo", "value, unit?, label?, compare?: {value, label}, min?, max?, source?"],
  ["compare", "left / right: {value, ja, en}, vs?, source?"], ["clock", "hours: [{at: \"07:00\", ja, en}] 3-6"], ["bars", "bars: [{value, ja, en, shown?}] 2-5, unit?, source?"],
  ["icons", "items: [{icon, ja, en}] 3-6, note?"], ["steps", "steps: [{ja, en}] 2-4"], ["quote", "ja (the line), en?, by?"], ["end", "src, lines: [..] up to 3, mascot?"],
];
var EX_ICONS = "tent car kotatsu laptop wifi shower fire star snowflake mountain mug sun moon toilet dumbbell parking";
function exLoad(force) {
  if (EX.loading || (EX.list && !force)) return;
  EX.loading = true;
  api("/api/explainers").then((v) => { EX.list = v; }).catch((e) => { EX.list = EX.list || { scripts: [], error: e.message }; })
    .finally(() => { EX.loading = false; if (page === "explainer" && atHome()) renderHome(true); });
}
/** Open one script (or a new one) in the editor. */
function exOpen(sel) {
  if (EX.sel === sel && EX.for === sel) return;
  EX.sel = sel; EX.res = null; EX.view = "video"; EX.sheetAt = 0; EX.sheetSlug = null;
  if (sel === "new") { EX.text = JSON.stringify(EX_TEMPLATE, null, 1); EX.for = sel; return; }
  EX.text = ""; EX.for = null;
  api(`/api/explainers/script?slug=${encodeURIComponent(sel)}`).then((v) => {
    if (EX.sel !== sel) return;
    EX.text = v?.script ? JSON.stringify(v.script, null, 1) : ""; EX.for = sel;
    if (page === "explainer" && atHome()) renderHome(true);
  }).catch((e) => toast(`${ico("alert", "sm")} ${esc(e.message)}`, 5000));
}
/** One row per explainer: the scripts in the library and every explainer the overview has, with its state. */
function exRows() {
  const made = new Map((overview?.reels || []).filter((r) => vxType(r) === "explainer").map((r) => [r.slug, r]));
  const rows = (EX.list?.scripts || []).map((s) => ({ slug: s.slug, title: s.title || s.slug, seconds: s.seconds, r: made.get(s.slug) || null, error: s.error }));
  for (const [slug, r] of made) if (!rows.some((x) => x.slug === slug)) rows.push({ slug, title: r.title || slug, seconds: r.seconds, r });
  return rows;
}
function exState(row) {
  if (!row?.r) return { cls: "draft", text: tr("ex.status.none") };
  const s = reelState(row.r);
  return { cls: s === "topost" && row.r.status === "rendered" ? "review" : s, text: stateLine(row.r, s) };
}
function exParse() {
  try { return { script: JSON.parse(EX.text) }; } catch (e) { return { err: tr("ex.badjson", { e: e.message }) }; }
}
function exMsgsHtml() {
  const r = EX.res;
  if (!r) return `<p class="meta">${esc(tr("ex.lib"))}</p>`;
  const errs = r.errors || [], warns = r.warnings || [];
  return `${r.ok ? `<p class="okline">${ico("check", "sm")} ${esc(tr("ex.ok", { s: r.seconds, n: r.scenes }))}</p>` : ""}
    ${errs.length ? `<div class="ex-errs" role="alert"><b>${ico("alert", "sm")} ${esc(tr("ex.errors", { n: errs.length }))}</b><ul>${errs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    ${warns.length ? `<div class="ex-warns"><b>${esc(tr("ex.warnings"))}</b><ul>${warns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`;
}
function renderExplainer() {
  exLoad();
  if (!overviewLoaded) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.explainer")])}</div>${loadingHtml(tr("nav.explainer"))}`; return; }
  const rows = exRows();
  if (!EX.sel) exOpen(rows[0]?.slug || "new");
  const cur = rows.find((x) => x.slug === EX.sel) || null, r = cur?.r || null, st = exState(cur);
  const sheetJob = (EX.list?.sheets || []).find((j) => j.slug === `sheet-${EX.sel}` && ["queued", "running"].includes(j.status));
  const vid = r && r.rendered && !busyJob(r) ? reelVid(r) : "";
  // The video once made; else the preview still (an earlier one too), or what to press when there is none yet.
  const view = vid && EX.view === "video" ? `<video class="ex-video" src="${vid}" controls playsinline preload="metadata"></video>`
    : sheetJob || EX.busy === "preview" ? `<div class="ex-wait">${ico("hourglass")}<span>${esc(tr("ex.previewing"))}</span></div>`
    : EX.sel && EX.sel !== "new" || EX.sheetAt ? `<img class="ex-sheet" src="/api/explainers/sheet?slug=${encodeURIComponent(EX.sheetSlug || EX.sel)}&v=${EX.sheetAt}" alt="${esc(tr("ex.sheet"))}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ex-wait',textContent:${esc(JSON.stringify(tr("ex.nopreview")))}}))">`
    : `<div class="ex-wait">${ico("eye")}<span>${esc(tr("ex.nopreview"))}</span></div>`;
  const job = r && busyJob(r) ? r.job : null;
  const list = `<aside class="ex-list panel" aria-label="${esc(tr("ex.scripts"))}">
      <div class="ex-lhead"><b>${esc(tr("ex.scripts"))}</b><span class="meta">${rows.length}</span><span class="grow"></span><button class="sm" data-exsel="new">${ico("plus", "sm")}${esc(tr("ex.new"))}</button></div>
      <ol class="ex-rows">${rows.map((x) => { const s = exState(x); return `<li><button class="ex-row${x.slug === EX.sel ? " sel" : ""}" data-exsel="${esc(x.slug)}" ${x.slug === EX.sel ? 'aria-current="true"' : ""}>
        <span class="ex-th" style="background-image:url('${x.r?.hook ? thumb(x.r.hook, 120) + "&v=" + (x.r.updated || 0) : ""}')"></span>
        <span class="ex-rt"><b class="clamp" lang="ja">${esc(x.title)}</b><span class="meta">${x.seconds ? `${x.seconds}s · ` : ""}<i class="dot s-${s.cls}"></i>${esc(s.text)}</span></span></button></li>`; }).join("")}</ol>
      <details class="ex-add"${EX.added ? " open" : ""}><summary>${ico("folder", "sm")} ${esc(tr("ex.addfolder"))}</summary>
        <label class="meta" for="exFolder">${esc(tr("ex.folder"))}</label>
        <div class="row-tight"><input id="exFolder" data-exfolder value="${esc(EX.folder)}" placeholder="C:\\explainers" spellcheck="false"><button data-exadd="1" ${EX.busy ? "disabled" : ""}>${esc(tr("ex.addgo"))}</button></div>
        ${EX.added ? `<p class="meta">${esc(tr("ex.added", { n: EX.added.made.length }))}${EX.added.failed.length ? ` · <span class="warnline">${esc(tr("ex.failed", { n: EX.added.failed.length }))}</span>` : ""}</p>
          ${EX.added.failed.length ? `<ul class="ex-fails">${EX.added.failed.map((f) => `<li><b>${esc(f.file)}</b>: ${esc((f.errors || []).slice(0, 3).join(" · "))}</li>`).join("")}</ul>` : ""}` : ""}
      </details></aside>`;
  const title = EX.sel === "new" ? tr("ex.new") : cur?.title || EX.sel;
  const detail = `<section class="ex-detail panel" aria-label="${esc(title)}">
      <div class="ex-head"><b class="clamp" lang="ja">${esc(title)}</b>${EX.sel !== "new" ? `<span class="spill s-${st.cls}">${esc(st.text)}</span>` : ""}
        ${job ? `<span class="meta live-label">${esc(job.status === "queued" ? tr("job.queued", { n: job.position }) : `${job.pct || 0}% · ${job.label || ""}`)}</span>` : ""}
        <span class="grow"></span>
        <button data-excheck="1" ${EX.busy ? "disabled" : ""}>${ico("check", "sm")}${esc(tr("ex.check"))}</button>
        <button data-expreview="1" ${EX.busy || sheetJob ? "disabled" : ""}>${ico("eye", "sm")}${esc(tr("ex.preview"))}</button>
        <button class="primary" data-exsave="1" ${EX.busy || job ? "disabled" : ""}>${ico("clapper", "sm")}${esc(tr("ex.save"))}</button>
        ${r && r.status === "rendered" && !job ? `<button data-exreview="${esc(r.slug)}">${ico("eye", "sm")}${esc(tr("ex.review"))}</button>` : ""}</div>
      <div class="ex-body">
        <div class="ex-view">${vid ? `<div class="ex-tabs" role="tablist"><button role="tab" aria-selected="${EX.view === "video"}" class="${EX.view === "video" ? "on" : ""}" data-exview="video">${esc(tr("ex.video"))}</button><button role="tab" aria-selected="${EX.view === "sheet"}" class="${EX.view === "sheet" ? "on" : ""}" data-exview="sheet">${esc(tr("ex.sheet"))}</button></div>` : ""}
          <div class="ex-pic">${view}</div>
          ${r ? `<div class="ex-out">${r.rendered && !r.house ? netStrip(r) : ""}${vxNumHtml(r, true)}</div>` : ""}
          <p class="meta ex-rule">${ico("shield", "sm")} ${esc(tr("ex.approvedby"))}</p></div>
        <div class="ex-edit"><label for="exText" class="meta">${esc(tr("ex.script"))}</label>
          <textarea id="exText" data-extext spellcheck="false" ${EX.for !== EX.sel ? "disabled" : ""}>${esc(EX.text)}</textarea>
          <div class="ex-msgs" aria-live="polite">${exMsgsHtml()}</div>
          <details class="ex-kinds"><summary class="meta">${esc(tr("ex.kinds"))}</summary><table>${EX_KINDS.map(([k, f]) => `<tr><th>${k}</th><td>${esc(f)}</td></tr>`).join("")}<tr><th>icon</th><td>${esc(EX_ICONS)}</td></tr></table></details></div>
      </div></section>`;
  const keep = document.activeElement?.id === "exText" ? { s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd, top: document.activeElement.scrollTop } : null;
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.reels"), "#/reels"], [tr("nav.explainer")])}<span class="meta">${esc(tr("ex.lead"))}</span></div>
    <div class="ex-md">${list}${detail}</div>`;
  if (keep) { const ta = $("#exText"); ta.focus(); ta.setSelectionRange(keep.s, keep.e); ta.scrollTop = keep.top; }
}
function exPollSheet(slug) {
  clearTimeout(EX.poll);
  EX.poll = setTimeout(async () => {
    await api("/api/explainers").then((v) => { EX.list = v; }).catch(() => {});
    const j = (EX.list?.sheets || []).find((x) => x.slug === `sheet-${slug}`);
    if (j && ["queued", "running"].includes(j.status)) return exPollSheet(slug);
    EX.busy = "";
    if (j?.status === "done") { EX.sheetAt = Date.now(); EX.view = "sheet"; } else if (j) toast(`${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || tr("ex.previewfail"))}`, 8000);
    if (page === "explainer" && atHome()) renderHome(true);
  }, 2000);
}
document.addEventListener("input", (e) => {
  if (e.target.matches?.("[data-extext]")) { EX.text = e.target.value; EX.res = null; }
  if (e.target.matches?.("[data-exfolder]")) EX.folder = e.target.value;
});
document.addEventListener("click", async (e) => {
  const sel = e.target.closest?.("[data-exsel]");
  if (sel) { location.hash = `#/explainer/${sel.dataset.exsel}`; return; }
  const v = e.target.closest?.("[data-exview]");
  if (v) { EX.view = v.dataset.exview; renderHome(true); return; }
  const rv = e.target.closest?.("[data-exreview]");
  if (rv) { revFocus = rv.dataset.exreview; location.hash = "#/review"; return; }
  const act = e.target.closest?.("[data-excheck], [data-expreview], [data-exsave], [data-exadd]");
  if (!act || EX.busy) return;
  if (act.dataset.exadd) {
    const path = String(EX.folder || "").trim();
    if (!path) { toast(`${ico("alert", "sm")} ${esc(tr("ex.folder"))}`); return; }
    EX.busy = "add"; renderHome(true);
    try {
      EX.added = await post("/api/explainers/add", { path });
      toast(`${ico("check", "sm")} ${esc(tr("ex.added", { n: EX.added.made.length }))}`, 6000);
      EX.list = null; exLoad(true); await loadOverview().catch(() => {});
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    finally { EX.busy = ""; renderHome(true); }
    return;
  }
  const p = exParse();
  if (p.err) { EX.res = { ok: false, errors: [p.err], warnings: [] }; renderHome(true); return; }
  if (act.dataset.excheck) {
    EX.busy = "check"; renderHome(true);
    try { EX.res = await post("/api/explainers/check", { script: p.script }); } catch (err) { EX.res = { ok: false, errors: [err.message], warnings: [] }; }
    finally { EX.busy = ""; renderHome(true); }
    return;
  }
  if (act.dataset.expreview) {
    EX.busy = "preview"; renderHome(true);
    try {
      const j = await post("/api/explainers/preview", { script: p.script });
      EX.res = null; EX.list = { ...(EX.list || {}), sheets: [...(EX.list?.sheets || []).filter((x) => x.slug !== j.slug), j] };
      EX.sheetSlug = p.script.slug;
      exPollSheet(p.script.slug);
    } catch (err) {
      EX.busy = "";
      EX.res = await post("/api/explainers/check", { script: p.script }).catch(() => ({ ok: false, errors: [err.message], warnings: [] }));
    }
    renderHome(true);
    return;
  }
  EX.busy = "save"; renderHome(true);
  try {
    const r = await post("/api/explainers/save", { script: p.script, render: true });
    EX.res = { ok: true, errors: [], warnings: r.warnings || [], seconds: r.seconds, scenes: p.script.scenes?.length };
    toast(`${ico("check", "sm")} ${esc(tr("ex.saved"))}`, 5000);
    EX.list = null; exLoad(true); await loadOverview().catch(() => {});
    if (EX.sel !== r.slug) { EX.for = r.slug; EX.sel = r.slug; history.replaceState(null, "", `#/explainer/${r.slug}`); }
  } catch (err) {
    EX.res = await post("/api/explainers/check", { script: p.script }).catch(() => ({ ok: false, errors: [err.message], warnings: [] }));
    if (EX.res.ok) EX.res = { ok: false, errors: [err.message], warnings: EX.res.warnings };
  } finally { EX.busy = ""; renderHome(true); }
});
