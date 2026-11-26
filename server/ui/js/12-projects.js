/* ---------- Projects: one studio, several brands or accounts (each its own footage, reels, posts and logins) ---------- */
let wsView = null, wsPanel = false, wsNew = false;
const WS_SWATCH = ["#2f7d4f", "#2563eb", "#c2410c", "#9333ea", "#0e7490", "#be123c", "#a16207", "#4d7c0f"];
async function loadWorkspaces() {
  try { wsView = await api("/api/workspaces"); } catch { wsView = null; }
  paintWsChip(); if (wsPanel) paintWs();
}
/* ---------- All projects at once (owner, 14 Nov: "would be helpful if we can see all projects status and progress at
   once somewhere too - really bad uiux and user journey to keep pressing between different projects"). One card per
   project from GET /api/projects/summary: what is rendering and how far, reels to review, the next post, long-video
   parts, what needs you; each opens that project's studio. Refreshed every 15 s while open. ---------- */
let projView = null, projTimer = null, projLoading = false;
async function loadProjects() {
  if (projLoading) return; projLoading = true;
  try { projView = await api("/api/projects/summary"); } catch (err) { projView = { ...(projView || { list: [] }), error: err.message }; }
  projLoading = false;
  if (page === "projects") renderHome(true);
}
function projCard(x) {
  const ja = lang === "ja", base = x.here ? "" : x.url || "";
  const link = (hash, label) => `<a class="linkish" href="${escUrl(base + hash)}">${label}</a>`;
  const bar = (pct) => `<span class="sbar"><i style="width:${Math.max(2, pct || 0)}%"></i></span>`;
  const head = `<div class="pjhead"><span class="wsdot big"></span><b class="pjname">${esc(x.name)}</b>
    ${x.here ? `<span class="chip ok">${tr("pj.here")}</span>` : x.open === false ? `<span class="chip">${tr("pj.closed")}</span>` : `<span class="chip">${tr("pj.elsewhere")}</span>`}
    <span class="grow"></span>${x.open === false ? `<button data-wsopen="1">${ico("folder", "sm")}${tr("pj.openit")}</button>` : x.here ? "" : `<a class="btn" href="${escUrl(x.url)}">${tr("pj.go")} ↗</a>`}</div>`;
  if (x.open === false) return `<article class="pjcard" style="--ws:${esc(x.color || "#888")}">${head}<p class="meta">${tr("pj.closedwhy")}</p></article>`;
  const q = x.queue || {}, v = x.vlogs, r = x.reels, ps = x.posts, pr = x.problems || {};
  const doneBy = q.left ? new Date(Date.now() + q.left * 1000).toLocaleTimeString(ja ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const rows = [
    [ico("clapper", "sm"), tr("pj.making"), q.running
      ? `<div><b>${esc(q.running.slug)}</b> <span class="meta">${q.running.pct || 0}% · ${esc(q.running.label || "")}</span></div>${bar(q.running.pct)}
         <div class="meta">${q.queued ? tr("pj.waiting", { n: q.queued }) + " · " : ""}${doneBy ? tr("pj.doneby", { t: doneBy }) : ""} ${link("#/making", tr("pj.see"))}</div>`
      : `<span class="meta">${tr("pj.idle")}</span>`],
    v ? [ico("play", "sm"), tr("pj.videos"), v.building
      ? `<div><b>${tr("pj.part", { n: v.building.n })}</b> <span class="meta">${v.building.pct || 0}% · ${esc(v.building.label || "")}</span></div>${bar(v.building.pct)}
         <div class="meta">${tr("pj.vmade", { b: v.built, n: v.parts, u: v.uploaded })} ${link("#/videos", tr("pj.see"))}</div>`
      : `<span>${tr("pj.vmade", { b: v.built, n: v.parts, u: v.uploaded })}</span> ${link("#/videos", tr("pj.see"))}`] : null,
    r ? [ico("eye", "sm"), tr("pj.review"), r.review ? `<b>${tr("pj.toreview", { n: r.review })}</b> ${link("#/review", tr("pj.reviewnow"))}` : `<span class="meta">${tr("pj.nothingreview")}</span>`] : null,
    [ico("send", "sm"), tr("pj.posting"), ps?.next
      ? `<span>${netLogo(ps.next.network, "sm")} ${esc(whenText(ps.next.at))}</span> <span class="meta">· ${esc(ps.next.slug)}</span><div class="meta">${tr("pj.booked", { n: ps.booked })}${ps.postedWeek ? " · " + tr("pj.postedweek", { n: ps.postedWeek }) : ""} ${link("#/posting", tr("pj.see"))}</div>`
      : `<span class="meta">${tr("pj.nobooked")}</span>`],
    pr.red || pr.amber ? [ico("alert", "sm"), tr("pj.needs"), `<b class="${pr.red ? "bad" : ""}">${tr("pj.problems", { n: (pr.red || 0) + (pr.amber || 0) })}</b>
      ${(pr.top || []).map((t) => `<div class="meta clamp">${esc((ja && t.ja) || t.title)}</div>`).join("")}`] : null,
  ].filter(Boolean);
  return `<article class="pjcard ${x.here ? "here" : ""}" style="--ws:${esc(x.color || "#888")}">${head}
    <dl>${rows.map(([i, k, val]) => `<div class="pjrow"><dt>${i}${k}</dt><dd>${val}</dd></div>`).join("")}</dl></article>`;
}
function renderProjects() {
  const head = `<div class="pagehead"><nav class="bc"><b>${esc(tr("nav.projects"))}</b></nav><span class="grow"></span>
    ${projView?.at ? `<span class="meta">${ico("refresh", "sm")} ${tr("pj.updated", { t: new Date(projView.at).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</span>` : ""}</div>`;
  clearTimeout(projTimer);
  projTimer = setTimeout(() => { if (page === "projects" && document.visibilityState === "visible") loadProjects(); }, 15000);
  if (!projView) { loadProjects(); $("#home").innerHTML = head + loadingHtml(tr("nav.projects")); return; }
  $("#home").innerHTML = `${head}<p class="intro keep">${tr("pj.intro")}</p>
    ${projView.error ? `<p class="meta warnline">${ico("alert", "sm")} ${esc(projView.error)}</p>` : ""}
    <div class="pjgrid">${(projView.list || []).map(projCard).join("")}</div>`;
}
function paintWsChip() {
  const ws = wsView?.list?.find((x) => x.id === wsView.running);
  const b = $("#wsBtn"); if (!b || !ws) return;
  b.style.setProperty("--ws", ws.color); $("#app").style.setProperty("--ws", ws.color);
  // The project name always shows, Main included (a studio with no STUDIO_WORKSPACE hides the other .workspace labels).
  const nm = b.querySelector(".wsname"); nm.textContent = ws.name; nm.hidden = false;
  b.title = `${tr("ws.title")}: ${ws.name}`;
  b.hidden = false;
}
function paintWs() {
  let host = $("#wsModal");
  if (!host) { host = document.createElement("div"); host.id = "wsModal"; document.body.appendChild(host); }
  if (!wsPanel || !wsView) { host.innerHTML = ""; return; }
  const swatches = (id, cur) => WS_SWATCH.map((c) => `<button class="sw ${c === cur ? "on" : ""}" style="--sw:${c}" data-wscolor="${esc(id)}|${c}" aria-label="${c}"></button>`).join("");
  host.innerHTML = `<div class="dscrim" data-wsclose="1"></div><div class="wsbox" role="dialog" aria-modal="true" aria-label="${esc(tr("ws.title"))}">
    <div class="dh"><b>${ico("folder", "sm")} ${tr("ws.title")}</b><span class="grow"></span><button class="icon" data-wsclose="1" aria-label="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>
    <a class="btn primary pjall" href="#/projects" data-wsclose="1">${ico("folder", "sm")}${tr("pj.all")}</a>
    <p class="meta">${tr("ws.note")} ${tr("ws.autonote")}</p>
    ${wsView.pending ? `<div class="notice warn" role="status">${ico("clock", "sm")}<span>${tr("ws.pending", { n: esc(wsView.pending.name), k: wsView.pending.busy })}${wsView.pending.what ? " " + tr("ws.pendingwhat", { w: esc(wsView.pending.what) }) : ""}${wsView.elsewhere?.[wsView.pending.id] ? ` <a href="${escUrl(wsView.elsewhere[wsView.pending.id])}" target="_blank" rel="noopener">${tr("ws.there")} ↗</a>` : ""}</span><button data-wscancel="1">${tr("ws.cancel")}</button></div>` : ""}
    <ul class="wslist">${wsView.list.map((w) => `<li class="${w.id === wsView.running ? "cur" : ""}" style="--ws:${esc(w.color)}"><span class="wsdot big"></span>
      <div style="flex:1;min-width:0"><label class="wsrename" title="${esc(tr("ws.renametip"))}"><input class="wsname-in" data-wsname="${esc(w.id)}" value="${esc(w.name)}" aria-label="${esc(tr("ws.rename"))}" maxlength="40">${ico("type", "sm")}</label>
        <div class="meta clamp" title="${esc(w.source || w.data)}">${ico("layers", "sm")} ${esc(w.source || w.data || "")}</div><div class="swrow"><span class="meta">${tr("ws.color")}</span>${swatches(w.id, w.color)}</div></div>
      ${w.id === wsView.running ? `<span class="chip">${tr("ws.current")}</span><a class="btn" href="/api/workspaces/export" download title="${esc(tr("ws.sharetip"))}">${ico("download", "sm")}${tr("ws.share")}</a>` : `${wsView.elsewhere?.[w.id] ? `<a class="btn primary" href="${escUrl(wsView.elsewhere[w.id])}" target="_blank" rel="noopener">${tr("ws.there")} ↗</a><span class="meta">${esc(tr("ws.therenote", { m: (wsView.list.find((x) => x.id === wsView.running) || {}).name || "" }))}</span>` : `<button class="primary" data-wsgo="${esc(w.id)}">${tr("ws.switch")}</button>`}${w.main ? "" : `<button class="linkbtn" data-wsforget="${esc(w.id)}" title="${esc(tr("ws.askforget"))}">${tr("ws.forget")}</button>`}`}</li>`).join("")}</ul>
    ${wsNew ? `<form class="wsnew" data-wsnew="1"><label><span class="meta">${tr("ws.name")}</span><input name="name" required maxlength="40" placeholder="${esc(tr("ws.nameph"))}"></label>
      <label><span class="meta">${tr("ws.source")}</span><input name="source" placeholder="${esc(tr("ws.sourceph"))}"></label>
      <fieldset><legend class="meta">${tr("ws.nets")}</legend><div class="netpick">${POST_NETS.filter((n) => chanOf(n)).map((n) => `<label class="np">${netLogo(chOf(n), 18)}<input type="checkbox" name="net" value="${esc(chOf(n))}" ${["youtube", "tiktok"].includes(n) ? "checked" : ""}>${esc(NET_NAME[n] || n)}</label>`).join("")}</div></fieldset>
      <div class="row"><button class="primary" type="submit">${ico("plus", "sm")}${tr("ws.create")}</button><button type="button" data-wsnewx="1">${tr("ws.cancel")}</button></div></form>`
      : `<div class="row"><button class="big" data-wsnewopen="1">${ico("plus", "sm")}${tr("ws.new")}</button>
        <label class="btn big">${ico("folder", "sm")}${tr("ws.import")}<input type="file" accept=".json,application/json" data-wsimport="1" hidden></label></div>
        <p class="meta">${tr("ws.sharenote")}</p>`}</div>`;
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest("[data-wsopen], #wsBtn")) { wsPanel = true; wsNew = false; paintWs(); loadWorkspaces(); return; }
  if (!wsPanel) return;
  if (t.closest("[data-wsclose]")) { wsPanel = false; paintWs(); return; }
  if (t.closest("[data-wsnewopen]")) { wsNew = true; paintWs(); $("#wsModal input[name=name]")?.focus(); return; }
  if (t.closest("[data-wsnewx]")) { wsNew = false; paintWs(); return; }
  try {
    const col = t.closest("[data-wscolor]");
    if (col) { const [id, color] = col.dataset.wscolor.split("|"); wsView = await post("/api/workspaces/edit", { id, color }); paintWs(); paintWsChip(); return; }
    const fg = t.closest("[data-wsforget]");
    if (fg) { if (!confirm(tr("ws.askforget"))) return; wsView = await post("/api/workspaces/forget", { id: fg.dataset.wsforget }); paintWs(); return; }
    const go2 = t.closest("[data-wsgo]");
    if (go2) { const w = wsView.list.find((x) => x.id === go2.dataset.wsgo); return await switchProject(go2.dataset.wsgo, w?.name || ""); }
    if (t.closest("[data-wscancel]")) {
      wsView = await post("/api/workspaces/switch", { cancel: true }); paintWs();
      // The work ended a moment before Cancel arrived: the studio is already opening the other project.
      if (wsView.active !== wsView.running) { toast(`${ico("clock", "sm")} ${esc(tr("ws.toolate", { n: wsView.list.find((x) => x.id === wsView.active)?.name || wsView.active }))}`, 10000); waitForSwitch(); }
      return;
    }
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
document.addEventListener("change", async (e) => {
  const n = e.target.closest("[data-wsname]"); if (!n) return;
  const was = wsView?.list?.find((x) => x.id === n.dataset.wsname)?.name || "";
  // An empty name is refused, and the field shows the saved name again (never a blank field and a "Renamed to ." toast).
  if (!n.value.trim()) { n.value = was; toast(`${ico("alert", "sm")} ${esc(tr("ws.needname", { n: was }))}`, 5000); return; }
  try { wsView = await post("/api/workspaces/edit", { id: n.dataset.wsname, name: n.value }); paintWsChip(); toast(`${ico("check", "sm")} ${tr("ws.renamed", { n: esc(wsView.list.find((x) => x.id === n.dataset.wsname)?.name || n.value.trim()) })}`, 2500); }
  catch (err) { n.value = was; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-saidsigned]"); if (!b) return;
  lsSet("studio.signedin." + b.dataset.saidsigned, String(Date.now()));
  toast(`${ico("check", "sm")} ${tr("acc.saidok", { n: esc(NET_NAME[b.dataset.saidsigned] || b.dataset.saidsigned) })}`, 3500);
  renderHome(true);
  PROB.load();  // its "needs a one-time sign-in check" line goes
});
document.addEventListener("change", async (e) => {
  const f = e.target.closest("[data-wsimport]"); if (!f || !f.files?.[0]) return;
  try {
    const bundle = JSON.parse(await f.files[0].text());
    toast(`${ico("hourglass", "sm")} ${tr("ws.importing")}`, 4000);
    const r = await post("/api/workspaces/import", { bundle });
    wsView = r; paintWs(); toast(`${ico("check", "sm")} ${tr("ws.imported", { n: esc(r.name), k: r.reels })}`, 8000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(/JSON|not a Lazycow project file/i.test(err.message) ? tr("ws.notfile") : err.message)}`, 8000); }
  f.value = "";
});
/* Open another project: the server restarts on its folders (a few seconds); the page reloads once it answers again.
   The Switch button (or Create and open) is the decision, so no extra "are you sure": nothing is lost by switching. */
async function switchProject(id, name) {
  // Renders or uploads still running: the studio switches by itself when they end (never cuts one off).
  const r = await post("/api/workspaces/switch", { id, whenIdle: true });
  if (r.waiting) {
    wsView = { ...wsView, ...r }; paintWs();
    toast(`${ico("clock", "sm")} ${tr("ws.waiting", { n: name, k: r.waiting })}`, 10000);
    waitForSwitch();
    return;
  }
  toast(`${ico("refresh", "sm")} ${tr("ws.switching", { n: name })}`, 20000);
  const t0 = Date.now();
  const poll = async () => { try { await api("/api/health"); location.href = "/#/"; location.reload(); } catch { if (Date.now() - t0 < 60000) setTimeout(poll, 1200); } };
  setTimeout(poll, 1500);
}
/* While a switch waits for jobs, the page watches for the restart and opens the new project when it is up. */
function waitForSwitch() {
  // Reload when the studio runs another project. Waiting to see it down missed a restart quicker than one poll, and
  // the page stayed on the old project while the studio ran the new one.
  const started = Date.now(), from = wsView?.running || "main";
  const tick = async () => {
    let v = null;
    try { v = await api("/api/workspaces"); } catch { /* restarting on the new project */ }
    if (v && v.running !== from) { location.href = "/#/"; location.reload(); return; }
    if (v && !v.pending && v.active === from) return;  // cancelled: nothing left to wait for
    if (Date.now() - started < 3 * 3600e3) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-wsnew]"); if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  try {
    wsView = await post("/api/workspaces", { name: fd.get("name"), source: String(fd.get("source") || "").trim() || undefined, networks: fd.getAll("net") });
    wsNew = false; paintWs();
    toast(`${ico("check", "sm")} ${tr("ws.made", { n: String(fd.get("name")) })}`, 6000);
    if (wsView.made) await switchProject(wsView.made, String(fd.get("name")));  // a new project is made to be used: open it
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && wsPanel) { wsPanel = false; paintWs(); } });
// Esc closes the footage viewer and the folder picker, as it closes every other dialog.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || wsPanel || wz || pal || !atHome() || page !== "footage") return;
  if (foot.open != null) { foot.open = null; renderHome(true); }
  else if (foot.picker) { foot.picker = null; renderHome(true); }
});

/* Track C (24 Nov): the newest seven (one row at 1440 px) open, the rest folded: 15 tall cards ran 2.2 screens. */
const TC_YT_SHOWN = 7;
function renderYouTube() {
  if (!yt.connected) {
    $("#home").innerHTML = `<div class="pagehead">${crumbs(["YouTube"])}</div><section class="panel"><p>${tr("yt.notconnected")}</p>${ytConnectHtml()}</section>`;
    return;
  }
  if (ytLists === null) { ytLists = undefined; loadYtLists(); }
  const V = Array.isArray(ytVideos) ? ytVideos : [];
  const pub = V.filter((v) => v.privacy === "public"), sched = V.filter((v) => v.privacy !== "public" && v.publishAt), priv = V.filter((v) => v.privacy !== "public" && !v.publishAt);
  const views = V.reduce((a, v) => a + (v.views || 0), 0), vmax = Math.max(1, ...V.map((v) => v.views || 0));
  // Results' number for YouTube (the studio's Shorts, 60 days, as last read), so the two numbers can be told apart here.
  if (reachView === null) { reachView = undefined; api("/api/perf/reach").then((v) => { reachView = v; }, () => { reachView = { networks: [] }; }).then(() => { if (page === "youtube") renderHome(true); }); }
  const ytReach = reachView?.networks?.find((x) => x.network === "youtube");
  const ytFresh = gxFresh("yt"); let ytI = 0;
  const inLists = (id) => (ytLists || []).filter((p) => p.members.includes(id));
  const coverOf = (slug) => overview.reels.find((r) => r.slug === slug)?.hook;
  const tile = (cls, n, label) => `<div class="tile-stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const card = (v) => {
    const s = v.privacy === "public" ? "posted" : v.publishAt ? "scheduled" : "skip";
    const own = coverOf(v.slug);
    return `<a class="ytc st-${s}" href="${escUrl(v.url)}" target="_blank" rel="noopener" title="${esc(v.title)}">
      <span class="yt-thumb big"><img src="${esc(own ? file(own) : v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`)}" data-alt-src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">${ico("play")}
        <span class="spill s-${s}">${s === "posted" ? tr("yt.public") : s === "scheduled" ? `${tr("yt.sched")} ${whenText(v.publishAt)}` : tr("yt.private")}</span></span>
      <span class="ytc-body"><b class="clamp">${esc(v.title)}</b><span class="ytc-v" style="--i:${ytI++}"><span class="ytc-vbar" aria-hidden="true"><i style="--w:${((v.views || 0) / vmax).toFixed(3)}"></i></span><b>${Number(v.views || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB")} <span class="meta">${tr("yt.views")}</span></b></span>${v.slug ? `<span class="meta">${tr("yt.studio")}</span>` : ""}
        ${inLists(v.id).length ? `<span class="pl-chips">${inLists(v.id).map((p) => `<span class="chip">${esc(p.title.split(" | ")[lang === "ja" ? 0 : 1])}</span>`).join("")}</span>` : ""}</span></a>`;
  };
  $("#home").innerHTML = `
    <div class="pagehead">${crumbs(["YouTube"])}<span class="meta">${esc(yt.channel?.title || "")} ${esc(yt.channel?.handle || "")}</span><span class="grow"></span>
      ${yt.playlists ? `<button id="ytSort">${ico("list", "sm")}${tr("yt.sort")}</button>` : `<a class="btn" href="/api/youtube/connect">${ico("list", "sm")}${tr("yt.allow")}</a>`}</div>
    <div class="stats">${tile("s-posted", pub.length, tr("yt.public"))}${tile("s-scheduled", sched.length, tr("yt.sched"))}${tile("s-skip", priv.length, tr("yt.private"))}${tile("", views.toLocaleString(lang === "ja" ? "ja-JP" : "en-GB"), esc(tr("yt.totalnew", { n: V.length })))}</div>
    ${V.length ? `<p class="note ytscope">${ico("info", "sm")} ${esc(ytReach ? tr("yt.scope", { n: V.length, v: Number(ytReach.views).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB"), d: reachView.days || 60 }) : tr("yt.scopenone", { n: V.length }))}</p>` : ""}
    <section class="panel"><h3>${ico("list")} ${tr("yt.playlists")}</h3>
      ${!Array.isArray(ytLists) ? `<div class="skel skel-line" style="width:60%"></div>` : ytLists.filter((p) => p.id).length ? `<div class="pl-row">${ytLists.filter((p) => p.id).map((p) => `<a class="chip" href="${escUrl(p.url)}" target="_blank" rel="noopener">${esc(p.title)} · ${p.count}</a>`).join("")}</div>` : `<p class="note">${tr("yt.none")}</p>`}</section>
    <h3 class="sub">${ico("play", "sm")} ${tr("yt.videos")}</h3>
    <div class="ytgrid mo-gfx ${ytFresh ? "in" : ""}" data-gx="yt">${[...sched, ...pub, ...priv].slice(0, TC_YT_SHOWN).map(card).join("") || (Array.isArray(ytVideos) ? `<div class="empty" style="grid-column:1/-1"><b>${tr("yt.novideos")}</b></div>` : '<div class="skel skel-card"></div>'.repeat(7))}</div>
    ${[...sched, ...pub, ...priv].length > TC_YT_SHOWN ? `<details class="pfold tc-ytmore"><summary>${esc(tr("tc.yt.morevids", { n: [...sched, ...pub, ...priv].length - TC_YT_SHOWN }))}</summary><div class="ytgrid">${[...sched, ...pub, ...priv].slice(TC_YT_SHOWN).map(card).join("")}</div></details>` : ""}
    <p class="note" style="margin-top:12px">${ico("info", "sm")} ${tr("yt.privnote")}</p>`;
}


/* Log: what the studio did and what it cost; how each reel was assembled. */
let logData = null, logTab = "overview", logQ = "", logKind = "all", logPage = 0, logFocus = false, capEdit = false;
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-capedit]")) { capEdit = true; renderHome(true); return; }
  if (e.target.closest("[data-capcancel]")) { capEdit = false; renderHome(true); }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-logcap]"); if (!f) return;
  e.preventDefault();
  try { await saveSetting({ daily_usd_budget: +new FormData(f).get("cap") }); toast(`${ico("check", "sm")} ${tr("acc.saved")}`); capEdit = false; logData = null; renderHome(true); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); }
});
function loadLog() {
  api("/api/log").then((d) => { logData = d; if (atHome() && page === "log") renderHome(true); })
    .catch((err) => { logData = { error: err.message }; if (atHome() && page === "log") renderHome(true); });
}
const PURPOSE = { "ai-music": "pp.music", "ai-vlog-names": "pp.names", "ai-vlog-signs": "pp.signs", "ai-review": "pp.review", "ai-words": "pp.words",
  // BL-067: the rest in words too (the model ID only on hover)
  tagcheck: "ux2.pp.tagcheck", "tagcheck-error": "ux2.pp.tagerr", "ai-living": "ux2.pp.living", "ai-sharpen": "ux2.pp.sharpen", "ai-voice": "ux2.pp.voice",
  "words-suggest": "pp.words", "ai-behind": "ux2.pp.behind", "ai-foley": "ux2.pp.foley", "ai-slowmo": "ux2.pp.slowmo" };
const usd = (n) => `$${Number(n || 0).toFixed(n && n < 0.01 ? 4 : 2)}`;
const JOB_KINDS = { ai: "job.ai", build: "job.build", remix: "job.remix", helper: "job.helper", import: "job.import", post: "job.post", watch: "job.watch", youtube: "job.youtube", live: "job.live", vlog: "job.vlog", places: "geo.job" };
const jobKind = (k) => tr(JOB_KINDS[k] || k);
/** "post-loud-1108-bluesky" to "loud-1108 · Bluesky": what the job was about. */
function jobName(slug) {
  const s = String(slug || ""), m = /^(post|helper)-(.+)-([a-z]+(?:-[a-z]+)?)$/.exec(s);
  if (s === "helper-perf") return tr("job.readnumbers");
  if (s === "footage") return tr("job.foldercheck");
  if (s === "places") return tr("geo.job");
  if (/^live-/.test(s)) return tr("job.livecheck");
  const due = /^post-due-(.+)$/.exec(s); if (due) return tr("job.due", { p: wsLabel(due[1]) });
  const v = /^vlog-(\d+)$/.exec(s); if (v) return tr("bd.vlog", { n: v[1] });
  if (s === "vlog-plan") return tr("bd.vlogplan");
  if (m && (NET_NAME[m[3]] || m[3] === "line-oa")) return `${m[2]} · ${NET_NAME[m[3]] || m[3]}`;
  return s;
}
function renderLog() {
  if (logData === null) { logData = undefined; loadLog(); }
  if (!logData) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.results"), "#/results"], [tr("nav.log")])}</div><div class="stats">${'<div class="skel" style="height:78px"></div>'.repeat(4)}</div>${'<div class="skel skel-line"></div>'.repeat(6)}`; return; }
  if (logData.error) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.results"), "#/results"], [tr("nav.log")])}</div><div class="empty"><b>${ico("alert")} ${esc(logData.error)}</b><button id="logRefresh">${ico("refresh", "sm")}${tr("sys.retry")}</button></div>`; return; }
  const { spend, local, reels: made, jobs: J, youtube: Y } = logData;
  const tile = (cls, big, label, href) => href ? `<a class="tile-stat tlink ${cls}" href="${href}"><b>${big}</b><span>${label}</span>${ico("chev-r", "sm")}</a>` : `<div class="tile-stat ${cls}"><b>${big}</b><span>${label}</span></div>`;
  const reelRow = (r) => {
    const card = overview.reels.find((x) => x.slug === r.slug);
    // one line a reel (fx-tr1): the full title and details stay on hover
    const fxMeta = `${r.madeBy || ""} · ${(r.madeAt || "").replace("T", " ").slice(0, 16)}${r.seed != null ? ` · ${tr("log.seed")} ${r.seed}` : ""}${r.music ? ` · ♪ ${r.music}` : ""}${r.bpm ? ` · ${r.bpm} BPM` : ""}`;
    return `<details class="trace"><summary>
        <span class="mthumb" style="background-image:url('${card?.hook ? thumb(card.hook, 120) : ""}')"></span>
        <span class="trace-head"><b lang="ja" title="${esc(`${r.title || reelName(r.slug)} (${r.slug})`)}">${esc(r.title || reelName(r.slug))}</b>
          <span class="meta" title="${esc(fxMeta)}">${esc(fxMeta)}</span></span>
        <span class="chip ${r.traced ? "ok" : ""}">${tr(r.traced ? "log.traced" : "log.rebuilt")}</span></summary>
      <table class="kvt"><thead><tr><th>#</th><th>${tr("log.prompt")}</th><th>${tr("log.picked")}</th><th>${tr("log.others")}</th></tr></thead><tbody>
        ${r.trace.map((s) => `<tr><td>${s.slot + 1}</td><td>${esc(s.prompt)}</td>
          <td>${s.picked ? `<b>${esc(s.picked)}</b>${(() => { const c = s.candidates.find((x) => x.file === s.picked); return c?.match != null ? ` <span class="meta">${tr("log.match")} ${c.match.toFixed(3)}${c.aesthetic != null ? ` · ${tr("log.look")} ${c.aesthetic.toFixed(1)}` : ""}</span>` : ""; })()}` : `<span class="warnline">${tr("log.nopick")}</span>`}</td>
          <td class="meta">${s.candidates.filter((c) => c.file !== s.picked).map((c) => `${esc(c.file)} ${c.score != null ? c.score.toFixed(3) : c.match != null ? c.match.toFixed(3) : ""}`).join(" · ") || "—"}</td></tr>`).join("")}
      </tbody></table>
      <p class="meta">${tr("log.words")}: ${r.words.map((w) => esc(w.replace(/\n/g, " "))).join(" / ")}</p>
      <div class="row"><a class="btn" href="#/reel/${esc(r.slug)}">${ico("eye", "sm")}${tr("act.open")}</a><button data-remake="${esc(r.theme)}">${ico("refresh", "sm")}${tr("log.remake")}</button></div></details>`;
  };
  /* The log in four tabs (#/log/<tab>), each a page of its own instead of one long scroll. */
  const tabs = [["overview", "list", tr("log.t.overview")], ["reels", "film", tr("log.t.reels", { n: made.length })], ["activity", "clock", tr("log.t.activity", { n: J.length })], ["posts", "send", tr("log.t.posts", { n: postsLog.length })]];
  if (!tabs.some(([k]) => k === logTab)) logTab = "overview";
  const kinds = [...new Set(J.map((j) => j.kind))].sort();
  const q = logQ.toLowerCase();
  const PAGE = 25;
  const pager = (total) => {
    const pages = Math.max(1, Math.ceil(total / PAGE)); logPage = Math.min(logPage, pages - 1);
    return pages < 2 ? "" : `<div class="pager"><button data-lpage="${logPage - 1}" ${logPage ? "" : "disabled"}>${ico("chev-l", "sm")}</button><span class="meta">${tr("log.page", { i: logPage + 1, n: pages, t: total })}</span><button data-lpage="${logPage + 1}" ${logPage < pages - 1 ? "" : "disabled"}>${ico("chev-r", "sm")}</button></div>`;
  };
  const search = (ph) => `<div class="search" style="width:min(320px,100%);margin:0">${ico("search", "sm")}<input id="logQ" value="${esc(logQ)}" placeholder="${esc(ph)}"></div>`;
  // Job times are stored in UTC ("…Z"): shown on this computer's clock, like every other time in the studio.
  const when = (s) => {
    const d = new Date(s || ""), p2 = (x) => String(x).padStart(2, "0");
    if (!s || isNaN(d)) return esc(String(s || "").replace("T", " ").slice(0, 16));
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  let body = "";
  if (logTab === "overview") {
    const fails = J.filter((j) => j.status === "error").length;
    body = `<div class="stats">
      ${tile(spend.total ? "s-topost" : "s-posted", usd(spend.total), tr("log.paid"), "#/keys/caps")}
      <div class="tile-stat capt">${capEdit
        ? `<form class="capedit" data-logcap="1"><label><span>${tr("log.today")}</span><input name="cap" type="number" min="0" step="1" inputmode="decimal" value="${esc(spend.budget)}" autofocus></label><button class="primary" type="submit">${tr("log.capsave")}</button><button type="button" data-capcancel="1">${tr("log.capcancel")}</button></form>`
        : `<b>${usd(spend.today)} / ${usd(spend.budget)}</b><span>${tr("log.today")}</span><span class="capacts"><button class="linkbtn" data-capedit="1">${tr("log.capchange")}</button><a href="#/keys/caps">${tr("log.capall")}</a></span>`}</div>
      ${tile("s-posted", `${local.length} · $0`, tr("log.local"))}
      ${tile("s-scheduled", `${Y.uploadsToday} / ${Y.uploadLimit}`, tr("log.ytuploads"), "#/posting/schedule/youtube")}
    </div>
    <div class="stats">
      ${tile("", made.length, tr("log.t.reels", { n: "" }).trim(), "#/log/reels")}
      ${tile(fails ? "s-topost" : "s-posted", `${J.length - fails} / ${J.length}`, tr("log.okjobs"), "#/log/activity")}
      ${/* BL-065: the same counts as Posting's "Sent" tab and its schedule (posts, not reels) */ ""}
      ${tile("s-posted", recentPosts(Infinity).length, tr("ux2.postsout"), "#/posting/sent")}
      ${tile("s-scheduled", bookedAhead().length, tr("ux2.postsbooked"), "#/posting/schedule")}
    </div>
    <section class="panel"><h3>${ico("info")} ${tr("log.whatai")}</h3>
      <p class="note">${tr("log.whatai.note")}</p>
      <table class="kvt">${local.map((m) => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.use)}</td><td>${mp("pin", esc(m.where), "s-posted")} ${mp("", "$0")}</td></tr>`).join("")}
        ${spend.byPurpose.map((p) => `<tr title="${esc(`${p.model}${p.tokens_in || p.tokens_out ? ` · ${tr("ux2.tokens", { i: p.tokens_in || 0, o: p.tokens_out || 0 })}` : ""}`)}"><td><b>${esc(PURPOSE[p.purpose] ? tr(PURPOSE[p.purpose]) : p.purpose)}</b></td><td>${tr("log.calls", { n: p.calls })}</td><td>${mp("", usd(p.usd), "s-topost")}</td></tr>`).join("")}</table>
      ${spend.rows.length ? "" : `<p class="note">${tr("log.nopaid")}</p>`}</section>`;
  } else if (logTab === "reels") {
    const list = made.filter((r) => !q || `${r.slug} ${r.title} ${r.music || ""} ${r.theme || ""}`.toLowerCase().includes(q));
    body = `<div class="row">${search(tr("log.findreel"))}<span class="meta">${tr("log.howmade.note")}</span></div>
      <div class="traces fx-tr1">${list.slice(logPage * PAGE, logPage * PAGE + PAGE).map(reelRow).join("") || `<p class="note">${tr("home.emptyfilter")}</p>`}</div>${pager(list.length)}`;
  } else if (logTab === "activity") {
    // batch C: the other project's due-post runs are hidden unless the swimlane's switch shows them
    const list = J.filter((j) => (cLogOther || !cIsOther(j)) && (logKind === "all" || j.kind === logKind || (logKind === "error" && j.status === "error")) && (!q || `${j.slug} ${j.slug ? reelName(j.slug) : ""} ${j.kind} ${j.last || ""}`.toLowerCase().includes(q)));
    body = `${cSwimHtml()}<div class="row">${search(tr("log.findjob"))}<div class="seg">${["all", ...kinds, "error"].map((k) => `<button class="${logKind === k ? "on" : ""}" data-lkind="${esc(k)}">${esc(k === "all" ? tr("st.all") : k === "error" ? tr("log.failed") : jobKind(k))}</button>`).join("")}</div></div>
      ${list.length ? `<table class="kvt td-logt"><thead><tr><th>${tr("log.when")}</th><th>${tr("posting.reel")}</th><th>${tr("log.kind")}</th><th>${tr("posting.state")}</th><th>${tr("log.secs")}</th><th></th></tr></thead><tbody>
      ${list.slice(logPage * PAGE, logPage * PAGE + PAGE).map((j) => `<tr><td class="meta">${when(j.ended)}</td><td>${j.slug && overview.reels.some((r) => r.slug === j.slug) ? `<a href="#/reel/${esc(j.slug)}" title="${esc(j.slug)}" lang="ja">${esc(reelName(j.slug))}</a>` : esc(jobName(j.slug))}</td><td>${mp(j.kind === "youtube" ? "play" : j.kind === "remix" ? "volume" : j.kind === "build" ? "clapper" : "layers", esc(jobKind(j.kind)))}</td>
        <td>${mp(j.status === "done" ? "check" : j.status === "error" ? "alert" : "x", esc(j.status === "done" ? tr("pal.done") : j.status === "error" ? tr("log.failed") : jobLabel(j.status)), j.status === "done" ? "s-posted" : j.status === "error" ? "bad" : "")}</td><td>${j.seconds != null ? span(j.seconds) : ""}</td><td class="meta"><span class="clamp" title="${esc(j.last || "")}">${esc(j.last || "")}</span></td></tr>`).join("")}</tbody></table>${pager(list.length)}`
      : `<p class="note">${tr("log.nojobs")}</p>`}`;
  } else {
    const list = postsLog.filter((p) => p.network !== "all" && (!q || `${p.slug} ${reelName(p.slug)} ${p.network} ${p.status}`.toLowerCase().includes(q))).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    body = `<div class="row">${search(tr("log.findpost"))}</div>
      ${list.length ? `<table class="kvt"><thead><tr><th>${tr("log.when")}</th><th></th><th>${tr("posting.reel")}</th><th>${tr("posting.state")}</th><th></th></tr></thead><tbody>
      ${list.slice(logPage * PAGE, logPage * PAGE + PAGE).map((p) => `<tr><td class="meta">${p.at ? esc(whenText(p.at)) : ""}</td><td>${netLogo(chOf(p.network), "sm")}</td><td><a href="#/reel/${esc(p.slug)}" title="${esc(p.slug)}" lang="ja">${esc(reelName(p.slug))}</a></td>
        <td>${mp(p.status === "posted" ? "check" : p.status === "scheduled" ? "cal" : "clock", esc(tr(p.status === "posted" ? "st.posted" : p.status === "scheduled" ? "st.scheduled" : "st.reminder")), p.status === "posted" ? "s-posted" : p.status === "scheduled" ? "s-scheduled" : "s-topost")}</td>
        <td>${p.url ? `<a class="chip" href="${escUrl(p.url)}" target="_blank" rel="noopener">${ico("eye", "sm")}${tr("act.open")}</a>` : ""}</td></tr>`).join("")}</tbody></table>${pager(list.length)}`
      : `<p class="note">${tr("posting.none")}</p>`}`;
  }
  $("#home").innerHTML = `
    <div class="pagehead">${crumbs([tr("nav.results"), "#/results"], [tr("nav.log")])}<span class="grow"></span><button id="logRefresh">${ico("refresh", "sm")}${tr("log.refresh")}</button></div>
    <nav class="tabs" role="tablist">${tabs.map(([k, i, label]) => `<a role="tab" aria-selected="${k === logTab}" class="${k === logTab ? "on" : ""}" href="#/log/${k}">${ico(i, "sm")}${esc(label)}</a>`).join("")}</nav>
    ${body}`;
  if (logTab === "activity") cSwimDraw();  // batch C: the swimlane is drawn at its measured width
  const qi = $("#logQ"); if (qi && logFocus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}

/* Footage: the whole tagged library as a portfolio, what is used and what is not. */
const foot = { items: [], q: "", f: "all", open: null, loading: false, job: null, g: null, session: null, src: null, picker: null };
async function loadSources() {
  try { foot.src = await api("/api/sources"); } catch (err) { foot.src = { sources: [], last: {}, watch: {}, error: err.message }; if (err.offline) foot.away = true; }
  if (atHome() && page === "footage") renderHome(true);
}
const ago = (iso) => {
  if (!iso) return tr("src.never");
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? tr("src.justnow") : m < 60 ? tr("src.minago", { n: m }) : tr("src.hago", { n: Math.round(m / 60) });
};
const bytes = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? Math.round(n / 1e6) + " MB" : Math.round((n || 0) / 1e3) + " KB";
/* Collect footage from other people, using none of their storage: the drop box (phones on this Wi-Fi send straight
   to this computer) and a Google Form (uploads land in your Drive, on your storage). Research and the reasons:
   README › "Collect footage from other people". */
let collect = null, collectBusy = false;
async function loadCollect() {
  try { collect = await api("/api/intake"); }
  catch (e) { collect = { error: e.message }; setTimeout(() => { if (collect?.error) { collect = null; if (page === "footage") renderHome(true); } }, 5000); }
  if (page === "footage") renderHome(true);
}
const qrImg = (u, label) => `<img class="qr" src="/api/intake/qr?u=${encodeURIComponent(u)}" width="168" height="168" alt="${esc(label)}">`;
function collectMsg(u) { return trA("col.msg", { u, name: brandView?.name || WORKSPACE || "" }); }
/* The two ways other people send footage (shown in Footage › Add footage, under "Phones and other people"). */
function collectBody() {
  if (collect === null) { collect = undefined; loadCollect(); }
  const c = collect, d = c?.drop, f = c?.form;
  const until = d?.open ? new Date(d.until).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const drop = !c ? loadingHtml(tr("col.title")) : c.error ? `<p class="bad">${esc(c.error)}</p>`
    : d?.open ? `<div class="colopen">${qrImg(d.url, tr("col.qr"))}<div class="colbody">
        <p class="colstate"><i class="led"></i>${tr("col.isopen", { t: until })}</p>
        <p class="colurl" lang="en">${esc(d.url)}</p>
        <div class="row wrap"><button data-colcopy="${esc(d.url)}">${ico("copy", "sm")}${tr("col.copylink")}</button><button data-colcopy="${esc(collectMsg(d.url))}">${ico("copy", "sm")}${tr("col.copymsg")}</button>
          <button data-coldrop="0" ${collectBusy ? "disabled" : ""}>${ico("x", "sm")}${tr("col.close")}</button></div>
        <p class="meta">${tr("col.received", { n: d.received || 0, b: bytes(d.bytes || 0) })}${d.received ? " · " + tr("col.where") : ""}</p>
        <p class="meta">${tr("col.wifi")}</p></div></div>`
    : `<p>${tr("col.drophow")}</p><div class="row wrap"><label class="meta">${tr("col.for")} <select id="colHours">${[1, 3, 8].map((h) => `<option value="${h}" ${h === 3 ? "selected" : ""}>${tr("col.hours", { n: h })}</option>`).join("")}</select></label>
        <button class="primary" data-coldrop="1" ${collectBusy ? "disabled" : ""}>${ico("download", "sm")}${tr("col.open")}</button></div>
        <p class="meta">${tr("col.types", { t: (c.types || []).join(" ") })}</p>`;
  const form = !c ? "" : f?.url ? `<div class="colopen">${qrImg(f.url, tr("col.formqr"))}<div class="colbody">
        <p class="colurl" lang="en">${esc(f.url)}</p>
        <div class="row wrap"><button data-colcopy="${esc(f.url)}">${ico("copy", "sm")}${tr("col.copylink")}</button><button data-colcopy="${esc(collectMsg(f.url))}">${ico("copy", "sm")}${tr("col.copymsg")}</button>
          <button data-colform="" class="ghost">${ico("x", "sm")}${tr("col.forget")}</button></div>
        <p class="meta">${tr("col.formwatch")}</p></div></div>`
    : `<ol class="colsteps"><li>${tr("col.f1")} <a class="btn" href="https://forms.new" target="_blank" rel="noopener">forms.new ↗</a></li><li>${tr("col.f2")}</li><li>${trA("col.f3")}</li><li>${tr("col.f4")}</li></ol>
        <form class="row wrap" data-colformsave="1"><input type="url" name="url" placeholder="https://forms.gle/…" aria-label="${esc(tr("col.formlink"))}" required><button class="primary" type="submit">${tr("key.save")}</button></form>`;
  return `<div class="colgrid"><section><h4>${ico("wifi", "sm")} ${tr("col.drop")}</h4>${drop}</section><section><h4>${ico("list", "sm")} ${tr("col.form")}</h4>${form}</section></div>`;
}
document.addEventListener("click", async (e) => {
  const cp = e.target.closest("[data-colcopy]");
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.colcopy); toast(`${ico("check", "sm")} ${tr("col.copied")}`, 2500); } catch { toast(`${ico("alert", "sm")} ${tr("col.nocopy")}`, 5000); } return; }
  const dr = e.target.closest("[data-coldrop]");
  if (dr) {
    collectBusy = true; renderHome(true);
    try {
      const r = await post("/api/intake/drop", dr.dataset.coldrop === "1" ? { open: true, hours: +($("#colHours")?.value || 3) } : { open: false });
      collect = { ...(collect || {}), drop: r.drop };
      if (r.drop?.open) toast(`${ico("check", "sm")} ${tr("col.opened")}`, 6000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    collectBusy = false; renderHome(true); return;
  }
  const fo = e.target.closest("[data-colform]");
  if (fo) { try { const r = await post("/api/intake/form", { url: "" }); collect = { ...(collect || {}), form: r.form }; } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); } renderHome(true); }
});
document.addEventListener("submit", async (e) => {
  const fm = e.target.closest("[data-colformsave]"); if (!fm) return;
  e.preventDefault();
  try { const r = await post("/api/intake/form", { url: new FormData(fm).get("url") }); collect = { ...(collect || {}), form: r.form }; toast(`${ico("check", "sm")} ${tr("col.formsaved")}`, 4000); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  renderHome(true);
});
/* Where footage comes from: every place the studio reads, what kind of place it is (a Google Drive folder synced by
   Drive for desktop, a folder on this PC, the studio's own inbox for Google Photos picks and the drop box, the Google
   Form's upload folder), how many files it holds and when it was last checked. Always open: this is the page's map. */
function srcKind(x) {
  const pth = x.path || "";
  if (/\(File responses\)/i.test(pth)) return ["form", "src.k.form", "src.k.form.tip"];
  if (/[\\/]imports$/i.test(pth) || x.label === "Google Photos picks and collected footage") return ["inbox", "src.k.inbox", "src.k.inbox.tip"];
  if (/[\\/](My Drive|Shared drives|マイドライブ)[\\/]|Google ?Drive/i.test(pth)) return ["drive", "src.k.drive", "src.k.drive.tip"];
  return ["pc", "src.k.pc", "src.k.pc.tip"];
}
function srcPlace(pth) {
  const parts = String(pth || "").split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `${parts[0]}\\…\\${parts.slice(-2).join("\\")}` : String(pth || "");
}
/* The source map: where footage comes from, drawn like a mind map. The project sits in the middle; each footage
   place is a branch, a folder inside another place hangs off it, and the studio inbox splits into what fills it
   (Google Photos picks, the drop box, files dropped on this page). Colour and icon say the kind of place, the same
   as the Add cards above it: this computer, cloud, phones and other people. Each node: clips in the library, how
   many are unused, when it was last checked and whether the studio is watching it. Clicking a node opens its
   details and actions under the map. Under 640 px the map is a plain list. Counts come from /api/sources (files on
   disk) and the library itself (/api/library, read once and kept until something new is catalogued). */
const AH_KIND = { pc: { cls: "k-pc", icon: "home" }, cloud: { cls: "k-cloud", icon: "globe" }, people: { cls: "k-people", icon: "users" }, inbox: { cls: "k-inbox", icon: "download" } };
const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
foot.mapLib = null; foot.node = null; foot.seen = new Set(); foot.addMore = "";
function loadMapLib() {
  if (foot.mapLib || foot.mapLibLoading || foot.mapLibErr) return;
  foot.mapLibLoading = true;
  post("/api/library", { query: "", filters: {}, limit: 100000 })
    .then((r) => { foot.mapLib = (r.items || []).map((i) => ({ p: normPath(i.path), u: !(i.usedIn?.length || i.inVlogs?.length) })); })
    .catch((err) => { foot.mapLibErr = true; if (err.offline) foot.away = true; })  // no answer: "…", not "0 files" (BL-138); asked again once back
    .finally(() => { foot.mapLibLoading = false; if (atHome() && page === "footage") renderHome(true); });
}
function mapNodes() {
  const s = foot.src; if (!s) return null;
  const last = s.last || {}, w = s.watch || {}, g = foot.g || {}, d = collect?.drop || {};
  const counts = new Map((last.sources || []).map((x) => [x.path, x]));
  const folderStatus = (x, files) => !x.exists ? ["bad", tr("sm.st.error")] : (files == null && !last.checked) ? ["warn", tr("sm.st.never")] : w.every ? ["ok", tr("sm.st.watch")] : ["", tr("sm.st.manual")];
  const nodes = s.sources.map((x) => {
    const [k, kl] = srcKind(x), c = counts.get(x.path) || {};
    const kind = k === "drive" ? "cloud" : k === "form" ? "people" : k === "inbox" ? "inbox" : "pc";
    return { id: x.path, name: x.labelKey ? trR("src.l." + x.labelKey) : x.label, kind, sub: tr(kl), path: x.path, src: x, files: c.files ?? null, fresh: c.new || 0,
      match: ((p) => (q) => q.startsWith(p + "/"))(normPath(x.path)), status: folderStatus(x, c.files), kids: [], checked: last.checked };
  });
  // A place inside another place hangs off it (the longest parent wins).
  for (const n of nodes) {
    const np = normPath(n.path);
    n.parent = nodes.filter((o) => o !== n && np.startsWith(normPath(o.path) + "/")).sort((a, b) => b.path.length - a.path.length)[0] || null;
  }
  // The inbox splits into what fills it.
  const inboxPath = collect?.inbox ? collect.inbox.replace(/[\\/]collected[\\/]?$/i, "") : nodes.find((n) => n.kind === "inbox")?.path;
  const ib = inboxPath ? normPath(inboxPath) : null;
  const inbox = nodes.find((n) => n.kind === "inbox") || null;
  const dropped = /^\d{4}-\d{2}-\d{2}_dropped$/;
  const until = d.open ? new Date(d.until).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const busyUp = uploads.some((u) => u.state === "up" || u.state === "wait");
  const syn = ib ? [
    { id: "gphotos", name: "Google Photos", kind: "cloud", sub: tr("src.k.gphotos"), path: inboxPath + "\\google-photos", account: g.account || "",
      match: (q) => q.startsWith(ib + "/google-photos/"), status: g.connected ? ["ok", tr("sm.st.pick")] : ["warn", tr("sm.st.noconn")], kids: [], checked: null },
    { id: "dropbox", name: tr("col.drop"), kind: "people", sub: tr("sm.k.dropbox"), path: inboxPath + "\\collected",
      match: (q) => q.startsWith(ib + "/collected/") && !dropped.test(q.slice(ib.length + 11).split("/")[0]), status: d.open ? ["live", tr("sm.st.open", { t: until })] : ["", tr("sm.st.closed")], kids: [], checked: d.lastAt || null },
    { id: "uploads", name: tr("sm.uploads"), kind: "pc", sub: tr("sm.k.uploads"), path: inboxPath + "\\collected",
      match: (q) => q.startsWith(ib + "/collected/") && dropped.test(q.slice(ib.length + 11).split("/")[0]), status: busyUp ? ["live", tr("sm.st.receiving")] : ["ok", tr("sm.st.ready")], kids: [], checked: null },
  ] : [];
  for (const n of syn) n.parent = inbox;
  const all = [...nodes, ...syn];
  // Clips and unused clips from the library; a parent counts what is in its children too.
  if (foot.mapLib) for (const n of all) { const mine = foot.mapLib.filter((i) => n.match(i.p)); n.clips = mine.length; n.unused = mine.filter((i) => i.u).length; }
  for (const n of all) if (n.parent) n.parent.kids.push(n);
  const top = all.filter((n) => !n.parent);
  const ord = { cloud: 0, pc: 1, inbox: 2, people: 3 };
  top.sort((a, b) => ord[a.kind] - ord[b.kind]);
  return { all, top };
}
