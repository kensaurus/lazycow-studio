/* ---------- Photo posts (GET /api/stills, py/studio/stills.py, src/Post.tsx) ----------
   Carousels and a Story drawn from the footage's photos in ten looks, previewed the way each network shows them:
   the Instagram post (swipe), the profile grid (3:4 crop), the Story, Facebook, Threads, X and Bluesky. A list on the
   left, one set on the right, so the page stays one screen. Nothing here posts. */
let phView = null, phSel = null, phTab = "ig", phLook = "", phTheme = "", phLoading = false;
const PH_TABS = ["ig", "story", "grid", "fb", "threads", "x", "bsky", "all"];
const PH_LIMIT = { instagram: 2200, facebook: 63206, threads: 500, x: 280, bluesky: 300 };
const phFile = (s, f) => `/api/stills/file?id=${encodeURIComponent(s.id)}&f=${f}&v=${encodeURIComponent(s.created || "")}`;
async function loadPhotos() {
  if (phLoading) return; phLoading = true;
  try { phView = await api("/api/stills"); globalThis.PH_SETS = phView.sets; if (!phSel || !phView.sets.some((s) => s.id === phSel)) phSel = phView.sets[0]?.id || null; }
  catch (e) { phView = { sets: [], error: e.message }; }
  finally { phLoading = false; if (page === "photos" && atHome()) renderHome(true); }
}
function phJob(j) {
  if (!phView) return;
  phView.job = j;
  if (!isActive(j)) {
    if (j.status === "done") toast(`${ico("check", "sm")} ${esc(tr("ph.made", { n: j.result?.made?.length || 0 }))}`, 6000);
    else if (j.status === "error") toast(`${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || "failed")}`, 9000);
    phSel = j.result?.made?.[0] || phSel; loadPhotos(); return;
  }
  const bar = $("#phProg");
  if (bar && page === "photos") bar.outerHTML = phProgress(j); else if (page === "photos" && atHome()) renderHome(true);
}
function phStoryJob(j) {
  if (!phView) return;
  phView.storyJob = j;
  if (!isActive(j)) {
    if (j.status === "done") toast(`${ico("send", "sm")} ${esc(tr("ph.story.done"))}`, 7000);
    else if (j.status === "error") toast(`${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || "failed")}`, 12000);
    loadPhotos(); return;
  }
  if (page === "photos" && atHome()) renderHome(true);
}
function phProgress(j) {
  if (!j || !isActive(j)) return `<div id="phProg" hidden></div>`;
  const pct = j.of ? Math.round(100 * ((j.stage - 1) / (j.stages || 3) + (j.done / j.of) / (j.stages || 3))) : Math.round(100 * Math.max(0, (j.stage || 1) - 1) / (j.stages || 3));
  return `<div id="phProg" class="ph-prog"><div class="bar"><i style="width:${Math.max(4, pct)}%"></i></div><span class="meta">${ico("clock", "sm")} ${esc(tr("ph.making"))} · ${esc(j.label || "")}${j.of ? ` · ${j.done}/${j.of}` : ""}</span></div>`;
}
function phCaptionBox(s, net) {
  const text = s.captions?.[net] || "";
  const n = net === "x" ? s.captions?._lengths?.x ?? text.length : net === "bluesky" ? s.captions?._lengths?.bluesky ?? text.length : text.length;
  const over = n > PH_LIMIT[net];
  return `<div class="ph-cap"><pre>${esc(text)}</pre><div class="row"><span class="meta ${over ? "bad" : ""}">${esc(tr("ph.len", { n, max: PH_LIMIT[net] }))}</span>
    <button class="sm" data-phcopy="${net}">${ico("copy", "sm")}${tr("ph.copy")}</button></div></div>`;
}
function phMock(s) {
  const b = brandView || {}, handle = (b.handle || "@you").replace(/^@/, ""), name = b.name || handle;
  const slides = s.slides.map((f, i) => `<img src="${phFile(s, f)}" alt="${esc(s.alt?.[i] || "")}" loading="lazy">`);
  const avatar = `<span class="ph-av">${esc(name.slice(0, 1))}</span>`;
  const capShort = (t) => esc((t || "").split("\n").filter(Boolean).slice(0, 2).join(" "));
  if (phTab === "ig") return `<div class="ph-phone"><div class="ph-top">${avatar}<b>${esc(handle)}</b><span class="meta">${esc(s.themeJa)}</span></div>
      <div class="ph-swipe" data-phswipe>${slides.join("")}</div>
      <div class="ph-dots">${s.slides.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>
      <div class="ph-acts">♡ 💬 ↗<span style="flex:1"></span>🔖</div>
      <p class="ph-txt"><b>${esc(handle)}</b> ${capShort(s.captions?.instagram)} <span class="meta">… ${tr("ph.more")}</span></p></div>
    <div class="ph-side">${phCaptionBox(s, "instagram")}<p class="meta">${ico("music", "sm")} ${tr("ph.music")}</p></div>`;
  if (phTab === "grid") {
    const others = (phView?.sets || []).filter((x) => x.id !== s.id).slice(0, 8);
    return `<div class="ph-phone"><div class="ph-top">${avatar}<b>${esc(handle)}</b></div><div class="ph-grid">
      <img class="me" src="${phFile(s, s.slides[0])}" alt="">${others.map((o) => `<img src="${phFile(o, o.slides[0])}" alt="" loading="lazy">`).join("")}</div></div>
      <div class="ph-side"><p class="meta">${tr("ph.gridnote")}</p></div>`;
  }
  if (phTab === "story") {
    const vid = s.storyVideo ? phFile(s, s.storyVideo) : "";
    const when = (iso) => { const w = wallOf(Date.parse(iso)); return `${shortDay(w.slice(0, 10))} ${w.slice(11, 16)}`; };  // in the audience's zone, whatever zone the time was stored in
    return `<div class="ph-phone story"><div class="ph-bars"><i></i></div><div class="ph-top over">${avatar}<b>${esc(handle)}</b></div>${vid
        ? `<video src="${vid}" autoplay muted loop playsinline aria-label="${esc(s.themeJa)}"></video>` : `<img src="${phFile(s, s.story)}" alt="">`}</div>
      <div class="ph-side">${s.storyPosted ? `<div class="ph-res"><b>${tr("ph.res")}</b> ${s.storyResult ? `<span>${esc(tr("ph.res.line", { v: s.storyResult.views ?? "–", r: s.storyResult.reach ?? "–", p: s.storyResult.profile_visits ?? "–" }))}</span> <span class="meta">· ${esc(when(s.storyResult.at))}</span>` : `<span class="meta">${tr("ph.res.none")}</span>`}</div>` : ""}
        ${(phView.looks || []).length ? `<p class="meta">${tr("ph.looks")} ${(phView.looks || []).slice(0, 4).map((l) => `${esc((phView.templates?.styles || PH_STYLES).find((x) => x[0] === l.style)?.[lang === "ja" ? 2 : 1] || l.style)} (${esc(String(l.reach || l.views))}, ${l.stories})`).join(" · ")}</p>` : ""}
        <p class="meta">${vid ? esc(tr("ph.story.vnote", { s: Math.round(3 * s.slides.length + 1.5) })) : tr("ph.storynote")}</p>
        <div class="row wrap">${vid ? `<a class="btn sm" download href="${vid}">${ico("download", "sm")}story.mp4</a>` : ""}<a class="btn sm" download href="${phFile(s, s.story)}">${ico("download", "sm")}story.jpg</a></div></div>`;
  }
  if (phTab === "all") return `<figure class="ph-all"><img src="${phFile(s, "strip.jpg")}" alt=""><figcaption class="meta">${tr("ph.all")}</figcaption>
      <div class="ph-slides"><span class="meta">${tr("ph.dl")}</span>${s.slides.map((f, i) => `<a class="btn sm" download href="${phFile(s, f)}">${ico("download", "sm")}${i + 1}</a>`).join("")}</div></figure>`;
  if (phTab === "fb") {
    const more = s.slides.length - 4;
    return `<div class="ph-card"><div class="ph-top">${avatar}<div><b>${esc(name)}</b><div class="meta">· 🌐</div></div></div><p class="ph-txt">${esc((s.captions?.facebook || "").split("\n").slice(0, 3).join("\n"))}</p>
      <div class="ph-fb">${slides.slice(0, 4).map((im, i) => `<div class="c${i}">${im}${i === 3 && more > 0 ? `<span class="plus">+${more}</span>` : ""}</div>`).join("")}</div>
      <div class="ph-acts">👍 💬 ↗</div></div><div class="ph-side">${phCaptionBox(s, "facebook")}</div>`;
  }
  if (phTab === "threads") return `<div class="ph-card"><div class="ph-top">${avatar}<b>${esc(handle)}</b></div><p class="ph-txt">${esc(s.captions?.threads || "")}</p>
      <div class="ph-strip">${slides.join("")}</div><div class="ph-acts">♡ 💬 🔁 ↗</div></div><div class="ph-side">${phCaptionBox(s, "threads")}</div>`;
  const net = phTab === "x" ? "x" : "bluesky";
  return `<div class="ph-card"><div class="ph-top">${avatar}<div><b>${esc(name)}</b> <span class="meta">@${esc(handle)}</span></div></div><p class="ph-txt">${esc(s.captions?.[net] || "")}</p>
      <div class="ph-four">${slides.slice(0, 4).join("")}</div><div class="ph-acts">💬 🔁 ♡ ↗</div></div>
    <div class="ph-side">${phCaptionBox(s, net)}<p class="meta">${tr("ph.xnote")}</p></div>`;
}
function renderPhotos() {
  const head = `<div class="pagehead">${crumbs([tr("nav.photos")])}</div>`;
  if (!brandView && !renderPhotos.askedBrand) {  // the handle and name on the mock-ups
    renderPhotos.askedBrand = true;
    api("/api/brand").then((b) => { brandView = b; if (page === "photos" && atHome()) renderHome(true); }).catch(() => {});
  }
  if (!phView) { $("#home").innerHTML = head + loadingHtml(tr("nav.photos")); loadPhotos(); return; }
  const tpl = phView.templates || null;
  const busy = phView.job && isActive(phView.job);
  const sets = phView.sets || [], s = sets.find((x) => x.id === phSel) || sets[0];
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  const looks = [...new Map(sets.map((x) => [x.style, lang === "ja" ? x.styleJa : x.styleEn])).entries()];
  const themes = [...new Map(sets.map((x) => [x.theme, lang === "ja" ? x.themeJa : x.themeEn])).entries()];
  const bar = `<div class="ph-bar"><p class="note">${tr("ph.intro")}</p>
    <div class="row wrap"><button class="primary" data-phmake ${busy ? "disabled" : ""}>${ico("image", "sm")}${tr("ph.make", { n: phLook ? 3 : 10 })}</button>
      <select data-phlook aria-label="look">${opt("", tr("ph.anylook"), phLook)}${(tpl?.styles || PH_STYLES).map(([id, en, ja]) => opt(id, lang === "ja" ? ja : en, phLook)).join("")}</select>
      <select data-phtheme aria-label="subject">${opt("", tr("ph.anytheme"), phTheme)}${(tpl?.themes || PH_THEMES).map(([id, en, ja]) => opt(id, lang === "ja" ? ja : en, phTheme)).join("")}</select>
      ${tdPhNext(sets)}${phProgress(phView.job)}</div></div>`;
  if (!sets.length) { $("#home").innerHTML = head + subTabsHtml() + bar + `<p class="empty">${tr("ph.none")}</p>`; return; }
  // one heading per batch ("21 Nov 13:01"), not the same date under every item
  let lastBatch = "";
  const list = `<ul class="ph-list">${sets.map((x) => {
    const c = String(x.created || ""), batch = `${shortDay(c.slice(0, 10))} ${c.slice(11, 16)}`;
    const grp = batch !== lastBatch ? `<li class="grp">${esc(batch)}</li>` : "";
    lastBatch = batch;
    const marks = `${x.storyQueued ? `<span title="${esc(tr("ph.booked", { d: shortDay(String(x.storyQueued.at).slice(0, 10)) + " " + String(x.storyQueued.at).slice(11, 16) }))}">${ico("cal", "sm")}</span>` : ""}${x.storyPosted ? `<span title="${esc(tr("ph.story.posted", { d: shortDay(String(x.storyPosted.at).slice(0, 10)) }))}${x.storyResult ? " · " + esc(tr("ph.res.line", { v: x.storyResult.views ?? "–", r: x.storyResult.reach ?? "–", p: x.storyResult.profile_visits ?? "–" })) : ""}">${ico("send", "sm")}</span>` : ""}${x.approved ? `<span title="${esc(tr("ph.sent", { d: shortDay(String(x.approved.at).slice(0, 10)) }))}">${ico("check", "sm")}</span>` : ""}`;
    return `${grp}<li><button class="${x.id === s.id ? "on" : ""}" data-phsel="${esc(x.id)}" title="${esc(`${lang === "ja" ? x.styleJa : x.styleEn} · ${lang === "ja" ? x.themeJa : x.themeEn}`)}">
      <img src="${phFile(x, x.slides[0])}" alt="" loading="lazy"><span><b>${esc(lang === "ja" ? x.styleJa : x.styleEn)}</b><span class="meta">${esc(lang === "ja" ? x.themeJa : x.themeEn)} · ${esc(tr("ph.slides", { n: x.panels }))}</span>${tdPhOut(x)}</span>${marks ? `<span class="marks">${marks}</span>` : ""}</button></li>`;
  }).join("")}</ul>`;
  const tabs = `<div class="ph-tabs" role="tablist">${PH_TABS.map((t) => `<button role="tab" aria-selected="${t === phTab}" class="${t === phTab ? "on" : ""}" data-phtab="${t}">${tr(`ph.tab.${t}`)}</button>`).join("")}</div>`;
  const sj = phView.storyJob && isActive(phView.storyJob) ? phView.storyJob : null;
  const when = (iso) => { const w = wallOf(Date.parse(iso)); return `${shortDay(w.slice(0, 10))} ${w.slice(11, 16)}`; };  // in the audience's zone, whatever zone the time was stored in
  const storyBtn = s.storyPosted
    ? `<p class="meta ok">${ico("send", "sm")} ${esc(tr("ph.story.posted", { d: when(s.storyPosted.at) }))}${s.storyPosted.url ? ` · <a href="${escUrl(s.storyPosted.url)}" target="_blank" rel="noopener">${tr("ph.story.view")}</a>` : ""}</p>`
    : sj ? `<button class="primary" disabled>${ico("clock", "sm")}${esc(tr("ph.story.posting"))} ${esc(sj.label || "")}</button>`
    : s.storyQueued ? `<p class="meta ok">${ico("cal", "sm")} ${esc(tr("ph.booked", { d: when(s.storyQueued.at) }))}</p><button class="sm" data-phunbook="${esc(s.id)}">${tr("ph.unbook")}</button>`
    : `${s.storyFailed ? `<p class="meta bad" title="${esc(s.storyFailed.why)}">${ico("alert", "sm")} ${esc(tr("ph.failed", { m: s.storyFailed.why.slice(0, 80) }))}</p>` : ""}<button class="primary" data-phsched="${esc(s.id)}" title="${esc(tr("ph.sched.tip"))}">${ico("cal", "sm")}${tr("ph.sched")}</button>
       <button data-phstory="${esc(s.id)}" title="${esc(tr("ph.story.post"))}">${ico("send", "sm")}${tr("ph.now")}</button>`;
  const ready = s.approved ? `<p class="meta ok">${ico("check", "sm")} ${esc(tr("ph.sent", { d: shortDay(String(s.approved.at).slice(0, 10)) }))} <span class="mono" title="${esc(s.approved.folder)}">${esc(String(s.approved.folder).split(/[\\/]/).pop())}</span></p>`
    : `<button data-phok="${esc(s.id)}" title="${esc(tr("ph.sendtip"))}">${ico("folder", "sm")}${tr("ph.send")}</button>`;
  const del = `<button class="icon-only" data-phdel="${esc(s.id)}" title="${esc(tr("ph.delete"))}" aria-label="${esc(tr("ph.delete"))}">${ico("trash", "sm")}</button>`;
  $("#home").innerHTML = head + subTabsHtml() + bar + `<div class="ph-wrap">${list}<section class="ph-main"><div class="ph-head"><h3>${esc(lang === "ja" ? s.styleJa : s.styleEn)} · ${esc(lang === "ja" ? s.themeJa : s.themeEn)} <span class="meta">· ${esc(tr("ph.slides", { n: s.panels }))}</span></h3><div class="ph-ok">${storyBtn}${ready}${del}</div></div>${tabs}<div class="ph-view">${phMock(s)}</div></section></div>`;
  document.querySelector(".ph-list button.on")?.scrollIntoView({ block: "nearest" });
}
const PH_STYLES = [["pano", "Seamless panorama", "つながるパノラマ"], ["polaroid", "Polaroid collage", "ポラロイド"], ["film", "Film strip", "フィルム"], ["magazine", "Magazine", "マガジン"], ["dump", "Photo dump", "フォトダンプ"],
  ["scrapbook", "Scrapbook", "スクラップブック"], ["gallery", "Gallery", "ギャラリー"], ["tategaki", "Vertical poem", "縦書き"], ["guide", "Save-worthy guide", "保存したくなるガイド"], ["newspaper", "Newspaper", "新聞"]];
const PH_THEMES = [["autumn", "Autumn", "秋"], ["stay", "Tents", "テント泊"], ["views", "Views", "景色"], ["work", "Work", "山で働く"], ["food", "Food", "ごはん"], ["night", "Night", "夜"], ["winter", "Winter", "冬"]];
const subTabsHtml = () => "";  // renderHome adds the section's tabs itself (subTabs)
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-phsel],[data-phtab],[data-phmake],[data-phcopy],[data-phdel],[data-phok],[data-phstory],[data-phsched],[data-phunbook]");
  if (!t || page !== "photos") return;
  if (t.dataset.phsel) { phSel = t.dataset.phsel; renderHome(true); return; }
  if (t.dataset.phtab) { phTab = t.dataset.phtab; renderHome(true); return; }
  const s = (phView?.sets || []).find((x) => x.id === phSel) || phView?.sets?.[0];
  if (t.dataset.phcopy && s) { try { await navigator.clipboard.writeText(s.captions?.[t.dataset.phcopy] || ""); toast(`${ico("copy", "sm")} ${tr("ph.copied")}`); } catch (err) { toast(esc(err.message)); } return; }
  if (t.dataset.phok) {
    t.disabled = true;
    try { const r = await api("/api/stills/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: t.dataset.phok }) });
      toast(`${ico("check", "sm")} ${esc(tr("ph.sentto", { n: r.files }))}`, 6000); await loadPhotos(); }
    catch (err) { t.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return;
  }
  if (t.dataset.phsched || t.dataset.phunbook) {
    const id = t.dataset.phsched || t.dataset.phunbook, path = t.dataset.phsched ? "/api/stills/schedule" : "/api/stills/unschedule";
    t.disabled = true;
    const send = async (force) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...(force ? { force: true } : {}) }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    try {
      let r = await send(false);
      // a slide with a face: the person decides (a Story goes out to everyone)
      if (r.status === 409 && r.body.code === "faces" && confirm(tr("ph.faces", { m: r.body.error }))) r = await send(true);
      if (r.status !== 200) { if (!(r.status === 409 && r.body.code === "faces")) toast(`${ico("alert", "sm")} ${esc(r.body.error || r.status)}`, 9000); }
      else toast(`${ico("cal", "sm")} ${esc(t.dataset.phsched ? tr("ph.bookedto", { d: `${shortDay(r.body.at.slice(0, 10))} ${r.body.at.slice(11, 16)}` }) : tr("ph.unbooked"))}`, 7000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    t.disabled = false;
    await loadPhotos();
    if (typeof pollPosts === "function") pollPosts();
    return;
  }
  if (t.dataset.phstory) {
    if (!confirm(tr("ph.story.ask", { h: brandView?.handle || "Instagram" }))) return;
    t.disabled = true;
    try { phView.storyJob = await api("/api/stills/story", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: t.dataset.phstory }) }); renderHome(true); }
    catch (err) { t.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    return;
  }
  if (t.dataset.phdel) {
    if (!confirm(tr("ph.askdel"))) return;
    try { await api("/api/stills/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: t.dataset.phdel }) }); phSel = null; await loadPhotos(); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return;
  }
  if (t.hasAttribute("data-phmake")) {
    t.disabled = true;
    try {
      const j = await api("/api/stills/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: phLook ? 3 : 10, ...(phLook ? { style: phLook } : {}), ...(phTheme ? { theme: phTheme } : {}) }) });
      phView.job = j; renderHome(true);
    } catch (err) { t.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  }
});
document.addEventListener("change", (e) => {
  if (page !== "photos") return;
  if (e.target.matches("[data-phlook]")) { phLook = e.target.value; renderHome(true); }
  if (e.target.matches("[data-phtheme]")) { phTheme = e.target.value; }
});
document.addEventListener("scroll", (e) => {  // the dots under the Instagram mock-up follow the swipe
  const sw = e.target?.closest?.("[data-phswipe]");
  if (!sw) return;
  const i = Math.round(sw.scrollLeft / sw.clientWidth);
  sw.parentElement.querySelectorAll(".ph-dots i").forEach((d, k) => d.classList.toggle("on", k === i));
}, true);

