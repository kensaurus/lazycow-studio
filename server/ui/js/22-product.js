/* ---------- Product videos (#/product; GET /api/product, py/studio/product.py, docs/product-kit.md) ----------
   An app's release kit (screens before and after, recordings, changelog lines, brand) made into an App Store preview, a
   Google Play promo or a social cut. Add a kit by its link (or a kit folder on this computer), look through its screens
   (drag a screen's slider, or use its arrow keys, to compare before and after), pick a preset (each card says whether the
   kit fits it and its spec), watch the moving storyboard drawn from the same timeline the render uses, render, download.
   The render uses no AI; the optional reviewer is priced first. Nothing here posts. Keys pv.*. */
const PV = { view: null, loading: false, err: null, kit: null, kitName: null, kitBusy: false, preset: null, plan: null, planOf: "", planErr: null,
  adding: false, addErr: null, jobs: {}, review: {}, anim: null, playing: true, t0: 0, at: 0 };
const pvHex = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || "")) ? c : "#0d0f14");
const pvFile = (name, f) => `/api/product/file?name=${encodeURIComponent(name)}&kind=file&file=${encodeURIComponent(f)}`;
const pvVideo = (name, preset, v, dl) => `/api/product/file?name=${encodeURIComponent(name)}&kind=video&preset=${encodeURIComponent(preset)}${v ? `&v=${encodeURIComponent(v)}` : ""}${dl ? "&download=1" : ""}`;
const pvId = () => (PV.kit && PV.preset ? `pv-${PV.kit.name}--${PV.preset}` : "");
const pvActive = (j) => !!j && (j.status === "queued" || j.status === "running");
const pvSec = (s) => `${Math.round(Number(s) * 10) / 10} s`;

async function pvLoad() {
  if (PV.loading) return;
  PV.loading = true;
  try {
    PV.view = await api("/api/product");
    PV.err = null;
    for (const j of PV.view.jobs || []) PV.jobs[j.slug] = j;
  } catch (err) { PV.err = err.message; PV.view = PV.view || { presets: {}, kits: [], jobs: [] }; }
  PV.loading = false;
  const kits = PV.view.kits || [];
  const want = PV.kitName && kits.some((k) => k.name === PV.kitName) ? PV.kitName : kits[0]?.name || null;
  if (want && want !== PV.kit?.name) await pvOpen(want, false);
  if (page === "product") renderHome(true);
}
async function pvOpen(name, draw = true) {
  PV.kitName = name; PV.kitBusy = true;
  if (draw && page === "product") renderHome(true);
  try {
    PV.kit = await api(`/api/product/kit?name=${encodeURIComponent(name)}`);
    for (const j of Object.values(PV.kit.jobs || {})) PV.jobs[j.slug] = j;
    const fits = PV.kit.fits || {};
    if (!PV.preset || !fits[PV.preset]?.ok) PV.preset = Object.keys(fits).find((p) => fits[p].ok) || PV.preset || Object.keys(PV.view?.presets || {})[0] || null;
    PV.plan = null; PV.planOf = ""; PV.err = null;
  } catch (err) { PV.kit = null; PV.err = err.message; }
  PV.kitBusy = false;
  if (draw && page === "product") renderHome(true);
  pvPlan();
}
async function pvPlan() {
  if (!PV.kit || !PV.preset || !PV.kit.fits?.[PV.preset]?.ok) { PV.plan = null; pvAnimStop(); if (page === "product") pvPaintPreview(); return; }
  const key = `${PV.kit.name}|${PV.preset}`;
  if (PV.planOf === key && PV.plan) return;
  PV.planOf = key; PV.planErr = null; PV.plan = null;
  if (page === "product") pvPaintPreview();
  try {
    const pl = await api(`/api/product/plan?name=${encodeURIComponent(PV.kit.name)}&preset=${encodeURIComponent(PV.preset)}`);
    if (PV.planOf === key) { PV.plan = pl; PV.at = 0; PV.playing = !moCalm(); PV.t0 = performance.now(); }
  } catch (err) { if (PV.planOf === key) PV.planErr = err.message; }
  if (page === "product") pvPaintPreview();
}
/* A product render's live updates (the job stream, 00-core.js): the progress panel only; a finished one reloads the kit. */
function pvJob(j) {
  const was = PV.jobs[j.slug];
  PV.jobs[j.slug] = j;
  if (page !== "product") return;
  if (pvActive(j)) return pvPaintAct();
  if (was && pvActive(was) && j.status === "done") {
    toast(`${ico("check", "sm")} ${esc(tr("pv.job.done"))}`, 6000);
    if (PV.kit) pvOpen(PV.kit.name);
  } else pvPaintAct();
}

function renderProduct() {
  const head = `<div class="pagehead">${crumbs([tr("nav.product")])}</div>`;
  if (!PV.view) { $("#home").innerHTML = head + loadingHtml(tr("nav.product")); pvLoad(); return; }
  const kits = PV.view.kits || [];
  $("#home").innerHTML = `${head}<div class="pv">
    <p class="note pv-lead">${esc(tr("pv.lead"))} <a href="https://github.com/kensaurus/lazycow-studio/blob/main/docs/product-kit.md" target="_blank" rel="noopener">${esc(tr("pv.howkit"))}</a></p>
    ${PV.err ? `<p class="warnline" role="alert">${ico("alert", "sm")} ${esc(PV.err)} <button type="button" class="chip" data-pvretry="1">${ico("refresh", "sm")}${esc(tr("pv.retry"))}</button></p>` : ""}
    ${pvAddHtml(!kits.length)}
    ${kits.length ? `${pvKitsHtml(kits)}${pvKitHtml()}` : pvEmptyHtml()}</div>`;
  pvPaintPreview();
  pvPaintAct();
}

function pvAddHtml(first) {
  return `<form class="pv-add${first ? " first" : ""}" data-pvadd="1" novalidate>
    <label class="pv-src"><b>${esc(tr("pv.add.h"))}</b><span class="meta">${esc(tr("pv.add.hint"))}</span>
      <input name="src" type="text" autocomplete="off" spellcheck="false" required placeholder="${esc(tr("pv.add.ph"))}" ${PV.adding ? "disabled" : ""}></label>
    <label class="pv-name"><span class="meta">${esc(tr("pv.add.name"))}</span>
      <input name="name" type="text" autocomplete="off" spellcheck="false" maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="my-app-1-4" ${PV.adding ? "disabled" : ""}></label>
    <button class="primary" type="submit" ${PV.adding ? "disabled" : ""}>${ico("download", "sm")}${esc(tr(PV.adding ? "pv.add.busy" : "pv.add.go"))}</button>
    <p class="meta pv-addstate" role="status" aria-live="polite">${PV.adding ? `<span class="w9bar sm run"><i></i></span> ${esc(tr("pv.add.wait"))}` : ""}</p>
    ${PV.addErr ? `<p class="warnline" role="alert">${ico("alert", "sm")} ${esc(PV.addErr)}</p>` : ""}</form>`;
}
function pvEmptyHtml() {
  return `<div class="empty mascot pv-empty">${kenji("point")}<b>${esc(tr("pv.empty.h"))}</b><span>${esc(tr("pv.empty.d"))}</span>
    <ol class="pv-steps"><li>${esc(tr("pv.empty.a"))}</li><li>${esc(tr("pv.empty.b"))}</li><li>${esc(tr("pv.empty.c"))}</li></ol></div>`;
}
function pvKitsHtml(kits) {
  if (kits.length < 2) return "";
  return `<nav class="pv-kits" aria-label="${esc(tr("pv.kits"))}">${kits.map((k) => `<button type="button" class="pv-kitbtn${k.name === PV.kitName ? " on" : ""}" data-pvkit="${esc(k.name)}" ${k.name === PV.kitName ? 'aria-current="true"' : ""}>
    ${k.thumb ? `<img src="${pvFile(k.name, k.thumb)}" alt="" loading="lazy">` : `<span class="pv-kitph">${ico("phone", "sm")}</span>`}
    <span><b>${esc(k.app)}</b><span class="meta">${esc(k.version ? `v${k.version}` : k.name)} · ${esc(tr("pv.kit.n", { s: k.screens, r: k.recordings }))}</span></span></button>`).join("")}</nav>`;
}
function pvKitHtml() {
  const k = PV.kit;
  if (!k) return PV.kitBusy ? `<div class="skel pv-skel" role="status" aria-label="${esc(tr("pv.loading"))}"></div>` : "";
  const c = k.brand?.colors || {};
  const sw = ["background", "text", "primary", "accent"].filter((x) => c[x]).map((x) => `<span class="pv-sw" style="background:${pvHex(c[x])}" title="${esc(x)} ${esc(c[x])}"></span>`).join("");
  const from = String(k.source?.from || "").replace(/^https:\/\//, "").split("/")[0];
  const shots = (k.screens || []).map((s) => pvShotHtml(k, s)).join("") + (k.recordings || []).map((r) => pvRecHtml(k, r)).join("");
  const lines = (k.changelog || []).map((l) => `<li>${l.surface ? `<b>${esc(l.surface)}</b> ` : ""}${esc(l.text)}</li>`).join("");
  return `<section class="pv-kit" aria-labelledby="pvKitTitle">
    <header class="pv-khead">${k.brand?.logo ? `<img class="pv-logo" src="${pvFile(k.name, "logo.png")}" alt="" width="52" height="52">` : ""}
      <div><h2 id="pvKitTitle">${esc(k.app?.name)} ${k.release?.version ? `<span class="chip">v${esc(k.release.version)}</span>` : ""}</h2>
        <p class="meta">${esc(k.app?.tagline || "")}${k.app?.tagline ? " · " : ""}${esc(tr("pv.kit.from", { f: from || k.name, t: String(k.source?.fetched || "").replace("T", " ").slice(0, 16) }))}</p></div>
      <span class="grow"></span>${sw ? `<span class="pv-sws" aria-label="${esc(tr("pv.brand"))}">${sw}</span>` : ""}
      <span class="chip" title="${esc(tr("pv.font"))}">${ico("type", "sm")}${esc(k.brand?.font?.file ? tr("pv.font.own") : k.brand?.font?.family || "DM Sans")}</span></header>
    ${(k.warnings || []).length ? `<p class="warnline">${ico("alert", "sm")} ${esc(k.warnings.join(" "))}</p>` : ""}
    <div class="pv-grid">${shots}</div>
    ${lines ? `<details class="pv-log" open><summary><b>${esc(tr("pv.changelog", { n: k.changelog.length }))}</b></summary><ul>${lines}</ul></details>` : ""}
    ${pvPresetsHtml(k)}
    <div class="pv-work"><section class="pv-prev" id="pvPreview" aria-label="${esc(tr("pv.prev.h"))}"></section><section class="pv-act" id="pvAct" aria-live="polite"></section></div>
  </section>`;
}
const pvRatio = (vp, fallback) => (vp?.width && vp?.height ? `${vp.width} / ${vp.height}` : fallback);
function pvShotHtml(k, s) {
  const name = s.surface || s.id, ratio = pvRatio(s.viewport, "9 / 19.5");
  const pic = s.before && s.after
    ? `<div class="pv-cmp" style="--cut:50%;aspect-ratio:${ratio}">
        <img src="${pvFile(k.name, s.before.thumb)}" alt="${esc(tr("pv.shot.before", { s: name }))}" loading="lazy">
        <img class="after" src="${pvFile(k.name, s.after.thumb)}" alt="${esc(tr("pv.shot.after", { s: name }))}" loading="lazy">
        <i class="pv-cut" aria-hidden="true"></i>
        <span class="pv-tag b" aria-hidden="true">${esc(k.labels?.before || "Before")}</span><span class="pv-tag a" aria-hidden="true">${esc(k.labels?.after || "Now")}</span>
        <input type="range" min="0" max="100" value="50" step="1" data-pvcmp="1" aria-label="${esc(tr("pv.shot.cmp", { s: name }))}"></div>`
    : `<div class="pv-pic" style="aspect-ratio:${ratio}"><img src="${pvFile(k.name, s.after.thumb)}" alt="${esc(name)}" loading="lazy"></div>`;
  return `<figure class="pv-shot" data-device="${esc(s.viewport?.device || "phone")}">${pic}
    <figcaption><b>${esc(name)}</b><span class="meta">${esc(s.viewport?.device || "")} · ${s.viewport?.width || "?"}×${s.viewport?.height || "?"}${s.before ? ` · ${esc(tr("pv.shot.pair"))}` : ""}</span>${s.caption ? `<span>${esc(s.caption)}</span>` : ""}</figcaption></figure>`;
}
function pvRecHtml(k, r) {
  const name = r.surface || r.id;
  return `<figure class="pv-shot rec" data-device="${esc(r.viewport?.device || "phone")}">
    <div class="pv-pic" style="aspect-ratio:${r.file?.width || 9} / ${r.file?.height || 16}" data-pvclip="${esc(r.file?.file || "")}">
      <img src="${pvFile(k.name, r.file?.thumb || "")}" alt="" loading="lazy">
      <button type="button" class="pv-playrec" data-pvrec="${esc(r.file?.file || "")}" aria-label="${esc(tr("pv.rec.play", { s: name }))}">${ico("play")}</button></div>
    <figcaption><b>${esc(name)}</b><span class="meta">${esc(tr("pv.rec"))} · ${pvSec(r.file?.seconds || 0)}</span>${r.caption ? `<span>${esc(r.caption)}</span>` : ""}</figcaption></figure>`;
}
function pvPresetsHtml(k) {
  const all = PV.view?.presets || {};
  const cards = Object.entries(all).map(([id, p]) => {
    const fit = k.fits?.[id] || { ok: false, why: "" };
    const badges = [`${p.width}×${p.height}`, `${p.minSec}–${p.maxSec} s`, `${p.fps} fps`, "H.264", p.frame === "none" ? tr("pv.pre.full") : tr("pv.pre.device")];
    const made = k.renders?.[id];
    return `<label class="pv-pre${fit.ok ? "" : " no"}">
      <input type="radio" name="pvpreset" value="${esc(id)}" ${PV.preset === id ? "checked" : ""} ${fit.ok ? "" : "disabled"} aria-describedby="pvfit-${esc(id)}">
      <span class="pv-sil" aria-hidden="true"><i style="aspect-ratio:${p.width} / ${p.height}"></i></span>
      <span class="pv-pre-t"><b>${esc(p.label)}</b><span class="pv-badges">${badges.map((b) => `<i>${esc(b)}</i>`).join("")}</span>
        <span class="meta" id="pvfit-${esc(id)}">${fit.ok ? `${ico("check", "sm")} ${esc(tr("pv.pre.fits", { s: pvSec(fit.seconds), n: fit.scenes }))}${made ? ` · ${esc(tr("pv.pre.made"))}` : ""}` : `${ico("x", "sm")} ${esc(fit.why || tr("pv.pre.nofit"))}`}</span></span></label>`;
  }).join("");
  return `<fieldset class="pv-presets"><legend><b>${esc(tr("pv.pre.h"))}</b> <span class="meta">${esc(tr("pv.pre.lead"))}</span></legend><div class="pv-pregrid">${cards}</div></fieldset>`;
}

/* ---------- the moving storyboard: the render's own timeline, drawn with the kit's pictures (an approximation) ---------- */
function pvStageHtml(pl) {
  const W = pl.preset.width, H = pl.preset.height, full = pl.preset.frame === "none", fr = PV.kit.name;
  const b = pl.brand || {};
  const thumbOf = (src) => { const f = String(src || "").split("/").pop() || ""; return /\.png$/.test(f) ? f.replace(/\.png$/, ".thumb.jpg") : f.replace(/\.mp4$/, ".thumb.jpg"); };
  const layer = (sc, i) => {
    const pic = (src, cls = "") => `<img class="${cls}" src="${pvFile(fr, thumbOf(src))}" alt="">`;
    const screen = sc.kind === "compare" ? `${pic(sc.before)}${pic(sc.src, "after")}<i class="pv-cut" aria-hidden="true"></i>` : pic(sc.src);
    const ratio = sc.vw && sc.vh && sc.kind !== "recording" ? `${sc.vw} / ${sc.vh}` : `${sc.w} / ${sc.h}`;
    return `<div class="pv-sc ${esc(sc.kind)}" data-i="${i}" data-from="${sc.from}" data-dur="${sc.dur}">
      ${full ? `<div class="pv-scr full">${screen}</div>` : `<div class="pv-dev ${esc(sc.device)}"><div class="pv-scr" style="aspect-ratio:${ratio}">${screen}</div></div>`}
      ${sc.caption || sc.surface ? `<div class="pv-cap">${sc.surface ? `<small>${esc(sc.surface)}</small>` : ""}${sc.caption ? `<b>${esc(sc.caption)}</b>` : ""}</div>` : ""}</div>`;
  };
  const card = (cls, from, dur, inner) => `<div class="pv-sc ${cls}" data-from="${from}" data-dur="${dur}">${inner}</div>`;
  const logo = pl.logo ? `<img class="pv-clogo" src="${pvFile(fr, "logo.png")}" alt="">` : "";
  return `<div class="pv-stage ${full ? "full" : "dev"} ${esc(pl.preset.orientation)}" style="aspect-ratio:${W} / ${H};--ar:${(W / H).toFixed(4)};--pv-bg:${pvHex(b.background)};--pv-ink:${pvHex(b.text)};--pv-acc:${pvHex(b.accent)};--pv-pri:${pvHex(b.primary)};--pv-on:${pvHex(b.onAccent)}">
    ${pl.title ? card("title", pl.title.from, pl.title.dur, `${logo}<b>${esc(pl.app.name)}</b>${pl.app.version ? `<small>${esc(pl.labels.news)} · ${esc(pl.app.version)}</small>` : ""}`) : ""}
    ${pl.scenes.map(layer).join("")}
    ${pl.news ? card("news", pl.news.from, pl.news.dur, `<b>${esc(pl.labels.news)}</b><ul>${pl.news.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`) : ""}
    ${card(`end ${pl.end.kind}`, pl.end.from, pl.end.dur, `${pl.end.kind === "card" ? logo
      : `<div class="pv-scr full"><img src="${pvFile(fr, thumbOf(pl.scenes[pl.scenes.length - 1]?.src))}" alt=""></div><i class="pv-fade" aria-hidden="true"></i>`}<b>${esc(pl.app.name)}</b><span class="pv-cta">${esc(pl.app.cta)}</span>`)}
  </div>`;
}
function pvPaintPreview() {
  const box = document.getElementById("pvPreview");
  if (!box) return;
  const p = PV.view?.presets?.[PV.preset];
  if (!PV.kit || !p) { box.innerHTML = ""; return; }
  if (!PV.kit.fits?.[PV.preset]?.ok) { box.innerHTML = `<p class="meta">${esc(tr("pv.prev.nofit"))}</p>`; return; }
  if (PV.planErr) { box.innerHTML = `<p class="warnline" role="alert">${ico("alert", "sm")} ${esc(PV.planErr)}</p>`; return; }
  if (!PV.plan) { box.innerHTML = `<div class="skel pv-skel" role="status" aria-label="${esc(tr("pv.loading"))}" style="aspect-ratio:${p.width} / ${p.height}"></div>`; return; }
  const pl = PV.plan, fps = pl.preset.fps, total = pl.durationInFrames;
  const segs = [...(pl.title ? [{ from: pl.title.from, dur: pl.title.dur, name: pl.app.name }] : []), ...pl.scenes.map((s) => ({ from: s.from, dur: s.dur, name: s.surface || s.id })),
    ...(pl.news ? [{ from: pl.news.from, dur: pl.news.dur, name: pl.labels.news }] : []), { from: pl.end.from, dur: pl.end.dur, name: tr("pv.prev.end") }];
  box.innerHTML = `<div class="pv-prevhead"><b>${esc(tr("pv.prev.h"))}</b><span class="meta">${esc(tr("pv.prev.note"))}</span></div>
    ${pvStageHtml(pl)}
    <div class="pv-ctrl">
      <button type="button" class="icon" data-pvplay="1" aria-pressed="${PV.playing}" aria-label="${esc(tr(PV.playing ? "pv.prev.pause" : "pv.prev.play"))}" title="${esc(tr(PV.playing ? "pv.prev.pause" : "pv.prev.play"))}">${ico(PV.playing ? "pause" : "play")}</button>
      <span class="tc mono" id="pvTc">0:00 / ${mmss(total / fps)}</span>
      <div class="pv-tl" role="group" aria-label="${esc(tr("pv.prev.scenes"))}">${segs.map((s, i) => `<button type="button" class="pv-seg" style="flex:${s.dur}" data-pvseek="${s.from}" aria-label="${esc(tr("pv.prev.seek", { n: i + 1, s: s.name, t: pvSec(s.dur / fps) }))}" title="${esc(s.name)}"></button>`).join("")}<i class="pv-head" id="pvHead"></i></div>
    </div>
    ${(pl.warnings || []).length ? `<p class="meta">${ico("info", "sm")} ${esc(pl.warnings.join(" "))}</p>` : ""}`;
  pvAnimStart();
  pvDraw();
}
function pvAnimStop() { if (PV.anim) cancelAnimationFrame(PV.anim); PV.anim = null; }
function pvAnimStart() {
  pvAnimStop();
  const step = () => {
    if (page !== "product" || !document.getElementById("pvPreview")?.querySelector(".pv-stage")) { PV.anim = null; return; }
    if (PV.playing && PV.plan) {
      const fps = PV.plan.preset.fps;
      PV.at = (((performance.now() - PV.t0) / 1000) * fps) % PV.plan.durationInFrames;
      pvDraw();
    }
    PV.anim = requestAnimationFrame(step);
  };
  PV.anim = requestAnimationFrame(step);
}
/* One frame of the storyboard: the scenes on screen now, the reveal's line, the caption's arrival, the playhead. */
function pvDraw() {
  const pl = PV.plan, stage = document.querySelector("#pvPreview .pv-stage");
  if (!pl || !stage) return;
  const f = PV.at, ov = pl.overlap || 15, calm = moCalm();
  for (const el of stage.querySelectorAll(".pv-sc")) {
    const from = +el.dataset.from, dur = +el.dataset.dur, local = f - from;
    const on = local >= 0 && local < dur;
    el.classList.toggle("on", on);
    if (!on) continue;
    const enter = Math.min(1, local / ov), leave = el.classList.contains("full") || stage.classList.contains("full") ? 1 : Math.min(1, (dur - local) / ov);
    el.style.opacity = String(Math.max(0, Math.min(enter, leave)));
    const t = local / dur;
    el.style.setProperty("--t", calm ? "0" : t.toFixed(3));
    el.style.setProperty("--in", calm ? "1" : Math.min(1, Math.max(0, (local - 6) / 14)).toFixed(3));
    if (el.classList.contains("compare")) {
      const a = 0.36, b = 0.62, p = Math.min(1, Math.max(0, (t - a) / (b - a)));
      el.style.setProperty("--cut", `${(p * p * (3 - 2 * p) * 100).toFixed(2)}%`);
    }
  }
  const fps = pl.preset.fps;
  const tc = document.getElementById("pvTc"), head = document.getElementById("pvHead");
  if (tc) tc.textContent = `${mmss(f / fps)} / ${mmss(pl.durationInFrames / fps)}`;
  if (head) head.style.left = `${(100 * f / pl.durationInFrames).toFixed(2)}%`;
}

/* ---------- render, progress, the finished file and its spec, the optional reviewer ---------- */
function pvPaintAct() {
  const box = document.getElementById("pvAct");
  if (!box) return;
  const k = PV.kit, p = PV.view?.presets?.[PV.preset];
  if (!k || !p) { box.innerHTML = ""; return; }
  const id = pvId(), j = PV.jobs[id], fit = k.fits?.[PV.preset], made = k.renders?.[PV.preset];
  const busy = pvActive(j);
  const prog = busy ? `<div class="pv-prog"><div class="bar"><i style="width:${j.pct || 0}%"></i></div>
      <span class="meta">${esc(j.status === "queued" ? tr("pv.job.queued", { n: j.position || 1 }) : j.label || tr("pv.job.running"))} · ${j.pct || 0}%${j.eta != null ? ` · ${esc(mins(j.eta))}` : ""}</span>
      <button type="button" data-cancel="${esc(id)}">${ico("x", "sm")}${esc(tr("pv.job.stop"))}</button></div>` : "";
  const failed = j && j.status === "error" ? `<p class="warnline" role="alert">${ico("alert", "sm")} ${esc((j.lines || []).slice(-1)[0] || j.label || tr("pv.job.failed"))}</p>` : "";
  const result = made && !busy ? pvResultHtml(k, PV.preset, made, id) : "";
  box.innerHTML = `<div class="pv-acthead"><b>${esc(p.label)}</b><span class="meta">${esc(tr("pv.act.spec", { w: p.width, h: p.height, f: p.fps, a: p.minSec, b: p.maxSec }))}</span></div>
    ${busy ? "" : `<button type="button" class="primary" data-pvrender="1" ${fit?.ok ? "" : "disabled"}>${ico("clapper", "sm")}${esc(tr(made ? "pv.act.again" : "pv.act.go"))}</button>
      <span class="meta">${esc(fit?.ok ? tr("pv.act.noai") : fit?.why || tr("pv.pre.nofit"))}</span>`}
    ${prog}${failed}${result}`;
  if (made && PV.review[id] === undefined) {
    PV.review[id] = null;
    api(`/api/ai/review?slug=${encodeURIComponent(id)}`).then((r) => { PV.review[id] = r?.review ? r.review : null; if (r?.review) pvPaintAct(); }).catch(() => {});
  }
}
function pvResultHtml(k, preset, r, id) {
  const p = PV.view.presets[preset];
  const checks = [[`${r.width}×${r.height}`, r.width === p.width && r.height === p.height], [pvSec(r.seconds), r.seconds >= p.minSec && r.seconds <= p.maxSec],
    [`${String(r.fps || "").replace("/1", "")} fps`, true], [`H.264 ${r.profile || ""} ${r.level ? (r.level / 10).toFixed(1) : ""}`.trim(), true], [`${(r.bytes / 1024 / 1024).toFixed(1)} MB`, true]];
  const rv = PV.review[id];
  const review = rv?.busy ? `<p class="meta" role="status">${ico("hourglass", "sm")} ${esc(tr("pv.ai.busy"))}</p>`
    : rv?.error ? `<p class="warnline" role="alert">${ico("alert", "sm")} ${esc(rv.error)}</p>`
    : rv?.hook ? `<div class="pv-review"><b>${esc(tr("pv.ai.scores", { h: rv.hook?.score ?? "?", l: rv.look?.score ?? "?" }))}</b>${rv.summary ? `<p>${esc(rv.summary)}</p>` : ""}
        ${(rv.fixes || []).length ? `<ul>${rv.fixes.map((x) => `<li>${esc(typeof x === "string" ? x : x.fix || x.what || JSON.stringify(x))}</li>`).join("")}</ul>` : ""}</div>` : "";
  return `<div class="pv-result">
    <video class="pv-vid" controls preload="metadata" playsinline style="aspect-ratio:${p.width} / ${p.height};--ar:${(p.width / p.height).toFixed(4)}" src="${pvVideo(k.name, preset, r.made)}"></video>
    <div class="pv-rmeta">
      <p class="${r.ok ? "okline" : "warnline"}">${ico(r.ok ? "check" : "alert", "sm")} ${esc(r.ok ? tr("pv.res.ok", { l: p.label }) : (r.problems || []).join(" "))}</p>
      <ul class="pv-checks">${checks.map(([t, ok]) => `<li class="${ok ? "ok" : "bad"}">${ico(ok ? "check" : "x", "sm")}${esc(t)}</li>`).join("")}</ul>
      <p class="meta">${esc(tr("pv.res.made", { t: String(r.made || "").replace("T", " ").slice(0, 16) }))}</p>
      <div class="row wrap"><a class="btn primary" href="${pvVideo(k.name, preset, r.made, true)}" download>${ico("download", "sm")}${esc(tr("pv.res.dl"))}</a>
        <button type="button" data-pvcopy="${esc(r.file || "")}">${ico("copy", "sm")}${esc(tr("pv.res.copy"))}</button>
        <button type="button" data-pvreview="${esc(id)}" ${rv?.busy ? "disabled" : ""} title="${esc(tr("pv.ai.tip"))}">${ico("eye", "sm")}${esc(tr("pv.ai.go"))}</button></div>
      ${p.store === "google-play" ? `<p class="meta">${ico("info", "sm")} ${esc(tr("pv.res.play"))}</p>` : p.store === "app-store" ? `<p class="meta">${ico("info", "sm")} ${esc(tr("pv.res.asc"))}</p>` : ""}
      ${review}</div></div>`;
}
async function pvRender() {
  if (!PV.kit || !PV.preset) return;
  try {
    const r = await post("/api/product/render", { name: PV.kit.name, preset: PV.preset });
    PV.jobs[r.id] = r.job;
    toast(`${ico("clapper", "sm")} ${esc(tr("pv.job.queuedt", { s: pvSec(r.plan?.seconds || 0) }))}`, 5000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  pvPaintAct();
}
async function pvReview(id) {
  try {
    const e = await post("/api/ai/estimate", { slug: id, tools: ["review"] });
    if (!e.fits) { toast(`${ico("alert", "sm")} ${esc(e.refusal || e.summary)}`, 9000); return; }
    if (!confirm(tr("pv.ai.ask", { usd: Number(e.total || 0).toFixed(3) }))) return;
    PV.review[id] = { busy: true }; pvPaintAct();
    PV.review[id] = await post("/api/ai/review", { slug: id });
  } catch (err) { PV.review[id] = { error: err.message }; }
  pvPaintAct();
}
async function pvAdd(form) {
  const src = String(form.elements.src.value || "").trim(), name = String(form.elements.name.value || "").trim();
  if (!src) { PV.addErr = tr("pv.add.need"); renderHome(true); return; }
  const payload = /^(https:\/\/|file:)/i.test(src) ? { kitUrl: src } : /^https?:/i.test(src) ? null : { kitPath: src };
  if (!payload) { PV.addErr = tr("pv.add.https"); renderHome(true); return; }
  if (name) payload.name = name;
  PV.adding = true; PV.addErr = null; renderHome(true);
  try {
    const kit = await post("/api/product/kits", payload);
    PV.kit = null; PV.kitName = kit.name; PV.plan = null; PV.planOf = "";
    toast(`${ico("check", "sm")} ${esc(tr("pv.add.done", { a: kit.app?.name || kit.name, n: (kit.screens || []).length + (kit.recordings || []).length }))}`, 6000);
    PV.adding = false;
    await pvLoad();
    return;
  } catch (err) { PV.addErr = err.message; }
  PV.adding = false; renderHome(true);
}
document.addEventListener("submit", (e) => {
  const f = e.target.closest?.("[data-pvadd]"); if (!f) return;
  e.preventDefault();
  pvAdd(f);
});
document.addEventListener("input", (e) => {
  const r = e.target.closest?.("[data-pvcmp]"); if (!r) return;
  r.parentElement.style.setProperty("--cut", `${r.value}%`);
});
document.addEventListener("change", (e) => {
  const r = e.target.closest?.("input[name=pvpreset]"); if (!r) return;
  PV.preset = r.value; PV.plan = null;
  pvPaintAct(); pvPlan();
});
document.addEventListener("click", (e) => {
  const kb = e.target.closest?.("[data-pvkit]");
  if (kb) { if (kb.dataset.pvkit !== PV.kitName) pvOpen(kb.dataset.pvkit); return; }
  if (e.target.closest?.("[data-pvretry]")) { PV.err = null; PV.view = null; renderHome(true); return; }
  if (e.target.closest?.("[data-pvrender]")) return pvRender();
  const rv = e.target.closest?.("[data-pvreview]");
  if (rv) return pvReview(rv.dataset.pvreview);
  const cp = e.target.closest?.("[data-pvcopy]");
  if (cp) { navigator.clipboard?.writeText(cp.dataset.pvcopy).then(() => toast(`${ico("check", "sm")} ${esc(tr("pv.res.copied"))}`), () => toast(esc(cp.dataset.pvcopy), 8000)); return; }
  const rec = e.target.closest?.("[data-pvrec]");
  if (rec && PV.kit) {
    const box = rec.closest("[data-pvclip]");
    box.innerHTML = `<video src="${pvFile(PV.kit.name, rec.dataset.pvrec)}" controls autoplay muted playsinline></video>`;
    box.querySelector("video")?.focus();
    return;
  }
  const pl = e.target.closest?.("[data-pvplay]");
  if (pl) {
    PV.playing = !PV.playing;
    if (PV.playing && PV.plan) PV.t0 = performance.now() - (PV.at / PV.plan.preset.fps) * 1000;
    pl.setAttribute("aria-pressed", String(PV.playing));
    pl.setAttribute("aria-label", tr(PV.playing ? "pv.prev.pause" : "pv.prev.play"));
    pl.innerHTML = ico(PV.playing ? "pause" : "play");
    return;
  }
  const sk = e.target.closest?.("[data-pvseek]");
  if (sk && PV.plan) {
    PV.at = Number(sk.dataset.pvseek) + 1;
    PV.t0 = performance.now() - (PV.at / PV.plan.preset.fps) * 1000;
    pvDraw();
  }
});
