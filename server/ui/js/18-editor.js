/* ---------- edit model ---------- */
function commit(fn, label) {
  history.push(JSON.stringify(edit)); future = [];
  fn();
  keepWordsWithPicture();
  if (history.length > 200) history.shift();
  setMode(pictureDirty() ? "edit" : "rendered");
  renderAll();
  saveDraftSoon();
  if (label) toast(label, 1200);
}
function undo() { if (!history.length) return; future.push(JSON.stringify(edit)); edit = JSON.parse(history.pop()); setMode(pictureDirty() ? "edit" : "rendered"); renderAll(); saveDraftSoon(); }
function redo() { if (!future.length) return; history.push(JSON.stringify(edit)); edit = JSON.parse(future.pop()); setMode(pictureDirty() ? "edit" : "rendered"); renderAll(); saveDraftSoon(); }
function keepWordsWithPicture() {
  const T = total();
  const end = edit.beats.find((b) => b.kind === "end");
  if (end) { const len = Math.min(3.5, Math.max(2.4, end.endSec - end.startSec)); end.endSec = +T.toFixed(2); end.startSec = +Math.max(0.5, T - len).toFixed(2); }
  for (const b of edit.beats) if (b.kind !== "end" && end && b.endSec > end.startSec - 0.1) b.endSec = +(end.startSec - 0.1).toFixed(2);
  edit.beats = edit.beats.filter((b) => b.endSec - b.startSec >= 0.4);
}
const snapT = (v, extra = []) => {
  if (!snapOn) return v;
  const cands = [Math.round(v / GRID) * GRID, ...starts(), total(), t, ...extra];
  let best = v, dist = 0.18;
  for (const c of cands) if (Math.abs(c - v) < dist) { best = c; dist = Math.abs(c - v); }
  return +best.toFixed(3);
};
const snapLen = (v) => (snapOn ? Math.max(GRID, Math.round(v / GRID) * GRID) : Math.max(0.3, +v.toFixed(2)));
function shotAt(time) { const st = starts(); for (let i = 0; i < edit.shots.length; i++) if (time >= st[i] && time < st[i] + edit.shots[i].sec) return i; return edit.shots.length - 1; }
function inPoint(s) { return s.start ?? s.picked ?? 0; }
function maxLen(s) { if (s.kind === "photo") return 2.0; return s.srcDur ? Math.max(0.5, s.srcDur - inPoint(s) - 0.05) : 6; }

function splitAt() {
  const i = shotAt(t), s = edit.shots[i], st = starts()[i];
  const a = snapLen(t - st); if (a <= 0 || a >= s.sec) return toast("Put the playhead inside a clip to split it");
  commit(() => {
    const b = { ...JSON.parse(JSON.stringify(s)), sec: +(s.sec - a).toFixed(2), start: +(inPoint(s) + a).toFixed(2), mezz: null };
    s.sec = a; s.start = inPoint(s); s.mezz = null;
    edit.shots.splice(i + 1, 0, b);
  }, "Split. Note: a reel may not use one file twice, delete one half before rendering.");
}
function trimLeft() {
  const i = shotAt(t), s = edit.shots[i], st = starts()[i], cut = snapLen(t - st);
  if (cut <= 0 || cut >= s.sec) return toast("Put the playhead inside a clip");
  commit(() => { s.start = +(inPoint(s) + cut).toFixed(2); s.sec = +(s.sec - cut).toFixed(2); s.mezz = null; t = st; }, "Trimmed left of the playhead (Q)");
}
function trimRight() {
  const i = shotAt(t), s = edit.shots[i], st = starts()[i], keep = snapLen(t - st);
  if (keep <= 0 || keep >= s.sec) return toast("Put the playhead inside a clip");
  commit(() => { s.start = inPoint(s); s.sec = keep; s.mezz = null; }, "Trimmed right of the playhead (W)");
}
function deleteSel() {
  if (sel?.type === "shot") commit(() => { edit.shots.splice(sel.i, 1); sel = null; }, "Clip removed, the rest closed up");
  else if (sel?.type === "beat" && edit.beats[sel.i]?.kind !== "end") commit(() => { edit.beats.splice(sel.i, 1); sel = null; }, "Caption removed");
}
function insertAsset(item, index) {
  const rel = item.path.startsWith(MEDIA) ? item.path.slice(MEDIA.length).replaceAll("\\", "/") : item.path;
  if (edit.shots.some((s) => s.file.toLowerCase() === item.file.toLowerCase())) return toast(`${esc(item.file)} is already in this reel, each file is used once`);
  commit(() => {
    edit.shots.splice(index, 0, { src: rel, sec: 1.5, start: null, pan: null, role: "added in the editor", path: item.path, assetId: item.id, file: item.file,
      thumb: item.thumbs[0] || null, kind: item.kind, picked: null, srcDur: item.duration, mezz: null });
  }, `Added ${esc(item.file)}. The best 1.5 s is picked when you render.`);
  if (item.kind === "video") fetch("/proxy?id=" + item.id).catch(() => {});
}

/* ---------- rules (same as the build checks) ---------- */
function rules() {
  const out = [];
  const names = edit.shots.map((s) => s.file.toLowerCase());
  if (new Set(names).size !== names.length) out.push("a file is used twice");
  const photos = edit.shots.filter((s) => s.kind === "photo").length;
  if (photos > 0.3 * edit.shots.length) out.push(`too many photos (${photos}/${edit.shots.length})`);
  const T = total();
  // Each cut's own range and longest shot (py reels.LENGTH_RULE, SHOT_MAX): the long explainer 30-60 s, the site walk 25-40 s of shots up to 9 s.
  const [lo, hi] = edit.variant === "b-explainer" ? [30, 60] : edit.variant === "site-walk" ? [25, 40] : [8, 25];
  const most = edit.variant === "site-walk" ? 9 : 4;
  if (T < lo || T > hi) out.push(`length ${T.toFixed(1)} s (keep ${lo}–${hi} s)`);
  if (edit.shots.some((s) => s.sec > most)) out.push(`a shot over ${most} s`);
  if (!edit.beats.some((b) => b.kind === "hook" && b.startSec <= 0.5)) out.push("no hook in the first 0.5 s");
  return out;
}

/* ---------- player and preview ---------- */
function setAspect(a) {
  aspect = a;
  document.querySelectorAll("[data-aspect]").forEach((b) => b.classList.toggle("on", b.dataset.aspect === a));
  const [w, h] = a === "9x16" ? [9, 16] : a === "4x5" ? [4, 5] : [16, 9];
  $("#frame").style.aspectRatio = `${w} / ${h}`;
  $("#frame").style.height = w > h ? "auto" : "100%";
  $("#frame").style.width = w > h ? "100%" : "auto";
  seekWant ??= player.currentTime || 0;  // keep the moment across sizes, unless a seek is already waiting
  player.src = file(reel.outputs[a]);
  paintSafe();
  const spec = { "9x16": "1080×1920 · 9:16 · Reels, Shorts, TikTok, Threads, RED", "4x5": "1080×1350 · 4:5 · LinkedIn, Facebook feed", "16x9": "1920×1080 · 16:9 · X, kensaur.us, Zenn, note" }[a];
  $("#specLine").innerHTML = `${ico("film", "sm")} ${spec} · 30 fps · H.264`;
}
function setMode(m) {
  mode = m;
  const edit_ = m === "edit";
  player.style.display = edit_ ? "none" : "";
  pv.style.display = edit_ ? "" : "none";
  if (!edit_) { pi.style.display = "none"; $("#caps").innerHTML = ""; }
  $("#modeChip").innerHTML = edit_ ? `${ico("scissors", "sm")} Edit preview (unsaved)` : `${ico("eye", "sm")} Rendered`;
  $("#modeChip").className = "mode chip " + (edit_ ? "warn" : "blue");
  syncSound();
}
function play() { playing = true; lastTick = performance.now(); if (mode === "rendered") player.play().catch(() => {}); /* a newer load interrupts it: harmless, not an error */ $("#play").innerHTML = `${ico("pause")}<span>Pause</span>`; }
function pause() { playing = false; player.pause(); pv.pause(); pa.pause(); $("#play").innerHTML = `${ico("play")}<span>Play</span>`; }

/* ---------- the edit preview has sound: clip sound plus the chosen track, kept in step with the playhead ---------- */
const pa = $("#pa");
let soundOn = true;
try { soundOn = localStorage.getItem("studio.previewSound") !== "off"; } catch { /* default on */ }
function previewMusic() {
  const m = edit?.music;
  if (!m || m === "off") return null;
  const id = typeof m === "object" ? m.id : reel.audio?.music?.id;
  const track = audioLib.find((a) => a.id === id);
  if (!track?.file) return null;
  const start = typeof m === "object" ? m.start ?? 0 : reel.audio?.music?.start ?? 0;
  const vol = typeof m === "object" ? m.volume ?? 1 : reel.audio?.music?.volume ?? 1;
  return { src: file(track.file), start, vol };
}
function syncSound() {
  const on = mode === "edit" && playing && soundOn;
  pv.muted = !(mode === "edit" && soundOn);
  pv.volume = 0.55;
  const mus = on ? previewMusic() : null;
  if (!mus) { if (!pa.paused) pa.pause(); return; }
  if (pa.dataset.src !== mus.src) { pa.dataset.src = mus.src; pa.src = mus.src; }
  pa.volume = Math.max(0, Math.min(1, 0.45 * mus.vol));
  const want = mus.start + t;
  // A track shorter than the reel just ends (the render does the same); never restart it from 0 every frame.
  if (pa.readyState >= 1 && Number.isFinite(pa.duration) && want >= pa.duration - 0.05) { if (!pa.paused) pa.pause(); return; }
  if (pa.readyState >= 1 && Math.abs(pa.currentTime - want) > 0.25) pa.currentTime = want;
  if (pa.paused) pa.play().catch(() => {});
}
function paintSound() { const b = $("#soundBtn"); b.classList.toggle("on", soundOn); b.setAttribute("aria-pressed", String(soundOn)); b.innerHTML = ico(soundOn ? "volume" : "x"); }
$("#soundBtn").onclick = () => { soundOn = !soundOn; try { localStorage.setItem("studio.previewSound", soundOn ? "on" : "off"); } catch { /* fine */ } paintSound(); syncSound(); };
paintSound();

/* ---------- unsaved edits survive a closed tab, a crash or a restart (this browser only) ---------- */
const draftKey = (slug) => "studio.draft." + slug;
let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!edit) return;
    try { if (isDirty()) localStorage.setItem(draftKey(edit.slug), JSON.stringify({ base: saved, edit: JSON.stringify(edit), at: Date.now() })); else localStorage.removeItem(draftKey(edit.slug)); } catch { /* storage full or off: the edit is still in memory */ }
  }, 800);
}
function clearDraft(slug) { try { localStorage.removeItem(draftKey(slug)); } catch { /* fine */ } sys.clear("draft"); }
function offerDraft() {
  sys.clear("draft");
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey(reel.slug)) || "null"); } catch { d = null; }
  if (!d || d.edit === saved) return;
  if (d.base !== saved) { clearDraft(reel.slug); return; }  // the reel was re-rendered since: the draft no longer applies
  sys.say("draft", "warn", tr("draft.found", { t: new Date(d.at).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) }),
    `<button class="primary" data-draft="restore">${tr("draft.restore")}</button><button data-draft="drop">${tr("draft.drop")}</button>`);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-draft]"); if (!b || !reel) return;
  if (b.dataset.draft === "restore") {
    try { const d = JSON.parse(localStorage.getItem(draftKey(reel.slug))); history.push(JSON.stringify(edit)); edit = JSON.parse(d.edit); }
    catch { return clearDraft(reel.slug); }
    sys.clear("draft"); setMode(pictureDirty() ? "edit" : "rendered"); renderAll(); toast(`${ico("check", "sm")} ${tr("draft.restored")}`);
  } else clearDraft(reel.slug);
});
window.addEventListener("beforeunload", (e) => { if (reel && edit && !atHome() && isDirty()) { e.preventDefault(); e.returnValue = ""; } });
let pvShot = -1;
function drawPreview() {
  const i = shotAt(t), s = edit.shots[i], st = starts()[i];
  const local = t - st;
  if (s.kind === "photo") {
    pv.pause(); pv.style.display = "none"; pi.style.display = "";
    const src = s.assetId ? "/proxy?id=" + s.assetId : (s.thumb ? file(s.thumb) : "");
    if (pi.dataset.src !== src) { pi.dataset.src = src; pi.src = src; }
    pi.style.transform = `scale(${1 + 0.09 * (local / s.sec)})`;
  } else {
    pi.style.display = "none"; pv.style.display = "";
    let src, at;
    if (s.mezz && s.mezzIndex != null) { src = file(`${MEDIA_MEZZ}\\${reel.slug}\\${String(s.mezzIndex).padStart(2, "0")}_${aspect === "16x9" ? "w" : "t"}.mp4`); at = local; }
    else if (s.assetId) { src = "/proxy?id=" + s.assetId; at = inPoint(s) + local; }
    if (src && pv.dataset.src !== src) { pv.dataset.src = src; pv.src = src; pv.addEventListener("loadedmetadata", () => { pv.currentTime = at; if (playing) pv.play().catch(() => {}); }, { once: true }); }
    else if (src && (i !== pvShot || Math.abs(pv.currentTime - at) > 0.25)) { pv.currentTime = at; }
    if (playing && pv.paused && pv.readyState >= 2) pv.play().catch(() => {});
    if (!playing && !pv.paused) pv.pause();
  }
  pvShot = i;
  const beat = edit.beats.find((b) => t >= b.startSec && t < b.endSec);
  const wide = aspect !== "9x16";
  $("#caps").className = edit.style || "column";
  const side = beat && reel.beats?.find((b) => b.kind === "line" && Math.abs(b.startSec - beat.startSec) < 0.05)?.side;
  $("#caps").innerHTML = !beat ? "" : beat.kind === "hook"
    ? `<div class="cap hook ${wide ? "wide" : ""}">${esc(beat.ja).replace("\n", "<br>")}<span class="en">${esc(beat.en)}</span></div>`
    : beat.kind === "end" ? endCardHtml()
    : `<div class="cap line ${side === "right" ? "right" : ""}">${esc(beat.ja)}<span class="en">${esc(beat.en)}</span></div>`;
}
/* The end card in the preview: this project's name (GET /api/brand), a CJK name over its Latin part as src/Story.tsx draws it. */
function endCardHtml() {
  if (!brandView && !endCardHtml.asked) { endCardHtml.asked = true; api("/api/brand").then((b) => { brandView = b; }).catch(() => {}); }
  const n = String(brandView?.name || WORKSPACE || "");
  const m = n.match(/^(.*[\u3040-\u30ff\u3400-\u9fff])\s*([A-Za-z].*)$/);
  const [top, low] = m ? [m[1], m[2].replace(/\s*&\s*/, " & ")] : [n, ""];
  return `<div class="cap end"><div style="font-family:'Shippori Mincho';font-style:normal;font-size:2.2vh;letter-spacing:.4em">${esc(top)}</div>${esc(low)}</div>`;
}
function seek(v) {
  t = Math.max(0, Math.min(v, (mode === "rendered" ? reel.durationSec : total()) - 0.001));
  if (mode !== "rendered") return drawPreview();
  // A file still loading would reset to 0 when it arrives: one waiting seek, applied when it can be.
  if (player.readyState >= 1) { player.currentTime = t; seekWant = null; } else seekWant = t;
}
let seekWant = null;
player.addEventListener("loadedmetadata", () => { if (seekWant != null) { player.currentTime = seekWant; seekWant = null; } });
(function tick(now) {
  if (reel && edit) {
    if (mode === "rendered") { if (player.readyState >= 1) t = player.currentTime || 0; }
    else if (playing) {
      t += (now - lastTick) / 1000; lastTick = now;
      if (t >= total()) { if ($("#loop").classList.contains("on")) t = 0; else { t = total(); pause(); } }
      drawPreview();
    }
    if (mode === "edit") syncSound();
    lastTick = now;
    if (mode === "edit" && pv.style.display !== "none" && pv.readyState < 2 && pv.dataset.src) $("#busy").dataset.prep = "1";
    const prep = mode === "edit" && pv.style.display !== "none" && pv.readyState < 2 && pv.dataset.src;
    if (!/chip (blue|warn|bad)|data-cancel|data-keep/.test($("#busy").innerHTML)) $("#busy").innerHTML = prep ? `<span class="chip">${ico("clock", "sm")} preparing a preview of this clip…</span>` : "";
    const T = mode === "rendered" ? reel.durationSec : total();
    $("#tc").textContent = fmt(t) + " / " + fmt(T);
    const ph = $("#ph"); if (ph) ph.style.left = t * pps + "px";
  }
  requestAnimationFrame(tick);
})(performance.now());
player.onended = () => { if (!$("#loop").classList.contains("on")) pause(); };
player.loop = true;

/* ---------- render: header, left, inspector, timeline ---------- */
function renderAll() { renderStatus(); renderLeft(); renderInspector(); renderTimeline(); }
function renderStatus() {
  const st = reel.review?.status || "rendered";
  const faces = reel.stats.faces > 0 && !edit.blurFaces;
  const now = Date.now(), mine = (typeof postsLog !== "undefined" ? postsLog : []).filter((p) => p.slug === reel.slug && p.network !== "all" && p.at);
  const booked = mine.filter((p) => ["scheduled", "queued"].includes(p.status) && new Date(p.at).getTime() > now).sort((a, b) => new Date(a.at) - new Date(b.at));
  const out = [...new Set(mine.filter((p) => p.status === "posted").map((p) => NET_NAME[chOf(p.network)] || p.network))];
  const where = booked.length ? " · " + tr("ed.booked", { nets: [...new Set(booked.map((p) => NET_NAME[chOf(p.network)] || p.network))].join(", "), t: whenText(booked[0].at) })
    : out.length ? " · " + tr("ed.out", { nets: out.join(", ") }) : "";
  const ST = { approved: "ed.st.approved", rendered: "ed.st.rendered", rejected: "ed.st.rejected", reroll: "ed.st.reroll", draft: "ed.st.draft" };
  $("#status").innerHTML = `${ico(st === "approved" ? "check" : "film", "sm")} <span class="edstatus">${tr(ST[st] || "ed.st.rendered")}${where}${faces ? ` · ${ico("user", "sm")} ${reel.review?.consent ? tr("ed.consentok") : tr("ed.consentneed")}` : ""}</span>`;
  $("#approve").style.display = st === "approved" ? "none" : "";
  $("#approve").title = tr(autoView?.settings?.plan?.on === false ? "ed.approvetip.manual" : "ed.approvetip.auto");
  // Keep "edit-only": without it this chip stayed on every page after leaving a reel.
  $("#status").className = "chip edit-only " + (st === "approved" ? "ok" : faces && !reel.review?.consent ? "warn" : "");
  $("#consent").style.display = faces ? "" : "none";
  $("#linkMade").href = "#/log/reels/" + reel.slug; $("#linkMade").innerHTML = `${ico("list", "sm")}${tr("r.howmade")}`;
  $("#linkPosts").href = "#/log/posts/" + reel.slug; $("#linkPosts").innerHTML = `${ico("send", "sm")}${tr("r.posts")}`;
  const dirty = isDirty();
  $("#dirty").style.display = dirty ? "" : "none";
  cRulesChip();  // batch C: the same issue list as the Issues lane and Properties (edIssues)
  $("#undo").disabled = !history.length; $("#redo").disabled = !future.length;
}

function libTile(it) {
  const used = it.usedIn.length;
  const dur = it.kind === "video" ? `${(it.duration || 0).toFixed(1)}s` : "photo";
  const sel_ = libSel === it.id ? "sel" : "";
  const season = it.season ? ico(SEASON_ICON[it.season] || "cal", "sm") : "";
  return `<div class="tile ${sel_}" draggable="true" data-asset="${it.id}" title="${esc(it.file)}\n${esc(it.event || "")}\nDrag onto the timeline, or double-click to add at the playhead">
    <img src="${thumb(it.thumbs[0] || "", 320)}" data-thumbs='${esc(JSON.stringify(it.thumbs))}' loading="lazy" alt="">
    <div class="tl"><span class="pill">${ico(it.kind === "video" ? "film" : "image", "sm")}${dur}</span>${it.faces ? `<span class="pill" title="${it.faces} face(s): needs consent">${ico("user", "sm")}${it.faces}</span>` : ""}</div>
    <div class="tr">${used ? `<span class="pill used" title="Used in: ${esc(it.usedIn.join(", "))}">×${used}</span>` : `<span class="pill unused" title="Not used in any reel yet">unused</span>`}
      ${it.place.startsWith("away") ? `<span class="pill away" title="GPS says away from the ranch">${ico("pin", "sm")}away</span>` : ""}
      ${it.vetoed ? `<span class="pill away" title="Never auto-picked (you can still add it by hand)">${ico("x", "sm")}hidden</span>` : ""}</div>
    <div class="bl"><span class="pill">${ico(DEVICE_ICON[it.device] || "camera", "sm")}${esc((it.captured || "").slice(0, 10))}</span>${season}${footTags(it).slice(0, 3).map(([, x]) => `<span class="tag">${esc(x)}</span>`).join("")}</div>
  </div>`;
}
function renderLeft() {
  document.querySelectorAll("[data-ltab]").forEach((b) => b.classList.toggle("on", b.dataset.ltab === ltab));
  const el = $("#left");
  if (ltab === "library") {
    const items = lib.items;
    const unused = items.filter((i) => !i.usedIn.length).length, once = items.filter((i) => i.usedIn.length === 1).length, more = items.filter((i) => i.usedIn.length > 1).length;
    const f = libFilters;
    el.innerHTML = `
      <div class="search">${ico("search")}<input id="q" placeholder="${RANCH_WS ? "Search in words: tent at dusk, snow, pizza, drone over field…" : "Search in words: sunset, food, a person, drone over a field…"}" value="${esc(libQuery)}"></div>
      <div class="row">
        ${["", "video", "photo"].map((k) => `<button class="toggle ${f.kind === k || (!f.kind && !k) ? "on" : ""}" data-f="kind" data-v="${k}">${k ? ico(k === "video" ? "film" : "image", "sm") : ico("layers", "sm")}${k || "all"}</button>`).join("")}
        ${RANCH_WS ? `<button class="toggle ${f.ranch ? "on" : ""}" data-f="ranch" title="Only footage the GPS or its folder puts at the ranch">${ico("pin", "sm")}ranch</button>` : ""}
        <button class="toggle ${f.noFaces ? "on" : ""}" data-f="noFaces" title="Hide clips with faces">${ico("user", "sm")}no faces</button>
        <button class="toggle ${f.unused ? "on" : ""}" data-f="unused" title="Only footage not used in any reel">unused</button>
      </div>
      <div class="row">
        <select id="fSeason" title="Season">${["", "spring", "summer", "autumn", "winter"].map((s) => `<option value="${s}" ${f.season === s ? "selected" : ""}>${s || "any season"}</option>`).join("")}</select>
        <select id="fEvent" title="Event (folder)" style="flex:1;min-width:0"><option value="">any event</option>${lib.events.map((e) => `<option ${f.event === e ? "selected" : ""}>${esc(e)}</option>`).join("")}</select>
      </div>
      <div class="row">${["mountains", "field", "tent", "fire", "snow", "deck", "food", "car", "aerial", "desk", "night", "autumn"].map((tg) => `<button class="toggle ${f.tag === tg ? "on" : ""}" data-tag="${tg}">${ico(TAG_ICON[tg] || "tag", "sm")}${tg}</button>`).join("")}</div>
      <div class="stats">
        <div class="stat" data-quick="all"><b>${items.length}</b><span>shown</span></div>
        <div class="stat" data-quick="unused"><b style="color:var(--accent)">${unused}</b><span>unused</span></div>
        <div class="stat"><b>${once}</b><span>used once</span></div>
        <div class="stat"><b style="color:var(--warn)">${more}</b><span>used 2+</span></div>
      </div>
      <div class="grid">${items.map(libTile).join("") || "<p class='note'>Nothing matches.</p>"}</div>`;
    const q = $("#q");
    q.onkeydown = (e) => { if (e.key === "Enter") { libQuery = q.value; searchLibrary(); } };
    $("#fSeason").onchange = (e) => { libFilters.season = e.target.value || undefined; searchLibrary(); };
    $("#fEvent").onchange = (e) => { libFilters.event = e.target.value || undefined; searchLibrary(); };
    return;
  }
  if (ltab === "exports") {
    el.innerHTML = renderExports();
    // Opened from one network's square: show that network's card, not the top of the list.
    if (focusChan) { const c = el.querySelector(`.chan[data-channel="${CSS.escape(focusChan)}"]`); focusChan = null; if (c) { c.classList.add("focus"); c.scrollIntoView({ block: "start" }); } }
    return;
  }
  if (ltab === "audio") { el.innerHTML = renderAudioTab(); return; }
  if (ltab === "ai") { el.innerHTML = renderAiTab(); return; }
  el.innerHTML = `<p class="note">${edit.shots.length} clips in this ${isDirty() ? "edit" : "reel"}. Click to jump; drag on the timeline to reorder.</p>` +
    edit.shots.map((s, i) => {
      const m = reel.shots.find((x) => x.file === s.file);
      return `<div class="card ${sel?.type === "shot" && sel.i === i ? "sel" : ""}" data-shot="${i}">
        <img src="${s.thumb ? file(s.thumb) : ""}" alt="">
        <div><div class="name">${i + 1}. ${esc(s.file)}</div>
          <div class="meta">${ico(s.kind === "video" ? "film" : "image", "sm")} ${esc(s.src.split("/").slice(0, -1).join(" / "))}</div>
          ${m ? `<div class="meta">${ico(DEVICE_ICON[m.device] || "camera", "sm")} ${m.source.width}×${m.source.height} · ${m.source.fps ?? "?"} fps${m.source.hdr ? " · HDR" : ""} · ${esc((m.captured || "").slice(0, 10))}</div>` : ""}
          <div class="meta">${ico("clock", "sm")} ${s.sec}s on screen${s.start != null ? ` · from ${s.start}s` : s.picked != null ? ` · from ${s.picked}s (auto)` : " · best window picked at render"}</div>
        </div></div>`;
    }).join("");
}
/* AI touches for the open reel: tick what to add, the studio prices it (fal.ai / OpenRouter, POST /api/ai/estimate)
   against the per-reel, daily and total limits, then runs it and renders the reel again (POST /api/ai/run). An approved
   reel is never changed: the touches go onto a copy (<slug>-ai) that goes to review like any new reel. */
const AI_ORDER = ["review", "sharpen", "slowmo", "living", "foley", "behind", "music", "voice"];
const AI_LABEL = { review: "ait.review", sharpen: "ait.sharpen", slowmo: "ait.slowmo", living: "ait.living", foley: "ait.foley", behind: "ait.behind", music: "ait.music", voice: "ait.voice" };
let aiTab = { slug: "", tools: new Set(["music"]), est: null, busy: false, err: "", into: "" };
function renderAiTab() {
  if (aiTab.slug !== reel.slug) aiTab = { slug: reel.slug, tools: new Set(["music"]), est: null, busy: false, err: "", into: "" };
  if (aiView === null) { aiView = undefined; api("/api/ai").then((a) => { aiView = a; }).catch(() => { aiView = { unavailable: true, slow: true }; }).finally(() => { if (ltab === "ai" && !atHome()) renderLeft(); }); }
  if (aiView === undefined) return loadingHtml("AI");
  if (aiView.slow) return `<p class="note">${tr("ait.slow")} <button data-airetry>${tr("ait.retry")}</button></p>`;
  if (aiView.unavailable || !aiView.ready) return `<p class="note">${tr("ait.nokey")} <a href="#/keys/keys">${tr("nav.keys")} ›</a></p>`;
  const what = Object.fromEntries((aiView.tools || []).map((t) => [t.tool, t.what]));
  aipTabHealth();
  const e = aiTab.est, room = aiView.room || {};
  return `<div class="aitab">
    <p class="meta">${tr("ait.room", { t: usd(room.today ?? 0), a: usd(room.total ?? 0), r: usd(aiView.caps?.reel ?? 0) })}</p>
    ${aiTab.into ? `<p class="note">${tr("ait.copy", { s: esc(aiTab.into) })}</p>` : ""}
    <ul class="aitools">${AI_ORDER.map((t) => {
      const row = e?.tools?.find((x) => x.tool === t);
      return `<li><label><input type="checkbox" data-aitool="${t}" ${aiTab.tools.has(t) ? "checked" : ""} ${aiTab.busy ? "disabled" : ""}>
        <b>${tr(AI_LABEL[t])}</b>${row ? `<span class="aiusd">${row.usd ? usd(row.usd) : row.note ? "–" : usd(0)}</span>` : ""}</label>
        <span class="meta">${t === "review" && (row?.basis === "frames" || (!row && aiView.reviewBasis === "frames")) ? esc(tr("ai.frames", { n: row?.quantity || "12–16" })) : esc(row?.note || (lang === "ja" ? tr("d_wf.w." + AIP_TOOL_CAP[t]) : what[t]) || "")}</span>${aipSvc(t)}</li>`;
    }).join("")}</ul>
    ${e ? `<p class="aisum ${e.fits ? "" : "bad"}"><b>${usd(e.total)}</b> ${esc(e.fits ? tr("ait.fits") : e.refusal || "")}${e.labelRequired ? ` · ${tr("ait.label")}` : ""}</p>` : ""}
    ${aiTab.err ? `<p class="bad">${esc(aiTab.err)}</p>` : ""}
    <div class="row wrap">
      <button data-aiprice ${aiTab.busy || !aiTab.tools.size ? "disabled" : ""}>${tr("ait.price")}</button>
      <button class="primary" data-airun ${aiTab.busy || !e?.fits ? "disabled" : ""}>${tr(aiTab.busy ? "ait.running" : "ait.run")}</button></div>
  </div>`;
}
/* aip (21 Nov): which service each touch runs on now (GET /api/ai/health, asked again after 30 s so a switch made in
   Settings shows here), and plainly when that service is out of credit or has no key yet, with the way to fix it. */
const AIP_TOOL_CAP = { review: "vision", sharpen: "upscale", slowmo: "slowmo", living: "img2video", foley: "sfx", behind: "bg-cut", music: "music", voice: "voice" };
let aipTabAt = 0;
function aipTabHealth() {
  if (Date.now() - aipTabAt < 30e3) return;
  aipTabAt = Date.now();
  api("/api/ai/health").then((v) => { fbView = v; fbAt = Date.now(); if (ltab === "ai" && !atHome()) renderLeft(); }).catch(() => {});
}
function aipSvc(tool) {
  const f = fbView?.capabilities?.[AIP_TOOL_CAP[tool]], pid = f?.provider;
  if (!pid || f.on === false) return "";
  const name = fbName(pid), st = aipState(pid), key = pid === "own" ? true : aipHasKey(pid);
  const fix = st !== "ok" ? `<i class="wtag bad">${ico("alert", "sm")}${esc(tr("fb_a.h." + st))}</i><a href="#/keys/blocks">${esc(tr("aip_s.change"))} ›</a>`
    : key === false ? `<a class="wtag warn" href="#/keys/keys" data-aipkey="${esc(pid)}">${ico("alert", "sm")}${esc(tr("aip_s.needkey", { p: name }))} ›</a>` : "";
  return `<span class="aip-svc"><span class="meta">${esc(tr("aip_s.on", { p: name }))}</span>${fix}</span>`;
}
function aiSync() {  // the tab always works on the reel that is open (a reel switched mid-load must not be priced as the last one)
  if (reel && aiTab.slug !== reel.slug) aiTab = { slug: reel.slug, tools: new Set(aiTab.tools), est: null, busy: false, err: "", into: "" };
}
async function aiPrice() {
  aiSync();
  aiTab.busy = true; aiTab.err = ""; renderLeft();
  const body = (into) => ({ slug: aiTab.slug, tools: [...aiTab.tools], options: into ? { into } : {} });
  try {
    let est = await post("/api/ai/estimate", body(aiTab.into));
    if (!est.fits && /approved or scheduled/.test(est.refusal || "") && !aiTab.into) { aiTab.into = `${aiTab.slug}-ai`.slice(0, 60); est = await post("/api/ai/estimate", body(aiTab.into)); }
    aiTab.est = est;
  } catch (err) { aiTab.err = err.message; }
  aiTab.busy = false; renderLeft();
}
document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-aitool]"); if (!t) return;
  if (t.checked) aiTab.tools.add(t.dataset.aitool); else aiTab.tools.delete(t.dataset.aitool);
  aiTab.est = null; renderLeft();
});
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-aiprice]")) return aiPrice();
  if (e.target.closest("[data-airetry]")) { aiView = null; return renderLeft(); }
  if (!e.target.closest("[data-airun]")) return;
  if (reel && aiTab.slug !== reel.slug) { aiSync(); return renderLeft(); }  // priced for another reel: price this one first
  aiTab.busy = true; aiTab.err = ""; renderLeft();
  try {
    const r = await post("/api/ai/run", { slug: aiTab.slug, tools: [...aiTab.tools], options: aiTab.into ? { into: aiTab.into } : {}, render: true });
    toast(`${ico("clapper", "sm")} ${esc(tr("ait.started", { s: aiTab.into || aiTab.slug, n: usd(r.estimate?.total || 0) }))}`, 6000);
    aiView = null; aiTab.est = null; loadOverview();
  } catch (err) { aiTab.err = err.message; }
  aiTab.busy = false; if (ltab === "ai") renderLeft();
});
function renderExports() {
  const files = Object.fromEntries((reel.channels || []).map((c) => [c.name, c]));
  return `<p class="note">${ico("info", "sm")} ${tr("ux2.exp.note")} ${(reel.channels || [])[0]?.dir ? `${tr("ux2.exp.files")} <span class="meta" title="${esc(reel.channels[0].dir)}">${esc(String(reel.channels[0].dir).split(/[\\/]/).filter(Boolean).slice(-2).join(" › "))}</span>` : ""}</p>` +
    channelsSpec.channels.map((c) => {
      const got = files[c.id];
      const over = reel.durationSec > c.maxSec;
      return `<div class="chan" data-channel="${c.id}">
        <div class="head">${netLogo(c.id)}<div style="flex:1"><b>${esc(c.name)}</b><div class="meta">${esc(c.who)}</div></div>
          ${got ? `<span class="chip ok">${ico("check", "sm")}${tr("ux2.exp.ready")}</span>` : `<span class="chip">${ico("clock", "sm")}${tr("ux2.exp.renderfirst")}</span>`}</div>
        <div class="row" style="margin-top:6px">${c.files.map((f) => `<span class="chip blue">${ico("film", "sm")}${f.aspect.replace("x", ":")} · ${f.w}×${f.h}</span>`).join("")}<span class="chip">30 fps</span>
          <span class="chip ${over ? "bad" : ""}">${ico("clock", "sm")}≤ ${c.maxSec >= 60 ? tr("ux2.exp.min", { n: Math.round(c.maxSec / 60) }) : tr("ux2.exp.sec", { n: c.maxSec })}</span></div>
        <div class="meta">${esc(c.note)}</div>
        ${got ? `<div class="meta">${got.videos.map((v) => `${esc(v.file)} · ${v.w}×${v.h} · ${v.fps} fps · ${v.sec}s · ${v.mb} MB`).join("<br>")}</div>` : ""}
        ${got ? exportActions(c.id, got) : ""}
      </div>`;
    }).join("");
}

/* ---------- posting: download, copy, plan and remind, YouTube, what went out ---------- */
let yt = { app: false, connected: false }, postsLog = [], ytVideos = null, focusChan = null;
let connections = {};               // networks the studio posts to itself (Accounts page), with their status
const publishing = new Set();       // post-<slug>-<net> jobs started from this page
const bookingAt = new Set();        // ...of them, the ones booking a later time (not posting now): their own words
const drawerOpen = () => !!drawer;
const netOf = (cid) => (cid === "youtube-shorts" ? "youtube" : cid);
const chOf = (net) => (net === "youtube" ? "youtube-shorts" : net);
/* Post times are picked and shown in the audience's zone (STUDIO_TZ in .env, e.g. Asia/Tokyo), not this
   computer's: a PC in Singapore posting for Japan must not shift every slot by an hour. Times are saved with
   their offset ("2026-11-12T19:00+09:00"); old entries without one were picked in this computer's zone. */
const PC_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
function audTz() { try { if (AUD_TZ) { new Intl.DateTimeFormat("en", { timeZone: AUD_TZ }); return AUD_TZ; } } catch { /* unknown name: use this computer's */ } return PC_TZ; }
function wallOf(ms, tz = audTz()) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(ms)) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
}
// "2026-11-12T19:00" read as a wall clock in the audience zone → "2026-11-12T19:00+09:00".
/* Two kinds of time: a stored post time (with its offset, or bare = this computer's local time, read by new Date())
   and a wall-clock time typed for the audience (zonedIso: read in the audience's zone). Never mix them. */
function zonedIso(wall, tz = audTz()) {
  if (!wall || /([zZ]|[+-]\d\d:?\d\d)$/.test(wall)) return wall;
  const guess = Date.parse(wall.slice(0, 16) + "Z");
  let ms = guess;
  for (let i = 0; i < 2; i++) ms = guess - (Date.parse(wallOf(ms, tz) + "Z") - ms);
  const off = Math.round((Date.parse(wallOf(ms, tz) + "Z") - ms) / 60000), a = Math.abs(off);
  return `${wall.slice(0, 16)}${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const tzLabel = (tz = audTz()) => new Intl.DateTimeFormat("ja-JP", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || tz;
const tzHint = () => (audTz() === PC_TZ ? "" : `<span class="meta" title="${esc(audTz())}">${esc(tzLabel())}</span>`);
function whenText(iso) {
  // In the page's language: an English page showed "11/11(水) 06:25".
  const t = new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", { timeZone: audTz(), month: lang === "ja" ? "numeric" : "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  return audTz() === PC_TZ ? t : `${t} ${tzLabel()}`;
}
function nextSlot(hour = 19) {
  const now = Date.now(), w = wallOf(now);
  const day = +w.slice(11, 13) >= hour - 1 ? wallOf(now + 86400000).slice(0, 10) : w.slice(0, 10);
  return `${day}T${String(hour).padStart(2, "0")}:00`;
}
/* A failed read keeps what the page already had (a restart must never look like an empty studio), and says so. */
let postsLoaded = false, postsFailed = false;
async function loadPosting() {
  let failed = false;
  const keep = (old) => () => { failed = true; return old; };
  [yt, postsLog, connections] = await Promise.all([api("/api/youtube").catch(keep(yt)), api("/api/posts").catch(keep(postsLog)), api("/api/connections").catch(keep(connections))]);
  postsFailed = failed && !postsLoaded;
  if (!failed) { postsLoaded = true; postsHash = JSON.stringify(postsLog.map((p) => [p.id, p.status, p.at, p.url, p.seen_at])); postNews(postsLog); loadStale(); if (page === "posting") loadAuto(); }
  if (failed) { setTimeout(() => loadPosting(), 4000); if (postsLoaded) toast(`${ico("alert", "sm")} ${tr("load.stale")}`, 4000); }
  lastSync = Date.now(); paintSync();
  if (drawer) paintDrawer();
  if (yt.connected && ytVideos === null) {
    ytVideos = undefined;
    api("/api/youtube/videos").then((v) => { ytVideos = v; if (atHome()) renderHome(true); })
      .catch((err) => { ytVideos = []; toast(`${ico("alert", "sm")} YouTube: ${esc(err.message)}`, 6000); });
  }
  if (atHome()) renderHome(true);
  else if (reel && ltab === "exports") renderLeft();
}
function ytConnectHtml() {
  if (!yt.app) return `<p class="note">${ico("info", "sm")} ${tr("x.ytsetup")}</p>${page === "keys" ? "" : `<p><a class="btn primary" href="#/keys/google">${ico("shield", "sm")}${tr("x.ytsetupgo")}</a></p>`}`;
  return `<div class="row"><a class="btn primary" href="/api/youtube/connect">${ico("play", "sm")}${tr("yt.connect")}</a><span class="meta">${tr("x.ytconnecthint")}</span></div>`;
}
/* Bookings whose headline already goes out on the same network within 14 days: id → the other booking. */
function repeatMap(list) {
  const hookOf = Object.fromEntries(overview.reels.map((r) => [r.slug, r.hookText || ""]));
  const out = new Map(), DAY = 864e5;
  const byNet = {};
  for (const p of list) (byNet[p.network] ||= []).push(p);
  for (const ps of Object.values(byNet)) {
    ps.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    for (let i = 0; i < ps.length; i++) for (let k = 0; k < i; k++) {
      const a = ps[k], b = ps[i];
      if (a.slug === b.slug || !hookOf[a.slug] || hookOf[a.slug] !== hookOf[b.slug]) continue;
      if (Math.abs(new Date(b.at) - new Date(a.at)) <= 14 * DAY && !out.has(b.id)) out.set(b.id, a);
    }
  }
  return out;
}
/* A booking made before the reel's latest render holds the old video (and old words) on the network. */
const REPLACE_API = ["facebook", "youtube", "x", "tiktok"];  // replaced from the studio (API, or your Chrome for X and TikTok)
function staleBooking(p) {
  if (p.status !== "scheduled" || !p.created || p.network === "all") return false;  // queued: the studio sends the newest render
  const r = overview.reels.find((x) => x.slug === p.slug);
  if (!r?.wordsAt) return false;  // only a reel that got new words after this booking was made
  return new Date(r.wordsAt).getTime() > new Date(p.created.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(p.created) ? "" : "Z")).getTime() + 60e3;
}
function staleLine(p) {
  if (!staleBooking(p)) return "";
  const r = overview.reels.find((x) => x.slug === p.slug) || {};
  if (p.network === "bluesky") return `<div class="meta okline">${ico("check", "sm")} ${tr(r.status === "approved" ? "rp.bsky" : "rp.bskyhold")}</div>`;
  if (r.wordsPending || busyJob(r)) return `<div class="meta warnline">${ico("hourglass", "sm")} ${tr("rp.rendering")}</div>`;
  if (r.status !== "approved") return `<div class="meta warnline">${ico("eye", "sm")} ${tr("rp.review")} <a href="#/review">${tr("act.reviewone")}</a></div>`;
  if (REPLACE_API.includes(p.network)) return `<div class="meta warnline">${ico("refresh", "sm")} ${tr("rp.old")} <button class="linkbtn" data-replace="${p.id}" data-slug="${esc(p.slug)}" data-net="${esc(p.network)}">${tr("rp.go")}</button></div>`;
  return `<div class="meta warnline">${ico("refresh", "sm")} ${tr("rp.chrome", { n: esc(NET_NAME[p.network] || p.network) })}</div>`;
}
/* The time of day only, in the audience's zone (a day card already says the date). */
function timeOnly(iso) {
  const t = new Date(iso).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { timeZone: audTz(), hour: "2-digit", minute: "2-digit" });
  return audTz() === PC_TZ ? t : `${t} ${tzLabel()}`;
}
function postLine(p, compact = false, rep = null, inDay = false) {
  const due = p.status === "planned" && new Date(p.at).getTime() <= Date.now();
  const verb = tr(p.status === "scheduled" ? "x.goespublic" : p.status === "planned" ? "x.byhand" : "x.posted");
  const when = `${verb} ${p.at ? esc(whenText(p.at)) : ""}${due ? ` · <b style="color:var(--warn)">${tr("x.due")}</b>` : ""}`;
  // In a day card: the reel's first frame and its words, the network and the time; its file name stays small.
  const r = inDay ? overview.reels.find((x) => x.slug === p.slug) : null;
  if (inDay) return `<div class="plan-row pcard s-${p.status}">
    <a class="pthumb" href="#/reel/${esc(p.slug)}" style="background-image:url('${r?.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')" aria-label="${esc(r?.title || p.slug)}"></a>
    <div class="pbody"><div class="ptop">${netLogo(chOf(p.network), "sm")}<span>${esc(NET_NAME[p.network] || p.network)}</span><span class="ptime">${p.at ? esc(timeOnly(p.at)) : ""}</span>${due ? `<b class="pdue">${tr("x.due")}</b>` : ""}</div>
      <a class="ptitle" href="#/reel/${esc(p.slug)}">${esc(r?.title || p.slug)}</a>${r?.title ? `<span class="pslug">${esc(p.slug)}</span>` : ""}
      ${rep ? `<div class="meta warnline">${ico("alert", "sm")} ${tr("w.repeatpost", { s: esc(rep.slug), t: esc(whenText(rep.at)) })}</div>` : ""}${staleLine(p)}</div>
    ${p.url ? `<a class="chip ok" href="${escUrl(p.url)}" target="_blank" rel="noopener" title="${esc(tr("act.open"))}">${ico("eye", "sm")}</a>` : ""}
    ${p.status === "planned" ? `<button data-posted="${p.id}" title="${esc(tr("x.markposted"))}">${ico("check", "sm")}</button>` : ""}
  </div>`;
  return `<div class="plan-row s-${p.status}">${compact ? "" : netLogo(chOf(p.network))}
    <div style="flex:1 1 140px">${compact ? `<span class="meta">${ico("cal", "sm")} ${when}</span>` : `<a href="#/reel/${esc(p.slug)}"><b>${esc(p.slug)}</b></a> <span class="meta">${esc(NET_NAME[p.network] || p.network)}</span><div class="meta">${when}</div>${rep ? `<div class="meta warnline">${ico("alert", "sm")} ${tr("w.repeatpost", { s: esc(rep.slug), t: esc(whenText(rep.at)) })}</div>` : ""}${staleLine(p)}`}</div>
    ${p.url ? `<a class="chip ok" href="${escUrl(p.url)}" target="_blank" rel="noopener">${ico("eye", "sm")}${tr("act.open")}</a>` : ""}
    ${p.status === "planned" ? `<a class="chip" href="/api/posts/ics?id=${p.id}" download title="${tr("x.calendartip")}">${ico("cal", "sm")}${tr("x.calendar")}</a><button data-posted="${p.id}">${ico("check", "sm")}${tr("x.markposted")}</button><button data-unplan="${p.id}" title="${tr("x.removeplan")}">${ico("x", "sm")}</button>` : ""}
  </div>`;
}
function exportActions(cid, got) {
  const mine = postsLog.filter((p) => p.slug === reel.slug && p.network === netOf(cid));
  const v = got.videos[0];
  return `<div class="row" style="margin-top:6px">
      ${v ? `<a class="btn" href="${file(got.dir + "\\" + v.file)}" download="${esc(v.file)}">${ico("download", "sm")}${tr("x.download")}</a>` : ""}
      ${got.post ? `<button data-copy-post="${cid}">${ico("copy", "sm")}${tr("x.copy")}</button>` : ""}
    </div>
    ${got.post ? `<details><summary class="meta">${tr("x.posttext")}</summary><div class="post-txt">${esc(got.post)}</div></details>` : ""}
    ${mine.map((p) => postLine(p, true)).join("")}
    ${cid === "youtube-shorts" ? ytBox() : `<div class="row" style="margin-top:6px"><input type="datetime-local" data-plan-at="${cid}" value="${nextSlot()}">${tzHint()}<button data-plan="${cid}" title="${tr("x.remindtip")}">${ico("cal", "sm")}${tr("x.remind")}</button></div>`}`;
}
function ytBox() {
  if (!yt.connected) return `<div class="yt-box">${ytConnectHtml()}</div>`;
  const done = postsLog.find((p) => p.slug === reel.slug && p.network === "youtube" && p.status !== "planned");
  const busy = overview.reels.find((r) => r.slug === reel.slug)?.job;
  if (busy?.kind === "youtube" && busy.status === "running") return `<div class="yt-box"><span class="chip warn">${ico("send", "sm")} ${esc(busy.label)} · ${busy.pct}%</span></div>`;
  if (done) return `<div class="yt-box meta">${ico("check", "sm")} ${tr("x.already", { c: yt.channel?.title || "YouTube" })}</div>`;
  return `<div class="yt-box"><div class="meta" style="margin-bottom:6px">${ico("play", "sm")} ${esc(yt.channel?.title || "")} · ${tr("x.ytmeta")}</div>
    <div class="row"><input type="datetime-local" id="ytAt" value="${nextSlot()}">${tzHint()}<button class="primary" id="ytSchedule">${ico("cal", "sm")}${tr("x.schedule")}</button></div>
    <div class="row"><select id="ytPrivacy"><option value="private">${tr("yt.private")}</option><option value="unlisted">unlisted</option><option value="public">${tr("yt.public")}</option></select><button id="ytNow">${ico("send", "sm")}${tr("x.uploadnow")}</button></div>
    <p class="note">${tr("x.schednote")}</p></div>`;
}
async function ytUpload(body) {
  const what = body.at ? `goes public ${whenText(body.at)}` : `uploads now as ${body.privacy}`;
  if (!confirm(`${reel.slug} → ${yt.channel?.title || "YouTube"}\n${what}.\n\nSend it?`)) return;
  try { await post("/api/youtube/upload", { slug: reel.slug, ...body }); toast(`${ico("send", "sm")} Uploading ${esc(reel.slug)} to YouTube…`, 4000); await loadOverview(); renderLeft(); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); }
}
document.addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy-post]"), plan = e.target.closest("[data-plan]"), posted = e.target.closest("[data-posted]"), unplan = e.target.closest("[data-unplan]");
  if (copy) {
    const ch = (reel.channels || []).find((c) => c.name === copy.dataset.copyPost);
    await navigator.clipboard.writeText(ch?.post || "");
    return toast(`${ico("copy", "sm")} Post text copied`);
  }
  if (plan) {
    const at = zonedIso(document.querySelector(`[data-plan-at="${CSS.escape(plan.dataset.plan)}"]`)?.value);
    if (!at) return toast("Pick a time first");
    try {
      await post("/api/posts/plan", { slug: reel.slug, network: netOf(plan.dataset.plan), at });
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
      toast(`${ico("cal", "sm")} Reminder set: ${esc(plan.dataset.plan)} ${esc(whenText(at))}`); await loadPosting();
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    return;
  }
  if (posted) {
    const link = prompt("Link to the live post (optional):", "");
    if (link === null) return;
    try { await post("/api/posts/done", { id: +posted.dataset.posted, url: link.trim() }); toast(`${ico("check", "sm")} Marked posted`); await loadPosting(); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    return;
  }
  if (unplan) {
    try { await post("/api/posts/drop", { id: +unplan.dataset.unplan }); } catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return loadPosting();
  }
  if (e.target.closest("#ytSchedule")) return ytUpload({ at: zonedIso($("#ytAt").value) });
  if (e.target.closest("#ytNow")) return ytUpload({ privacy: $("#ytPrivacy").value });
});
/* Reminders while the studio is open; the calendar file covers the rest of the time. */
const reminded = new Set();
setInterval(() => {
  for (const p of postsLog) {
    if (p.status !== "planned" || reminded.has(p.id) || new Date(p.at).getTime() > Date.now() + 5 * 60000) continue;
    reminded.add(p.id);
    toast(`${ico("cal", "sm")} ${tr("post.timeto", { s: `<b>${esc(p.slug)}</b>`, n: esc(NET_NAME[p.network] || p.network) })}`, 10000);
    if ("Notification" in window && Notification.permission === "granted") new Notification("Lazycow Studio", { icon: "/brand/icon-192.png", body: tr("post.timeto", { s: p.slug, n: NET_NAME[p.network] || p.network }) });
  }
}, 30000);

/* "auto: a fire pit at night (match 0.2772)" → Picked for “a fire pit at night” · strong match.
   Weak is the same 0.20 line the card flags use (py/studio/service.py WEAK_MATCH). */
// Notes worth a look before approving. Rows from an older studio carry no "look": every one counts, as before.
function lookChecks(r) { return (r?.checks || []).filter((c) => c.look !== false); }
function roleText(role) {
  const m = /^auto:\s*(.+?)\s*\(match ([\d.]+)\)\s*$/i.exec(role || "");
  if (!m) return esc(role || "");
  const v = +m[2], k = v < 0.2 ? "weak" : v < 0.28 ? "fair" : "strong";
  return `${tr("clip.pickedfor")} “${esc(m[1])}” · <span class="${k === "weak" ? "warnline" : k === "strong" ? "okline" : ""}" title="CLIP ${v.toFixed(3)}">${tr(MATCH_KEY[k])}</span>`;
}
/* Loudness in words (the number stays on hover): -14 LUFS is what the networks play at. */
function loudWord(lufs) {
  const n = Number(lufs);
  const w = !Number.isFinite(n) ? "" : tr(n < -16 ? "ux2.pr.quiet" : n > -12 ? "ux2.pr.loud" : "ux2.pr.loudok");
  return w ? `<span title="${esc(`${lufs} LUFS (target about -14)`)}">${w}</span>` : "";
}
function kv(rows) { return `<table class="kv">${rows.filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`; }
async function renderInspector() {
  const el = $("#inspector");
  const ptb = document.querySelector(".right .ptabs button"); if (ptb) ptb.innerHTML = `${ico("info")}${esc(tr("ux2.pr.tab"))}`;  // BL-067
  if (sel?.type === "asset") {
    const a = await api("/api/asset?id=" + sel.id);
    if (sel?.type !== "asset" || sel.id !== a.id) return;
    const media = a.kind === "video" ? `<video class="proof" src="/proxy?id=${a.id}" controls muted preload="metadata"></video><p class="note">Preview proxy (540p). The first open of a long drone file takes a moment.</p>` : `<img class="proof" src="${file(a.thumbs[0] || "")}" alt="">`;
    el.innerHTML = `<h3>${ico(a.kind === "video" ? "film" : "image")}${esc(a.file)}</h3>${media}
      <div class="row"><button class="primary" id="addAsset">${ico("plus")}Add at playhead</button>
        <button id="vetoAsset" class="${lib.items.find((x) => x.id === a.id)?.vetoed ? "on" : ""}" title="Auto-made reels will never pick this clip (feet, a stranger, a bad take). You can still add it by hand.">${ico("x", "sm")}${lib.items.find((x) => x.id === a.id)?.vetoed ? "Hidden from auto-picks" : "Never auto-pick"}</button></div>
      ${kv([
        [`${ico("folder", "sm")} Event`, esc(a.event || "")],
        [`${ico(DEVICE_ICON[a.device] || "camera", "sm")} Camera`, esc(a.device || "unknown")],
        [`${ico("cal", "sm")} Taken`, esc(a.captured || "unknown")],
        [`${ico("pin", "sm")} Place`, a.near === 1 ? "at the ranch (GPS)" : a.near === 0 ? "<span style='color:var(--bad)'>away (GPS)</span>" : "no GPS in file"],
        [`${ico("film", "sm")} Source`, `${a.width}×${a.height}${a.fps ? ` · ${a.fps} fps` : ""}${a.duration ? ` · ${a.duration.toFixed(1)} s` : ""} · ${a.mb} MB`],
        [`${ico("user", "sm")} Faces`, a.faces ? `<span style="color:var(--warn)">${a.faces}</span>` : "none found"],
        [`${ico(SEASON_ICON[a.season] || "cal", "sm")} Season · light`, `${esc(a.season || "?")} · ${esc(a.tod || "?")} · ${esc(a.orientation || "")}`],
        [`${ico("layers", "sm")} Used in`, a.usedIn.length ? a.usedIn.map(esc).join(", ") : "<span style='color:var(--accent)'>not used yet</span>"],
      ])}
      <h3>${ico("tag")}Tags (local CLIP, scores)</h3>
      ${a.tags.map((tg) => `<div class="row" style="margin-bottom:4px"><span style="width:110px">${ico(TAG_ICON[tg.tag] || "tag", "sm")} ${esc(tg.ja)} <span class="meta">${esc(tg.tag)}</span></span><div class="bar" style="flex:1"><i style="width:${Math.min(100, tg.score * 250)}%"></i></div></div>`).join("")}
      <p class="note">${esc(a.path)}</p>`;
    $("#addAsset").onclick = () => { const item = lib.items.find((x) => x.id === a.id) || { ...a, thumbs: a.thumbs, usedIn: a.usedIn }; insertAsset(item, shotAt(t) + 1); };
    $("#vetoAsset").onclick = async () => {
      const item = lib.items.find((x) => x.id === a.id); const on = !item?.vetoed;
      try { await post("/api/veto", { id: a.id, on }); } catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
      if (item) item.vetoed = on;
      toast(on ? `${ico("x", "sm")} ${esc(a.file)} will not be auto-picked again` : `${ico("check", "sm")} ${esc(a.file)} can be auto-picked again`);
      renderLeft(); renderInspector();
    };
    return;
  }
  if (sel?.type === "shot") {
    const s = edit.shots[sel.i]; const m = reel.shots.find((x) => x.file === s.file);
    el.innerHTML = `<h3 style="text-transform:none;letter-spacing:0;font-size:var(--fs-md);color:var(--text)">${ico(s.kind === "video" ? "film" : "image")}Clip ${sel.i + 1} · ${roleText(s.role)}</h3>
      ${m?.grade ? `<img class="proof" src="${file(m.grade)}" alt=""><p class="note">Left: as shot. Right: graded, same frame.</p>` : ""}
      ${kv([
        ["File", esc(s.file)], ["Folder", esc(s.src.split("/").slice(0, -1).join(" / "))],
        m ? [`${ico(DEVICE_ICON[m.device] || "camera", "sm")} Camera`, `${esc(m.device)} · ${m.source.width}×${m.source.height} · ${m.source.codec} · ${m.source.fps} fps · ${m.source.bitDepth}-bit${m.source.hdr ? " HDR (tone-mapped)" : ""}`] : null,
        m ? [`${ico("cal", "sm")} Taken`, esc(m.captured || "unknown")] : null,
        m ? [`${ico("pin", "sm")} GPS`, `${esc(m.gps.file)} · folder: ${esc(m.gps.folder)}`] : null,
        [`${ico("clock", "sm")} On screen`, `${s.sec} s`],
        [`${ico("scissors", "sm")} In point`, s.start != null ? `${s.start} s (set)` : s.picked != null ? `${s.picked} s (auto pick)` : "auto pick at render"],
        m ? [`${ico("user", "sm")} Faces`, m.faces > 0 ? `<span style="color:var(--warn)">${m.faces}</span>` : "none found"] : null,
        (() => { const c = (overview.reels.find((r) => r.slug === edit.slug)?.checks || []).find((x) => x.file.toLowerCase() === s.file.toLowerCase());
          return c ? [`${ico("alert", "sm")} ${c.look === false ? "Notes" : "Check"}`, `<span style="color:var(${c.look === false ? "--mute" : "--warn"})">${esc(c.flags.join(" · "))}</span>`] : null; })(),
      ])}
      <p class="note">Drag the clip to reorder, drag its edges to trim (snaps to 0.5 s). Q / W trim at the playhead, Ctrl+B splits, Delete removes.</p>`;
    return;
  }
  if (sel?.type === "layer" && edit.layers?.[sel.i]) {
    const x = edit.layers[sel.i], m = (reel.layers || [])[sel.i] || {};
    el.innerHTML = `<h3>${ico("layers")}V2 · ${x.kind === "inset" ? "Inset (paper print)" : "Cutaway (B-roll)"}</h3>
      <p class="note">${x.kind === "inset" ? "A second clip as a tilted print over the shot underneath. Both play; the sound is the shot underneath." : "A detail shot laid over the running shot. The shot underneath keeps its sound, so cutting away and back reads like an L-cut."}</p>
      ${kv([["File", esc(x.src.split("/").pop())], ["When", `${x.at.toFixed(2)} → ${(x.at + x.sec).toFixed(2)} s (${x.sec} s)`], ["Why", esc(x.role || "added by hand")], ...(m.faces ? [["Faces", `<span style="color:var(--warn)">${m.faces}: consent needed</span>`]] : [])])}
      <div class="row"><button id="layerKind">${ico("refresh", "sm")}Make it ${x.kind === "inset" ? "a cutaway" : "an inset"}</button><button id="layerDel">${ico("trash", "sm")}Remove layer</button></div>
      <p class="note">Changes need Save &amp; render. Layers never sit on the opening half second, never overlap, and never reuse a clip already in the reel.</p>`;
    $("#layerDel").onclick = () => { const i = sel.i; sel = null; commit(() => { edit.layers.splice(i, 1); }, "Layer removed. Save & render to apply."); };
    $("#layerKind").onclick = () => commit(() => {
      const y = edit.layers[sel.i];
      if (y.kind === "inset") { y.kind = "cutaway"; y.sec = Math.min(y.sec, 1.5); delete y.rect; delete y.tilt; }
      else { y.kind = "inset"; y.rect = { x: 0.06, y: 0.13, w: 0.46, h: 0.3 }; y.tilt = -3; }
    }, "Layer changed. Save & render to apply.");
    return;
  }
  if (sel?.type === "beat") {
    const b = edit.beats[sel.i];
    el.innerHTML = `<h3>${ico("type")}Caption · ${esc(b.kind)}</h3>
      <label class="meta">Japanese</label><textarea id="bJa">${esc(b.ja)}</textarea>
      <label class="meta">English</label><textarea id="bEn">${esc(b.en)}</textarea>
      ${kv([["Time", `${b.startSec.toFixed(2)} → ${b.endSec.toFixed(2)} s`], ["Rule", "Words come from the site's approved lines. The fact check checks prices and banned claims when you render."]])}`;
    $("#bJa").onchange = (e) => commit(() => { edit.beats[sel.i].ja = e.target.value; });
    $("#bEn").onchange = (e) => commit(() => { edit.beats[sel.i].en = e.target.value; });
    return;
  }
  const st = reel.stats, v = reel.verify;
  el.innerHTML = `<h3>${ico("film")}${esc(edit.title_ja)}</h3>
    <p class="note">${esc(edit.slug)} · ${isDirty() ? `<b style='color:var(--warn)'>${tr("ux2.pr.unsaved")}</b>` : tr("ux2.pr.asrendered")}${lang === "ja" ? "。" : ". "}${tr("ux2.pr.click")}</p>
    ${tdWhyChip(edit.slug)}${tdAutoTag(overview?.reels?.find((r) => r.slug === edit.slug))}
    ${reelJourney(edit.slug)}
    ${kv([
      [`${ico("clock", "sm")} ${tr("ux2.pr.length")}`, tr("ux2.pr.lengthv", { s: total().toFixed(1), n: edit.shots.length })],
      [`${ico("scissors", "sm")} ${tr("ux2.pr.pace")}`, (() => { const lo = Math.min(...edit.shots.map((s) => s.sec)), hi = Math.max(...edit.shots.map((s) => s.sec)); return lo === hi ? tr("ux2.pr.pace1", { a: lo }) : tr("ux2.pr.pace2", { a: lo, b: hi }); })()],
      [`${ico("image", "sm")} ${tr("ux2.pr.photos")}`, tr("ux2.pr.photosv", { p: edit.shots.filter((s) => s.kind === "photo").length, n: edit.shots.length })],
      [`${ico("user", "sm")} ${tr("ux2.pr.faces")}`, edit.blurFaces ? tr("ux2.pr.blurred") : st.faces > 0 ? (reel.review?.consent || consentAll() ? tr("ux2.pr.agreed") : `<span style="color:var(--warn)">${tr("ux2.pr.tick")}</span>`) : tr("ux2.pr.none")],
      [`${ico("music", "sm")} ${tr("ux2.pr.sound")}`, reel.audio.music
        ? `${esc(reel.audio.music.title)} <span class="meta">(${esc(reel.audio.music.creator)}, ${esc(reel.audio.music.license)})</span> ${tr("ux2.pr.clipsnd")}${reel.audio.sfx?.length ? ` ${tr("ux2.pr.fx", { n: reel.audio.sfx.length })}` : ""} · ${loudWord(st.lufs)}`
        : `${tr("ux2.pr.cliponly")}${reel.audio.sfx?.length ? ` ${tr("ux2.pr.fx", { n: reel.audio.sfx.length })}` : ""} · ${loudWord(st.lufs)} <a href="#" data-goto-audio="1">${tr("ux2.pr.addmusic")}</a>`],
      [`${ico("film", "sm")} ${tr("ux2.pr.video")}`, `<span title="${esc(`${v.codec} · ${v.audio} ${v.rate} Hz`)}">${tr("ux2.pr.videov", { w: v.width, h: v.height, f: v.fps })}</span>`],
      [`${ico("image", "sm")} ${tr("ux2.pr.cover")}`, tr("ux2.pr.coverv", { s: (edit.coverAt ?? 2.4).toFixed(2) })],
      [`${ico("check", "sm")} ${tr("ux2.pr.quality")}`, qaLine(reel.qa)],
      [`${ico("check", "sm")} ${tr("ux2.pr.rules")}`, cIssuesRow()],  // batch C: one list with the rules chip and the Issues lane
    ])}
    <div class="row"><button class="toggle ${edit.keep?.colorMatch !== false ? "on" : ""}" id="colorMatch" title="${esc(tr("ux2.pr.colortip"))}">${ico("image", "sm")}${tr("ux2.pr.color")}</button>
      <span class="meta">${tr("ux2.pr.steady")}</span>${["auto", "on", "off"].map((m) => `<button class="toggle ${(edit.keep?.stabilize || "auto") === m ? "on" : ""}" data-stab="${m}" title="${esc(tr("ux2.pr.st." + m + "tip"))}">${tr("ux2.pr.st." + m)}</button>`).join("")}</div>
    ${reel.audio?.voice ? `<div class="row"><button class="toggle ${edit.keep?.spokenWords !== false ? "on" : ""}" id="spokenWords" title="${esc(tr("ux2.pr.voicetip"))}">${ico("type", "sm")}${tr("ux2.pr.voice")}</button></div>` : ""}
    <div class="row"><button class="toggle ${edit.blurFaces ? "on" : ""}" id="blurFaces" title="${esc(tr("ux2.pr.blurtip"))}">${ico("user", "sm")}${tr("ux2.pr.blur")}</button>${edit.bpm ? `<span class="chip">${ico("music", "sm")} ${tr("ux2.pr.bpm", { n: edit.bpm })}</span>` : ""}</div>
    ${wordsBlock()}
    <h3>${ico("type")}${tr("ux2.pr.layout")}</h3>
    <div class="row">${Object.entries(STYLE_LABEL).map(([k, [icon, label, tip]]) => `<button class="toggle ${edit.style === k ? "on" : ""}" data-style="${k}" title="${tip}">${ico(icon, "sm")}${label}</button>`).join("")}</div>
    <p class="note">${tr("ux2.pr.layoutnote")}</p>
    ${dressBlock()}
    <h3>${ico("info")}${tr("ux2.pr.icons")}</h3>
    <div class="legend">
      <span>${ico("film", "sm")} ${tr("ux2.pr.i.video")}</span><span>${ico("image", "sm")} ${tr("ux2.pr.i.photo")}</span>
      <span>${ico("drone", "sm")} ${tr("ux2.pr.i.drone")}</span><span>${ico("phone", "sm")} ${tr("ux2.pr.i.phone")}</span>
      <span>${ico("pin", "sm")} ${tr("ux2.pr.i.place")}</span><span>${ico("user", "sm")} ${tr("ux2.pr.i.faces")}</span>
      <span><b style="color:var(--accent)">${tr("ux2.pr.i.unused")}</b> ${tr("ux2.pr.i.unusedv")}</span><span><b style="color:var(--warn)">×2</b> ${tr("ux2.pr.i.twice")}</span>
      <span>${ico("snap", "sm")} ${tr("ux2.pr.i.snap")}</span><span>${ico("magnet", "sm")} ${tr("ux2.pr.i.gaps")}</span>
    </div>`;
}

/* Properties › where this reel is: made → approved → booked → live, each step with its date, the step it waits on
   marked, and below it one chip per network it is booked on or out on (its state as a dot, its time on hover). A chip
   opens Exports at that network. Read from the overview and the posting log the page already has. */
function reelJourney(slug) {
  const r = overview.reels.find((x) => x.slug === slug); if (!r || r.house) return "";
  const ps = Object.entries(postState(slug)).filter(([, p]) => ["posted", "scheduled", "planned", "missing", "failed"].includes(p.status));
  const ms = (p) => new Date(p.at).getTime() || 0;
  const live = ps.filter(([, p]) => p.status === "posted").sort((a, b) => ms(a[1]) - ms(b[1]));
  const booked = ps.filter(([, p]) => p.status === "scheduled" || p.status === "planned").sort((a, b) => ms(a[1]) - ms(b[1]));
  const day = (t) => (t ? new Date(t).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short", day: "numeric" }) : "");
  const ok = r.status === "approved" || live.length || booked.length, bad = r.status === "rejected" || r.status === "reroll";
  const steps = [
    // A reel re-cut after it went out (new words, a better version) has its newest render date: say so, not "made" after "live".
    { k: "made", done: !!r.rendered, label: tr("rj.made"), sub: r.updated && [...live, ...booked].some(([, p]) => ms(p) && ms(p) < r.updated * 1000 && p.status === "posted") ? tr("rj.recut", { d: day(r.updated * 1000) }) : day(r.updated ? r.updated * 1000 : 0) },
    { k: "ok", done: !!ok, bad, label: tr(ok ? "rj.approved" : bad ? "rj.rejected" : "rj.waiting"), sub: ok ? "" : bad ? "" : tr("rj.none") },
    { k: "booked", done: !!(booked.length || live.length), label: tr("rj.booked"), sub: booked.length ? tr("rj.netsn", { n: booked.length }) + "\n" + day(booked[0][1].at) : live.length ? "" : tr("rj.none") },
    { k: "live", done: !!live.length, label: tr("rj.live"), sub: live.length ? tr("rj.netsn", { n: live.length }) + "\n" + day(live[0][1].at) : tr("rj.none") },
  ];
  const now = steps.findIndex((s) => !s.done);
  const ST = { posted: "st.posted", scheduled: "st.scheduled", planned: "st.reminder", missing: "st.missing", failed: "st.missing" };
  const chips = [...live, ...booked, ...ps.filter(([, p]) => p.status === "missing" || p.status === "failed")].map(([n, p]) => {
    const t = `${NET_NAME[n] || n} · ${tr(ST[p.status])}${p.at ? " · " + whenText(p.at) : ""}`;
    return `<button type="button" class="rj-chip s-${esc(p.status)}" data-rjnet="${esc(n)}" title="${esc(t)}" aria-label="${esc(t)}">${netLogo(chOf(n), "sm")}<i aria-hidden="true"></i></button>`;
  }).join("");
  const said = steps.map((s, i) => `${s.label}${s.sub ? " " + s.sub : ""}${i === now ? " ←" : ""}`).join(" › ");
  // The line fills up to the waiting step once each time the reel is opened (openReel forgets it), not on each repaint.
  const fresh = reelJourney.shown !== slug;  // set once it has filled on screen (moWatch)
  queueMicrotask(moAfter);  // once the caller has put it on the page: held until on screen, then its loops run
  return `<section class="rjourney${fresh && !moCalm() ? " in" : ""}" data-rjslug="${esc(slug)}" aria-label="${esc(tr("rj.label", { s: said }))}"><h4>${tr("rj.title")}</h4>
    <ol class="rj-steps">${steps.map((s, i) => `<li class="${s.done ? "done" : ""} ${i === now ? "now" : ""} ${s.bad ? "bad" : ""}" style="--s:${i}"><i aria-hidden="true"></i><b>${esc(s.label)}</b><span>${esc(s.sub || "")}</span></li>`).join("")}</ol>
    ${chips ? `<div class="rj-nets">${chips}<span class="meta">${tr("rj.hint")}</span></div>` : ""}</section>`;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest?.("[data-rjnet]"); if (!c || atHome()) return;
  ltab = "exports"; focusChan = chOf(c.dataset.rjnet); renderLeft();
});
function renderTimeline() {
  const T = Math.max(total(), mode === "rendered" ? reel.durationSec : 0);
  const W = Math.ceil((T + 4) * pps);
  const ticks = [];
  for (let x = 0; x <= T + 4; x += GRID) {
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    ticks.push(`<div class="tick ${major ? "major" : ""}" style="left:${x * pps}px">${major ? `<span>${x.toFixed(0)}s</span>` : ""}</div>`);
  }
  const st = starts();
  const text = edit.beats.map((b, i) => `<div class="blk text ${b.kind} ${sel?.type === "beat" && sel.i === i ? "sel" : ""}" data-beat="${i}"
      style="left:${b.startSec * pps}px;width:${(b.endSec - b.startSec) * pps}px" title="${esc(b.ja)}">
      <span class="handle l" data-edge="l"></span>${ico(b.kind === "hook" ? "play" : b.kind === "end" ? "film" : "type", "sm")}${esc(b.ja.replace("\n", " "))}<span class="handle r" data-edge="r"></span></div>`).join("");
  const checks = Object.fromEntries(lookChecks(overview.reels.find((r) => r.slug === edit.slug)).map((c) => [c.file.toLowerCase(), c.flags]));
  const vid = edit.shots.map((s, i) => `<div class="blk video ${sel?.type === "shot" && sel.i === i ? "sel" : ""}" data-shot="${i}"
      style="left:${st[i] * pps}px;width:${s.sec * pps - 2}px;background-image:url('${s.thumb ? file(s.thumb) : ""}')">
      <span class="handle l" data-edge="l"></span><span class="kind pill">${ico(s.kind === "video" ? "film" : "image", "sm")}</span>
      ${checks[s.file.toLowerCase()] ? `<span class="pill used" style="position:absolute;top:4px;right:6px" title="Check this clip: ${esc(checks[s.file.toLowerCase()].join(", "))}">${ico("alert", "sm")}</span>` : ""}
      <div class="lbl">${i + 1} · ${s.sec}s</div><span class="handle r" data-edge="r"></span></div>`).join("");
  const lay = (edit.layers || []).map((x, i) => `<div class="blk layer k-${esc(x.kind)} ${sel?.type === "layer" && sel.i === i ? "sel" : ""}" data-layer="${i}"
      style="left:${x.at * pps}px;width:${Math.max(24, x.sec * pps - 2)}px" title="${esc(`${x.kind}: ${x.src.split("/").pop()} · ${x.at}s for ${x.sec}s`)}">
      ${ico(x.kind === "inset" ? "image" : "layers", "sm")}<span>${esc(x.kind === "inset" ? "Inset" : "Cutaway")}</span></div>`).join("")
    || `<div class="meta tl-empty">No picture-in-picture or overlays on this reel</div>`;
  const audio = reel.audio.wave ? `<div class="blk audio" style="left:0;width:${reel.durationSec * pps}px;background-image:url('${file(reel.audio.wave)}&v=${Date.now() >> 16}')" title="The rendered mix: clip sound + music + effects"></div>` : "";
  const mus = musicInfo();
  const music = edit.music === "off" || !mus
    ? `<div class="blk music" data-music="1" style="left:0;width:${Math.max(160, total() * pps)}px;opacity:.55">${ico("plus", "sm")} No music · click to choose</div>`
    : `<div class="blk music ${sel?.type === "music" ? "sel" : ""}" data-music="1" style="left:0;width:${total() * pps}px" title="${esc(mus.title)} · ${esc(mus.creator || "")} · ${esc(mus.license || "")}">
        ${ico("music", "sm")}<b>${esc(mus.title)}</b><span class="meta">${esc(mus.creator || "")} · ${esc(mus.license || "")}${edit.music === "auto" ? " · auto pick" : ""}</span></div>`;
  const fx = sfxPlan().map((s) => `<div class="fx" data-music="1" style="left:${s.at * pps}px;width:${Math.max(18, s.sec * pps)}px" title="${esc(s.name)} at ${s.at.toFixed(2)} s">${ico(s.name === "hit" ? "volume" : "wave", "sm")}${esc(s.name.replace(/_\d/, ""))}</div>`).join("");
  $("#tl").style.width = W + "px";
  $("#tl").innerHTML = `<div class="ruler h-ruler" id="ruler">${ticks.join("")}</div>
    <div class="track issues h-issues" id="trIssues">${cIssueLane()}</div>
    <div class="track text h-text" id="trText">${text}</div>
    <div class="track layer h-layer" id="trLayer">${lay}</div>
    <div class="track video h-video" id="trVideo">${vid}</div>
    <div class="track h-music">${music}</div>
    <div class="track h-sfx">${fx}</div>
    <div class="track audio h-audio">${audio}</div>
    <div class="marker" id="marker"></div><div class="snapline" id="snapline"></div><div class="playhead" id="ph"></div>`;
  renderStatus();
}

/* ---------- timeline pointer editing ---------- */
let drag = null;
$("#tlBody").addEventListener("pointerdown", (e) => {
  if (e.target.closest("[data-music]")) return;
  const lb = e.target.closest(".blk.layer");
  if (lb) { sel = { type: "layer", i: +lb.dataset.layer }; seek(edit.layers[sel.i].at + 0.05); renderAll(); return; }
  const blk = e.target.closest(".blk.video, .blk.text");
  const body = $("#tl").getBoundingClientRect();
  const x = e.clientX - body.left;
  if (e.target.closest("#ruler")) { seek(x / pps); startScrub(e); return; }
  if (!blk) { sel = null; renderAll(); return; }
  const edge = e.target.dataset.edge;
  if (blk.dataset.shot) {
    const i = +blk.dataset.shot; sel = { type: "shot", i };
    drag = { kind: edge ? "trim-shot" : "move-shot", i, edge, x0: x, snap: JSON.stringify(edit), orig: JSON.parse(JSON.stringify(edit.shots[i])) };
  } else {
    const i = +blk.dataset.beat; sel = { type: "beat", i };
    drag = { kind: edge ? "trim-beat" : "move-beat", i, edge, x0: x, snap: JSON.stringify(edit), orig: { ...edit.beats[i] } };
  }
  blk.setPointerCapture(e.pointerId);
  renderLeft(); renderInspector();
  blk.classList.add("sel");
});
function startScrub(e) {
  const move = (ev) => seek((ev.clientX - $("#tl").getBoundingClientRect().left) / pps);
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const x = e.clientX - $("#tl").getBoundingClientRect().left;
  const dt = (x - drag.x0) / pps;
  const snapline = $("#snapline"), marker = $("#marker");
  if (drag.kind === "trim-shot") {
    const s = edit.shots[drag.i], o = drag.orig;
    if (drag.edge === "r") s.sec = Math.min(snapLen(o.sec + dt), maxLen({ ...o, start: o.start ?? o.picked }));
    else { const cut = Math.max(-(o.start ?? o.picked ?? 0), Math.min(o.sec - GRID, snapOn ? Math.round(dt / GRID) * GRID : dt)); s.sec = +(o.sec - cut).toFixed(2); s.start = +((o.start ?? o.picked ?? 0) + cut).toFixed(2); }
    s.mezz = null; dragRender();
  } else if (drag.kind === "move-shot") {
    const st = starts(); let idx = edit.shots.length;
    for (let i = 0; i < edit.shots.length; i++) if (x < (st[i] + edit.shots[i].sec / 2) * pps) { idx = i; break; }
    drag.to = idx; marker.style.display = "block"; marker.style.left = ((idx < edit.shots.length ? st[idx] : total()) * pps - 1) + "px";
    document.querySelector(`.blk.video[data-shot="${drag.i}"]`)?.classList.add("dragging");
  } else if (drag.kind === "move-beat" || drag.kind === "trim-beat") {
    const b = edit.beats[drag.i], o = drag.orig, len = o.endSec - o.startSec;
    if (drag.kind === "move-beat") { const s0 = snapT(o.startSec + dt); b.startSec = Math.max(0, s0); b.endSec = +(b.startSec + len).toFixed(2); snapline.style.display = "block"; snapline.style.left = b.startSec * pps + "px"; }
    else if (drag.edge === "l") { b.startSec = Math.max(0, Math.min(snapT(o.startSec + dt), o.endSec - 0.4)); snapline.style.display = "block"; snapline.style.left = b.startSec * pps + "px"; }
    else { b.endSec = Math.max(snapT(o.endSec + dt), o.startSec + 0.4); snapline.style.display = "block"; snapline.style.left = b.endSec * pps + "px"; }
    dragRender();
  }
});
function dragRender() {
  const st = starts();
  edit.shots.forEach((s, i) => { const el = document.querySelector(`.blk.video[data-shot="${i}"]`); if (el) { el.style.left = st[i] * pps + "px"; el.style.width = s.sec * pps - 2 + "px"; el.querySelector(".lbl").textContent = `${i + 1} · ${s.sec}s`; } });
  edit.beats.forEach((b, i) => { const el = document.querySelector(`.blk.text[data-beat="${i}"]`); if (el) { el.style.left = b.startSec * pps + "px"; el.style.width = (b.endSec - b.startSec) * pps + "px"; } });
}
window.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag; drag = null;
  $("#marker").style.display = "none"; $("#snapline").style.display = "none";
  const after = JSON.stringify(edit);
  if (d.kind === "move-shot") {
    // A click (no move) on a clip jumps the playhead to it, like every editor does.
    if (d.to == null || d.to === d.i || d.to === d.i + 1) { seek(starts()[d.i] + 0.02); renderTimeline(); return; }
    edit = JSON.parse(d.snap);
    commit(() => { const [m] = edit.shots.splice(d.i, 1); const to = d.to > d.i ? d.to - 1 : d.to; edit.shots.splice(to, 0, m); sel = { type: "shot", i: to }; }, "Moved. The track closed up.");
    return;
  }
  if (after === d.snap) { if (d.kind === "move-beat") seek(edit.beats[d.i].startSec + 0.02); renderTimeline(); return; }
  edit = JSON.parse(d.snap);
  commit(() => { edit = JSON.parse(after); }, d.kind.startsWith("trim") ? "Trimmed" : "Moved");
  if (d.kind === "trim-shot") { const s = edit.shots[d.i]; if (s?.assetId) fetch("/proxy?id=" + s.assetId).catch(() => {}); }
});

/* drag from library onto the video track */
document.addEventListener("dragstart", (e) => {
  const tile = e.target.closest(".tile"); if (!tile) return;
  e.dataTransfer.setData("text/asset", tile.dataset.asset); e.dataTransfer.effectAllowed = "copy";
});
$("#tlBody").addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("text/asset")) return;
  e.preventDefault();
  const x = e.clientX - $("#tl").getBoundingClientRect().left, st = starts();
  let idx = edit.shots.length; for (let i = 0; i < edit.shots.length; i++) if (x < (st[i] + edit.shots[i].sec / 2) * pps) { idx = i; break; }
  const m = $("#marker"); m.style.display = "block"; m.style.left = ((idx < edit.shots.length ? st[idx] : total()) * pps - 1) + "px"; m.dataset.idx = idx;
  $("#trVideo")?.classList.add("drop");
});
$("#tlBody").addEventListener("dragleave", () => { $("#marker").style.display = "none"; $("#trVideo")?.classList.remove("drop"); });
$("#tlBody").addEventListener("drop", (e) => {
  e.preventDefault(); const id = +e.dataTransfer.getData("text/asset"); const idx = +$("#marker").dataset.idx;
  $("#marker").style.display = "none"; $("#trVideo")?.classList.remove("drop");
  const item = lib.items.find((x) => x.id === id); if (item) insertAsset(item, idx);
});

/* ---------- library ---------- */
async function searchLibrary() {
  $("#left").style.opacity = .6;
  try { lib = await post("/api/library", { query: libQuery, filters: libFilters, limit: 240 }); }
  catch (err) { toast("Library: " + esc(err.message)); }
  $("#left").style.opacity = 1;
  if (atHome()) renderHome();
  else if (ltab === "library") renderLeft();
}

/* ---------- clicks ---------- */
document.addEventListener("click", (e) => {
  const tgt = e.target.closest("[data-aspect],[data-ltab],[data-f],[data-tag],[data-quick],.tile,.card[data-shot],button[data-theme]");  // button: <html data-theme> is the colour theme (batch D)
  if (!tgt) return;
  if (tgt.dataset.aspect) return setAspect(tgt.dataset.aspect);
  if (tgt.dataset.ltab) { ltab = tgt.dataset.ltab; return renderLeft(); }
  if (tgt.dataset.f) { const f = tgt.dataset.f; if (f === "kind") libFilters.kind = tgt.dataset.v || undefined; else libFilters[f] = !libFilters[f]; return searchLibrary(); }
  if (tgt.dataset.tag) { libFilters.tag = libFilters.tag === tgt.dataset.tag ? undefined : tgt.dataset.tag; return searchLibrary(); }
  if (tgt.dataset.quick) { libFilters.unused = tgt.dataset.quick === "unused" ? !libFilters.unused : false; return searchLibrary(); }
  if (tgt.classList.contains("tile")) { libSel = +tgt.dataset.asset; sel = { type: "asset", id: libSel }; document.querySelectorAll(".tile").forEach((x) => x.classList.toggle("sel", x === tgt)); return renderInspector(); }
  if (tgt.dataset.shot) { const i = +tgt.dataset.shot; sel = { type: "shot", i }; seek(starts()[i] + 0.02); return renderAll(); }
  if (tgt.dataset.theme) { document.querySelectorAll("button[data-theme]").forEach((b) => b.classList.toggle("on", b === tgt)); $("#newSlug").value = tgt.dataset.theme + "-" + new Date().toISOString().slice(5, 10).replace("-", ""); }
});
document.addEventListener("dblclick", (e) => {
  const tile = e.target.closest(".tile"); if (!tile) return;
  const item = lib.items.find((x) => x.id === +tile.dataset.asset); if (item) insertAsset(item, shotAt(t) + 1);
});
document.addEventListener("mouseover", (e) => {
  const img = e.target.closest(".tile img"); if (!img || img._cycling) return;
  const thumbs = JSON.parse(img.dataset.thumbs || "[]"); if (thumbs.length < 2) return;
  let k = 0; img._cycling = setInterval(() => { k = (k + 1) % thumbs.length; img.src = file(thumbs[k]); }, 600);
  img.addEventListener("mouseleave", () => { clearInterval(img._cycling); img._cycling = null; img.src = file(thumbs[0]); }, { once: true });
});

/* ---------- toolbar, keys ---------- */
$("#play").onclick = () => (playing ? pause() : play());
$("#prev").onclick = () => { pause(); seek(t - 1 / FPS); };
$("#next").onclick = () => { pause(); seek(t + 1 / FPS); };
$("#loop").onclick = (e) => { e.currentTarget.classList.toggle("on"); player.loop = e.currentTarget.classList.contains("on"); };

/* ---------- safe zones and the cover (what CapCut leaves to a PNG overlay and a still export) ---------- */
// Bottom / right margins each app's own buttons and caption cover on a 1080×1920 frame
// (safezonepreview.com, read 2026-11-07). The dashed box is the studio's own text area (shared/spec.json).
const PLATFORM_UI = { instagram: { label: "Instagram Reels", bottom: 380 }, tiktok: { label: "TikTok", bottom: 480 }, shorts: { label: "YouTube Shorts", right: 160 } };
const SAFE_ORDER = ["off", "studio", "instagram", "tiktok", "shorts"];
let safeMode = 0, specFormats = null;
api("/api/spec").then((s) => { specFormats = s.formats; paintSafe(); }).catch(() => {});
/* A reel's type pairing, colours, how its words arrive and its colour grade (shared/type-kits.json). New reels draw
   them at random (py/studio/typekits.py); here the person sees them and picks any, or rolls a new set. */
let typeKits = null;
const DRESS = [["typeKit", "kits", "Type"], ["palette", "palettes", "Colours"], ["motion", "motions", "Words arrive"], ["grade", "grades", "Colour grade"]];
api("/api/typekits").then((t) => { typeKits = t; if (edit) renderAll(); }).catch(() => {});
function dressBlock() {
  if (!typeKits || !edit) return "";
  const name = (x) => esc(lang === "ja" ? x.ja : x.en);
  return `<h3>${ico("type")}Type, colours and motion</h3>
    <div class="row wrap">${DRESS.map(([field, list, label]) => `<label class="meta">${label} <select data-dress="${field}">${typeKits[list].map((x, i) => `<option value="${esc(x.id)}" ${(edit[field] || typeKits[list][0].id) === x.id ? "selected" : ""}>${name(x)}${i === 0 ? " (house)" : ""}</option>`).join("")}</select></label>`).join("")}
      <button data-dressroll="1" title="Draw a new type, colours, motion and grade at random">${ico("refresh", "sm")}Surprise me</button></div>
    ${tdDressNote()}`;
}
document.addEventListener("change", (e) => {
  const s = e.target.closest?.("[data-dress]"); if (!s || !edit) return;
  commit(() => { edit[s.dataset.dress] = s.value; }, "Style changed. Save & render to apply.");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("[data-dressroll]") || !edit || !typeKits) return;
  const draw = (list, not) => { const rows = list.filter((x) => x.id !== not); let r = Math.random() * rows.reduce((a, x) => a + (x.weight || 1), 0); return (rows.find((x) => (r -= x.weight || 1) < 0) || rows[0]).id; };
  commit(() => { for (const [field, list] of DRESS) edit[field] = draw(typeKits[list], edit[field]); }, "A new style drawn. Save & render to apply.");
});
function paintSafe() {
  const el = $("#safe"), m = SAFE_ORDER[safeMode];
  $("#safeBtn").classList.toggle("on", m !== "off");
  $("#safeBtn span").textContent = m === "off" ? "Safe zone" : m === "studio" ? "Text area" : PLATFORM_UI[m].label;
  if (m === "off" || !specFormats?.[aspect]) { el.innerHTML = ""; return; }
  const f = specFormats[aspect], s = f.safe, pct = (v, of) => `${(100 * v / of).toFixed(2)}%`;
  let html = `<div class="safe-box" style="left:${pct(s.x, f.w)};top:${pct(s.y, f.h)};width:${pct(s.right - s.x, f.w)};height:${pct(s.bottom - s.y, f.h)}"><span>studio text area</span></div>`;
  const ui = PLATFORM_UI[m];
  if (ui && aspect !== "9x16") html += `<div class="safe-ui" style="left:0;right:0;bottom:0;height:12%"><span>${ui.label} guides are for 9:16</span></div>`;
  else if (ui?.bottom) html += `<div class="safe-ui" style="left:0;right:0;bottom:0;height:${pct(ui.bottom, f.h)}"><span>${ui.label}: caption and buttons</span></div>`;
  else if (ui?.right) html += `<div class="safe-ui" style="top:0;bottom:0;right:0;width:${pct(ui.right, f.w)}"><span>${ui.label}</span></div>`;
  el.innerHTML = html;
}
$("#safeBtn").onclick = () => { safeMode = (safeMode + 1) % SAFE_ORDER.length; paintSafe(); };
$("#coverBtn").onclick = async () => {
  if (!reel) return;
  if (mode === "edit") return toast(`${ico("info", "sm")} Covers come from the rendered video. Save & render first, or Revert.`, 4000);
  const at = +(player.currentTime || 0).toFixed(2);
  toast(`${ico("image", "sm")} Cutting covers at ${at.toFixed(2)} s…`, 4000);
  try {
    const r = await post("/api/cover", { slug: reel.slug, t: at });
    edit.coverAt = r.at; saved = JSON.stringify({ ...JSON.parse(saved), coverAt: r.at });
    toast(`${ico("check", "sm")} Cover set at ${r.at.toFixed(2)} s for ${r.channels.length} networks<br><img src="${file(r.preview)}&v=${Date.now()}" style="height:120px;margin-top:6px;border-radius:6px">`, 6000);
    renderInspector();
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
};
$("#undo").onclick = undo; $("#redo").onclick = redo;
$("#split").onclick = splitAt; $("#trimL").onclick = trimLeft; $("#trimR").onclick = trimRight; $("#del").onclick = deleteSel;
$("#snap").onclick = (e) => { snapOn = !snapOn; e.currentTarget.classList.toggle("on", snapOn); toast(snapOn ? "Snapping on" : "Snapping off", 900); };
$("#zin").onclick = () => { pps = Math.min(400, pps * 1.25); renderTimeline(); };
$("#zout").onclick = () => { pps = Math.max(20, pps / 1.25); renderTimeline(); };
$("#zfit").onclick = () => { pps = Math.max(20, ($("#tlBody").clientWidth - 40) / Math.max(total(), 1)); renderTimeline(); };
$("#revert").onclick = () => { if (!isDirty()) return; edit = JSON.parse(saved); history = []; future = []; setMode("rendered"); renderAll(); clearDraft(edit.slug); };
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || atHome() || !edit) return;
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
  else if (e.code === "ArrowLeft") { pause(); seek(t - (e.shiftKey ? 10 : 1) / FPS); }
  else if (e.code === "ArrowRight") { pause(); seek(t + (e.shiftKey ? 10 : 1) / FPS); }
  else if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === "b") { e.preventDefault(); splitAt(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "=" || k === "+")) { e.preventDefault(); $("#zin").click(); }
  else if ((e.ctrlKey || e.metaKey) && k === "-") { e.preventDefault(); $("#zout").click(); }
  else if (e.shiftKey && k === "z") $("#zfit").click();
  else if (k === "q") trimLeft();
  else if (k === "w") trimRight();
  else if (k === "n") $("#snap").click();
  else if (e.key === "Delete" || e.key === "Backspace") deleteSel();
  else if (e.key === "Home") seek(0);
});

/* ---------- save & render, new reel, review actions ---------- */
/* Properties › Words: what this reel says, how many others say exactly the same, and one button for fresh approved words. */
function wordsBlock() {
  const r = overview.reels.find((x) => x.slug === edit.slug) || {};
  const hook = edit.beats.find((b) => b.kind === "hook");
  const lines = edit.beats.filter((b) => b.kind === "line");
  const same = r.sameWords > 0 ? `<span style="color:var(--warn)">${tr("w.same", { n: r.sameWords })}</span>` : r.sameHook > 0 ? tr("w.samehook", { n: r.sameHook }) : tr("w.unique");
  return `<h3>${ico("type")}${tr("w.words")}</h3>
    <div class="wprev"><b>${esc((hook?.ja || "").replace(/\n/g, " "))}</b>${lines.map((b) => `<span>${esc(b.ja.replace(/\n/g, " "))}</span>`).join("")}</div>
    <p class="note">${same}. ${tr("w.edhint")}</p>
    <div class="row"><button id="drawWords" ${edit.theme ? "" : "disabled"}>${ico("refresh", "sm")}${tr("w.draw")}</button><a class="btn" href="#/words">${ico("type", "sm")}${tr("w.bank")}</a></div>`;
}
function toProject() {
  return { slug: edit.slug, title_ja: edit.title_ja, season: edit.season, bed: edit.bed, tags: edit.tags, yt_title: edit.yt_title, ...(edit.posts ? { posts: edit.posts } : {}),
    ...(edit.theme ? { theme: edit.theme } : {}), ...(edit.made_by ? { made_by: edit.made_by } : {}), music: edit.music, sfx: edit.sfx, style: edit.style,
    blurFaces: !!edit.blurFaces, ...(edit.bpm ? { bpm: edit.bpm } : {}), ...(edit.coverAt != null ? { coverAt: edit.coverAt } : {}), ...(edit.fx || {}),
    ...(edit.keep || {}), ...(edit.layers?.length ? { layers: edit.layers } : {}), beats: edit.beats, shots: edit.shots.map((s) => ({ src: s.src, sec: s.sec, ...(s.start != null ? { start: s.start } : {}), ...(s.pan ? { pan: s.pan } : {}), role: s.role })) };
}
async function watchJob(slug) {
  const busy = $("#busy");
  for (;;) {
    let j;
    try { j = await api("/api/job?slug=" + slug); }
    catch { await new Promise((r) => setTimeout(r, 4000)); continue; }  // server restarting: keep waiting
    const what = j.kind === "remix" ? "Mixing sound" : "Rendering";
    if (reel?.slug === slug && !atHome()) busy.innerHTML = busyChip(j, what);
    if (j.status === "done") { busy.innerHTML = ""; toast(`${ico("check", "sm")} ${esc(slug)} ${j.kind === "remix" ? "has its new sound" : "rendered"}`); await loadReels(slug); return; }
    if (j.status === "error") { busy.innerHTML = `<span class="chip bad">${ico("alert", "sm")} ${tr("job.failed")}: ${esc((j.lines || []).slice(-2).join(" "))}</span>`; return; }
    if (j.status === "none" || j.status === "cancelled") { if (j.status === "none") busy.innerHTML = ""; return; }
    await new Promise((r) => setTimeout(r, 2500));
  }
}
$("#render").onclick = async () => {
  const r = rules(); if (r.length) return toast(`${ico("alert", "sm")} Fix first: ${esc(r.join("; "))}`, 4000);
  // A refusal (the disk is nearly full, the studio is switching projects) is shown: the button never looks dead.
  let res;
  try { res = await post("/api/project", { project: toProject(), render: true }); } catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  if (res.problems?.length) return toast(`${ico("alert", "sm")} ${esc(res.problems.join("; "))}`, 5000);
  saved = JSON.stringify(edit); clearDraft(edit.slug); renderStatus(); watchJob(edit.slug);
};
$("#newReel").onclick = async () => {
  let themes;
  try { themes = await api("/api/themes"); } catch (err) { return toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  $("#themeList").innerHTML = Object.entries(themes).map(([k, v]) => `<button data-theme="${k}">${ico(THEME_ICON[k] || "film")}<b>${esc(k)}</b><span class="meta">${esc(v.title)}</span></button>`).join("");
  $("#newModal").classList.add("on");
};
$("#newCancel").onclick = () => $("#newModal").classList.remove("on");
$("#newGo").onclick = async () => {
  const theme = document.querySelector("button[data-theme].on")?.dataset.theme; const slug = $("#newSlug").value.trim();
  if (!theme || !/^[a-z0-9-]+$/.test(slug)) return toast("Pick a theme and a name (lowercase, dashes)");
  $("#newModal").classList.remove("on");
  toast(`${ico("clapper", "sm")} Assembling ${esc(slug)} from the library…`, 4000);
  try { await post("/api/assemble", { theme, slug, faces: $("#newFaces").checked, since: $("#newSince").value || null }); homeFilter = "making"; await loadOverview(); go(""); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 5000); }
};
async function act(name) {
  const slug = "story-" + reel.slug;
  const note = name === "reject" ? prompt("What is wrong with it? (kept with the reel)") : "";
  if (note === null) return;
  try {
    const out = await post("/api/" + name, { slug, note });
    toast(`${ico("check", "sm")} ${name === "approve" ? `Approved. Files are in Drive ready/${esc(String(out).trim().split(/[\\/]/).pop())}` : name}`, 4000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message.trim().split("\n").pop())}`, 5000); return; }
  await loadOverview();
  if (name === "consent") { reel = await api("/api/reel?slug=" + encodeURIComponent(reel.slug)); renderStatus(); return; }
  const q = needsReview();
  if (q.length) go(q[0].slug); else { toast(`${ico("check", "sm")} Nothing left to review`, 3000); go(""); }
}
$("#approve").onclick = () => (isDirty() ? toast("Save & render (or Apply sound) before approving") : act("approve"));
$("#consent").onclick = () => act("consent");
$("#reject").onclick = () => act("reject");
$("#qPrev").onclick = () => stepQueue(-1);
$("#qNext").onclick = () => stepQueue(1);
boot();
/* Google Maps Timeline (py/studio/timeline.py): where the trip went, from an export the person makes on their phone.
   The file goes only to this computer's studio, which keeps the trip's days and deletes the file. */
const TL = { data: null, loading: false, busy: false, error: "", asked: false };
async function loadTimeline(force) {
  if ((TL.asked && !force) || TL.loading) return;
  TL.asked = true; TL.loading = true;
  try { TL.data = await (await fetch("/api/vlogs/timeline")).json(); TL.error = ""; } catch (e) { TL.error = String(e.message || e); }
  TL.loading = false;
  if (page === "videos") route();
}
const tlTime = (iso, off) => new Date(Date.parse(iso) + (off || 0) * 60000).toISOString().slice(11, 16);
const tlStay = (min) => (min >= 1200 ? `${Math.round(min / 1440) || 1} ${lang === "ja" ? "泊" : (Math.round(min / 1440) || 1) > 1 ? "nights" : "night"}` : min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`);
const TL_MODE = { drive: ["車", "drive"], flight: ["飛行機", "flight"], walk: ["徒歩", "walk"], bus: ["バス", "bus"], train: ["電車", "train"], boat: ["船", "boat"], bike: ["自転車", "ride"], move: ["移動", "journey"] };
function timelineCard() {
  const ja = lang === "ja", t = TL.data;
  if (!TL.asked) loadTimeline();
  const has = t && t.imported;
  const nVisits = has ? t.days.reduce((a, d) => a + d.visits.filter((v) => v.show).length, 0) : 0;
  const steps = ja
    ? `<ol><li><b>Android</b>：スマホの「設定」›「位置情報」›「位置情報サービス」›「タイムライン」›「タイムライン データをエクスポート」</li><li><b>iPhone</b>：Google マップ › プロフィール写真 ›「設定」›「位置情報とプライバシー」›「タイムライン データをエクスポート」</li><li>できたファイル（.json）をこのパソコンに送り、下で選びます。</li></ol>`
    : `<ol><li><b>Android</b>: phone Settings › Location › Location services › Timeline › Export Timeline data</li><li><b>iPhone</b>: Google Maps › your picture › Settings › Location &amp; Privacy › Export Timeline data</li><li>Send the .json file to this computer and choose it below.</li></ol>`;
  const privacy = ja
    ? "ファイルはこのパソコンから出ません。スタジオはこの旅の日だけを残し、自宅と職場は除き、受け取ったファイルは削除します。場所の名前はファイルにないので、あなたが入力します（各場所に Google マップで見るリンクがあります）。どの場所を出すかはあなたが選べ、いつでも全部消せます。"
    : "The file stays on this computer: the studio keeps only this trip's days, leaves out home and work, and deletes the file it was given. Google's file has no place names, so you type them (each place has a link to see it in Google Maps). You choose which places appear, and you can remove all of it at any time.";
  const table = has ? t.days.map((d) => `<div class="tlday">${esc(shortDay(d.day))}</div><table><tbody>${[...d.visits.map((v) => ({ ...v, k: "v" })), ...d.legs.map((l) => ({ ...l, k: "l" }))]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map((x) => x.k === "l"
      ? `<tr class="leg"><td colspan="5">${esc(tlStay(x.min))} ${esc(TL_MODE[x.mode]?.[ja ? 0 : 1] || x.mode)}${x.km ? ` · ${Math.round(x.km)} km` : ""}</td></tr>`
      : `<tr><td class="mono">${tlTime(x.start, d.offsetMin)}–${tlTime(x.end, d.offsetMin)}</td><td class="mono">${esc(tlStay(x.min))}</td><td>${esc(x.country || "")}</td>
        <td><input type="text" maxlength="60" data-tlname="${esc(d.day)}|${esc(x.id)}" value="${esc(x.name || "")}" placeholder="${esc(ja ? "場所の名前（例：River Camp）" : "Name this place (e.g. River Camp)")}" aria-label="${esc(ja ? "場所の名前" : "Place name")}">
        <a href="${escUrl(`https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}${x.placeId ? `&query_place_id=${encodeURIComponent(x.placeId)}` : ""}`)}" target="_blank" rel="noopener noreferrer" class="meta">${ja ? "Google マップで見る" : "See it in Google Maps"}</a></td>
        <td><label class="chk"><input type="checkbox" data-tlshow="${esc(d.day)}|${esc(x.id)}" ${x.show ? "checked" : ""}> ${ja ? "出す" : "Show"}</label></td></tr>`).join("")}</tbody></table>`).join("") : "";
  return `<details class="tlcard" ${has || homeName() ? "" : "open"}><summary>${ico("pin", "sm")} ${ja ? "行った場所を取り込む（Google マップのタイムライン）" : "Bring in where you went (Google Maps Timeline)"}${has ? ` <span class="meta">· ${ja ? `${t.days.length}日、${nVisits}か所` : `${t.days.length} day${t.days.length === 1 ? "" : "s"}, ${nVisits} place${nVisits === 1 ? "" : "s"}`}</span>` : ""}</summary>
    <p class="meta">${ja ? "地図に実際の道、場所タグに滞在時間、説明欄に「どこへ行ったか」が入ります。" : "The maps draw the real road, the place tags say how long you stayed, and the description lists where you went."}</p>
    ${steps}<p class="meta">${ico("shield", "sm")} ${esc(privacy)}</p>
    <div class="row wrap"><label class="btn ${has ? "" : "primary"}">${TL.busy ? `<span class="spin sm"></span>${ja ? "読み込み中…" : "Reading…"}` : `${ico("folder", "sm")}${has ? (ja ? "別のファイルを取り込む" : "Import another file") : (ja ? "ファイルを選ぶ" : "Choose the file")}`}<input type="file" accept=".json,.gpx,application/json" data-tlfile="1" hidden ${TL.busy ? "disabled" : ""}></label>
      ${has ? `<button type="button" data-tlsave="1">${ico("check", "sm")}${ja ? "名前と表示を保存" : "Save names and choices"}</button><button type="button" data-tlforget="1">${ico("trash", "sm")}${ja ? "タイムラインを削除" : "Remove the Timeline"}</button>` : ""}
      ${has && t.hidden ? `<span class="meta">${ja ? `自宅・職場など ${t.hidden} か所は除きました` : `${t.hidden} home or work stop${t.hidden === 1 ? "" : "s"} left out`}</span>` : ""}</div>
    ${TL.error ? `<p class="bad">${ico("alert", "sm")} ${esc(TL.error)}</p>` : ""}${table}</details>`;
}
document.addEventListener("change", async (e) => {
  const f = e.target.closest?.("[data-tlfile]");
  if (!f || !f.files?.[0]) return;
  const file = f.files[0];
  TL.busy = true; TL.error = ""; route();
  try {
    const r = await fetch(`/api/vlogs/timeline?name=${encodeURIComponent(file.name.slice(-8))}`, { method: "POST", body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    TL.data = j; toast(`${ico("check", "sm")} ${esc(lang === "ja" ? "タイムラインを取り込みました。元のファイルは削除しました。" : "Timeline brought in. The file you chose was deleted from the studio.")}`, 6000);
  } catch (err) { TL.error = String(err.message || err); }
  TL.busy = false; route();
});
document.addEventListener("click", async (e) => {
  const t = e.target.closest?.("[data-tlsave], [data-tlforget]");
  if (!t) return;
  if (t.dataset.tlforget) {
    const r = await fetch("/api/vlogs/timeline/forget", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.ok) { TL.data = { imported: null }; toast(`${ico("check", "sm")} ${esc(lang === "ja" ? "タイムラインを削除しました。" : "The Timeline is removed from this project.")}`, 5000); route(); }
    return;
  }
  const changes = [];
  document.querySelectorAll("[data-tlname]").forEach((i) => { const [day, id] = i.dataset.tlname.split("|"); changes.push({ day, id, name: i.value }); });
  document.querySelectorAll("[data-tlshow]").forEach((i) => { const [day, id] = i.dataset.tlshow.split("|"); const c = changes.find((x) => x.day === day && x.id === id); if (c) c.show = i.checked; });
  const r = await fetch("/api/vlogs/timeline/choose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { TL.data = j; toast(`${ico("check", "sm")} ${esc(lang === "ja" ? "保存しました。次に作る動画から使われます。" : "Saved. The next videos you make use them.")}`, 5000); route(); }
  else toast(`${ico("alert", "sm")} ${esc(j.error || "Could not save")}`, 6000);
});

/* The Problems list (server/problems.mjs): what went wrong stays here until it is fixed, unlike the bell's passing notes.
   Text from the server can carry a network's own error message, so every field is escaped. */
/* Each cause: [English name, Japanese name, what fixes every problem of this kind (EN), (JA)]. */
const PROB_CAUSE = {
  job: ["Making stopped", "作成が止まったもの", "Open the reel and press Save & render again; the first line says why it stopped.", "リールを開いて、もう一度「Save & render」を押してください。止まった理由は1行目にあります。"],
  missed: ["Posts that did not go out", "出なかった投稿", "Post it now by hand, or book it again on Posting.", "今すぐ手で投稿するか、投稿ページでもう一度予約してください。"],
  unapproved: ["Booked but not approved", "未承認のまま予約", "Watch the reel and approve it, or take it off the plan.", "リールを見て承認するか、予定から外してください。"],
  signin: ["Sign-ins", "サインイン", "Sign in once on Settings › Accounts; the bookings then go out by themselves.", "設定 › アカウントで一度サインインすれば、予約は自動で出ます。"],
  reach: ["Networks not showing your posts", "投稿が表示されていないSNS", "Check the account on the network itself. A better reel will not fix this; the network has to show your posts first.", "SNS側でアカウントを確かめてください。リールを良くしても直りません。まずSNSが投稿を表示する必要があります。"],
  "vlog-shape": ["Long videos", "長い動画", "", ""],
  // Track C (24 Nov): reading views/likes stopped. Nothing made or booked is affected, so not "Making stopped" with a render fix.
  numbers: ["Reading numbers", "数字の読み取り", "Numbers are read again every hour. See the log for the post that was not read; for TikTok, X and the other Chrome networks keep Chrome open with the helper linked (Settings › Accounts).", "数字は1時間ごとに読み直します。読めなかった投稿はログで確かめてください。TikTokやXなどChromeで読むSNSは、ヘルパーをつないだままChromeを開いておいてください（設定 › アカウント）。"],
  switch: ["Project notes", "プロジェクトのお知らせ", "Nothing to fix: a note that the studio changed project.", "直すことはありません。プロジェクトを切り替えたお知らせです。"],
  ai: ["AI services", "AIサービス", "Top up the service, or give the block a backup on the Workflow page. Try again asks it first once more.", "サービスにチャージするか、ワークフローでブロックに予備を追加してください。「もう一度試す」で、またそのサービスを先に使います。"],
  other: ["Other", "その他", "", ""],
};
const sort3 = (items) => [...items].sort((a, b) => ({ red: 0, amber: 1, info: 2 }[a.level] ?? 3) - ({ red: 0, amber: 1, info: 2 }[b.level] ?? 3));
const PROB = {
  raw: [], open: false,
  /* The problems in the page's language at the moment they are read (BL-149): the server says each in both languages
     (`ja`), and so do this page's own lines. They used to be put into the language once, when loaded: after a switch
     back to English, Home still read "アカウントを開く ›" until the next load. A problem recorded before the server said
     both stays in English. */
  get items() {
    const ja = lang === "ja";
    return sort3(this.raw.map((it) => (ja && it.ja ? { ...it, title: it.ja.title || it.title, detail: it.ja.detail || it.detail,
      fix: it.fix && { ...it.fix, label: it.ja.fix || it.fix.label }, also: it.also && { ...it.also, label: it.ja.also || it.also.label } } : it)));
  },
  set items(v) { this.raw = Array.isArray(v) ? v : []; },
  async load() {
    let items;
    try { items = (await (await fetch("/api/problems")).json()).items || []; } catch { return; }
    // a numbers read that stopped breaks nothing (only numbers are late): amber, in "Numbers" (also one kept from before)
    items = items.map((it) => (/^job:(helper-perf|perf)(-|$)/.test(it.id) ? { ...it, level: it.level === "red" ? "amber" : it.level, group: "numbers" } : it));
    this.raw = [...items, ...(await this.local())];
    this.draw();
  },
  /* What only this page knows: a network booked through your Chrome that nobody has checked is signed in there (your
     "I'm signed in" lives in this browser). One line each, until it is checked on Settings › Accounts. Said in both
     languages, like the server's. */
  async local() {
    const out = [];
    if (!channelsSpec?.channels) return out;
    if (!helperView || Date.now() - (this.helperAt || 0) > 10 * 60_000) { try { helperView = await api("/api/helper"); this.helperAt = Date.now(); } catch { /* no helper: nothing to say */ } }
    for (const n of ["line-oa", "pinterest", "linkedin", "x", "tiktok", "gbp"]) {
      const s = chanOf(n);
      if (!s || s.off || !helperView) continue;
      const seen = helperView?.signins?.[n] ?? null, said = +lsGet("studio.signedin." + n, 0);
      if (seen === true || (seen === null && said && Date.now() - said < 30 * 864e5)) continue;
      const name = NET_NAME[n] || n;
      out.push({ id: `check:${n}`, level: "amber", local: true, first: new Date().toISOString(), dismissable: false,
        title: `${name} needs a one-time sign-in check`,
        detail: `The studio cannot tell from outside whether your Chrome is signed in to ${name}. On Settings › Accounts press "Open ${name} in my Chrome"; if it shows your account, press "I'm signed in".`,
        fix: { label: "Open Accounts", href: "#/accounts" },
        ja: { title: `${name}：Chromeでのサインインを一度確認してください`,
          detail: `スタジオは外から${name}にサインインしているか分かりません。設定 › アカウントで「Open ${name} in my Chrome」を押し、自分のアカウントが表示されたら「I'm signed in」を押してください。`,
          fix: "アカウントを開く" } });
    }
    return out;
  },
  word(n, ja) { return ja ? `${n}件` : `${n} thing${n === 1 ? "" : "s"}`; },
  /** The server names reels by file name ("aerial-1108"); people know them by their headline. */
  nice(text) { return String(text || "").replace(/\b[a-z][a-z0-9]*-\d{4}(?:-[a-z0-9]+)*\b/g, (m) => (overview?.reels?.some((r) => r.slug === m) ? `「${reelName(m)}」` : m)); },
  draw() {
    const ja = lang === "ja", items = this.items, red = items.filter((i) => i.level === "red"), amber = items.filter((i) => i.level === "amber");
    const btn = $("#probBtn"), strip = $("#probStrip");
    if (!btn || !strip) return;
    // Track C (24 Nov): one inbox. The header button counts the same list as "Needs you" (WN.paintBtn): its aria said 6,
    // its tooltip 2 and the strip 9. The strip under the header is that list, worst first.
    void ja; void red; void amber; void strip;
    WN.draw();
    if (this.open) this.panel();
  },
  place() { WN.place(); },
  panel() {
    const ja = lang === "ja";
    let p = $("#probPanel");
    const opening = !p;  // the by-cause bar fills when the panel opens, not when it repaints
    if (!p) { p = document.createElement("div"); p.id = "probPanel"; p.className = "probpanel"; p.setAttribute("role", "dialog"); document.body.appendChild(p); }
    this.open = true;
    const red = this.items.some((i) => i.level === "red");
    p.setAttribute("aria-label", ja ? "問題" : "Problems");
    /* Grouped by cause (the part of the id before ":"), worst group first: a bar of the groups on top (one block per
       problem, in its group's colour, each group a jump), then each group with its count and what fixes all of it. */
    const groups = new Map();
    for (const i of this.items) { const c = this.cause(i.id); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); }
    const lv = { red: 0, amber: 1, info: 2 }, worst = (l) => Math.min(...l.map((i) => lv[i.level] ?? 3));
    const order = [...groups].sort((a, b) => worst(a[1]) - worst(b[1]) || b[1].length - a[1].length);
    const tone = (l) => ["red", "amber", "info"][worst(l)] || "info";
    const item = (i) => `<li class="${esc(i.level)}"><b>${esc(this.nice(i.title))}</b><span class="why">${esc(this.nice(i.detail))}</span>
        <span class="meta">${ja ? "最初" : "First seen"} ${esc(new Date(i.first).toLocaleString(ja ? "ja-JP" : "en-GB"))}</span>
        <span class="row">${i.fix?.action?.ai === "retry" ? `<button type="button" class="primary" data-aitry="${esc(i.fix.action.provider)}">${ico("refresh", "sm")}${esc(i.fix.label)}</button>` : `<a class="btn primary" href="${escUrl(i.fix?.href || "#/")}" data-probclose="1">${esc(i.fix?.label || (ja ? "直す" : "Fix"))}</a>`}${i.also?.href ? `<a class="btn" href="${escUrl(i.also.href)}" target="_blank" rel="noopener">${ico("globe", "sm")}${esc(i.also.label || "")}</a>` : ""}${i.dismissable ? `<button data-probdismiss="${esc(i.id)}">${ja ? "閉じる" : "Dismiss"}</button>` : `<span class="meta">${ja ? "直すまで残ります" : "Stays until it is fixed"}</span>`}</span></li>`;
    const summary = order.length > 1 ? `<nav class="pgroups${opening && !moCalm() ? " in" : ""}" aria-label="${ja ? "原因別" : "By cause"}">
        <div class="pgbar" role="img" aria-label="${esc(order.map(([c, l]) => `${this.causeName(c, ja)} ${l.length}`).join(", "))}">${order.map(([c, l], i) => `<i class="${tone(l)}" style="flex:${l.length};--i:${i}" title="${esc(this.causeName(c, ja))}: ${l.length}"></i>`).join("")}</div>
        <div class="pgchips">${order.map(([c, l]) => `<button type="button" class="pgchip ${tone(l)}" data-probjump="${esc(c)}"><i aria-hidden="true"></i>${esc(this.causeName(c, ja))}<b>${l.length}</b></button>`).join("")}</div></nav>` : "";
    p.innerHTML = `<div class="phead"><img src="/brand/kenji-${red ? "worried" : this.items.length ? "point" : "thumbs"}.png" alt=""><b>${this.items.length ? (ja ? "直すこと" : "What went wrong") : (ja ? "問題はありません" : "Nothing is wrong")}</b><button class="icon" data-probclose="1" aria-label="${ja ? "閉じる" : "Close"}">${ico("x", "sm")}</button></div>
      ${summary}
      ${order.map(([c, l]) => { const fix = this.causeFix(c, ja);
        return `<section class="pgroup ${tone(l)}" id="pg-${esc(c)}" aria-label="${esc(this.causeName(c, ja))}"><h4><i aria-hidden="true"></i>${esc(this.causeName(c, ja))}<span class="count">${l.length}</span></h4>
          ${fix ? `<p class="pgfix">${ico("info", "sm")}<span>${esc(fix)}</span></p>` : ""}<ul>${l.map(item).join("")}</ul></section>`; }).join("")}`;
  },
  /** The cause of a problem: the part of its id before ":" ("job:pov-1114" → job). A Chrome sign-in check is a sign-in. */
  cause(id) {
    // a numbers read (helper-perf) is its own cause, also for one recorded before the server said so (`group`)
    if (/^job:(helper-perf|perf)(-|$)/.test(String(id || "")) || this.items.find((i) => i.id === id)?.group === "numbers" && !/^reach:/.test(id)) return "numbers";
    const c = String(id || "").split(":")[0]; return c === "check" ? "signin" : PROB_CAUSE[c] ? c : "other";
  },
  causeName(c, ja) { return (PROB_CAUSE[c] || PROB_CAUSE.other)[ja ? 1 : 0]; },
  causeFix(c, ja) { return (PROB_CAUSE[c] || PROB_CAUSE.other)[ja ? 3 : 2]; },
  close() { this.open = false; $("#probPanel")?.remove(); },
  async dismiss(id) {
    const r = await fetch("/api/problems/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(`${ico("alert", "sm")} ${esc(j.error || "Could not dismiss")}`, 6000); return; }
    this.items = j.items || []; await this.load();  // load again: the page's own lines (Chrome sign-in checks) stay in the list
  },
};
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("#probBtn, [data-probopen], [data-probclose], [data-probdismiss], [data-probhide]");
  if (!t) return;
  if (t.dataset.probhide) { try { sessionStorage.setItem("lc.probHidden", PROB.items.map((i) => i.id).join("|")); } catch { /* fine */ } return PROB.draw(); }
  // the red button opens the one inbox (Needs you) at its problems, not a second list
  if (t.id === "probBtn" || t.dataset.probopen) { PROB.close(); return WN.open && WN.filter ? WN.shut() : WN.openAt(); }
  if (t.dataset.probdismiss) return PROB.dismiss(t.dataset.probdismiss);
  if (t.dataset.probclose) PROB.close();
});
document.addEventListener("click", (e) => {
  const j = e.target.closest?.("[data-probjump]"); if (!j) return;
  const g = document.getElementById("pg-" + j.dataset.probjump);
  g?.scrollIntoView({ block: "start", behavior: moCalm() ? "auto" : "smooth" });
  g?.querySelector("a, button")?.focus({ preventScroll: true });
  const h = g?.querySelector("h4");  // its header flashes once: this is the group you asked for
  if (h && !moCalm()) { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && PROB.open) PROB.close(); });
