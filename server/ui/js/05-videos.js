/* ---------- Long videos (GET /api/vlogs, py/studio/vlog.py) ----------
   A trip, in parts of 5-10 minutes for YouTube: plan it (by day, chapters named from the pictures), build each part,
   watch it here, copy its title and description (with chapters) and upload it yourself. Nothing is posted by itself. */
let vlogView = null, vlogLoading = false, vlogPlay = null, vlogTimer = null;
async function loadVlogs() {
  if (vlogLoading) return; vlogLoading = true;
  try { vlogView = await api("/api/vlogs"); } catch (err) { vlogView = vlogView || { parts: [], error: err.message }; }
  vlogLoading = false;
  clearTimeout(vlogTimer);
  if (vlogView.planning || vlogView.parts?.some((p) => p.job?.status === "running" || p.job?.status === "queued" || p.upload?.status === "running")) vlogTimer = setTimeout(loadVlogs, 4000);
  const vsig = JSON.stringify((vlogView?.parts || []).map((p) => [p.n, p.built?.made || ""]));
  if (page === "videos" || (page === "reels" && vsig !== vlogRowSig)) { vlogRowSig = vsig; renderHome(true); }
}
/* A project with no short reels yet: one line and the way to make them. The page around it is the same as in every
   other project (owner, 14 Nov: "why are the pages for different projects displayed differently?"); its long videos
   are the row below (vlogRowHtml), as in every project. */
let vlogRowSig = "";
function firstHtml() {
  if (!vlogView && !vlogLoading) loadVlogs();
  const built = (vlogView?.parts || []).some((p) => p.built);
  return `<div class="empty mascot first${built ? " slim" : ""}">${kenji(built ? "point" : "wave")}<b>${tr(built ? "home.noshort" : "home.first")}</b><span>${tr(built ? "home.noshorthint" : "home.firsthint")}</span>
    <button class="primary" data-openmaker>${ico("clapper", "sm")}${tr("act.make")}</button></div>`;
}
/* Long videos on the Reels page, one row like a reel group, in every project that has any. Play opens the part on
   Long videos, already playing. */
function vlogRowHtml() {
  if (!vlogView && !vlogLoading) loadVlogs();
  const built = (vlogView?.parts || []).filter((p) => p.built);
  if (!built.length) return "";
  const id = "videos", fold = reelFold.has(id), t = { icon: "film", hue: 265 };
  return `<section class="rgroup vlrow${fold ? " folded" : ""}" style="--h:${t.hue}">
    <button class="rg-head" data-rfold="${id}" aria-expanded="${!fold}">${kTile(t)}<h2>${tr("grp.videos")}</h2><span class="rg-n">${built.length}</span><span class="rg-rule"></span>${ico(fold ? "chev-r" : "chev-u", "sm")}</button>
    ${fold ? "" : `<div class="vlrowgrid">${built.map((p) => `<a class="vltile" href="#/videos" data-vlopen="${p.n}" aria-label="${esc(`${tr("vid.watch")} · ${tr("vid.part", { n: p.n })} · ${p.title}`)}">
      <i style="background-image:url('/api/vlogs/file?n=${p.n}&kind=thumb&v=${encodeURIComponent(p.built.made || "")}')"><span class="qplay" aria-hidden="true">${ico("play")}</span><span class="chip dur">${mmss(p.built.seconds)}</span></i>
      <b>${esc(p.title)}</b><span class="meta">${tr("vid.part", { n: p.n })}</span></a>`).join("")}</div>`}</section>`;
}
document.addEventListener("click", (e) => {
  const v = e.target.closest?.("[data-vlopen]"); if (!v) return;
  vlogPlay = Number(v.dataset.vlopen);
  location.hash = "#/videos";
  setTimeout(() => document.getElementById("vl-" + v.dataset.vlopen)?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
});
/* Quick play (owner, 14 Nov): every made reel plays on its own card. The play button plays the 9:16 film there with
   sound and controls, one at a time, and it keeps its place when the page redraws. With a mouse, moving across a
   card's picture scrubs through the reel (batch C, below: cScrub). */
let qplay = null;  // {slug, t}
const reelVid = (r) => (r.rendered && r.hook ? file(r.hook.replace(/hook\.jpg$/, r.slug + "_9x16.mp4")) + "&v=" + (r.updated || 0) : "");
function quickPlayHtml(r) {
  const vid = reelVid(r);
  if (!vid || busyJob(r)) return "";
  if (qplay?.slug === r.slug) return `<video class="qvid" data-qvid="${esc(r.slug)}" src="${vid}#t=${qplay.t || 0}" autoplay playsinline controls></video>
    <button class="qclose" data-qplay="${esc(r.slug)}" aria-label="${esc(tr("card.stop"))}" title="${esc(tr("card.stop"))}">${ico("x", "sm")}</button>`;
  return `<button class="qplay" data-qplay="${esc(r.slug)}" aria-label="${esc(tr("card.play"))}" title="${esc(tr("card.play"))}">${ico("play")}</button>`;
}
let qplayEl = null;
function keepQuickPlay() {
  if (!qplay) { qplayEl = null; return; }
  const slots = [...document.querySelectorAll(".qvid[data-qvid]")].filter((v) => v.dataset.qvid === qplay.slug);
  slots.slice(1).forEach((v) => {  // the same reel twice on the page (waiting row and its group): one player
    v.nextElementSibling?.matches(".qclose") && v.nextElementSibling.remove();
    v.insertAdjacentHTML("afterend", `<button class="qplay" data-qplay="${esc(qplay.slug)}" aria-label="${esc(tr("card.play"))}" title="${esc(tr("card.play"))}">${ico("play")}</button>`);
    v.remove();
  });
  const slot = slots[0];
  if (!slot) return;
  if (qplayEl && qplayEl !== slot && qplayEl.dataset.qvid === qplay.slug) slot.replaceWith(qplayEl);
  else qplayEl = slot;
}
document.addEventListener("click", (e) => {
  const q = e.target.closest?.("[data-qplay]"); if (!q) return;
  e.preventDefault();
  stopHover();
  qplay = qplay?.slug === q.dataset.qplay ? null : { slug: q.dataset.qplay, t: 0 };
  renderHome(true);
});
document.addEventListener("timeupdate", (e) => {
  if (e.target.matches?.(".qvid[data-qvid]") && qplay?.slug === e.target.dataset.qvid) qplay.t = Math.floor(e.target.currentTime);
}, true);
/* Hover-scrub (batch C, 18 Nov; reel cards on Reels and Being made, and the review rows): moving the mouse across the
   picture scrubs through the reel. The muted video is made only on hover (preload none until then), so 240 cards load
   nothing up front; it shows once its first frame is ready and the cover stays under it until then. Keyboard and touch
   keep the normal click (open the reel, or play it with the play button). Replaces the silent hover play. */
const cScrub = { host: null, v: null, bar: null, t: 0, frac: 0, want: null };
function cScrubStop() {
  clearTimeout(cScrub.t);
  if (cScrub.v) { cScrub.v.removeAttribute("src"); cScrub.v.load(); cScrub.v.remove(); }
  cScrub.bar?.remove(); cScrub.host?.classList.remove("c-scrubbing");
  Object.assign(cScrub, { host: null, v: null, bar: null, want: null });
}
function stopHover() { cScrubStop(); }  // the quick player calls this before it plays
function cScrubStart(host) {
  if (cScrub.host !== host || !host.isConnected || cScrub.v) return;
  const src = host.dataset.vid || host.closest(".rcard")?.dataset.vid; if (!src) return;
  const v = document.createElement("video");
  Object.assign(v, { className: "qvid hover c-scrubv", muted: true, playsInline: true, preload: "none" });
  v.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span"); bar.className = "c-scrubbar"; bar.setAttribute("aria-hidden", "true"); bar.innerHTML = "<i></i><b></b>";
  bar.style.setProperty("--f", cScrub.frac.toFixed(3));
  host.append(v, bar); host.classList.add("c-scrubbing");
  Object.assign(cScrub, { v, bar });
  v.addEventListener("loadedmetadata", cScrubSeek, { once: true });
  v.addEventListener("seeked", () => { v.classList.add("on"); if (cScrub.want != null && cScrub.v === v) { const w = cScrub.want; cScrub.want = null; v.currentTime = w; } });
  v.src = src; v.preload = "auto";  // now, on hover, it loads
}
function cScrubSeek() {
  const v = cScrub.v; if (!v || !(v.duration > 0)) return;
  const t = cScrub.frac * Math.max(0, v.duration - 0.05);
  if (cScrub.bar) cScrub.bar.querySelector("b").textContent = `${mmss(t)} / ${mmss(v.duration)}`;
  if (v.seeking) { cScrub.want = t; return; }
  v.currentTime = t;
}
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const host = e.target.closest?.(".rcard[data-vid] .thumb, .rvposter[data-vid]");
  if (host === cScrub.host) return;
  cScrubStop();
  if (!host || host.querySelector(".qvid:not(.c-scrubv)")) return;  // the quick player is open on it
  cScrub.host = host;
  cScrub.t = setTimeout(() => cScrubStart(host), 140);  // passing over a card on the way elsewhere loads nothing
});
document.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || !cScrub.host) return;
  const r = cScrub.host.getBoundingClientRect(); if (!r.width) return;
  cScrub.frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  cScrub.bar?.style.setProperty("--f", cScrub.frac.toFixed(3));
  cScrubSeek();
}, { passive: true });
document.addEventListener("pointerout", (e) => { if (cScrub.host && !cScrub.host.contains(e.relatedTarget)) cScrubStop(); });
const STAGE = { rendering: "vid.sg.render", "getting footage ready": "vid.sg.prep", preparing: "vid.sg.prep", checking: "vid.sg.check", music: "vid.sg.music" };
const shortDay = (d, year) => new Date(d + "T12:00:00").toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
/* "29 May – 4 Jul", with the years when the range crosses one or is not this year's. */
const dayRange = (a, b) => { const y = a.slice(0, 4) !== b.slice(0, 4) || a.slice(0, 4) !== String(new Date().getFullYear()); return `${shortDay(a, y)} – ${shortDay(b, y)}`; };
const mmss = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };  // 599.6 s is 10:00, not 9:60
/* The state of every video in one line, and the one thing to do next (watch the newest ready one). */
function vlogSumHtml(v) {
  const parts = v.parts, n = parts.length;
  const live = parts.find((p) => p.job && p.job.status !== "error");
  const waits = v.chain ? parts.filter((p) => p !== live && p.n >= v.chain.next && p.n <= v.chain.last) : [];
  const failed = parts.filter((p) => p.job?.status === "error");
  const ready = parts.filter((p) => p.built && p !== live && !waits.includes(p) && !failed.includes(p) && !(v.plan?.made && p.built.made < v.plan.made));
  const left = Math.round(((live?.job?.eta) || 0) + waits.reduce((a, p) => a + (p.estSec || 300) * 6, 0));  // this PC: ~6 s of work per second of film
  const span = left >= 5400 ? tr("vid.hours", { n: Math.round(left / 1800) / 2 }) : tr("vid.mins", { n: Math.max(1, Math.round(left / 60)) });
  const seg = (k, cls) => (k ? `<i class="${cls}" style="flex:${k}"></i>` : "");
  // a part already on YouTube is done, not "ready to upload": the next step is the newest one that is not up yet
  const onYt = ready.filter((p) => p.uploaded), toUp = ready.filter((p) => !p.uploaded);
  const newest = [...toUp].sort((a, b) => String(b.built.made).localeCompare(String(a.built.made)))[0];
  return `<section class="vlsum" aria-label="${esc(tr("vid.sumh", { n }))}">
    <div class="row wrap"><b class="vlsumh">${tr("vid.sumh", { n })}</b>
      ${onYt.length ? `<span class="chip ok">${tr("vid.sumon", { n: onYt.length })}</span>` : ""}${toUp.length || !onYt.length ? `<span class="chip ${onYt.length ? "" : "ok"}">${tr("vid.sumready", { n: toUp.length })}</span>` : ""}
      ${live ? `<span class="chip warn">${tr("vid.summaking", { n: live.n, p: live.job.pct || 0 })}</span>` : ""}
      ${waits.length ? `<span class="chip">${tr("vid.sumwait", { n: waits.length })}</span>` : ""}
      ${failed.length ? `<span class="chip bad">${tr("vid.sumfail", { n: failed.length })}</span>` : ""}
      <span class="grow"></span>${live || waits.length ? `<span class="meta">${ico("clock", "sm")} ${tr("vid.sumdone", { t: span })}</span>` : ""}</div>
    <div class="vlsumbar" role="img" aria-label="${esc(tr("vid.sumready", { n: ready.length }))}">${seg(ready.length, "r")}${seg(live ? 1 : 0, "m")}${seg(waits.length, "w")}${seg(Math.max(0, n - ready.length - (live ? 1 : 0) - waits.length), "o")}</div>
    <p class="meta">${newest ? `${tr("vid.sumnext", { n: newest.n })} <button class="linkbtn" data-vlplay="${newest.n}" data-vlgo="${newest.n}">${tr("vid.watchn", { n: newest.n })}</button>` : onYt.length && !live && !waits.length ? tr("vid.sumallup") : tr("vid.sumfirst")}</p></section>`;
}
/* Long videos to YouTube: which of the project's YouTube accounts, who can see them, and an optional schedule (saved per
   project, POST /api/vlogs/youtube); each part then uploads with one press, or all ready ones at once. */
let ytAccounts = null, ytAccountsLoading = false;
async function loadYtAccounts() {
  if (ytAccountsLoading) return; ytAccountsLoading = true;
  try { ytAccounts = (await api("/api/youtube/accounts")).accounts || []; } catch { ytAccounts = []; }
  ytAccountsLoading = false;
  if (page === "videos") renderHome(true);
}
const VYT_P = { private: "vyt.p.private", unlisted: "vyt.p.unlisted", public: "vyt.p.public" };
const VYT_HOW = { private: "vyt.how.private", unlisted: "vyt.how.unlisted", public: "vyt.how.public" };
const VYT_ASK = { private: "vyt.ask.private", unlisted: "vyt.ask.unlisted", public: "vyt.ask.public" };
const acctName = (a) => a ? `${a.channel || a.email || a.id}${a.handle ? " " + a.handle : ""}` : "";
function vlogYtHtml(v) {
  if (ytAccounts == null) { loadYtAccounts(); return `<section class="vlyt"><div class="skel skel-line" style="width:50%"></div></section>`; }
  // Ready: built from the current plan (a greyed-out build of an earlier plan is not offered), not up yet.
  const current = (p) => !(p.built?.made && v.plan?.made && p.built.made < v.plan.made);
  const s = v.youtube || {}, ready = v.parts.filter((p) => p.built && current(p) && !p.uploaded && !p.upload);
  const uploading = v.parts.filter((p) => p.upload && p.upload.status !== "error");
  if (!ytAccounts.length) return `<section class="vlyt"><div class="row wrap"><b>${ico("play", "sm")} ${tr("vyt.h")}</b><span class="meta">${tr("vyt.none")}</span>
    <a class="btn primary" href="/api/youtube/connect?account=new">${ico("play", "sm")}${tr("vyt.connect")}</a></div></section>`;
  const on = ytAccounts.find((a) => a.id === s.account) || ytAccounts[0];
  return `<section class="vlyt" aria-label="${esc(tr("vyt.h"))}">
    <div class="row wrap"><b>${ico("play", "sm")} ${tr("vyt.h")}</b>
      <label class="meta">${tr("vyt.account")} <select data-vyt="account">${ytAccounts.map((a) => `<option value="${esc(a.id)}" ${a.id === on.id ? "selected" : ""}>${esc(acctName(a))}${a.shorts ? ` (${esc(tr("vyt.shorts"))})` : ""}</option>`).join("")}</select></label>
      <a class="btn" href="/api/youtube/connect?account=new">${ico("plus", "sm")}${tr("vyt.another")}</a>
      <label class="meta">${tr("vyt.privacy")} <select data-vyt="privacy">${["private", "unlisted", "public"].map((x) => `<option value="${x}" ${s.privacy === x ? "selected" : ""}>${tr(VYT_P[x])}</option>`).join("")}</select></label></div>
    <div class="row wrap"><label class="meta"><input type="checkbox" data-vyt="schedule" ${s.schedule ? "checked" : ""}> ${tr("vyt.schedule")}</label>
      ${s.schedule ? `<label class="meta">${tr("vyt.from")} <input type="datetime-local" data-vyt="startAt" value="${esc(s.startAt || "")}"></label>
        <label class="meta">${tr("vyt.every")} <input type="number" min="1" max="60" data-vyt="everyDays" value="${s.everyDays || 2}" style="width:5em"> ${tr("vyt.days")}</label>` : ""}
      <span class="grow"></span>
      ${uploading.length ? `<span class="chip warn">${tr("vyt.uploading", { n: uploading.length })}</span>` : ready.length ? `<button class="primary" data-vytall="1">${ico("play", "sm")}${tr("vyt.all", { n: ready.length })}</button>` : ""}</div>
    <p class="meta">${tr(s.schedule ? "vyt.howsched" : VYT_HOW[s.privacy] || VYT_HOW.unlisted, { a: esc(acctName(on)) })}</p></section>`;
}
function vlogYtButton(p, plan) {
  if (p.uploaded || (p.upload && p.upload.status !== "error") || !ytAccounts?.length) return "";
  if (p.built?.made && plan?.made && p.built.made < plan.made) return "";  // an earlier plan's cut: build it again first
  return `<button data-vyt1="${p.n}">${ico("play", "sm")}${tr("vyt.one")}</button>`;
}
function vlogYtState(p) {
  if (p.uploaded) {
    const u = p.uploaded, acct = ytAccounts?.find((a) => a.id === u.account);
    const when = u.publishAt ? tr("vyt.st.at", { t: whenText(u.publishAt) }) : tr(VYT_P[u.privacy] || VYT_P.unlisted);
    return `<p class="meta">${ico("check", "sm")} ${tr("vyt.st.on")} · ${esc(when)}${acct ? ` · ${esc(acctName(acct))}` : ""} · <a href="${escUrl(u.url)}" target="_blank" rel="noopener">${esc(u.url)}</a>${/thumbnail not set/.test(u.note || "") ? ` · <span class="warn">${tr("vyt.nothumb")}</span>` : ""}</p>`;
  }
  if (p.upload?.status === "error") return `<p class="bad">${ico("alert", "sm")} ${tr("vyt.st.fail")}: ${esc(p.upload.label)}</p>`;
  if (p.upload) return `<div class="vlprog"><div class="bar"><i style="width:${p.upload.pct || 0}%"></i></div><span class="meta">${tr("vyt.st.up")} · ${p.upload.pct || 0}%</span></div>`;
  return "";
}
document.addEventListener("change", async (e) => {
  const f = e.target.closest?.("[data-vyt]"); if (!f || !vlogView) return;
  const k = f.dataset.vyt, value = f.type === "checkbox" ? f.checked : k === "everyDays" ? Number(f.value) : f.value;
  try { vlogView.youtube = await post("/api/vlogs/youtube", { settings: { [k]: value } }); renderHome(true); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
document.addEventListener("click", async (e) => {
  const one = e.target.closest?.("[data-vyt1]"), all = e.target.closest?.("[data-vytall]");
  if ((!one && !all) || !vlogView) return;
  const parts = one ? [Number(one.dataset.vyt1)] : vlogView.parts.filter((p) => p.built && !p.uploaded && !p.upload).map((p) => p.n);
  const s = vlogView.youtube || {}, acct = ytAccounts?.find((a) => a.id === s.account) || ytAccounts?.[0];
  if (!confirm(tr(s.schedule ? "vyt.asksched" : VYT_ASK[s.privacy] || VYT_ASK.unlisted, { n: parts.length, a: acctName(acct) }))) return;
  (one || all).disabled = true;
  try { await post("/api/vlogs/youtube", { upload: parts }); toast(`${ico("play", "sm")} ${tr("vyt.started", { n: parts.length })}`, 6000); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  loadVlogs();
});
/* A series on YouTube: the link pass (playlist in order, links in every description) and what only YouTube Studio
   can do (end screens, pinning, official series, Shorts' related video, going public), one tick per step (kept in
   vlog-youtube.json). Each link opens the right Studio page for that part. */
function vlogStudioHtml(v) {
  if (!v.plan?.series) return "";
  const parts = v.parts.filter((p) => p.series), up = parts.filter((p) => p.uploaded);
  if (!up.length) return "";
  const ticks = v.youtube?.ticks || {}, pl = v.seriesLinks?.playlist, all = up.length === parts.length;
  const tick = (k, label, href) => `<label class="chk"><input type="checkbox" data-vtick="${k}" ${ticks[k] ? "checked" : ""}> ${href ? `<a href="${escUrl(href)}" target="_blank" rel="noopener">${label}</a>` : label}</label>`;
  const studio = (id, page) => `https://studio.youtube.com/video/${encodeURIComponent(id)}/${page}`;
  return `<section class="vlyt vlstudio" aria-label="${esc(tr("vst.h"))}">
    <div class="row wrap"><b>${ico("check", "sm")} ${tr("vst.h")}</b><span class="grow"></span>
      ${all ? `<button data-vslink="1" title="${esc(tr("vst.linktip"))}">${ico("link", "sm")}${tr(pl ? "vst.relink" : "vst.link")}</button>
        <button data-vscomments="1" title="${esc(tr("vst.commentstip"))}">${ico("send", "sm")}${tr("vst.comments")}</button>` : `<span class="meta">${tr(parts.length - up.length === 1 ? "vst.waitall1" : "vst.waitall", { n: parts.length - up.length })}</span>`}</div>
    <p class="meta">${tr("vst.why")}</p>
    ${pl ? `<div class="row wrap">${tick("playlist", tr("vst.playlist"), "https://www.youtube.com/playlist?list=" + pl)} ${tick("series", tr("vst.official"))}</div>` : ""}
    <ul class="vlch">${up.map((p) => `<li><b>${tr("vst.part", { n: p.n, of: p.series.of })}</b> ${tick(`p${p.n}-end`, tr("vst.end"), studio(p.uploaded.id, "editor"))}
      ${tick(`p${p.n}-pin`, tr("vst.pin"), studio(p.uploaded.id, "comments"))} ${tick(`p${p.n}-shorts`, tr("vst.shorts"))} ${tick(`p${p.n}-public`, tr("vst.public"), studio(p.uploaded.id, "edit"))}</li>`).join("")}</ul></section>`;
}
document.addEventListener("change", async (e) => {
  const f = e.target.closest?.("[data-vtick]"); if (!f || !vlogView) return;
  try { vlogView.youtube = await post("/api/vlogs/youtube", { settings: { ticks: { [f.dataset.vtick]: f.checked } } }); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
document.addEventListener("click", async (e) => {
  const ln = e.target.closest?.("[data-vslink]"), cm = e.target.closest?.("[data-vscomments]");
  if (!ln && !cm) return;
  (ln || cm).disabled = true;
  try {
    const r = await post("/api/vlogs/series-links", cm ? { comments: true } : {});
    toast(`${ico("check", "sm")} ${cm ? tr("vst.commented", { n: (r.commented || []).length }) : tr("vst.linked", { n: (r.updated || []).length })}`, 8000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 10000); }
  loadVlogs();
});
let vlogShowPlanner = false;
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-vlshow]")) { vlogShowPlanner = true; renderHome(true); } });
function renderVideos() {
  const head = `<div class="pagehead">${crumbs([tr("nav.videos")])}</div>`;
  if (!vlogView) { $("#home").innerHTML = head + loadingHtml(tr("nav.videos")); loadVlogs(); return; }
  const v = vlogView, busy = !!v.planning || v.parts.some((p) => p.job && p.job.status !== "error");
  const form = `<form class="vlplan" data-vlplan="1">
    <p class="note">${tr("vid.intro")}</p>
    <div class="row wrap"><label>${tr("vid.parts")} <input name="parts" type="number" min="1" max="8" value="${v.plan?.parts || 4}"></label>
      <label>${tr("vid.minutes")} <input name="minutes" type="number" min="3" max="15" step="0.5" value="${v.plan?.minutes || 8}"></label>
      <label class="grow">${tr("vid.name")} <input name="name" maxlength="40" value="${esc(v.plan?.name || "")}" placeholder="${esc(tr("vid.nameph"))}"></label>
      <button class="${v.plan ? "" : "primary"}" type="submit" ${busy ? "disabled" : ""} title="${esc(v.plan ? tr("vid.replantip") : "")}">${ico("cal", "sm")}${tr(v.plan ? "vid.replan" : "vid.plan")}</button></div>
    <p class="meta">${tr("vid.cost")}</p>
    ${v.planning ? `<p class="meta">${ico("clock", "sm")} ${esc(v.planning.label || tr("vid.planning"))}</p>` : ""}
    ${v.planError ? `<p class="bad">${ico("alert", "sm")} ${esc(v.planError)}</p>` : ""}</form>`;
  const card = (p) => {
    const b = p.built, j = p.job;
    const old = !!(b && b.made && v.plan?.made && b.made < v.plan.made);  // made before the plan was changed
    const live = !!(j && j.status !== "error");                              // this part is being built now
    const waits = !live && !!v.chain && p.n >= v.chain.next && p.n <= v.chain.last;  // in line behind the one building
    const before = v.parts.filter((q) => q.job && q.job.status !== "error").length + Math.max(0, p.n - (v.chain?.next ?? p.n));
    const state = live ? (b ? "vid.st.redo" : "") : waits ? (b ? "vid.st.waitold" : "vid.st.wait") : old ? "vid.oldplan" : "";
    const chapters = b ? b.chapters.map((c) => `<li><span class="mono">${mmss(c.at)}</span> ${esc(c.title)}</li>`).join("")
      : p.chapters.map((c) => `<li><span class="mono">${esc(shortDay(c.day))}</span> ${esc(c.title)} <span class="meta">· ${c.shots}</span></li>`).join("");
    const status = j ? (j.status === "error" ? `<p class="bad">${ico("alert", "sm")} ${esc(jobLabel(j.label))}</p>`
        : `<div class="vlprog"><div class="bar"><i style="width:${j.pct || 0}%"></i></div><span class="meta">${esc(STAGE[j.label] ? tr(STAGE[j.label]) : /shots to \d/.test(j.label || "") ? tr("vid.sg.prep") : /^rendering/.test(j.label || "") ? tr("vid.sg.render")
          : /music and mix/.test(j.label || "") ? tr("vid.sg.music") : /quality check/.test(j.label || "") ? tr("vid.sg.check") : j.label || tr("vid.building"))} · ${j.pct || 0}%${j.eta != null ? ` · ${mins(j.eta)}` : ""}${b ? ` · ${tr("vid.keepold")}` : ""}</span></div>`)
      : waits ? `<p class="meta">${ico("hourglass", "sm")} ${tr(before > 1 ? "vid.inline" : "vid.inline1", { n: before })}${b ? ` · ${tr("vid.keepold")}` : ""}</p>`
      : b ? `<p class="meta ${b.qaOk ? "" : "bad"}">${ico(b.qaOk ? "check" : "alert", "sm")} ${b.qaOk ? tr("vid.qaok") : esc(b.qa.map((c) => c.found).join(" · "))} · ${mmss(b.seconds)} · ${b.mb} MB${b.target ? ` · <span class="${b.lengthOk ? "" : "warn"}">${tr(b.lengthOk ? "vid.len.ok" : "vid.len.off", { m: b.target })}</span>` : ""}</p>` : "";
    const play = vlogPlay === p.n && b ? `<video class="vlvid" controls preload="metadata" src="/api/vlogs/file?n=${p.n}&kind=master&v=${encodeURIComponent(b.made || "")}"></video>` : "";
    return `<article class="vlcard${state && b ? " stale" : ""}" id="vl-${p.n}">
      <div class="vlthumb" ${b ? `style="background-image:url('/api/vlogs/file?n=${p.n}&kind=thumb&v=${encodeURIComponent(b.made || "")}')"` : ""}>${b ? `<button class="vlplay" data-vlplay="${p.n}" aria-label="${esc(tr("vid.watch"))}">${ico("play")}</button>` : `<span class="meta">${j && j.status !== "error" ? `${tr("vid.building")} ${j.pct || 0}%` : tr("vid.notbuilt")}</span>`}</div>
      <div class="vlbody"><b>${esc(p.title)}</b>
        <p class="meta">${p.look && LOOKN[p.look] ? `<span class="chip">${tr(LOOKN[p.look][0])}</span> ` : ""}${state ? `<span class="chip warn">${tr(state)}</span> ` : ""}${p.series ? tr("vs.ep", { n: p.n, of: p.series.of }) : tr("vid.part", { n: p.n })} · ${esc(p.span || p.days.join(", "))} · ${b ? mmss(b.seconds) : "≈ " + mmss(p.estSec)} · ${b?.mix ? tr("vid.mix", { v: b.mix.videos, p: b.mix.photos, s: b.mix.videoPct }) : tr("vid.shots", { n: p.shots })}</p>
        ${p.summary ? `<p class="note">${esc(p.summary)}</p>` : ""}
        <details class="vlchd"><summary>${tr("vid.chapters", { n: b ? b.chapters.length : p.chapters.length })}</summary><ul class="vlch">${chapters}</ul></details>
        ${status}${play}
        <div class="row wrap">
          ${live ? `<button data-cancel="vlog-${p.n}" title="${esc(tr("vid.stoptip"))}">${ico("x", "sm")}${tr("vid.stop")}</button>` : ""}
          ${live || busy ? "" : `<button class="${b && !old ? "" : "primary"}" data-vlbuild="${p.n}">${ico("clapper", "sm")}${tr(b && !old ? "vid.rebuild" : "vid.build")}</button>${(() => {
            // BL-068: the same estimate as the summary line (~6 s of work per second of film on this PC)
            const est = Math.round((b?.seconds || p.estSec || 300) * 6);
            return `<span class="meta">${ico("clock", "sm")} ${tr("ux2.vl.est", { t: est >= 5400 ? tr("vid.hours", { n: Math.round(est / 1800) / 2 }) : tr("vid.mins", { n: Math.max(1, Math.round(est / 60)) }) })}</span>`; })()}`}
          ${b ? `<button data-vlcopy="${p.n}">${ico("copy", "sm")}${tr("vid.copy")}</button><a class="btn" href="/api/vlogs/file?n=${p.n}&kind=master" download="${esc(p.slug)}.mp4">${ico("download", "sm")}${tr("vid.download")}</a>${b.subs ? `<a class="btn" href="/api/vlogs/file?n=${p.n}&kind=srt" download="${esc(p.slug)}.srt" title="${esc(tr("vid.srttip"))}">${ico("type", "sm")}${tr("vid.srt", { n: b.subs })}</a>` : ""}
            ${vlogYtButton(p, v.plan)}` : ""}
        </div>${vlogYtState(p)}</div></article>`;
  };
  if (!v.parts.length) {
    // Nothing planned yet. A new person (and a campsite that films one day at a time) met a 49-day trip planner here:
    // say what long videos are first, and open the planner on request (fresh-user review, 15 Nov).
    if (!vlogShowPlanner && !v.planning) {
      $("#home").innerHTML = `${head}<div class="empty mascot">${kenji("point")}<b>${tr("vid.what")}</b><span>${tr("vid.whatwhy")}</span>
        <button class="primary" data-vlshow="1">${ico("cal", "sm")}${tr("vid.start")}</button></div><p class="meta">${tr("vid.cost")}</p>`;
      return;
    }
    $("#home").innerHTML = `${head}${vlogPlannerHtml(v, busy, form)}<p class="note">${tr("vid.none")}</p>`;
    return;
  }
  const yard = vs.data?.coverage;
  $("#home").innerHTML = `${head}${vlogSumHtml(v)}${vlogYtHtml(v)}${vlogStudioHtml(v)}
    <div class="vllist">${v.parts.map(card).join("")}</div>
    <details class="vsmore" ${vs.moreOpen ? "open" : ""} data-vsmore="1"><summary><b>${ico("plus", "sm")} ${tr("vid.more")}</b>
      <span class="meta">${yard?.more ? tr("vs.yard.more", { n: yard.more }) : tr("vid.morewhy")}</span></summary>${vlogPlannerHtml(v, busy, form)}</details>`;
}
document.addEventListener("toggle", (e) => { if (e.target.matches?.("[data-vsmore]")) vs.moreOpen = e.target.open; if (e.target.matches?.("[data-vslooks]")) vs.looksOpen = e.target.open; }, true);
document.addEventListener("click", (e) => { const d = e.target.closest?.("[data-vsdays] > summary")?.parentElement; if (d) vs.daysOpen = !d.open; });
/* The project's home place in words (Footage › brand), or "" for a project without one (a trip). */
function homeName() {
  if (!brandView) { if (!homeName.asked) { homeName.asked = true; api("/api/brand").then((b) => { brandView = b; if (page === "videos") renderHome(true); }).catch(() => {}); } return ""; }
  const names = brandView.place?.names || [];
  const n = (lang === "ja" ? names.find((x) => /[^\x00-\x7f]/.test(x)) : names.find((x) => /^[\x00-\x7f]+$/.test(x))) || names[0] || "";
  return n && /^[a-z]/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}
const VS_COUNTRIES = ["Argentina", "Australia", "Austria", "Botswana", "Brazil", "Cambodia", "Canada", "Chile", "China", "Egypt", "Ethiopia", "France", "Germany", "Greece", "Iceland", "India", "Indonesia", "Italy", "Japan", "Kenya", "Malaysia", "Mexico", "Morocco", "Namibia", "Nepal", "Netherlands", "New Zealand", "Norway", "Peru", "Philippines", "Portugal", "Qatar", "Rwanda", "Singapore", "South Africa", "South Korea", "Spain", "Sri Lanka", "Switzerland", "Taiwan", "Tanzania", "Thailand", "Turkey", "Uganda", "United Arab Emirates", "United Kingdom", "United States", "Vietnam", "Zambia", "Zimbabwe"];
const VS_FEW = 7;  // days shown before "Show all": a long stretch of footage is a long form
document.addEventListener("change", async (e) => {
  // "Length of each episode": kept in the trip notes, and the series is worked out again for it.
  const f = e.target.closest?.("[data-vslen]"); if (!f) return;
  const m = Number(f.value);
  if (!(m >= 5 && m <= 15)) { toast(`${ico("alert", "sm")} ${tr("vs.lenbad")}`, 5000); return; }
  try { await post("/api/vlogs/trip", { target: m }); vs.target = m; vs.data = null; vs.arm = null; if (vlogView?.trip) vlogView.trip.target = m; loadSuggest(); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-vlplan]"); if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  try {
    await post("/api/vlogs/plan", { parts: Number(fd.get("parts")), minutes: Number(fd.get("minutes")), name: String(fd.get("name") || "").trim() });
    toast(`${ico("cal", "sm")} ${tr("vid.planstarted")}`, 6000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  loadVlogs();
});
document.addEventListener("click", async (e) => {
  const bld = e.target.closest("[data-vlbuild]"), cp = e.target.closest("[data-vlcopy]"), pl = e.target.closest("[data-vlplay]");
  if (pl) {
    vlogPlay = pl.dataset.vlgo ? Number(pl.dataset.vlplay) : vlogPlay === Number(pl.dataset.vlplay) ? null : Number(pl.dataset.vlplay);
    renderHome(true);
    if (pl.dataset.vlgo) document.getElementById("vl-" + pl.dataset.vlgo)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (cp) {
    const p = vlogView?.parts.find((x) => x.n === Number(cp.dataset.vlcopy));
    try { await navigator.clipboard.writeText(`${p.title}\n\n${p.built.description}`); toast(`${ico("check", "sm")} ${tr("vid.copied")}`, 3000); }
    catch { toast(`${ico("alert", "sm")} ${tr("vid.nocopy")}`, 5000); }
    return;
  }
  if (bld) {
    try { await post("/api/vlogs/build", { n: Number(bld.dataset.vlbuild) }); toast(`${ico("clapper", "sm")} ${tr("vid.buildstarted")}`, 6000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    loadVlogs();
  }
});
/* The planner on Long videos (GET /api/vlogs/suggest, /api/vlogs/trip): what the footage holds per day, where each day
   was (the person says; there is no GPS to read), which words go on screen, and plans made by a dry run of the real
   picker with honest numbers (minutes, share of moving footage, weak parts, cost, build time). One press makes one. */
const vs = { style: "documentary", data: null, loading: false, error: null, arm: null };
const LOOKN = { documentary: ["vs.l.documentary", "vs.l.documentary.why"], cinematic: ["vs.l.cinematic", "vs.l.cinematic.why"], energetic: ["vs.l.energetic", "vs.l.energetic.why"],
  journal: ["vs.l.journal", "vs.l.journal.why"], retro: ["vs.l.retro", "vs.l.retro.why"], calm: ["vs.l.documentary", "vs.l.documentary.why"], lively: ["vs.l.energetic", "vs.l.energetic.why"],
  photos: ["vs.l.journal", "vs.l.journal.why"], fieldguide: ["vs.l.fieldguide", "vs.l.fieldguide.why"], monochrome: ["vs.l.monochrome", "vs.l.monochrome.why"],
  slow: ["vs.l.slow", "vs.l.slow.why"], roadmovie: ["vs.l.roadmovie", "vs.l.roadmovie.why"] };
async function loadSuggest() {
  if (vs.loading) return; vs.loading = true; vs.error = null;
  const target = vs.target ?? vlogView?.trip?.target;  // the person's "Length of each episode"
  try { vs.data = await api("/api/vlogs/suggest?style=" + vs.style + (target ? "&target=" + target : "")); } catch (err) { vs.error = err.message; }
  vs.loading = false; if (page === "videos") renderHome(true);
}
/* The yardstick: how much of the footage the videos use, and how many more it can honestly make (vlog.coverage). */
function vsYard(c) {
  const meter = (used, all, label) => { const p = all ? Math.round(100 * used / all) : 0;
    return `<div class="vsmeter"><span class="meta">${label}</span><span class="vsbar wide" role="img" aria-label="${p}%"><i style="width:${p}%"></i></span><span class="mono">${used} / ${all}</span></div>`; };
  return `<div class="vsyard"><div class="row"><b>${ico("layers", "sm")} ${tr("vs.yard", { n: c.videos })}</b><span class="grow"></span>
    <span class="chip ${c.more ? "warn" : "ok"}">${c.more ? tr("vs.yard.more", { n: c.more }) : tr("vs.yard.full")}</span></div>
    ${meter(c.clipsUsed, c.clips, tr("vs.yard.clips"))}${meter(Math.round(c.shownMin), Math.round(c.movingMin), tr("vs.yard.moving"))}${meter(c.photosUsed, c.photos, tr("vs.yard.photos"))}
    <p class="meta">${c.more ? tr("vs.yard.left", { m: c.leftMin, p: c.freshPhotos, n: c.more }) : tr("vs.yard.done", { m: c.leftMin, p: c.freshPhotos })}${c.moreAll > c.more ? ` ${tr("vs.yard.room", { n: c.room })}` : ""}</p></div>`;
}
function vlogPlannerHtml(v, busy, form) {
  if (!vs.data && !vs.loading && !vs.error) loadSuggest();
  const d = vs.data, ov = d?.overlays || v.trip?.overlays || { places: true, animals: true, captions: true };
  const styles = ["documentary", "cinematic", "energetic", "journal", "retro"].map((k) => [k, ...LOOKN[k]]);
  const OPT = { looks: ["vs.o.looks", "vs.o.looks.why"], series: ["vs.o.series", "vs.o.series.why"], highlights: ["vs.o.highlights", "vs.o.highlights.why"], even: ["vs.o.even", "vs.o.even.why"], more: ["vs.o.more", "vs.o.more.why"], fresh: ["vs.o.fresh", "vs.o.fresh.why"] };
  const bar = (pct) => `<span class="vsbar" title="${esc(tr("vs.moving", { p: pct }))}"><i style="width:${pct}%"></i></span>`;
  const built = v.parts.filter((p) => p.built).length, hints = v.trip?.hints || {}, home = homeName();
  const opt = (o, i) => {
    const best = d.best === o.id;
    return `<article class="vsopt ${best ? "best" : ""}">
      <div class="row"><b>${tr(OPT[o.id][0])}</b>${best ? `<span class="chip ok">${tr("vs.best")}</span>` : ""}</div>
      <p class="meta">${tr(OPT[o.id][1])}${o.looks && !o.extend ? ` ${tr("vs.alllooks")}` : ""}</p>
      ${o.series ? `<p class="meta">${tr("vs.serieslook")}</p>` : ""}
      <ul class="vsparts">${o.parts.map((x, k) => `<li title="${esc(tr("vs.mix", { v: x.videos, p: x.photos, s: x.videoPct }))}"><span title="${o.looks ? esc(tr(LOOKN[(o.allLooks || o.looks)[k]][1])) : ""}">${o.looks ? `<b>${tr(LOOKN[(o.allLooks || o.looks)[k]][0])}</b>` : o.series ? tr("vs.ep", { n: k + 1, of: o.parts.length }) : tr("vid.part", { n: k + 1 })} <span class="meta">${esc(x.days.length > 1 ? `${dayRange(x.days[0], x.days.at(-1))}` : shortDay(x.days[0]))}</span></span><span class="mono">${x.minutes} min</span>${bar(x.videoPct)}<span class="mono vspct">${x.videoPct}%</span></li>`).join("")}</ul>
      <p class="meta">${tr("vs.total", { m: o.minutes, s: o.videoPct, u: o.usd.toFixed(2), b: o.buildMin })}</p>
      ${o.weak.length ? `<p class="meta warnline">${ico("alert", "sm")} ${tr("vs.weak", { w: o.weak.map(esc).join(", ") })}</p>` : ""}
      <button class="${best ? "primary" : ""}" data-vlmake="${i}" ${busy ? "hidden" : ""}>${ico("clapper", "sm")}${o.extend ? tr("vs.add", { n: o.parts.length }) : vs.arm === i && built ? tr("vs.makesure", { n: built }) : tr("vs.make")}</button></article>`;
  };
  const placed = d ? d.have.filter((x) => x.place).length : 0;
  const order = d ? d.options.map((o, i) => [o, i]).sort(([x], [y]) => (y.id === d.best) - (x.id === d.best)) : [];
  // The series first (the suggestion); every other film is a separate one, under More looks; the even split stays with "choose yourself".
  const series = d?.options.find((o) => o.id === "series"), target = d?.target ?? v.trip?.target ?? 10;
  const main = order.filter(([o]) => o.id === (series ? "series" : d?.best)), more = order.filter(([o]) => o.id !== "even" && !main.some(([m]) => m === o));
  return `<section class="panel vlplanner">
    <div class="row"><h3>${ico("film")} ${tr("vs.h")}</h3>${d ? `<span class="meta">${tr("vs.have", { v: d.videos, m: d.rawMin ?? d.videoMin, p: d.photos, d: d.have.length })}</span>` : ""}<span class="grow"></span>${v.chain ? `<span class="meta">${ico("clock", "sm")} ${tr("vs.chain", { n: v.chain.next, of: v.chain.last })}</span>` : ""}</div>
    ${vs.loading && !d ? `<p class="meta">${ico("hourglass", "sm")} ${tr("vs.reading")}</p>` : vs.error ? `<p class="bad">${ico("alert", "sm")} ${esc(vs.error)}</p>` : ""}
    ${d ? `<details class="vsstep" data-vsdays="1" ${vs.daysOpen ?? (!placed && !home) ? "open" : ""}><summary><b class="vsno">1</b><b>${tr("vs.s1")}</b><span class="meta">${placed || !home ? tr("vs.s1sum", { n: placed, d: d.have.length }) : tr("vs.s1home", { p: home, d: d.have.length })}</span></summary>
    ${timelineCard()}<form class="vstrip" data-vltrip="1"><p class="meta">${home ? tr("vs.wherehome", { p: home }) : tr("vs.wherewhy")}</p><div class="tablewrap"><table class="kvt vsdays"><thead><tr><th>${tr("vs.day")}</th><th>${tr("vs.movingh")}</th><th>${tr("vs.photosh")}</th><th>${tr("vs.seen")}</th><th>${tr("vs.where")}</th>${home ? "" : `<th>${tr("vs.country")}</th>`}<th>${tr("vs.moment")}</th></tr></thead><tbody>
      ${d.have.map((x, k) => `<tr ${k >= VS_FEW && !vs.allDays && !x.place && !x.country && !d.moments?.[x.day] ? "hidden" : ""}><td><b>${tr("vs.dayn", { n: k + 1 })}</b> <span class="meta">${esc(shortDay(x.day))}</span></td><td class="mono">${x.videos ? `${x.videos} · ${x.videoMin} min` : "–"}</td><td class="mono">${x.photos}</td>
        <td class="meta">${esc(x.seen.join(", "))}</td><td><input name="place-${esc(x.day)}" maxlength="60" value="${esc(x.place || hints[x.day]?.place || "")}" placeholder="${esc(tr("vs.whereph"))}" aria-label="${esc(tr("vs.where") + " " + shortDay(x.day))}">
          ${!x.place && hints[x.day] ? `<div class="meta">${ico("eye", "sm")} ${tr("vs.fromsign", { r: esc(hints[x.day].read || hints[x.day].place) })}</div>` : ""}</td>
        ${home ? "" : `<td><input name="country-${esc(x.day)}" maxlength="40" list="vscountries" value="${esc(x.country || "")}" placeholder="${esc(tr("vs.countryph"))}" aria-label="${esc(tr("vs.country") + " " + shortDay(x.day))}" style="width:9em"></td>`}${/* BL-068: a home project is not a trip: no country column, no road-sign reading */ ""}
        <td><input name="moment-${esc(x.day)}" maxlength="80" value="${esc(d.moments?.[x.day] || "")}" placeholder="${esc(tr("vs.momentph"))}" aria-label="${esc(tr("vs.moment") + " " + shortDay(x.day))}"></td></tr>`).join("")}
      </tbody></table></div>
      ${d.have.length > VS_FEW && !vs.allDays ? `<button type="button" class="linkish" data-vsalldays="1">${ico("list", "sm")} ${tr("vs.alldays", { n: d.have.length })}</button>` : ""}
      <datalist id="vscountries">${[...new Set([...d.have.map((x) => x.country).filter(Boolean), ...VS_COUNTRIES])].map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
      <div class="row wrap"><span class="meta">${tr("vs.onscreen")}</span>
        ${[["places", "vs.ov.places"], ["animals", "vs.ov.animals"], ["captions", "vs.ov.captions"]].map(([k, key]) => `<label class="chk"><input type="checkbox" name="ov-${k}" ${ov[k] ? "checked" : ""}> ${tr(key)}</label>`).join("")}
        <label class="chk" title="${esc(tr("vs.personal.why"))}"><input type="checkbox" name="personal" ${d.personal ? "checked" : ""}> ${tr("vs.personal")}</label>
        ${d.held?.count || d.privateOk ? `<label class="chk" title="${esc(tr("vs.private.why"))}"><input type="checkbox" name="privateOk" ${d.privateOk ? "checked" : ""}> ${tr("vs.private", { n: d.held?.count || 0 })}</label>` : ""}
        <span class="grow"></span>${home ? "" : `<button type="button" data-vlsigns="1" ${vs.signs ? "disabled" : ""} title="${esc(tr("vs.signstip"))}">${vs.signs ? `<span class="spin sm"></span>${tr("vs.signing")}` : `${ico("eye", "sm")}${tr("vs.signs")}`}</button>`}<button class="primary" type="submit">${ico("check", "sm")}${tr("vs.save")}</button></div></form></details>
    ${d.coverage && d.coverage.videos ? vsYard(d.coverage) : ""}
    <div class="vsstep"><div class="vshead"><b class="vsno">2</b><b>${tr("vs.s2")}</b></div>
    <div class="row wrap"><label class="meta">${tr("vs.len")} <input type="number" min="5" max="15" step="0.5" data-vslen="1" value="${esc(String(target))}" style="width:5em"> ${tr("vs.min")}</label>
      ${series ? `<span class="meta">${tr("vs.eps", { n: series.parts.length })}</span>` : ""}${vs.loading ? `<span class="spin sm"></span>` : ""}</div>
    ${busy ? `<p class="meta warnline">${ico("clock", "sm")} ${tr("vs.busy")}</p>` : ""}
    <div class="vsopts">${main.map(([o, i]) => opt(o, i)).join("")}</div>
    <details class="vsown" ${vs.looksOpen ? "open" : ""} data-vslooks="1"><summary>${tr("vs.morelooks")}</summary>
    <div class="row wrap vsstyles" role="group" aria-label="${esc(tr("vs.stylefor"))}"><span class="meta">${tr("vs.stylefor")}</span>${styles.map(([k, key]) => `<button type="button" class="${vs.style === k ? "on" : ""}" aria-pressed="${vs.style === k}" data-vlstyle="${k}">${tr(key)}</button>`).join("")}
      <span class="meta">${tr(styles.find(([k]) => k === vs.style)[2])}</span></div>
    <div class="vsopts">${more.map(([o, i]) => opt(o, i)).join("")}</div></details></div>` : ""}
    <details class="vsown"><summary>${tr("vs.own")}</summary>${d ? order.filter(([o]) => o.id === "even").map(([o, i]) => opt(o, i)).join("") : ""}${form}</details></section>`;
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-vlsigns]")) {
    vs.signs = true; renderHome(true);
    try {
      const r = await post("/api/vlogs/places", {});
      toast(`${ico("eye", "sm")} ${tr("vs.signsdone", { n: Object.keys(r.hints || {}).length, d: r.days || 0 })}`, 7000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    vs.signs = false; vs.data = null; await loadVlogs(); loadSuggest(); return;
  }
  if (e.target.closest("[data-vsalldays]")) { vs.allDays = true; return renderHome(true); }
  const st = e.target.closest("[data-vlstyle]");
  if (st) { vs.style = st.dataset.vlstyle; vs.arm = null; vs.data = null; return loadSuggest(); }
  const mk = e.target.closest("[data-vlmake]");
  if (!mk || !vs.data) return;
  const i = Number(mk.dataset.vlmake), o = vs.data.options[i];
  if (o.extend) {  // more videos on the same plan: nothing is replaced, so one press
    mk.disabled = true;
    try { await post("/api/vlogs/plan", { extend: true, ...(o.fresh ? { fresh: true } : {}), build: true }); vs.data = null; toast(`${ico("clapper", "sm")} ${tr("vs.started", { n: o.parts.length })}`, 7000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return loadVlogs();
  }
  if (vlogView?.parts.some((p) => p.built) && vs.arm !== i) { vs.arm = i; return renderHome(true); }  // replacing built videos: press twice
  vs.arm = null; mk.disabled = true;
  try {
    await post("/api/vlogs/plan", o.series ? { series: true, target: o.target, build: true, name: vlogView?.plan?.name || "" }
      : { groups: o.groups, lengths: o.lengths, style: vs.style, ...(o.looks ? { looks: o.looks } : {}), ...(o.more ? { more: true } : {}), build: true, name: vlogView?.plan?.name || "" });
    toast(`${ico("clapper", "sm")} ${tr("vs.started", { n: o.parts.length })}`, 7000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  loadVlogs();
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-vltrip]"); if (!f) return;
  e.preventDefault();
  const fd = new FormData(f), places = {}, overlays = {};
  for (const [k, val] of fd.entries()) if (k.startsWith("place-")) places[k.slice(6)] = String(val).trim();
  for (const k of ["places", "animals", "captions"]) overlays[k] = fd.has("ov-" + k);
  const moments = {}, countries = {};
  for (const [k, val] of fd.entries()) if (k.startsWith("moment-")) moments[k.slice(7)] = String(val).trim();
  for (const [k, val] of fd.entries()) if (k.startsWith("country-")) countries[k.slice(8)] = String(val).trim();
  try { await post("/api/vlogs/trip", { places, overlays, moments, countries, personal: fd.has("personal"), privateOk: fd.has("privateOk") }); toast(`${ico("check", "sm")} ${tr("vs.saved")}`, 4000); vs.data = null; loadSuggest(); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
/* Older words on bookings: what happens to each group, and the switch that swaps them by itself (GET /api/posts/stale). */
let staleView = null, staleLoading = false;
async function loadStale() {
  if (staleLoading) return; staleLoading = true;
  try { staleView = await api("/api/posts/stale"); } catch { /* the line waits for the next load */ }
  staleLoading = false; if (page === "posting") renderHome(true);
}
