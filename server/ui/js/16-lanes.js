/* ---------- Lanes and sparks (batch A, 17 Nov): the shared pictures beside the node-and-wire maps ----------
   laneSvg(): one row per network, one column per day, as ONE svg per chart (a week of ten networks is 70 cells and up to
   a few hundred posts over the weeks: no DOM node per cell). The HTML around it holds the row names and the day heads
   (holidays, events, the day's count); drawLanes() fills the svg after layout at its measured width, as drawWires does
   for the maps, and again when it changes size. Each chart keeps its model in LANES.m[id]: rows, days, items (one per
   post: row, day, state, time, reel), gaps ("net|day" → the slot time of an empty slot that network posts in) and
   act(kind, cell) for a click, Enter, a drag or a drop. mode "cells" fills each cell by its state (the Monitor's week);
   "chips" draws one chip per post with its time and reel (Posting's week lanes). States: booked (on the site, solid),
   studio (the studio sends it, hatched), hand (a reminder, outline), bad (failed or missing, red), out (went out),
   gap (an empty slot, dashed). spark(): a small line of numbers, one svg. */
const LN_ORDER = ["bad", "booked", "studio", "hand", "out"];
const lnState = (p) => (["failed", "missing"].includes(p.status) ? "bad" : p.status === "posted" || isLive(p) ? "out" : p.status === "scheduled" ? "booked" : p.status === "queued" ? "studio" : p.status === "planned" ? "hand" : "");
const LANES = { m: {}, ro: null, cur: {}, start: "", pick: null, pending: null, focus: null, drag: null, dragSlug: null };
/* The posts, empty slots and rows for a run of days, from the posting log (the same rows as Posting and Accounts). */
function laneData(days, { only = "all" } = {}) {
  const now = Date.now(), first = days[0], last = days[days.length - 1];
  const keep = postsLog.filter((p) => p.network !== "all" && p.at && !["replaced", "dropped", "skipped"].includes(p.status) && (only === "all" || p.network === only));
  // A failed or missing post stays red until the same reel is booked again on that network.
  const rebooked = (p) => keep.some((o) => o !== p && o.slug === p.slug && o.network === p.network && !["failed", "missing"].includes(o.status) && (o.id || 0) > (p.id || 0));
  const inRange = keep.filter((p) => { const d = dayOf(p.at); return d >= first && d <= last && !(["failed", "missing"].includes(p.status) && rebooked(p)); });
  const items = inRange.map((p) => {
    const ps = p.network === "youtube" ? postState(p.slug).youtube : null;
    const st = lnState(ps && ps.id === p.id ? { ...p, status: ps.status } : p), t = new Date(p.at).getTime();
    return { row: p.network, day: dayOf(p.at), state: st, id: p.id, slug: p.slug, at: p.at, t, hm: wallOf(t).slice(11, 16), name: reelName(p.slug),
      movable: MOVABLE.includes(p.status) && t > now + 15 * 60e3, raw: p.status, test: tcTestHour(p) };
  }).filter((x) => x.state).sort((a, b) => a.t - b.t);
  const on = only === "all" ? PLAN_NETS() : PLAN_NETS().filter((n) => n === only);
  const nets = [...new Set([...on, ...items.map((x) => x.row)])].sort((a, b) => (WEEK_ORDER.indexOf(a) + 1 || 99) - (WEEK_ORDER.indexOf(b) + 1 || 99));
  const today = wallOf(now).slice(0, 10), gaps = new Map();
  for (const n of on) {
    const times = takenTimes(n), held = new Set(postsLog.filter((p) => p.network === n && holdsSlot(p)).map((p) => dayOf(p.at)));
    const weekly = PLAN_WEEKLY.includes(n), slots = weekly ? slotsOf(n).slice(0, 1) : slotsOf(n);
    for (const d of days) {
      if (d < today || held.has(d)) continue;
      const ahead = Math.round((Date.parse(d + "T12:00Z") - Date.parse(today + "T12:00Z")) / 864e5);
      if (planBooks(n) && ahead >= (BOOK_AHEAD[n] ?? 9999)) continue;
      const dow = new Date(d + "T12:00Z").getUTCDay();
      const s = slots.find((x) => (x.dow < 0 || x.dow === dow) && slotFree(times, zonedIso(`${d}T${x.hm}`)));
      if (!s || (weekly && times.some((t) => Math.abs(t - Date.parse(zonedIso(`${d}T${s.hm}`))) < 7 * 864e5 - 36e5))) continue;
      gaps.set(`${n}|${d}`, s.hm);
    }
  }
  return { rows: nets.map((n) => ({ key: n, name: NET_NAME[n] || NET_NAME[chOf(n)] || n })), items, gaps };
}
function lnDayHead(d, model) {
  const L = lang === "ja" ? "ja-JP" : "en-GB", dt = new Date(`${d}T12:00:00Z`), wd = dt.getUTCDay();
  const hol = HOLIDAYS?.[d], evs = (model.events || []).filter((e) => e.d === d), n = model.items.filter((x) => x.day === d).length;
  return `<li class="${d === model.today ? "today" : ""}${wd === 6 ? " sat" : ""}${wd === 0 || hol ? " sun" : ""}${d < model.today ? " past" : ""}">
    <span class="ln-dt"><b>${esc(dt.toLocaleDateString(L, { weekday: "short", timeZone: "UTC" }))}</b> ${dt.getUTCDate()}${model.counts && n ? `<i class="ln-n">${n}</i>` : ""}</span>
    ${hol ? `<span class="ln-hol" title="${esc(holName(hol))}">${esc(holName(hol))}</span>` : ""}${evs.map((e) => `<a class="ln-ev" href="${escUrl(e.url || "#/ideas/events")}" ${e.url ? 'target="_blank" rel="noopener"' : ""} title="${esc(e.t)}">${esc(e.t)}</a>`).join("")}</li>`;
}
function laneSvg(model) {
  LANES.m[model.id] = model;
  const rh = model.mode === "chips" ? 58 : 24;
  const rows = model.rows.map((r) => `<li title="${esc(r.name)}">${netLogo(chOf(r.key), "sm")}<span>${esc(r.name)}</span></li>`).join("");
  const fresh = !moCalm() && !moState().shown.has("ln:" + model.id);
  if (fresh) moState().shown.add("ln:" + model.id);
  return `<div class="lanes ${model.mode}${model.cls ? " " + model.cls : ""}${fresh ? " in" : ""}" id="${esc(model.id)}" data-lanes="${esc(model.id)}" style="--rows:${model.rows.length};--rh:${rh}px;--cols:${model.days.length}">
    <div class="ln-corner">${model.corner || ""}</div>
    <ol class="ln-days">${model.days.map((d) => lnDayHead(d, model)).join("")}</ol>
    <ul class="ln-rows">${rows}</ul>
    <div class="ln-plot"><svg class="ln-svg" role="grid" tabindex="0" aria-label="${esc(model.label)}" aria-describedby="${esc(model.id)}-read" focusable="true"></svg></div>
    <p class="ln-read meta" id="${esc(model.id)}-read" aria-live="polite">${esc(model.hint || "")}</p>
  </div>`;
}
const LN_NAME = { booked: "ln.s.booked", studio: "ln.s.studio", hand: "ln.s.hand", bad: "ln.s.bad", out: "ln.s.out", gap: "ln.s.gap" };
const lnStateName = (s) => tr(LN_NAME[s] || "ln.s.gap");
/* What one cell holds, in words: for the line under the chart, the hover and a screen reader. */
function lnCellText(m, r, d) {
  const row = m.rows[r], day = m.days[d]; if (!row || !day) return "";
  const xs = m.items.filter((x) => x.row === row.key && x.day === day), gap = m.gaps.get(`${row.key}|${day}`);
  const head = `${postDayLabel(day)} · ${row.name}`;
  if (xs.length) return `${head} · ${xs.map((x) => `${x.hm}${x.test ? ` (${tr("tc.test")})` : ""} ${lnStateName(x.state)}: ${x.name}`).join(" ; ")}`;
  return gap ? `${head} · ${tr("ln.gapat", { t: gap })}` : `${head} · ${tr("ln.none")}`;
}
function drawLanes() {
  for (const el of document.querySelectorAll(".lanes[data-lanes]")) {
    const m = LANES.m[el.dataset.lanes], svg = el.querySelector(".ln-svg");
    if (!m || !svg) continue;
    const W = Math.max(140, Math.round(svg.parentElement.clientWidth)), chips = m.mode === "chips", rh = chips ? 58 : 24, H = rh * m.rows.length;
    const cw = W / m.days.length, sig = `${W}|${m.sig || ""}|${JSON.stringify(LANES.cur[m.id] || null)}|${LANES.pick || ""}`;
    m.geo = { W, H, cw, rh };
    if (svg.dataset.sig === sig && svg.childElementCount) { lnPlace(el, m); continue; }
    svg.dataset.sig = sig;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const id = m.id, ri = new Map(m.rows.map((r, i) => [r.key, i])), di = new Map(m.days.map((d, i) => [d, i]));
    const rect = (x, y, w, h) => `M${x.toFixed(1)},${y.toFixed(1)}h${w.toFixed(1)}v${h.toFixed(1)}h${(-w).toFixed(1)}z`;
    let bg = "";
    // The day columns: today in the pop yellow, Sundays and holidays faintly pink, past days greyed.
    m.days.forEach((d, i) => {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      const cls = d === m.today ? "today" : d < m.today ? "past" : wd === 0 || HOLIDAYS?.[d] ? "sun" : wd === 6 ? "sat" : "";
      if (cls) bg += `<rect class="ln-col ${cls}" x="${(i * cw).toFixed(1)}" y="0" width="${cw.toFixed(1)}" height="${H}"/>`;
    });
    let grid = "";
    for (let r = 1; r < m.rows.length; r++) grid += `M0,${r * rh}H${W}`;
    for (let c = 1; c < m.days.length; c++) grid += `M${(c * cw).toFixed(1)},0V${H}`;
    const paths = { gap: "" }, extra = [];
    for (const [k, hm] of m.gaps) {
      const [net, day] = k.split("|"); if (!ri.has(net) || !di.has(day)) continue;
      const x = di.get(day) * cw, y = ri.get(net) * rh;
      paths.gap += rect(x + 4, y + 4, cw - 8, rh - 8);
      if (chips && cw > 54) extra.push(`<text class="ln-gapt" x="${(x + cw / 2).toFixed(1)}" y="${(y + rh / 2 + 4).toFixed(1)}">${esc(hm)}</text>`);
    }
    let body = "";
    if (!chips) {
      // One cell per network and day, filled by its most pressing state; a number when it holds more than one post.
      const cells = new Map();
      for (const x of m.items) { const k = `${x.row}|${x.day}`; (cells.get(k) || cells.set(k, []).get(k)).push(x); }
      for (const [k, xs] of cells) {
        const [net, day] = k.split("|"); if (!ri.has(net) || !di.has(day)) continue;
        const st = LN_ORDER.find((s) => xs.some((x) => x.state === s)), x = di.get(day) * cw, y = ri.get(net) * rh;
        paths[st] = (paths[st] || "") + rect(x + 2, y + 2, cw - 4, rh - 4);
        if (xs.length > 1) extra.push(`<text class="ln-cnt s-${st}" x="${(x + cw / 2).toFixed(1)}" y="${(y + rh / 2 + 4).toFixed(1)}">${xs.length}</text>`);
      }
    } else {
      // One chip per post: its time and reel, a cover when there is room; posts that share a day share its height.
      const cells = new Map();
      for (const x of m.items) { const k = `${x.row}|${x.day}`; (cells.get(k) || cells.set(k, []).get(k)).push(x); }
      m.hit = [];
      for (const [k, xs] of cells) {
        const [net, day] = k.split("|"); if (!ri.has(net) || !di.has(day)) continue;
        const x0 = di.get(day) * cw + 3, y0 = ri.get(net) * rh + 3, h = (rh - 6 - (xs.length - 1) * 2) / xs.length, w = cw - 6;
        xs.forEach((p, j) => {
          const y = y0 + j * (h + 2), big = h >= 40 && w >= 96, th = big ? Math.round(h * 9 / 16) : 0;
          const r = overview.reels.find((z) => z.slug === p.slug), img = big && r?.hook ? thumb(r.hook, 60) : "";
          const tx = x0 + (img ? th + 6 : 6), cap = Math.max(0, Math.floor((w - (tx - x0) - 4) / 6.6));
          const name = p.name.length > cap ? p.name.slice(0, Math.max(0, cap - 1)) + "…" : p.name;
          m.hit.push({ x: x0, y, w, h, p });
          const drag = LANES.drag?.p?.id === p.id ? " dragging" : "";
          body += `<g class="ch s-${p.state}${p.movable ? " mov" : ""}${drag}" style="--c:${di.get(day)}">
            <rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2"${p.state === "studio" ? ` fill="url(#${esc(id)}-hatch)"` : ""}/>${img ? `<image href="${escUrl(img)}" x="${(x0 + 2).toFixed(1)}" y="${(y + 2).toFixed(1)}" width="${th - 2}" height="${(h - 4).toFixed(1)}" preserveAspectRatio="xMidYMid slice"/>` : ""}
            <text class="ch-t" x="${tx.toFixed(1)}" y="${(y + (h >= 30 ? 15 : h / 2 + 4)).toFixed(1)}">${esc(p.hm)}${p.state === "bad" ? " !" : p.state === "out" ? " ✓" : ""}</text>${h >= 30 && cap > 2 ? `<text class="ch-n" x="${tx.toFixed(1)}" y="${(y + 31).toFixed(1)}" lang="ja">${esc(name)}</text>` : ""}${p.test && w >= 72 && h >= 18 ? `<g class="tc-testb"><title>${esc(tr("tc.testwhy", { h: p.test }))}</title><rect x="${(x0 + w - 40).toFixed(1)}" y="${(y + h - (h >= 40 ? 16 : 15)).toFixed(1)}" width="37" height="13" rx="2"/><text x="${(x0 + w - 21.5).toFixed(1)}" y="${(y + h - (h >= 40 ? 6.5 : 5.5)).toFixed(1)}">${esc(lang === "ja" ? "テスト" : "test")}</text></g>` : ""}</g>`;
        });
      }
    }
    const pat = `<defs><pattern id="${esc(id)}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="ln-hbg"/><line x1="0" y1="0" x2="0" y2="6" class="ln-hl"/></pattern></defs>`;
    const statePaths = ["out", "hand", "studio", "booked", "bad"].filter((s) => paths[s]).map((s) => `<path class="ln-c s-${s}" d="${paths[s]}"${s === "studio" ? ` fill="url(#${esc(id)}-hatch)"` : ""}/>`).join("");
    // Reel being placed (tray): every slot it may go in, outlined green.
    let ok = "";
    if (chips && LANES.pick && m.drop) for (let r = 0; r < m.rows.length; r++) for (let d = 0; d < m.days.length; d++) if (!lnWhyNot(LANES.pick, m.rows[r].key, m.days[d])) ok += rect(d * cw + 2, r * rh + 2, cw - 4, rh - 4);
    const cur = LANES.cur[id];
    svg.innerHTML = `${pat}${bg}<path class="ln-grid" d="${grid}"/>${paths.gap ? `<path class="ln-c s-gap" d="${paths.gap}"/>` : ""}${statePaths}${ok ? `<path class="ln-ok" d="${ok}"/>` : ""}${body}${extra.join("")}
      <rect class="ln-cur" x="${((cur?.d || 0) * cw + 1).toFixed(1)}" y="${((cur?.r || 0) * rh + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${rh - 2}" rx="2"/>
      <rect class="ln-drop" x="0" y="0" width="0" height="0" rx="2"/>`;
    lnPlace(el, m);
  }
  if (!LANES.ro && "ResizeObserver" in window) LANES.ro = new ResizeObserver(() => requestAnimationFrame(drawLanes));
  LANES.ro?.disconnect(); document.querySelectorAll(".lanes .ln-plot").forEach((p) => LANES.ro?.observe(p));
  if (LANES.focus) lnApplyFocus();
}
/* The confirm chip sits beside its cell (right of it, or left when there is no room). */
function lnPlace(el, m) {
  const cf = el.querySelector(".lnconfirm"), cc = LANES.cur[m.id], svg = el.querySelector(".ln-svg");
  if (!cf || !cc || !m.geo || !svg) return;
  const pr = svg.getBoundingClientRect(), lr = el.getBoundingClientRect(), w = cf.offsetWidth;
  let left = pr.left - lr.left + (cc.d + 1) * m.geo.cw + 6;
  if (left + w > lr.width - 6) left = pr.left - lr.left + cc.d * m.geo.cw - w - 6;
  cf.style.left = `${Math.round(Math.max(6, left))}px`;
  cf.style.top = `${Math.round(Math.max(4, Math.min(lr.height - cf.offsetHeight - 4, pr.top - lr.top + cc.r * m.geo.rh - 6)))}px`;
}
/* The cell under a pointer, from the chart's own layout (one svg, so no element per cell to ask). */
function lnCellAt(svg, cx, cy) {
  const m = LANES.m[svg.closest(".lanes")?.dataset.lanes]; if (!m?.geo) return null;
  const b = svg.getBoundingClientRect(), x = cx - b.left, y = cy - b.top;
  const d = Math.floor(x / m.geo.cw), r = Math.floor(y / m.geo.rh);
  if (d < 0 || r < 0 || d >= m.days.length || r >= m.rows.length) return null;
  const hit = (m.hit || []).find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
  return { m, r, d, net: m.rows[r].key, day: m.days[d], p: hit?.p || m.items.find((i) => i.row === m.rows[r].key && i.day === m.days[d]) || null };
}
function lnRead(m, text) { const el = document.getElementById(m.id + "-read"); if (el) el.textContent = text || m.hint || ""; }
function lnShowDrop(svg, c, good) {
  const box = svg.querySelector(".ln-drop"), m = c?.m; if (!box) return;
  if (!c) { box.setAttribute("width", 0); return; }
  box.setAttribute("x", (c.d * m.geo.cw + 1).toFixed(1)); box.setAttribute("y", (c.r * m.geo.rh + 1).toFixed(1));
  box.setAttribute("width", (m.geo.cw - 2).toFixed(1)); box.setAttribute("height", m.geo.rh - 2);
  box.classList.toggle("no", !good);
}
/* A cell asked for from elsewhere (the Monitor's week, Today): bring its week into view, focus it and say what is there. */
function lnApplyFocus() {
  const f = LANES.focus, m = Object.values(LANES.m).find((x) => x.mode === "chips" && document.getElementById(x.id));
  if (!f || !m) return;
  const r = m.rows.findIndex((x) => x.key === f.net), d = m.days.indexOf(f.day);
  if (d < 0) return;
  LANES.focus = null;
  LANES.cur[m.id] = { r: Math.max(0, r), d };
  const svg = document.querySelector(`#${CSS.escape(m.id)} .ln-svg`);
  requestAnimationFrame(() => { drawLanes(); svg?.focus({ preventScroll: true }); svg?.scrollIntoView({ block: "center", behavior: moCalm() ? "auto" : "smooth" }); lnRead(m, lnCellText(m, Math.max(0, r), d)); svg?.closest(".lanes")?.classList.add("flash"); setTimeout(() => svg?.closest(".lanes")?.classList.remove("flash"), 1200); });
}
document.addEventListener("pointermove", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg || LANES.drag?.on) return;
  const c = lnCellAt(svg, e.clientX, e.clientY); if (!c) return;
  lnRead(c.m, lnCellText(c.m, c.r, c.d));
  svg.style.cursor = c.p?.movable && c.m.move ? "grab" : c.p || c.m.act ? "pointer" : "";
});
document.addEventListener("pointerleave", (e) => { const svg = e.target.closest?.(".ln-svg"); if (svg && !LANES.drag?.on) lnRead(LANES.m[svg.closest(".lanes").dataset.lanes]); }, true);
document.addEventListener("focusin", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg) return;
  const m = LANES.m[svg.closest(".lanes").dataset.lanes], c = LANES.cur[m.id] || { r: 0, d: Math.max(0, m.days.indexOf(m.today)) };
  LANES.cur[m.id] = c; drawLanes(); lnRead(m, lnCellText(m, c.r, c.d));
});
document.addEventListener("keydown", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg) return;
  const m = LANES.m[svg.closest(".lanes").dataset.lanes], c = { ...(LANES.cur[m.id] || { r: 0, d: 0 }) };
  const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], Home: [0, -99], End: [0, 99] }[e.key];
  if (step && e.altKey && m.move && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    // Alt+← / Alt+→ moves the focused post a day, as a drag would.
    e.preventDefault();
    const p = m.items.find((x) => x.row === m.rows[c.r]?.key && x.day === m.days[c.d]);
    const to = m.days[c.d + step[1]] || (step[1] > 0 ? nextDay(m.days[c.d]) : "");
    if (p && to) m.move(p, to);
    return;
  }
  if (step) {
    e.preventDefault();
    c.r = Math.max(0, Math.min(m.rows.length - 1, c.r + step[0])); c.d = Math.max(0, Math.min(m.days.length - 1, c.d + step[1]));
    LANES.cur[m.id] = c; drawLanes(); lnRead(m, lnCellText(m, c.r, c.d));
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const net = m.rows[c.r]?.key, day = m.days[c.d];
    m.act?.("open", { m, r: c.r, d: c.d, net, day, p: m.items.find((x) => x.row === net && x.day === day) || null });
  }
  if (e.key === "Escape" && LANES.pick) { LANES.pick = null; renderHome(true); }
});
document.addEventListener("click", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg) return;
  if (LANES.drag?.moved) { const just = Date.now() - (LANES.drag.t || 0) < 400; LANES.drag = null; if (just) return; }  // the end of a drag is not a click
  const c = lnCellAt(svg, e.clientX, e.clientY); if (!c) return;
  LANES.cur[c.m.id] = { r: c.r, d: c.d };
  c.m.act?.("open", c);
});
/* Dragging a post the studio holds (dashed "studio sends" or a reminder) to another day of its row: the same time of day,
   moved at once on the page (optimistic) and then by /api/posts/move, with Undo. A post booked on the site says why it
   does not move instead. */
document.addEventListener("pointerdown", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg || e.button !== 0) return;
  const c = lnCellAt(svg, e.clientX, e.clientY); if (!c?.p || !c.m.move) return;
  LANES.drag = { svg, m: c.m, p: c.p, x: e.clientX, y: e.clientY, on: false, moved: false, from: c };
});
document.addEventListener("pointermove", (e) => {
  const g = LANES.drag; if (!g) return;
  if (!g.on && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
  if (!g.on) {
    g.on = true; g.moved = true;
    if (!g.p.movable) { const why = lnStuck(g.p); toast(`${ico("info", "sm")} ${esc(why)}`, 5000); lnRead(g.m, why); LANES.drag = { moved: true, t: Date.now() }; return; }
    g.svg.classList.add("dragging"); g.svg.setPointerCapture?.(e.pointerId);
  }
  const c = lnCellAt(g.svg, e.clientX, g.svg.getBoundingClientRect().top + (g.from.r + 0.5) * g.m.geo.rh);  // a post stays in its network's row
  if (!c) return;
  g.to = c.day;
  const why = c.day === g.p.day ? "" : lnMoveWhyNot(g.p, c.day);
  lnShowDrop(g.svg, c, !why);
  lnRead(g.m, why || tr("ln.moveto", { s: g.p.name, d: postDayLabel(c.day), t: g.p.hm }));
});
document.addEventListener("pointerup", () => {
  const g = LANES.drag; if (!g?.svg) return;
  g.svg.classList.remove("dragging"); lnShowDrop(g.svg, null);
  if (g.on && g.to && g.to !== g.p.day) { const why = lnMoveWhyNot(g.p, g.to); if (why) toast(`${ico("info", "sm")} ${esc(why)}`, 5000); else g.m.move(g.p, g.to); }
  LANES.drag = g.on ? { moved: true, t: Date.now() } : null;
});
/* Why a post cannot be dragged, in one sentence. */
function lnStuck(p) {
  if (p.state === "booked") return tr("ln.isbooked", { n: NET_NAME[p.row] || p.row });
  if (p.state === "out") return tr("ln.isout");
  if (p.state === "bad") return tr("ln.isbad");
  return tr("ln.soon");
}
function lnMoveWhyNot(p, day) {
  const at = zonedIso(`${day}T${p.hm}`);
  if (new Date(at).getTime() < Date.now() + 15 * 60e3) return tr("ln.soon");
  if (postsLog.some((o) => o.id !== p.id && o.network === p.row && holdsSlot(o) && dayOf(o.at) === day)) return tr("ln.taken", { n: NET_NAME[p.row] || p.row });
  return "";
}
function spark(values, { w = 120, h = 28, label = "", cls = "" } = {}) {
  const v = values.map((x) => Math.max(0, +x || 0)), top = Math.max(1, ...v), n = v.length;
  if (n < 2) return "";
  const pt = (x, i) => `${((i * (w - 4)) / (n - 1) + 2).toFixed(1)},${(h - 3 - (x / top) * (h - 6)).toFixed(1)}`;
  const line = v.map(pt).join(" ");
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><polygon class="sp-a" points="2,${h - 2} ${line} ${w - 2},${h - 2}"/><polyline class="sp-l" points="${line}"/><circle class="sp-d" cx="${pt(v[n - 1], n - 1).split(",")[0]}" cy="${pt(v[n - 1], n - 1).split(",")[1]}" r="2.5"/></svg>`;
}
function nodeHtml(n, i) {
  const k = AH_KIND[n.kind], seen = foot.seen.has(n.id);
  const nums = n.clips != null ? `${tr("sm.clips", { n: n.clips.toLocaleString() })} · <em>${tr("sm.unused", { n: n.unused.toLocaleString() })}</em>` : n.files != null ? tr("sm.files", { n: n.files.toLocaleString() }) : "…";
  const label = `${n.name}, ${n.sub}. ${n.clips != null ? tr("sm.clips", { n: n.clips }) + ", " + tr("sm.unused", { n: n.unused }) : ""}. ${n.status[1]}${n.checked ? ", " + tr("src.checked", { t: ago(n.checked) }) : ""}`;
  return mapNode({ kcls: k.cls, icon: k.icon, status: n.status, fresh: !seen, on: foot.node === n.id, attr: `data-snode="${esc(n.id)}"`, i, controls: "snDetail", label,
    title: n.path || n.name, name: n.name, nums: nums + (n.fresh ? ` <strong>+${n.fresh}</strong>` : ""), after: n.checked ? ago(n.checked) : "" });
}
function sourceMap() {
  const m = mapNodes();
  if (!m || !srcKnown()) return `<div class="smap-wrap"><div class="skel skel-line" style="width:40%"></div></div>`;  // no answer: no "0 places" (BL-138)
  loadMapLib();
  const s = foot.src, last = s.last || {};
  const clips = foot.mapLib ? foot.mapLib.length : null, unused = foot.mapLib ? foot.mapLib.filter((x) => x.u).length : null;
  const hub = `<div class="sm-hub ${foot.seen.size ? "" : "in"}" role="group" aria-label="${esc(tr("sm.project"))}">
      <span class="sm-hubico" aria-hidden="true">${ico("film")}</span>
      <b>${esc(WORKSPACE || tr("sm.project"))}</b>
      <span class="meta">${clips != null ? `${tr("sm.clips", { n: clips.toLocaleString() })} · ${tr("sm.unused", { n: unused.toLocaleString() })}` : "…"}</span>
      <span class="meta">${esc(tr("src.sum", { n: s.sources.length, f: m.all.reduce((a, n) => a + (n.src ? n.files || 0 : 0), 0).toLocaleString() }))}</span>
      <span class="meta">${tr("src.checked", { t: ago(last.checked) })}</span></div>`;
  const html = `<div class="smap-wrap">
    ${wireMap({ id: "smap", label: tr("sm.label"), hub, branches: m.top.map((b) => ({ node: (i) => nodeHtml(b, i), kids: b.kids.map((c) => (i) => nodeHtml(c, i)) })) })}
    ${nodeDetail(m.all.find((n) => n.id === foot.node))}</div>`;
  if (moCalm() || !("IntersectionObserver" in window)) { for (const n of m.all) foot.seen.add(n.id); foot.seen.add("_hub"); }  // else marked seen once on screen (moWatch)
  return html;
}
/* The wires: one curve from the hub to each branch and from a branch to each child, drawn after layout and again
   when the map changes size. They fade in; the nodes carry the meaning, the wires only the shape. */
function drawWires() { document.querySelectorAll("#home .smap, #app .smap").forEach(drawMapWires); document.querySelectorAll("#home .wfg").forEach(drawFlowWires); }
function drawMapWires(map) {
  const svg = map.querySelector(".sm-wires"), hub = map.querySelector(".sm-hub");
  if (!svg || !hub || getComputedStyle(svg).display === "none") return;
  const box = map.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`); svg.setAttribute("width", box.width); svg.setAttribute("height", box.height);
  const rel = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: r.left - box.left + r.width / 2, cy: r.top - box.top + r.height / 2 }; };
  const curve = (a, b) => {
    const right = b.cx > a.cx, x1 = right ? a.r : a.l, x2 = right ? b.l : b.r, mid = (x1 + x2) / 2;
    return `M${x1.toFixed(1)},${a.cy.toFixed(1)} C${mid.toFixed(1)},${a.cy.toFixed(1)} ${mid.toFixed(1)},${b.cy.toFixed(1)} ${x2.toFixed(1)},${b.cy.toFixed(1)}`;
  };
  // Each link: its kind's colour; dashed where nothing flows yet (wire-dash) or the place is broken or waits on a step;
  // a flow along it when the place is watched, ready or live. A branch flows while any of its children does.
  const has = (el, ...c) => c.some((x) => el.classList.contains(x));
  const live = (el) => !has(el, "wire-dash", "st-bad", "st-warn") && has(el, "st-ok", "st-live");
  const link = (el, d, kidsFlow = false) => {
    const flow = live(el) || (kidsFlow && !has(el, "st-bad", "wire-dash"));
    return { d, k: [...el.classList].find((c) => c.startsWith("k-")) || "", dash: !flow && has(el, "wire-dash", "st-bad", "st-warn"), bad: has(el, "st-bad"), flow, i: +el.style.getPropertyValue("--i") || 0 };
  };
  const h = rel(hub), links = [];
  for (const br of map.querySelectorAll(".sm-br")) {
    const node = br.querySelector(":scope > .snode"); if (!node) continue;
    const n = rel(node), kids = [...br.querySelectorAll(":scope > .sm-kids .snode")];
    links.push(link(node, curve(h, n), kids.some(live)));
    for (const kid of kids) links.push(link(kid, curve(n, rel(kid))));
  }
  const sig = links.map((l) => `${l.d}${l.k}${l.dash}${l.bad}${l.flow}`).join("|");
  if (sig === svg.dataset.sig && svg.childElementCount) return;  // same picture: leave it, and its motion, alone
  svg.dataset.sig = sig;
  // While the map's nodes rise (their entrance not yet seen on screen), each wire draws out after its node.
  const draw = !moCalm() && !!map.querySelector(".snode.in, .sm-hub.in");
  const delay = (l) => 140 + Math.min(l.i, 12) * 35;
  const base = links.map((l) => `<path class="w ${l.k}${l.dash ? " dash" : ""}${l.bad ? " bad" : ""}${draw ? " draw" : ""}"${draw && !l.dash ? ' pathLength="1"' : ""} style="--d:${delay(l)}ms" d="${l.d}"/>`).join("");
  const flows = links.filter((l) => l.flow).map((l) => `<path class="wf ${l.k}" d="${l.d}"/>`).join("");
  svg.innerHTML = base + (flows ? `<g class="wfs${draw ? " draw" : ""}" style="--d:${Math.max(0, ...links.map(delay)) + 380}ms">${flows}</g>` : "");
}
let wireObs = null;
function watchWires() {
  drawLanes();  // lanes (Posting's week, the Monitor's week) are drawn at their measured width
  moAfter();  // motion bookkeeping for every graphic on the page: fresh copies, the picked node, off-screen pauses
  const maps = document.querySelectorAll("#home .smap, #app .smap, #home .wfg"); if (!maps.length) return;
  drawWires(); requestAnimationFrame(drawWires);
  if (!wireObs && "ResizeObserver" in window) wireObs = new ResizeObserver(() => drawWires());
  wireObs?.disconnect(); maps.forEach((m) => wireObs?.observe(m));
}
function nodeDetail(n) {
  if (!n) { foot.detailShown = null; return `<p class="meta sm-hint">${ico("info", "sm")} ${tr("sm.hint")}</p>`; }
  const k = AH_KIND[n.kind], g = foot.g || {}, fresh = foot.detailShown !== n.id;  // it slides in when opened, not on every repaint
  foot.detailShown = n.id;
  const fact = (label, val) => `<div><dt>${label}</dt><dd>${val}</dd></div>`;
  const busy = foot.job?.status === "running";
  const acts = [];
  if (n.src) {
    acts.push(`<button type="button" class="primary" data-srcwatch="1" ${busy ? "disabled" : ""}>${ico("refresh", "sm")}${tr("src.checknow")}</button>`);
    if (n.src.exists) acts.push(`<button type="button" data-srcbrowse="${esc(n.path)}">${ico("folder", "sm")}${tr("sm.browse")}</button>`);
    acts.push(`<button type="button" data-colcopy="${esc(n.path)}">${ico("copy", "sm")}${tr("sm.copypath")}</button>`);
    if (n.src.origin === "added") acts.push(`<button type="button" class="ghost danger" data-srcdel="${esc(n.path)}">${ico("x", "sm")}${tr("src.remove")}</button>`);
  } else if (n.id === "gphotos") {
    acts.push(g.connected ? `<button type="button" class="primary" id="gpAdd" ${foot.session ? "disabled" : ""}>${ico("image", "sm")}${tr("f.gphotos")}</button><a class="btn" href="/api/gphotos/connect" title="${esc(tr("f.gswitchtip"))}">${ico("user", "sm")}${tr("f.gswitch")}</a>`
      : `<a class="btn primary" href="${gpConnectHref(g)}">${ico("image", "sm")}${tr(g.app === false ? "f.gsetup" : "f.gconnect")}</a>`);
  } else if (n.id === "dropbox") {
    acts.push(`<button type="button" class="primary" data-addmore="people">${ico("wifi", "sm")}${tr(collect?.drop?.open ? "sm.showqr" : "col.open")}</button>`);
  } else if (n.id === "uploads") {
    acts.push(`<button type="button" class="primary" data-choosefiles="1">${ico("plus", "sm")}${tr("ah.choose")}</button>`);
  }
  return `<section class="sn-detail ${k.cls} ${fresh ? "in" : ""}" id="snDetail" aria-label="${esc(n.name)}" tabindex="-1">
    <div class="sn-head"><span class="sn-ico" aria-hidden="true">${ico(k.icon, "sm")}</span><div><b>${esc(n.name)}</b><span class="meta">${esc(n.sub)} · <span class="st-${n.status[0] || "plain"}"><i class="dot" aria-hidden="true"></i>${esc(n.status[1])}</span></span></div>
      <span class="grow"></span><button type="button" class="icon" data-snclose="1" aria-label="${esc(tr("src.close"))}" title="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>
    <dl class="sn-facts">
      ${n.path ? fact(tr("src.h.where"), `<span class="srcpath">${esc(n.path)}</span>`) : ""}
      ${n.account ? fact(tr("sm.account"), esc(maskMail(n.account))) : ""}
      ${n.src ? fact(tr("src.h.use"), `<span title="${esc(n.src.mode === "trusted" ? trR("src.trustedtip") : tr("src.gpstip"))}">${n.src.mode === "trusted" ? trR("src.trusted") : tr("src.gps")}</span>`) : ""}
      ${n.files != null ? fact(tr("sm.ondisk"), n.files.toLocaleString() + (n.fresh ? ` <b class="warn">+${n.fresh}</b>` : "")) : ""}
      ${n.clips != null ? fact(tr("sm.inlib"), n.clips.toLocaleString()) + fact(tr("sm.unusedh"), n.unused.toLocaleString()) : ""}
      ${n.src || n.checked ? fact(tr("sm.checkedh"), esc(ago(n.checked))) : ""}
    </dl>
    ${n.id === "gphotos" ? `<p class="meta">${tr("src.gpnote")}</p>` : ""}
    ${n.src && !n.src.exists ? `<p class="bad">${ico("alert", "sm")} ${tr("src.missing")}</p>` : ""}
    <div class="row wrap">${acts.join("")}</div></section>`;
}
document.addEventListener("click", (e) => {
  const nd = e.target.closest?.("[data-snode]");
  if (nd) { foot.node = foot.node === nd.dataset.snode ? null : nd.dataset.snode; renderHome(true); if (foot.node) requestAnimationFrame(() => { const d = document.getElementById("snDetail"); d?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }); }); return; }
  if (e.target.closest?.("[data-snclose]")) { const id = foot.node; foot.node = null; renderHome(true); document.querySelector(`#home [data-snode="${CSS.escape(id || "")}"]`)?.focus(); return; }
  const br = e.target.closest?.("[data-srcbrowse]");
  if (br) { foot.picker = { roots: null, list: null, report: null, job: null, mode: "gps" }; pickerGo(br.dataset.srcbrowse); return; }
  const more = e.target.closest?.("[data-addmore]");
  if (more) {
    foot.addMore = foot.addMore === more.dataset.addmore && more.closest(".ah-card") ? "" : more.dataset.addmore;
    renderHome(true);
    if (foot.addMore) requestAnimationFrame(() => document.getElementById("ahMore")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !e.target.closest?.("#snDetail")) return;
  e.preventDefault(); document.querySelector("#snDetail [data-snclose]")?.click();
});
/* The folder picker: any drive on this machine (Windows letters, macOS volumes, Linux mounts),
   down to one folder, then a report on what is inside before anything is added. */
async function pickerGo(path) {
  const p = foot.picker;
  p.loading = true; p.report = null; p.error = null; renderHome(true);
  try {
    if (!p.roots) p.roots = await api("/api/fs/roots");
    // Add footage › Cloud › Google Drive folder opens at the synced Drive that already holds a footage place, else the first one.
    if (!path && p.want === "cloud") {
      const clouds = p.roots.filter((x) => x.kind === "cloud"), held = (foot.src?.sources || []).map((x) => normPath(x.path));
      path = (clouds.find((c) => held.some((h) => h.startsWith(normPath(c.path) + "/"))) || clouds[0])?.path || null;
    }
    p.list = path ? await api("/api/fs/list?path=" + encodeURIComponent(path) + (p.hidden ? "&hidden=1" : "")) : null;
    if (p.list) p.typed = p.list.path;  // the path box follows the folder shown
  } catch (err) { p.error = err.message; }
  p.loading = false; renderHome(true);
}
/* BL-141: a folder the buttons cannot reach. A typed or pasted path (the server checks it exists and is a folder:
   GET /api/fs/list), and "Show hidden folders" (dot folders, AppData) for the list. */
document.addEventListener("submit", (e) => {
  if (e.target.id !== "fsType" || !foot.picker) return;
  e.preventDefault();
  const v = e.target.querySelector("input")?.value.trim();
  if (v) { foot.picker.typed = v; pickerGo(v); }
});
document.addEventListener("input", (e) => { if (e.target.id === "fsTyped" && foot.picker) foot.picker.typed = e.target.value; });
document.addEventListener("change", (e) => {
  if (e.target.id !== "fsHidden" || !foot.picker) return;
  foot.picker.hidden = e.target.checked;
  pickerGo(foot.picker.list?.path || null);
});
function pickerHtml() {
  const p = foot.picker;
  if (!p) return "";
  const l = p.list, r = p.report, job = p.job;
  const crumbsHtml = l ? l.path.split(/[\\/]/).filter(Boolean).map((part, i, all) => {
    const sepc = l.path.includes("\\") ? "\\" : "/";
    let to = all.slice(0, i + 1).join(sepc);
    if (/^[A-Za-z]:$/.test(to)) to += "\\"; else if (sepc === "/") to = "/" + to;
    return `<button class="pkc" data-fsgo="${esc(to)}">${esc(part)}</button>`;
  }).join(`<span class="sep">›</span>`) : "";
  return `<div class="lightbox picker" data-pclose="1"><div class="lb-card pk" role="dialog" aria-modal="true" aria-label="${esc(tr("src.pick"))}">
    <div class="pk-head"><h3>${ico("folder")} ${tr("src.pick")}</h3><span class="grow"></span><button data-pclose="1">${ico("x", "sm")}${tr("src.close")}</button></div>
    <div class="pk-body">
      <nav class="pk-roots">${(p.roots || []).map((x) => `<button class="${l && l.path === x.path ? "on" : ""}" data-fsgo="${esc(x.path)}" title="${esc(x.path)}">${ico(x.kind === "cloud" ? "image" : x.kind === "source" ? "pin" : x.kind === "home" ? "folder" : "layers", "sm")}<span>${esc(x.label)}</span></button>`).join("") || (p.loading ? "…" : "")}</nav>
      <section class="pk-main">
        <div class="pk-type"><form id="fsType" role="search"><label class="sr-only" for="fsTyped">${esc(tr("hm.pk.typed"))}</label>
          <input id="fsTyped" data-lyfocus="fstyped" type="text" spellcheck="false" autocomplete="off" value="${esc(p.typed || "")}" placeholder="${esc(tr("hm.pk.typedph"))}">
          <button type="submit">${esc(tr("hm.pk.go"))}</button></form>
          <label class="pk-hid"><input type="checkbox" id="fsHidden" ${p.hidden ? "checked" : ""}> ${esc(tr("hm.pk.hidden"))}</label></div>
        ${p.error ? `<p class="bad" role="alert">${ico("alert", "sm")} ${esc(p.error)}</p>` : ""}
        ${l ? `<div class="pk-crumbs">${l.parent ? `<button data-fsgo="${esc(l.parent)}" title="${esc(tr("src.up"))}">${ico("chev-u", "sm")}</button>` : ""}${crumbsHtml}</div>
          <div class="pk-here"><span class="meta">${tr("src.here", { n: l.media, d: l.dirs.length })}</span><span class="grow"></span>
            ${l.included ? `<span class="chip ok">${ico("check", "sm")}${tr("src.already", { s: esc(l.included.label) })}</span>` : ""}
            <button class="primary" id="fsDiscover" data-path="${esc(l.path)}" ${job?.status === "running" ? "disabled" : ""}>${ico("search", "sm")}${tr("src.look")}</button></div>
          ${job?.status === "running" ? `<div class="jobline s-scheduled">${ico("clock", "sm")} ${esc(job.label || "")}</div>` : ""}
          ${r ? reportHtml(r) : `<div class="pk-dirs">${l.dirs.map((d) => `<button ${d.hidden ? 'class="hid" ' : ""}data-fsgo="${esc(d.path)}" title="${esc(d.path)}">${ico("folder", "sm")}<span>${esc(d.name)}</span></button>`).join("") || `<p class="note">${tr("src.nodirs")}</p>`}</div>`}`
        : `<p class="note">${p.loading ? "…" : tr("src.start")}</p>`}
      </section>
    </div></div></div>`;
}
/* What is in a folder before it is added. Placed by GPS or Shot here is asked only when the project has a home place
   (BL-133: without one every file is used whatever the answer, "ranch (no home place)"); r.homePlace comes from
   py/studio/sources.py discover, and an older engine without it asks as before. */
function reportHtml(r) {
  const k = r.kinds || {}, mode = foot.picker.mode || "gps";
  const tile = (n, label) => `<div class="tile-stat"><b>${n ?? 0}</b><span>${label}</span></div>`;
  return `<div class="report">
    <div class="pk-stats">${tile(r.total, tr("src.r.total"))}${tile(k.photo, tr("f.photo"))}${tile(k.video, tr("f.video"))}${tile(k.raw, "RAW")}${tile(r.is360, "360°")}${tile(r.new, tr("src.r.new"))}</div>
    <p class="meta">${tr("src.r.line", { b: bytes(r.bytes), f: r.folders, a: r.already, o: r.outputs, g: r.graphics || 0 })}</p>
    <div class="row wrap">${Object.entries(r.formats || {}).map(([x, n]) => `<span class="chip">${esc(x)} ${n}</span>`).join(" ")}</div>
    <div class="row wrap">${Object.entries(r.years || {}).map(([y, n]) => `<span class="chip">${esc(y)} · ${n}</span>`).join(" ")}</div>
    ${(r.newest || []).length ? `<p class="meta">${tr("src.r.newest")}: ${r.newest.slice(0, 4).map((x) => esc(x.path.split(/[\\/]/).pop())).join(", ")}</p>` : ""}
    ${r.included ? `<p class="note">${ico("check", "sm")} ${tr("src.already", { s: esc(r.included.label) })}</p>` : `
    ${r.homePlace === false ? `<p class="meta">${ico("info", "sm")} ${esc(tr("hm.noplace"))}</p>` : `<fieldset class="modes"><legend>${tr("src.how")}</legend>
      <label><input type="radio" name="srcMode" value="gps" ${mode === "gps" ? "checked" : ""}> <b>${tr("src.gps")}</b> <span class="meta">${tr("src.gpstip")}</span></label>
      <label><input type="radio" name="srcMode" value="trusted" ${mode === "trusted" ? "checked" : ""}> <b>${trR("src.trusted")}</b> <span class="meta">${trR("src.trustedtip")}</span></label>
    </fieldset>`}
    <div class="row"><button data-fsgo="${esc(r.path)}">${ico("chev-l", "sm")}${tr("src.back")}</button><span class="grow"></span>
      <button class="primary" id="fsInclude" data-path="${esc(r.path)}" ${r.total ? "" : 'disabled aria-describedby="fsNone"'}>${ico("plus", "sm")}${tr("src.include", { n: r.total })}</button></div>
    ${r.total ? "" : `<p class="note" id="fsNone">${ico("info", "sm")} ${tr("src.nofiles")}</p>`}`}
  </div>`;
}
async function loadFootage() {
  foot.loading = true;
  const filters = { ranch: true, ...(foot.f === "video" || foot.f === "photo" ? { kind: foot.f } : {}), ...(foot.f === "unused" ? { unused: true } : {}), ...(foot.f === "360" ? { is360: true, ranch: false } : {}) };
  foot.loadedKey = JSON.stringify([foot.q, foot.f]);
  try { const r = await post("/api/library", { query: foot.q, filters, limit: foot.q ? 300 : 5000 }); foot.items = foot.f === "used" ? r.items.filter((i) => i.usedIn.length || i.inVlogs?.length) : foot.f === "new" ? r.items.filter((i) => tdFoot.base != null && i.id > tdFoot.base) : r.items; foot.error = null; foot.itemsOk = true; }
  // BL-138: no answer is no count ("…" until one comes, footKnown), and a studio that was away is asked again once back.
  catch (err) { foot.error = err.message; foot.itemsOk = false; if (err.offline) foot.away = true; }
  foot.loading = false;
  if (atHome() && page === "footage") renderHome(true);
}
/* Footage, organised: grouped by shoot folder (default), month, season, camera or first tag; a row of the
   most common tags filters in one click; each group shows 60 tiles until "Show all", and groups past the
   first six start folded, so the page stays fast with thousands of clips. */
const FOOT_GROUPS = ["event", "month", "season", "device", "tag", "none"];
const FOOT_GROUP_KEY = { event: "f.g.event", month: "f.g.month", season: "f.g.season", device: "f.g.device", tag: "f.g.tag", none: "f.g.none" };
foot.group = (() => { try { return localStorage.getItem("studio.footGroup") || "event"; } catch { return "event"; } })();
foot.tag = null; foot.more = new Set();
function shootLabel(ev) {
  const m = /^(\d{4})[-_]?(\d{2})?[-_]?(\d{2})?[-_ ]*(.*)$/.exec(String(ev || ""));
  if (!m) return { date: "", name: ev || "—" };
  const date = [m[1], m[2], m[3]].filter(Boolean).join("-");
  const name = (m[4] || "").replace(/^[-_ ]+/, "").replace(/_+/g, " · ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return { date, name: name || tr("f.shoot") };
}
// Google Photos picks land in imports\google-photos\<import day>: the folder is the day they came in, not a shoot.
const isGp = (i) => /[\\/]google-photos[\\/]/i.test(i?.path || "");
const SEASON_KEY = { spring: "f.s.spring", summer: "f.s.summer", autumn: "f.s.autumn", winter: "f.s.winter" };
/* A clip's tags as [key, label] in the page's language (studio.library: tags are the keys, tagsJa the same in
   Japanese). An older server sends tagsJa only: those stay as they are. */
const TAG_EN = { desk: "desk work", pizza: "pizza oven", fire: "campfire", sky: "blue sky", sign: "a sign", working: "people working",
  animal: "animals", bird: "birds", pet: "pets", water: "lakes and rivers", city: "city", market: "market", airport: "airport", boat: "boats", beach: "beach" };
const footTags = (i) => i.tags ? i.tags.map((k, n) => [k, lang === "ja" ? (i.tagsJa?.[n] || k) : (TAG_EN[k] || k)]) : (i.tagsJa || []).map((j) => [j, j]);
const tagLabel = (key) => { for (const i of foot.items) { const t = footTags(i).find(([k]) => k === key); if (t) return t[1]; } return key; };
function footKey(i) {
  switch (foot.group) {
    case "event": return i.event || "—";
    case "month": return (i.captured || "").slice(0, 7) || "—";
    case "season": return i.season || "—";
    case "device": return i.device || "unknown";
    case "tag": return footTags(i)[0]?.[1] || "—";
    default: return "";
  }
}
function footHead(k, list) {
  const used = list.filter((i) => i.usedIn.length).length, vids = list.filter((i) => i.kind === "video").length;
  const inVl = list.filter((i) => i.inVlogs?.length), inVlVids = inVl.filter((i) => i.kind === "video").length;
  const days = list.map((i) => (i.captured || "").slice(0, 10)).filter(Boolean).sort();
  let title = esc(k), icon = "folder";
  if (foot.group === "event") { icon = isGp(list[0]) ? "image" : "folder"; title = esc(isGp(list[0]) ? tr("f.gpimport") : shootLabel(k).name); }
  else if (foot.group === "month") { icon = "cal"; title = k === "—" ? tr("f.nodate") : esc(new Date(k + "-01T12:00").toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { year: "numeric", month: "long" })); }
  else if (foot.group === "season") { icon = SEASON_ICON[k] || "leaf"; title = SEASON_KEY[k] ? tr(SEASON_KEY[k]) : tr("f.nodate"); }
  else if (foot.group === "device") { icon = DEVICE_ICON[k] || "camera"; title = k === "unknown" ? tr("f.nocamera") : esc(k); }
  else if (foot.group === "tag") { icon = "tag"; }
  const range = days.length ? (days[0] === days.at(-1) ? days[0] : `${days[0]} – ${days.at(-1)}`) : "";
  return `<summary class="fhead">${ico(icon, "sm")}<b>${title}</b>
    <span class="mps">${range && foot.group !== "month" ? mp("cal", esc(range), "h-date") : ""}${mp("layers", tr("f.count", { n: list.length }))}${vids ? mp("film", vids) : ""}${list.length - vids ? mp("image", list.length - vids) : ""}${used || !inVl.length ? mp("check", tr("f.usedn", { n: used }), used ? "s-posted" : "") : ""}${inVl.length ? mp("play", tr("f.invlogn", { v: inVlVids, p: inVl.length - inVlVids }), "s-posted") : ""}</span></summary>`;
}
let anyUsedFor = null, anyUsedVal = false;  // "unused" on every tile says nothing when no clip is used yet
function anyUsed() { if (anyUsedFor !== foot.items) { anyUsedFor = foot.items; anyUsedVal = foot.items.some((x) => x.usedIn.length || x.inVlogs?.length); } return anyUsedVal; }
function ftile(i) {
  return `<button class="ftile ${i.usedIn.length ? "used" : ""}" data-fopen="${i.id}" title="${esc(i.file)}">
      <img src="${thumb(i.thumbs[0] || "", 320)}" alt="" loading="lazy" decoding="async">
      <span class="fk">${ico(i.kind === "video" ? "film" : "image", "sm")}${i.duration ? Math.round(i.duration) + "s" : ""}${i.is360 ? ` ${ico("globe", "sm")}360°` : ""}${i.device && i.device !== "unknown" ? ` ${ico(DEVICE_ICON[i.device] || "camera", "sm")}` : ""}</span>
      ${i.usedIn.length ? `<span class="fu">${tr("f.usedin", { n: i.usedIn.length })}</span>` : i.inVlogs?.length ? `<span class="fu vl">${tr("f.invlog", { n: i.inVlogs.join(", ") })}</span>` : anyUsed() ? `<span class="fu">${tr("f.never")}</span>` : ""}</button>`;
}
/* Connect Google Photos needs the project's own Google app first: without one the link opened a raw error page
   ({"error":"RuntimeError: no Google app yet..."}). Then it leads to the Google app card in Settings instead. */
/* A clip's place ("ranch (GPS)", "away (event)") is the ranch's word for its home place: another project reads
   "home place", and "ranch (no home place)" (a project with no home place uses every clip) says nothing, so it is hidden. */
function placeText(p) {
  if (!p || RANCH_WS) return p || "";
  if (p === "ranch (no home place)") return "";
  return p.replace(/^ranch/, tr("pl.home")).replace(/^away/, tr("pl.away"));
}
const gpConnectHref = (g) => (g?.app === false ? "#/keys/google" : "/api/gphotos/connect");
function footFacts(it) {
  return [
    it.captured ? mp("cal", esc(it.captured.slice(0, 10)), "h-date") : "",
    it.device && it.device !== "unknown" ? mp(DEVICE_ICON[it.device] || "camera", esc(it.device), "h-cam") : "",
    placeText(it.place) ? mp("pin", esc(placeText(it.place)), "h-place") : "",
    it.season ? mp(SEASON_ICON[it.season] || "leaf", SEASON_KEY[it.season] ? tr(SEASON_KEY[it.season]) : esc(it.season), "h-season") : "",
    it.tod ? mp(it.tod === "night" ? "moon" : "sun", esc(it.tod)) : "",
    it.width ? mp("image", `${it.width}×${it.height}`) : "",
    it.duration ? mp("clock", `${Math.round(it.duration)}s${it.fps ? ` · ${Math.round(it.fps)} fps` : ""}`) : "",
    it.is360 ? mp("globe", "360°") : "",
    it.faces ? mp("user", tr("f.faces", { n: it.faces }), "s-topost") : "",
    it.aesthetic != null ? mp("eye", tr("f.look", { n: it.aesthetic.toFixed(1) }), it.aesthetic >= 6 ? "s-posted" : "") : "",
    mp(isGp(it) ? "image" : "folder", esc(isGp(it) ? tr("f.gpimport") : shootLabel(it.event).name)),
  ].join("");
}
/* Footage health: is there enough fresh ranch footage, which camera it comes from, how often clips are reused, and
   what to film next with which camera. The numbers come from /api/footage/health (counted in the studio). */
document.addEventListener("click", (e) => { if (e.target.closest("[data-shootall]")) { foot.shootAll = !foot.shootAll; renderHome(true); } });
function loadFootHealth() {
  if (foot.h) return;
  foot.h = { loading: true };
  api("/api/footage/health").then((h) => { foot.h = h; renderHome(true); }).catch((err) => { foot.h = { error: err.message }; renderHome(true); });
}
const moreReels = () => { const m = foot.h?.more; return m ? (m.low === m.high ? String(m.low) : `${m.low}–${m.high}`) : ""; };
function footHealth() {
  const h = foot.h;
  if (!h || h.loading) return "";
  if (h.error) return `<p class="meta">${esc(h.error)}</p>`;
  const r = h.reuse || {}, total = (r.never || 0) + (r.once || 0) + (r.twice || 0) + (r["3+"] || 0) || 1;
  const low = h.reelsLeft < 4;
  const seg = (k, cls) => (r[k] ? `<i class="${cls}" style="flex:${r[k]}" title="${esc(tr("fh." + (k === "3+" ? "more" : k)))}: ${r[k]}"></i>` : "");
  const maxV = Math.max(1, ...h.cameras.map((c) => c.videos));
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "—");
  return `<section class="panel fh" aria-label="${esc(tr("fh.title"))}">
    <div class="fh-head"><h3>${ico("camera")} ${tr("fh.title")}</h3><span class="meta">${trA("fh.hint")}</span></div>
    <div class="fh-viz">${runwayHtml(h)}${placesHtml()}</div>
    <div class="fh-stats">
      <div class="fh-stat ${low ? "warn" : ""}"><b>${h.reelsLeft}</b><span>${tr(h.reelsLeft === 1 ? "fh.reel1" : "fh.reels")}</span><span class="meta">${trA("fh.fresh", { n: h.fresh, all: h.clips })}</span>${h.more ? `<span class="meta"><b>${tr("fh.moreest", { r: moreReels() })}</b> ${tr("fh.morewhy", { c: h.more.cap })}</span>` : ""}</div>
      <div class="fh-stat fh-reuse"><span>${tr("fh.reuse")}</span>
        <div class="fh-stack" role="img" aria-label="${esc(tr("fh.reuse"))}: ${r.never || 0} / ${r.once || 0} / ${r.twice || 0} / ${r["3+"] || 0}">${seg("never", "n0")}${seg("once", "n1")}${seg("twice", "n2")}${seg("3+", "n3")}</div>
        <span class="meta fh-key"><i class="n0"></i>${tr("fh.never")} ${r.never || 0} <i class="n1"></i>${tr("fh.once")} ${r.once || 0} <i class="n2"></i>${tr("fh.twice")} ${r.twice || 0} <i class="n3"></i>${tr("fh.more")} ${r["3+"] || 0}</span>
        ${(h.mostReused || []).length ? `<span class="meta">${tr("fh.top")}: ${h.mostReused.slice(0, 3).map((m) => `${esc(m.file)} ×${m.uses}`).join(" · ")}</span>` : ""}</div>
    </div>
    <h4>${tr("fh.cams")}</h4>
    <div class="fh-cams">${h.cameras.map((c) => `<div class="fh-cam"><b>${esc(c.camera)}</b>
      <div class="bar"><i style="transform:scaleX(${(c.videos / maxV).toFixed(3)})"></i></div>
      <span class="meta">${tr("fh.camline", { v: c.videos, p: c.photos, m: c.minutes, u: c.unused, r: c.recent })} · ${tr("fh.newest")} ${day(c.newest)}</span></div>`).join("")}</div>
    ${h.unknownCameras ? `<p class="meta">${trA("fh.unknown", { n: h.unknownCameras })} <button class="mini" data-fhcams="1">${ico("search", "sm")}${tr("fh.read")}</button></p>` : ""}
    <h4 id="fhShoot" tabindex="-1">${tr("fh.shoot")} · ${h.shoot.length}</h4>
    ${h.shoot.length ? `<div class="fh-shoot">${(foot.shootAll ? h.shoot : h.shoot.slice(0, 5)).map((t) => `<div class="fh-row"><b>${ico(THEME_ICON[t.theme] || "film", "sm")} ${esc(t.theme)}</b><span class="${t.left ? "" : "bad"}">${t.left ? tr("f.left", { n: t.left }) : tr("f.noneleft")}</span><span>${esc(mkNeed(t))}</span><span class="meta">${t.camera ? tr("fh.with", { c: esc(t.camera) }) : ""}</span></div>`).join("")}</div>${h.shoot.length > 5 ? `<button class="rg-more" data-shootall="1">${tr(foot.shootAll ? "grp.showless" : "fh.shootall", { n: h.shoot.length })}</button>` : ""}` : `<p class="meta">${tr("fh.allgood")}</p>`}
  </section>`;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-fhcams]"); if (!b) return;
  b.disabled = true;
  try { await post("/api/footage/cameras", {}); toast(`${ico("clock", "sm")} ${tr("fh.reading")}`, 6000); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
