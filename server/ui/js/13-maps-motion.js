/* ---------- Node-and-wire maps, shared ----------
   One look for every "how this connects" picture in the studio (Footage › where footage comes from, Settings › how
   each network gets its post): a dark hub in the middle, branches left and right with their children hanging off
   them, one curve per link drawn after layout (drawWires), a colour per kind (.k-*), a status dot per node (.st-*),
   and a click that opens the node's details under the map. Under 640 px the CSS turns every map into a plain list.
   mapNode(): one node, a <button>. wireMap(): the layout; each branch is { node: (i) => html, kids: [(i) => html] },
   called in drawing order so the entrance delay (--i) runs in reading order. mapDetail(): the panel under a map.
   A node with the class "wire-dash" gets a dashed wire: the link is there but nothing flows yet. */
/* ---------- Motion on the graphics (17 Nov; the CSS is the "motion on the graphics" block) ----------
   Entrances play once per page visit: moVisit() forgets what was shown when another page opens, and each graphic
   keeps its own "already shown" key, so the many repaints of a page never replay them. A graphic waits off screen
   (.mo-off holds its entrance at the first frame and stops its loops) until an IntersectionObserver sees it; a hidden
   tab pauses everything (html.mo-hidden). The loops are moFlowTick's, read from the clock, so a repaint never restarts
   a breath or a flow. With reduced motion nothing here runs and the CSS shows every final state. */
function moState() { return (moState.s ||= { shown: new Set(), on: new Map(), io: null, watched: new Set(), fresh: new WeakSet() }); }
/* The motion switch (17 Nov): Auto follows the system, On and Reduced override it (localStorage studio.motion). The root
   class html.mo-calm carries it to the CSS; moCalm() is the same answer for the script. */
function moPref() { if (moPref.v === undefined) { let v = null; try { v = localStorage.getItem("studio.motion"); } catch { /* private window */ } moPref.v = v === "on" || v === "reduced" ? v : "auto"; } return moPref.v; }
function moSys() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
function moCalm() { const p = moPref(); return p === "reduced" || (p === "auto" && moSys()); }
/* Changing it (Settings, the hint, a system change under Auto): the class, the loops and every graphic follow at once,
   and the entrances play again, so "On" shows its motion straight away. */
function moSet(v) {
  try { if (v === "auto") localStorage.removeItem("studio.motion"); else localStorage.setItem("studio.motion", v); } catch { /* private window: this visit only */ }
  moPref.v = v; moApply();
}
function moApply() {
  document.documentElement.classList.toggle("mo-calm", moCalm());
  const s = moState(); clearInterval(s.tick); s.tick = 0; s.fresh = new WeakSet(); moVisit();
  if (atHome()) renderHome(true); else moAfter();
}
matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => { if (moPref() === "auto") moApply(); });
/* Auto, and the system asks for reduced motion: one note above the first graphic on the page says why it is still and
   turns it on in one press. Gone for good once pressed or closed (studio.motionHint). */
function moHint() {
  const old = document.querySelector("#home .mohint");
  const want = moPref() === "auto" && moSys() && lsGet("studio.motionHint", "") !== "1";
  const g = want && document.querySelector("#home :is(.smap, .rflow, #sysmon, .lanes, .tdy-grid)");
  if (!g) { old?.remove(); return; }
  let top = g; while (top.parentElement && top.parentElement.id !== "home") top = top.parentElement;
  if (old && old.nextElementSibling === top) return;
  old?.remove();
  top.insertAdjacentHTML("beforebegin", `<p class="mohint" role="note">${ico("pause", "sm")}<span>${esc(tr("mo.hint"))} <button type="button" class="linkbtn" data-moset="on">${esc(tr("mo.turnon"))}</button></span><a class="meta" href="#/keys/motion">${esc(tr("mo.where"))}</a><button type="button" class="icon" data-mohintx="1" aria-label="${esc(tr("mo.hide"))}" title="${esc(tr("mo.hide"))}">${ico("x", "sm")}</button></p>`);
}
document.addEventListener("click", (e) => {
  const on = e.target.closest?.("[data-moset]");
  if (on) { lsSet("studio.motionHint", "1"); moSet(on.dataset.moset); toast(`${ico("check", "sm")} ${esc(tr("mo.saved", { v: tr("mo." + moPref()) }))}`, 3000); return; }
  if (e.target.closest?.("[data-mohintx]")) { lsSet("studio.motionHint", "1"); document.querySelector("#home .mohint")?.remove(); }
});
document.addEventListener("change", (e) => {
  const r = e.target.closest?.("[data-motionpick]"); if (!r) return;
  lsSet("studio.motionHint", "1"); moSet(r.value);
  toast(`${ico("check", "sm")} ${esc(tr("mo.saved", { v: tr("mo." + r.value) }))}`, 3000);
});
/* Settings › Keys & AI › This studio: the switch itself, with what the system says and what the page does now. */
function motionCard() {
  const p = moPref();
  const opt = (v) => `<label class="moopt${p === v ? " on" : ""}"><input type="radio" name="studio-motion" value="${v}" data-motionpick ${p === v ? "checked" : ""}><b>${esc(tr("mo." + v))}</b><span class="meta">${esc(tr("mo." + v + "d"))}</span></label>`;
  return `<section class="sheet" data-anchor="motion"><h2>${ico("wave", "sm")} ${tr("mo.h")}</h2>
    <fieldset class="moset"><legend>${esc(tr("mo.label"))}</legend>${["auto", "on", "reduced"].map(opt).join("")}</fieldset>
    <p class="meta">${ico("info", "sm")} ${esc(tr(moSys() ? "mo.sysreduce" : "mo.sysfull"))} ${esc(tr(moCalm() ? "mo.nowstill" : "mo.nowmoving"))}</p>${themeFieldset()}</section>`;
}
function moVisit() {
  const s = moState(); s.shown.clear(); s.on.clear();
  try { foot.seen.clear(); accMap.seen.clear(); resFlow.drawn = false; } catch { /* not made yet at start-up */ }
}
function moAfter() {
  const s = moState(), calm = moCalm();
  for (const el of document.querySelectorAll(".smap, .rflow, .rjourney, .mo-gfx")) {
    if (s.fresh.has(el)) continue;
    s.fresh.add(el);
    if (!calm && "IntersectionObserver" in window) { el.classList.add("mo-off"); moWatch(el); }
  }
  // The picked node gives one ring when the pick changes.
  for (const map of document.querySelectorAll(".smap")) {
    const on = map.querySelector(".snode.on"), key = on ? on.dataset.snode || on.dataset.accnode || "on" : "";
    if (s.on.get(map.id) !== key) { s.on.set(map.id, key); if (on && !calm) on.classList.add("ping"); }
  }
  const mon = document.getElementById("sysmon");
  if (mon && !s.shown.has("mon")) { s.shown.add("mon"); if (!calm) { mon.classList.add("in"); setTimeout(() => mon.classList.remove("in"), 900); } }
  if (!calm && !s.tick && document.querySelector(moLoops())) s.tick = setInterval(moFlowTick, 83);
  moHint();
}
/* Every loop on the graphics (flows along wires, a silent band's drift, breathing and amber dots, red pings, the
   project's glow) is one set of custom properties written 12 times a second on the graphics on screen. Infinite CSS
   animations here were not composited and kept the page drawing 60 frames a second (about 10% of the main thread
   at idle); this costs a fraction of that. Values come from the clock, so a repaint carries on where it was. Stops by
   itself when no graphic is left; never starts with reduced motion, so the CSS defaults (the still states) show. */
function moLoops() { return ".smap, .sn-detail, .rflow, .rjourney, .wfg"; }
function moFlowTick() {
  const s = moState(), list = document.querySelectorAll(moLoops());
  if (!list.length || moCalm()) { clearInterval(s.tick); s.tick = 0; return; }
  if (document.hidden) return;
  const t = performance.now(), wave = (ms) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (t % ms)) / ms);
  const p = (t % 2400) / 2400, q = Math.min(1, p / 0.7);
  // Each value goes only on the elements that use it, so a tick restyles a handful of elements, not whole maps.
  const loops = [
    [".wfs", { "--fo": `${((t / 4800) * 72 % 72).toFixed(1)}px` }],  // flow: 72 px every 4.8 s
    [".rf-net:is(.k-zero, .k-unread, .k-react) .rf-rib", { "--fd": `${((t / 9000) * 18 % 18).toFixed(1)}px` }],  // drift: 18 px every 9 s
    [":is(.st-ok, .st-live) i.dot, i.dot.st-ok, .rj-chip.s-posted i", { "--mo-br": (1 - 0.6 * wave(2400)).toFixed(3) }],  // breathing, 2.4 s
    [".st-warn i.dot, i.dot.st-warn", { "--mo-nu": (1 + 0.35 * wave(1600)).toFixed(3) }],  // amber, 1.6 s
    [".st-bad i.dot, i.dot.st-bad, .rj-chip:is(.s-missing, .s-failed) i, .rj-steps li.now i",
      { "--mo-pp": (1 - (1 - q) ** 3).toFixed(3), "--mo-po": (p < 0.7 ? 0.75 * (1 - q) : 0).toFixed(3) }],  // ping, 2.4 s
    [".sm-hub", { "--mo-gl": (0.75 * wave(6000)).toFixed(3) }],  // the project's glow, 6 s
  ];
  for (const root of list) {
    if (root.closest(".mo-off")) continue;
    for (const [sel, v] of loops) for (const el of root.querySelectorAll(sel)) for (const k in v) el.style.setProperty(k, v[k]);
  }
}
function moWatch(el) {
  const s = moState();
  s.io ||= new IntersectionObserver((list) => {
    for (const e of list) {
      e.target.classList.toggle("mo-off", !e.isIntersecting);
      if (!e.isIntersecting) continue;
      const el = e.target;
      if (el.matches(".rflow.in, .mo-gfx.in") && !el.dataset.counted) { el.dataset.counted = "1"; moCount(el); }
      // An entrance counts as played once it has run on screen, not when its HTML is made: a page often paints twice
      // as it opens, and a copy replaced within that time plays it again in full instead of being cut short.
      if (el.matches(".in, .smap") && !el.dataset.moMark) {
        el.dataset.moMark = "1";
        setTimeout(() => {
          if (!el.isConnected) return;
          if (el.matches(".rflow.in")) resFlow.drawn = true;
          if (el.matches(".rjourney.in")) reelJourney.shown = el.dataset.rjslug;
          if (el.matches(".mo-gfx.in")) moState().shown.add("gx:" + el.dataset.gx);  // batch B's pictures (gxFresh)
          if (el.matches(".smap")) {
            const set = el.id === "amMap" ? accMap.seen : foot.seen;
            for (const nd of el.querySelectorAll(".snode.in")) set.add(nd.dataset.snode ?? nd.dataset.accnode);
            if (el.querySelector(".sm-hub.in")) set.add("_hub");
          }
        }, 700);
      }
    }
  }, { rootMargin: "40px" });
  for (const x of s.watched) if (!x.isConnected) { s.io.unobserve(x); s.watched.delete(x); }
  s.io.observe(el); s.watched.add(el);
}
/* Numbers marked data-count run up from 0 to their value in 600 ms, ease-out, as their band grows. */
function moCount(root) {
  const els = [...root.querySelectorAll("[data-count]")];
  if (!els.length || moCalm()) return;
  const fmt = (v) => Math.round(v).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB"), t0 = performance.now() + 160;
  const tick = (t) => {
    const p = Math.min(1, Math.max(0, (t - t0) / 600)), k = 1 - (1 - p) ** 3;
    for (const el of els) el.textContent = fmt(+el.dataset.count * k);
    if (p < 1 && root.isConnected) requestAnimationFrame(tick);
  };
  tick(performance.now());
}
document.addEventListener("visibilitychange", () => document.documentElement.classList.toggle("mo-hidden", document.hidden));
function mapNode(o) {
  return `<button type="button" class="snode ${o.kcls} st-${o.status?.[0] || "plain"} ${o.fresh ? "in" : ""} ${o.on ? "on" : ""} ${o.cls || ""}" ${o.attr} style="--i:${o.i || 0}"
      aria-expanded="${!!o.on}" aria-controls="${esc(o.controls || "")}" aria-label="${esc(o.label || o.name)}" title="${esc(o.title || o.name)}">
    <span class="sn-ico${o.logo ? " logo" : ""}" aria-hidden="true">${o.logo || ico(o.icon || "dot", "sm")}</span>
    <span class="sn-txt"><b>${esc(o.name)}</b><span class="sn-n">${o.nums || ""}</span>
      <span class="sn-st"><i class="dot" aria-hidden="true"></i>${esc(o.status?.[1] || "")}${o.after ? ` · ${esc(o.after)}` : ""}</span></span></button>`;
}
function wireMap({ id, label, hub, branches, cls = "" }) {
  // Branches go left and right, each side about the same height.
  const L = [], R = []; let hl = 0, hr = 0;
  for (const b of branches) { const h = 1 + (b.kids?.length || 0); if (hr <= hl) { R.push(b); hr += h; } else { L.push(b); hl += h; } }
  let i = 0;
  const branch = (b) => `<li class="sm-br">${b.node(i++)}${b.kids?.length ? `<ul class="sm-kids">${b.kids.map((c) => `<li>${c(i++)}</li>`).join("")}</ul>` : ""}</li>`;
  const sideL = L.map(branch).join(""), sideR = R.map(branch).join("");
  return `<div class="smap${cls ? " " + cls : ""}" id="${esc(id)}" aria-label="${esc(label)}">
      <svg class="sm-wires" aria-hidden="true" focusable="false"></svg>
      <ul class="sm-side l">${sideL}</ul>${hub}<ul class="sm-side r">${sideR}</ul>
    </div>`;
}
function mapDetail({ id, kcls, icon, logo, name, sub, status, facts, note = "", acts = "", fresh, closeAttr }) {
  return `<section class="sn-detail ${kcls} ${fresh ? "in" : ""}" id="${esc(id)}" aria-label="${esc(name)}" tabindex="-1">
    <div class="sn-head"><span class="sn-ico${logo ? " logo" : ""}" aria-hidden="true">${logo || ico(icon, "sm")}</span><div><b>${esc(name)}</b><span class="meta">${esc(sub)}${status ? ` · <span class="st-${status[0] || "plain"}"><i class="dot" aria-hidden="true"></i>${esc(status[1])}</span>` : ""}</span></div>
      <span class="grow"></span><button type="button" class="icon" ${closeAttr} aria-label="${esc(tr("src.close"))}" title="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>
    <dl class="sn-facts">${facts.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${note}${acts ? `<div class="row wrap">${acts}</div>` : ""}</section>`;
}
