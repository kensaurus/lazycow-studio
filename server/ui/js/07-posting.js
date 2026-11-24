/* ---------- Posting › Week (batch A): the default Posting view ----------
   The week's posts as lanes (laneSvg): one row per network, one column per day, today in yellow, holidays and events
   over their day. Drag a post the studio holds to another day (optimistic, with Undo); drag an approved reel from the
   tray onto an empty slot, or pick one and then a slot, and a confirm chip says what will happen before anything is
   booked (booking is outward facing). The booking itself is Plan posts' (runPlanner): the same routes, planFits rules
   and BOOK_AHEAD limits. Arrow keys move, Enter opens a post, Alt+←/→ moves the focused post a day. */
function lnSlotAt(net, day) {
  const dow = new Date(day + "T12:00Z").getUTCDay(), times = takenTimes(net), slots = slotsOf(net);
  const s = slots.find((x) => (x.dow < 0 || x.dow === dow) && slotFree(times, zonedIso(`${day}T${x.hm}`))) || slots.find((x) => slotFree(times, zonedIso(`${day}T${x.hm}`)));
  return s ? zonedIso(`${day}T${s.hm}`) : "";
}
/* Why a reel cannot be booked in that slot, in one sentence; "" when it can. */
function lnWhyNot(slug, net, day) {
  const r = overview.reels.find((x) => x.slug === slug), n = NET_NAME[net] || net;
  if (!r) return tr("ln.w.gone");
  if (!PLAN_NETS().includes(net)) return tr("ln.w.off", { n });
  if (!planReady(net)) return tr("ln.w.connect", { n });
  if (!planFits(r, net)) return net === "gbp" && r.faces > 0 ? tr("ln.w.faces") : postState(r.slug)[net] ? tr("ln.w.already", { n }) : net === "linkedin" ? tr("ln.w.long") : tr("ln.w.fit", { n });
  const today = wallOf(Date.now()).slice(0, 10);
  if (day < today) return tr("ln.w.past");
  const ahead = Math.round((Date.parse(day + "T12:00Z") - Date.parse(today + "T12:00Z")) / 864e5);
  if (planBooks(net) && ahead >= (BOOK_AHEAD[net] ?? 9999)) return tr("ln.w.ahead", { n, d: BOOK_AHEAD[net] });
  if (postsLog.some((p) => p.network === net && holdsSlot(p) && dayOf(p.at) === day)) return tr("ln.taken", { n });
  if (!lnSlotAt(net, day)) return tr("ln.soon");
  return "";
}
function lnKey() {
  return `<p class="lnkey">${["booked", "studio", "hand", "bad", "out", "gap"].map((s) => `<span><i class="k s-${s}" aria-hidden="true"></i>${esc(lnStateName(s))}</span>`).join("")}</p>`;
}
function lnWeekDays() {
  const today = wallOf(Date.now()).slice(0, 10);
  if (!LANES.start) LANES.start = today;
  if (LANES.focus?.day) {
    const f = LANES.focus.day, end = Array.from({ length: 6 }).reduce((d) => nextDay(d), LANES.start);
    if (f < LANES.start || f > end) LANES.start = f >= today && Date.parse(f) - Date.parse(today) < 7 * 864e5 ? today : f;
  }
  const days = [LANES.start];
  while (days.length < 7) days.push(nextDay(days[days.length - 1]));
  return { today, days };
}
function trayPool() { return overviewLoaded ? plannerPool(true) : []; }
function lanesWeekHtml() {
  if (HOLIDAYS === null) loadHolidays();
  const { today, days } = lnWeekDays();
  const d = laneData(days, { only: postNet });
  const evs = (ideasRes.events?.events || []).flatMap((e) => (e.dates?.length ? e.dates : [e.first]).filter(Boolean).map((x) => ({ d: x, t: e.title, url: e.url })));
  const model = { id: "lnWeek", mode: "chips", rows: d.rows, days, items: d.items, gaps: d.gaps, today, events: evs, counts: true, drop: true,
    label: tr("ln.label"), hint: LANES.pick ? tr("ln.picked", { s: reelName(LANES.pick) }) : tr("ln.hint"), corner: `<span>${esc(tr("ln.nets"))}</span>`,
    sig: JSON.stringify([lang, d.items.map((x) => [x.id, x.day, x.hm, x.state]), [...d.gaps], !!LANES.pending]),
    act: (kind, c) => lnOpen(c), move: (p, day) => { const why = lnMoveWhyNot(p, day); if (why) toast(`${ico("info", "sm")} ${esc(why)}`, 5000); else lnMoveTo(p.id, zonedIso(`${day}T${p.hm}`)); } };
  const L = lang === "ja" ? "ja-JP" : "en-GB", fmt = (x) => new Date(x + "T12:00:00Z").toLocaleDateString(L, { day: "numeric", month: "short", timeZone: "UTC" });
  const pool = trayPool(), shown = pool.slice(0, 24), live = d.items.filter((x) => x.state !== "out").length;
  const tray = pool.length ? `<aside class="tray" aria-label="${esc(tr("ln.tray"))}"><h4><span>${esc(tr("ln.tray"))}</span><b>${pool.length}</b></h4><p class="meta">${esc(tr("ln.trayhint"))}</p>
      <ul class="tray-list">${shown.map((r) => `<li><button type="button" class="tray-r${LANES.pick === r.slug ? " on" : ""}" draggable="true" data-trayslug="${esc(r.slug)}" aria-pressed="${LANES.pick === r.slug}" title="${esc(reelName(r.slug))}">
        <span class="tr-th" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></span><span class="tr-n" lang="ja">${esc(reelName(r.slug))}</span></button></li>`).join("")}</ul>
      ${pool.length > shown.length ? `<button type="button" class="linkbtn tray-more" data-wnplan="1">${esc(tr("ln.traymore", { n: pool.length - shown.length }))}</button>` : ""}</aside>` : "";
  return `<div class="lnwrap${tray ? " withtray" : ""}">
    <div class="lnmain">
      <div class="calnav lnnav"><button class="icon" data-lnweek="-7" aria-label="${esc(tr("ln.prev"))}" title="${esc(tr("ln.prev"))}">${ico("chev-l", "sm")}</button>
        <h3>${esc(`${fmt(days[0])} – ${fmt(days[6])}`)}</h3><button class="icon" data-lnweek="7" aria-label="${esc(tr("ln.next"))}" title="${esc(tr("ln.next"))}">${ico("chev-r", "sm")}</button>
        <button data-lnweek="0" ${days[0] === today ? "disabled" : ""}>${tr("cal.today")}</button><span class="meta">${tr("ln.count", { n: live })}</span></div>
      ${d.rows.length ? laneSvg(model).replace(`<p class="ln-read`, `${lnConfirmHtml()}<p class="ln-read`) : `<p class="note">${tr("posting.none")}</p>`}
      ${lnKey().replace(/<\/p>$/, `<span title="${esc(tr("tc.testwhy", { h: "19:00" }))}"><span class="tc-test">${esc(tr("tc.test"))}</span></span></p>`)}
    </div>${tray}</div>`;
}
function lnOpen(c) {
  if (c.p) return openDrawer(c.p.slug, c.p.row);
  if (LANES.pick) {
    const why = lnWhyNot(LANES.pick, c.net, c.day);
    if (why) { toast(`${ico("info", "sm")} ${esc(why)}`, 5000); lnRead(c.m, why); return; }
    return lnPropose(LANES.pick, c.net, c.day);
  }
  lnRead(c.m, tr("ln.emptyhint", { d: postDayLabel(c.day), n: NET_NAME[c.net] || c.net }));
}
function lnPropose(slug, net, day) {
  LANES.pending = { slug, net, day, at: lnSlotAt(net, day) }; LANES.pick = null;
  const m = LANES.m.lnWeek; if (m) LANES.cur.lnWeek = { r: Math.max(0, m.rows.findIndex((x) => x.key === net)), d: Math.max(0, m.days.indexOf(day)) };
  renderHome(true);
  requestAnimationFrame(() => document.querySelector(".lnconfirm [data-lnbook]")?.focus({ preventScroll: true }));
}
function lnConfirmHtml() {
  const x = LANES.pending; if (!x) return "";
  const r = overview.reels.find((z) => z.slug === x.slug), n = NET_NAME[x.net] || x.net;
  const how = x.net === "youtube" ? tr("ln.how.yt") : x.net in CHROME_NETS ? tr("ln.how.chrome", { n }) : STUDIO_NETS.includes(x.net) ? tr("ln.how.studio") : tr("ln.how.hand");
  const hook = r?.hookText, DAY = 864e5, rep = hook && postsLog.some((p) => p.network === x.net && holdsSlot(p) && p.at && overview.reels.find((z) => z.slug === p.slug)?.hookText === hook && Math.abs(new Date(p.at) - new Date(x.at)) <= 14 * DAY);
  return `<div class="lnconfirm" role="dialog" aria-label="${esc(tr("ln.ask", { s: reelName(x.slug) }))}">
    <span class="lc-th" style="background-image:url('${r?.hook ? thumb(r.hook, 120) : ""}')" aria-hidden="true"></span>
    <div class="lc-txt"><b>${esc(tr("ln.ask", { s: reelName(x.slug) }))}</b><span class="meta">${netLogo(chOf(x.net), "sm")} ${esc(n)} · ${esc(whenText(x.at))}</span><span class="meta">${esc(how)}</span>
      ${rep ? `<span class="meta warnline">${ico("alert", "sm")} ${esc(tr("ln.repeat", { n }))}</span>` : ""}</div>
    <div class="lc-acts"><button type="button" class="primary" data-lnbook="1" ${x.busy ? "disabled" : ""}>${esc(x.busy ? tr("ln.booking") : tr("ln.book"))}</button><button type="button" data-lncancel="1">${esc(tr("ln.cancel"))}</button></div></div>`;
}
/* Book one reel in one slot, the way Plan posts books each of its rows. */
async function lnBook() {
  const x = LANES.pending; if (!x || x.busy) return;
  x.busy = true; renderHome(true);
  const n = NET_NAME[x.net] || x.net;
  try {
    if (x.net === "youtube") {
      await post("/api/youtube/upload", { slug: x.slug, at: x.at, privacy: "private" });
      toast(`${ico("clock", "sm")} ${esc(tr("ln.ytup", { s: reelName(x.slug) }))}`, 7000);
    } else {
      if (planBooks(x.net)) {  // older reels may not have this network's files yet
        const d = await api("/api/reel?slug=" + encodeURIComponent(x.slug));
        if (!d.channels?.some((c) => c.name === chOf(x.net) && c.files?.some((name) => /\.mp4$/i.test(name)))) await post("/api/package", { slug: x.slug, channels: [chOf(x.net)] });
      }
      if (x.net in CHROME_NETS) await post("/api/helper/schedule", { slug: x.slug, network: x.net, at: x.at });
      else if (STUDIO_NETS.includes(x.net)) await post("/api/publish", { slug: x.slug, network: x.net, at: x.at });
      else await post("/api/posts/plan", { slug: x.slug, network: x.net, at: x.at });
      toast(`${ico("check", "sm")} ${esc(tr("ln.booked", { s: reelName(x.slug), n, t: whenText(x.at) }))}`, 6000);
    }
    LANES.pending = null;
  } catch (err) { x.busy = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
  await loadPosting();
}
/* Move a post the studio holds to another time: on the page at once, then on the server; Undo moves it back. */
async function lnMoveTo(id, at, undo = false) {
  const row = postsLog.find((p) => p.id === id); if (!row) return;
  const was = row.at;
  row.at = at; renderHome(true);
  try {
    await post("/api/posts/move", { id, at });
    toast(undo ? `${ico("check", "sm")} ${esc(tr("ln.undone"))}` : `${ico("check", "sm")} ${esc(tr("mv.done", { s: reelName(row.slug), n: NET_NAME[row.network] || row.network, t: whenText(at) }))} <button type="button" class="linkbtn" data-lnundo="${id}" data-lnat="${esc(was)}">${esc(tr("ln.undo"))}</button>`, undo ? 3000 : 9000);
  } catch (err) { row.at = was; renderHome(true); toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  loadPosting();
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest?.("[data-lnweek], [data-trayslug], [data-lnbook], [data-lncancel], [data-lnundo]");
  if (!t) return;
  if (t.dataset.lnweek !== undefined) {
    const step = +t.dataset.lnweek, today = wallOf(Date.now()).slice(0, 10);
    LANES.start = !step ? today : wallOf(Date.parse((LANES.start || today) + "T12:00Z") + step * 864e5, "UTC").slice(0, 10);
    renderHome(true); return;
  }
  if (t.dataset.trayslug) { LANES.pick = LANES.pick === t.dataset.trayslug ? null : t.dataset.trayslug; LANES.pending = null; renderHome(true); if (LANES.pick) document.querySelector("#lnWeek .ln-svg")?.focus({ preventScroll: true }); return; }
  if (t.dataset.lnbook) { await lnBook(); return; }
  if (t.dataset.lncancel) { LANES.pending = null; renderHome(true); return; }
  if (t.dataset.lnundo) { t.disabled = true; await lnMoveTo(+t.dataset.lnundo, t.dataset.lnat, true); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (LANES.pending || LANES.pick) && page === "posting") { LANES.pending = null; LANES.pick = null; renderHome(true); } });
/* The tray's reels, dragged onto the lanes (a pick and a click does the same, for touch and keyboards). */
document.addEventListener("dragstart", (e) => {
  const t = e.target.closest?.("[data-trayslug]"); if (!t) return;
  LANES.dragSlug = t.dataset.trayslug; LANES.pending = null;
  e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", t.dataset.trayslug);
});
document.addEventListener("dragover", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg || !LANES.dragSlug) return;
  const c = lnCellAt(svg, e.clientX, e.clientY); if (!c || !c.m.drop) return;
  const why = c.p ? tr("ln.taken", { n: NET_NAME[c.net] || c.net }) : lnWhyNot(LANES.dragSlug, c.net, c.day);
  lnShowDrop(svg, c, !why);
  lnRead(c.m, why || tr("ln.dropok", { s: reelName(LANES.dragSlug), n: NET_NAME[c.net] || c.net, d: postDayLabel(c.day), t: wallOf(new Date(lnSlotAt(c.net, c.day)).getTime()).slice(11, 16) }));
  if (!why) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
});
document.addEventListener("drop", (e) => {
  const svg = e.target.closest?.(".ln-svg"); if (!svg || !LANES.dragSlug) return;
  e.preventDefault();
  const c = lnCellAt(svg, e.clientX, e.clientY), slug = LANES.dragSlug;
  LANES.dragSlug = null; lnShowDrop(svg, null);
  if (c && !c.p && !lnWhyNot(slug, c.net, c.day)) lnPropose(slug, c.net, c.day);
});
document.addEventListener("dragend", () => { if (!LANES.dragSlug) return; LANES.dragSlug = null; document.querySelectorAll(".ln-svg").forEach((s) => lnShowDrop(s, null)); });
function renderPosting() {
  if (!postsLoaded || !overviewLoaded) {
    $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.posting")])}</div>${loadingHtml(tr("nav.posting"))}`;
    return;
  }
  // Same list and counts as Reels (one source of truth); a reel still being made shows a row with no squares yet.
  const R = overview.reels.filter((r) => !r.house);
  if (!R.length && !postsLog.some((x) => x.network !== "all")) {
    // Nothing made, nothing posted: one sentence and the way forward, not an empty calendar.
    $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.posting")])}</div>
      <div class="empty mascot">${kenji("point")}<b>${tr("pe.none")}</b><span>${tr("pe.hint")}</span>
        <span class="row wrap"><button class="primary" data-openmaker="1">${ico("clapper", "sm")}${tr("act.make")}</button><a class="btn" href="#/videos">${ico("play", "sm")}${tr("vid.see")}</a><a class="btn" href="#/accounts">${ico("user", "sm")}${tr("pe.accounts")}</a></span></div>`;
    return;
  }
  if (!SEGMENTS.includes(homeFilter)) homeFilter = "all";
  if (postSeen !== homeFilter) { postSeen = homeFilter; postPage = 0; }
  if (!["schedule", "reels", "sent"].includes(postTab)) postTab = "schedule";
  const counts = stateCounts(R);
  const upcoming = bookedAhead();
  const sent = recentPosts(Infinity);
  const tabs = [["lanes", "", tr("pv.week")], ["cal", "", tr("pv.cal")], ["days", "", tr("pv.list", { n: upcoming.length })], ["reels", "", tr("posting.t.reels", { n: R.length })], ["sent", "", tr("posting.t.sent", { n: sent.length })]];
  const SCHED_VIEWS = ["lanes", "cal", "days"], tabOn = (k) => (SCHED_VIEWS.includes(k) ? postTab === "schedule" && postView === k : postTab === k);
  let body = "";
  if (postTab === "schedule") {
    const list = upcoming.filter((p) => postNet === "all" || p.network === postNet);
    const repeats = repeatMap(upcoming);
    const days = new Map();
    for (const p of list) { const d = dayOf(p.at); if (!days.has(d)) days.set(d, []); days.get(d).push(p); }
    const dayCard = ([d, ps]) => `<section class="pday"><h4><span>${esc(postDayLabel(d))}</span><span class="count">${ps.length}</span></h4>${ps.map((p) => postLine(p, false, repeats.get(p.id), true)).join("")}</section>`;
    const all = [...days.entries()], near = all.slice(0, 7), later = all.slice(7);
    const nRep = list.filter((p) => repeats.has(p.id)).length;
    // One panel instead of five boxes: what to look at before these go out, then how posting runs by itself.
    const checks = [autoHtml("attention"), versionsLineHtml(), staleHtml(), levelsHtml(),
      nRep ? `<div class="notice warn">${ico("alert", "sm")}<span>${nRep === 1 ? tr("w.repeatsum1") : tr("w.repeatsum", { n: nRep })}</span><a class="btn" href="#/words">${tr("w.fix")}</a></div>` : ""].filter((x) => x && x.trim());
    // What to look at is in "What needs you" under the header now; the panels it points to follow the schedule.
    body = `${postNetBar(upcoming)}
      ${postView === "lanes" ? lanesWeekHtml() : postView === "cal" ? calHtml(list, repeats)
      : tcListHtml(all, dayCard, near, later)}
      <div class="pstatus" data-anchor="checks">${checks.join("")}${autoHtml()}</div>${healthStrip()}`;
  } else if (postTab === "reels") {
    // What goes out next is on top: reels with a post coming up, soonest first; then reels waiting for a
    // plan (approved before unreviewed, newest first); then what is out, shelved or still being made.
    const nextAt = (r) => Object.values(postState(r.slug)).filter((p) => p.status !== "posted" && p.at).map((p) => new Date(p.at).getTime()).sort((a, b) => a - b)[0] ?? Infinity;
    const rank = (r) => ({ scheduled: 0, topost: 1, posted: 2, skip: 3, making: 4, draft: 5, house: 6 }[reelState(r)] ?? 7);
    const q = postQ.toLowerCase();
    const rows = R.filter((r) => (homeFilter === "all" || reelState(r) === homeFilter) && (!q || `${r.slug} ${r.title || ""} ${r.theme || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || nextAt(a) - nextAt(b) || (b.status === "approved") - (a.status === "approved") || (b.updated || 0) - (a.updated || 0) || a.slug.localeCompare(b.slug));
    // Track C (24 Nov): 12 reels a page (20 ran 2.2 screens); the soonest to go out come first, so page 1 is what matters.
    const RP = 12, pager = postPager(rows.length, RP);
    const pageRows = rows.slice(postPage * RP, postPage * RP + RP);
    // only the networks in use: a network turned off with nothing on it was a faded column nobody could explain
    const MNETS = POST_NETS.filter((n) => !chanOf(n)?.off || pageRows.some((r) => postState(r.slug)[n]));
    body = `<div class="row ptools">${segBar(counts)}<div class="search" style="width:min(280px,100%);margin:0">${ico("search", "sm")}<input id="postQ" value="${esc(postQ)}" placeholder="${esc(tr("posting.find"))}" aria-label="${esc(tr("posting.find"))}"></div></div>
      <p class="meta">${ico("info", "sm")} ${tr("posting.reelsvsposts")}</p>
      <details class="pfold plegend"><summary>${tr("posting.legend")}</summary><p class="note">${tr("posting.hint")}</p></details>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead><tr><th>${tr("posting.reel")}</th><th>${tr("posting.state")}</th>${MNETS.map((n) => `<th title="${esc(NET_NAME[n] || n)}">${netLogo(n, "sm")}</th>`).join("")}</tr></thead>
          <tbody>${pageRows.map((r) => {
            const s = reelState(r), st = postState(r.slug), skipped = s === "skip";
            const twins = rows.filter((x) => (x.title || x.slug) === (r.title || r.slug)), k = twins.indexOf(r) + 1;
            const why = `${kTile(KINDS[kindOf(r)], "xs")}<span title="${esc(r.slug)}">${r.look ? `${esc(tr("rv.lookname", { look: nameOf("looks", r.look) }))}` : ""}${twins.length > 1 ? ` · <b class="ver">${esc(tr("posting.ver", { k, n: twins.length }))}</b>` : ""}${r.status === "approved" ? ` · <span class="okline">${ico("check", "sm")}${esc(tr("posting.approved"))}</span>` : r.status === "rendered" && !r.house ? ` · <span class="warnline">${ico("eye", "sm")}${esc(tr("st.review"))}</span>` : ""}</span>`;
            if (s === "making" || s === "draft") return `<tr class="st-${s}"><td><span class="mrow"><span class="mthumb"></span><span><b class="clamp">${esc(r.title || r.slug)}</b><span class="meta kindline">${why}</span></span></span></td>
              <td><span class="spill s-${s} inline">${tr(STATE_KEY[s])}</span></td><td colspan="${MNETS.length}" class="meta" style="text-align:left">${esc(r.job?.status === "queued" ? tr("job.queued", { n: r.job.position }) : r.job?.label || "")}${r.job?.eta ? ` · ${mins(r.job.eta)}` : ""}</td></tr>`;
            return `<tr class="st-${s}"><td><a class="mrow" href="#/reel/${r.slug}"><span class="mthumb" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></span><span><b class="clamp">${esc(r.title || r.slug)}</b><span class="meta kindline">${why}</span></span></a></td>
              <td><span class="spill s-${s} inline">${esc(stateLine(r, s))}</span></td>
              ${MNETS.map((n) => { const p = st[n]; const off = (chanOf(n)?.off || notForLong(r.slug, n)) && !p; const cls = (p ? p.status : skipped ? "skip" : "none") + (off ? " off" : "");
                return `<td><button class="cell ${cls}" data-net="${r.slug}" data-ch="${n}" ${off ? "disabled" : ""} aria-label="${esc(n)}" title="${esc(`${n}: ${p ? tr(p.status === "posted" ? "st.posted" : p.status === "scheduled" ? "st.scheduled" : "st.reminder") + (p.at ? " " + whenText(p.at) : "") : tr(skipped ? "st.skip" : "st.notyet")}`)}">${p?.status === "posted" ? ico("check", "sm") : p?.status === "scheduled" ? ico("cal", "sm") : p?.status === "planned" ? ico("clock", "sm") : ""}</button></td>`; }).join("")}</tr>`;
          }).join("") || `<tr><td colspan="${MNETS.length + 2}" class="note">${overview.reels.some((r) => !r.house) ? tr("home.empty") : `${tr("pl.noreels")} <a href="#/reels">${tr("act.make")} ›</a>`}</td></tr>`}</tbody>
        </table>
      </div>${pager}`;
  } else {
    const list = sent.filter((p) => postNet === "all" || p.network === postNet);
    const pager = postPager(list.length);
    body = `${postNetBar(sent)}${list.length ? `<div class="psent">${list.slice(postPage * POST_PAGE, postPage * POST_PAGE + POST_PAGE).map(recentLine).join("")}</div>${pager}` : `<div class="iempty"><p>${tr("posting.norecent")} ${tr("posting.norecenthint")}</p></div>`}`;
  }
  $("#home").innerHTML = `
    <div class="pagehead">${crumbs([tr("nav.posting")])}<span class="meta">${tr("posting.sum", { n: upcoming.length })}</span><span class="grow"></span>
      ${counts.topost ? `<button class="primary" id="openPlanner">${ico("cal", "sm")}${tr("plan.open")}</button>`
        : !overview.reels.some((r) => !r.house) ? `<a class="btn" href="#/videos">${ico("play", "sm")}${tr("posting.trip")}</a>` : `<span class="meta">${tr("plan.noneyet")}</span>`}</div>
    <nav class="tabs posttabs" role="tablist">${tabs.map(([k, , label]) => `<a role="tab" aria-selected="${tabOn(k)}" class="${tabOn(k) ? "on" : ""}" href="#/posting/${SCHED_VIEWS.includes(k) ? tcViewSlug(k) : k}" ${SCHED_VIEWS.includes(k) ? `data-pview="${k}"` : ""}>${esc(label)}</a>`).join("")}
      <span class="grow"></span>${ftShown("versions") ? `<a class="sidelink" href="#/versions">${tr("sub.versions")}${verView?.ready?.length ? ` <b class="subn">${verView.ready.length}</b>` : ""} ›</a>` : ""}${ftShown("youtube") ? `<a class="sidelink" href="#/youtube">${tr("sub.youtube")} ›</a>` : ""}${ftShown("ideas") ? `<a class="sidelink" href="#/ideas/ideas">${tr("sub.ideas")} ›</a>` : ""}</nav>
    ${body}
    ${planner ? plannerHtml() : ""}`;
  const qi = $("#postQ"); if (qi && postFocus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}
document.addEventListener("input", (e) => {
  if (e.target.id !== "postQ") return;
  clearTimeout(postTimer);
  postTimer = setTimeout(() => { postQ = e.target.value; postPage = 0; postFocus = true; renderHome(true); postFocus = false; }, 250);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ppage]"); if (!b || b.disabled) return;
  postPage = Math.max(0, Number(b.dataset.ppage)); renderHome(true); $("#home").scrollIntoView({ block: "start" });
});
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("hfold")) hsOpen = e.target.open; }, true);

/* A metadata pill: icon + short text, tinted by meaning (s-posted, s-scheduled, s-topost, bad, or a hue class). */
const mp = (icon, text, tone = "") => `<span class="mp ${tone}">${icon ? ico(icon, "sm") : ""}${text}</span>`;
/* What went out, newest first: one click to the live post, or to the panel to add its link. */
function recentPosts(limit = 10) {
  return postsLog.filter((p) => p.network !== "all" && !isHistory(p) && (postState(p.slug)[p.network]?.status === "posted"))
    .sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, limit);
}
function recentLine(p) {
  const r = overview.reels.find((x) => x.slug === p.slug);
  return `<div class="recent-row">
    <span class="mthumb sm" style="background-image:url('${r?.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></span>${netLogo(chOf(p.network), "sm")}
    <span class="grow" style="min-width:0"><b class="clamp" lang="ja" title="${esc(p.slug)}">${esc(reelName(p.slug))}</b><span class="meta">${p.at ? esc(whenText(p.at)) : ""}${p.seen_at ? ` · ${ico("check", "sm")}${tr("pd.seen", { t: esc(whenText(p.seen_at)) })}` : p.status === "scheduled" ? ` · ${tr("pd.unseen")}` : ""}</span></span>
    ${p.url ? `<a class="chip ok" href="${escUrl(p.url)}" target="_blank" rel="noopener">${ico("eye", "sm")}${tr("pd.view")} ↗</a>`
      : `<button class="chip" data-net="${esc(p.slug)}" data-ch="${esc(p.network)}">${ico("plus", "sm")}${tr("posting.addlink")}</button>`}
  </div>`;
}

/* ---------- Post panel: one reel × one network, opened from its square on the Posting page ----------
   Everything to get that one post out without leaving the page: the file, the text, the network's own
   upload page, then "Mark posted" (or a reminder, or a real YouTube schedule). "Next" walks to the next
   reel that network has not had yet, so a week of posts is a few clicks per network. */
let drawer = null;
const drawerCache = new Map();
const chanOf = (net) => channelsSpec?.channels?.find((c) => c.id === chOf(net));
/* A network's tier (BL-116): the server says it (channelsView); an older server does not, so the same default as
   server/uiprefs.mjs tierOf. */
const netTier = (net) => { const t = chanOf(net)?.tier; return t === "common" || t === "more" ? t : ["youtube-shorts", "tiktok", "instagram", "facebook", "x", "linkedin"].includes(chOf(net)) ? "common" : "more"; };
const isLong = (slug) => /-long(-\d+)?$/.test(slug || "");
const notForLong = (slug, net) => isLong(slug) && chanOf(net)?.variant !== "b-explainer";
function dayOf(iso) { return iso ? wallOf(new Date(iso).getTime()).slice(0, 10) : ""; }
/* Each network's posting times, in the audience's time, best first: the playbook's "bestJst", else channels.json
   "postTimesJst" ("Sun 19:00" = weekly), else "postAtJst", else 19:00. A network gets at most one post a day
   (the owner's rule): the later times are only used when the first one is already past. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function slotsOf(net) {
  const spec = chanOf(net), list = pbOf(net)?.times?.bestJst || spec?.postTimesJst || (spec?.postAtJst ? [spec.postAtJst] : ["19:00"]);
  return list.map((s) => /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)?\s*(\d{1,2}):(\d{2})$/.exec(s)).filter(Boolean)
    .map((m) => ({ dow: m[1] ? WEEKDAYS.indexOf(m[1]) : -1, hm: `${m[2].padStart(2, "0")}:${m[3]}` }));
}
/* A slot is taken when that network already has something within 45 minutes of it. */
const holdsSlot = (p) => p.at && !["skipped", "failed", "missing", "replaced"].includes(p.status);
function takenTimes(net) { return postsLog.filter((p) => p.network === net && holdsSlot(p)).map((p) => new Date(p.at).getTime()); }
const slotFree = (times, iso) => { const t = new Date(iso).getTime(); return t > Date.now() + 15 * 60e3 && !times.some((x) => Math.abs(x - t) < 45 * 60e3); };
const nextDay = (d) => wallOf(Date.parse(d + "T12:00Z") + 86400000, "UTC").slice(0, 10);
function freeSlot(net) {
  const times = takenTimes(net), slots = slotsOf(net);
  const busyDays = new Set(postsLog.filter((p) => p.network === net && holdsSlot(p)).map((p) => dayOf(p.at)));
  let day = wallOf(Date.now()).slice(0, 10);
  for (let i = 0; i < 400; i++, day = nextDay(day)) {
    if (busyDays.has(day)) continue;  // one post per network per day
    const dow = new Date(day + "T12:00Z").getUTCDay();
    for (const s of slots) if ((s.dow < 0 || s.dow === dow) && slotFree(times, zonedIso(`${day}T${s.hm}`))) return `${day}T${s.hm}`;
  }
  return nextSlot(19);
}
async function openDrawer(slug, net) {
  drawer = { slug, net, data: drawerCache.get(slug) || null, error: null };
  paintDrawer();
  if (drawer.data) return;
  try {
    const d = await api("/api/reel?slug=" + encodeURIComponent(slug));
    drawerCache.set(slug, d);
    if (drawer?.slug === slug) { drawer.data = d; paintDrawer(); }
  } catch (err) { if (drawer?.slug === slug) { drawer.error = err.message; paintDrawer(); } }
}
function closeDrawer() { drawer = null; paintDrawer(); }
/* Reels in Posting order that this network has not had (nothing planned, scheduled or posted). */
function openFor(net) {
  return overview.reels.filter((r) => !r.house && r.rendered && !busyJob(r) && !isSkipped(r.slug) && !postState(r.slug)[net] && !notForLong(r.slug, net))
    .sort((a, b) => STATE_ORDER.indexOf(reelState(a)) - STATE_ORDER.indexOf(reelState(b)) || a.slug.localeCompare(b.slug));
}
/* A post as the network will show it: the account, when it goes out, the cover and the text (hashtags and links
   picked out), with its length. Only the limit the studio itself enforces is checked (Bluesky, 300). */
function postPreview(slug, net, text, conn, p) {
  const r = overview.reels.find((x) => x.slug === slug);
  const cover = r?.hook ? thumb(r.hook, 240) + "&v=" + (r.updated || 0) : "";
  const body = esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<u>${u}</u>`).replace(/(^|\s)(#[^\s#<]+)/gu, "$1<b class=\"pvtag\">$2</b>");
  const n = [...text].length, cap = net === "bluesky" ? 300 : 0;
  return `<figure class="pvcard" aria-label="${esc(tr("pv.as", { n: NET_NAME[net] || net }))}">
    <figcaption class="pvhead">${netLogo(chOf(net), "sm")}<b>${esc(conn?.account || NET_NAME[net] || net)}</b><span class="meta">${p?.at && p.status !== "posted" ? esc(whenText(p.at)) : ""}</span></figcaption>
    <div class="pvbody">${cover ? `<span class="pvthumb" style="background-image:url('${cover}')" aria-hidden="true"></span>` : ""}<p class="pvtext" lang="ja">${body || `<span class="meta">${tr("pv.empty")}</span>`}</p></div>
    <div class="pvfoot meta"><span class="${cap && n > cap ? "bad" : ""}">${cap ? tr("pv.countcap", { n, c: cap }) : tr("pd.chars", { n })}</span></div></figure>`;
}
function paintDrawer() {
  let host = $("#drawer");
  if (!host) { host = document.createElement("div"); host.id = "drawer"; document.body.appendChild(host); }
  if (!drawer) { host.innerHTML = ""; return; }
  const { slug, net, data: d, error } = drawer;
  const r = overview.reels.find((x) => x.slug === slug) || { slug };
  const p = postState(slug)[net], cid = chOf(net), spec = chanOf(net), ch = d?.channels?.find((c) => c.name === cid);
  const v = ch?.videos?.[0], upload = spec?.upload || "";
  const pill = mp;
  const status = p ? pill(p.status === "posted" ? "check" : p.status === "scheduled" ? "cal" : "clock", `${tr(p.status === "posted" ? "st.posted" : p.status === "scheduled" ? "st.scheduled" : "st.reminder")}${p.at ? " " + esc(whenText(p.at)) : ""}`, `s-${p.status === "planned" ? "topost" : p.status}`)
    : pill("clock", tr("st.notyet"));
  const rest = openFor(net).filter((x) => x.slug !== slug);
  /* Out (or booked) already: lead with the live post, one click to see it; the files fold away below. */
  const live = p && (p.status === "posted" || p.status === "scheduled");
  const ytId = /(?:shorts\/|v=|youtu\.be\/)([\w-]{11})/.exec(p?.url || "")?.[1];
  const liveHtml = !live ? "" : `<div class="dlive s-${p.status}">
      <div class="row">${ico(p.status === "posted" ? "check" : "cal", "sm")}<b>${tr(p.status === "posted" ? "pd.livetitle" : "pd.bookedtitle", { n: esc(NET_NAME[net] || net) })}</b><span class="meta">${p.at ? esc(whenText(p.at)) : ""}</span></div>
      ${p.url ? `<a class="dlive-link" href="${escUrl(p.url)}" target="_blank" rel="noopener">${ytId ? `<img src="https://i.ytimg.com/vi/${esc(ytId)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">` : netLogo(cid)}<span><b>${tr("pd.view")} ↗</b><span class="meta clamp">${esc(p.url.replace(/^https:\/\/(www\.)?/, ""))}</span></span></a>` : `<p class="note">${tr("pd.nolink")}</p>`}
      <div class="row"><input id="dFix" type="url" value="${esc(p.url || "")}" placeholder="https://…" aria-label="${esc(tr("pd.link"))}"><button data-dlink="${p.id}">${ico("check", "sm")}${tr("pd.savelink")}</button></div>
    </div>`;
  /* Posting from the studio: a connected network posts (or schedules) with one button; a network the studio
     can connect to but is not connected says so; any other network gets a one-click hand-off. */
  const conn = connections[cid], sending = publishing.has(`post-${slug}-${net}`);
  const pubHtml = !ch || live ? "" : conn?.connected ? `<div class="dpub">
      <div class="row">${ico("send", "sm")}<b>${tr("pub.title", { n: esc(NET_NAME[net] || net) })}</b><span class="meta">${esc(conn.account || "")}</span></div>
      <div class="row"><button class="primary big" data-dpub="now" ${sending ? "disabled" : ""}>${ico("send", "sm")}${sending && !bookingAt.has(`post-${slug}-${net}`) ? tr("pub.sending") : tr("pub.now")}</button>
        <input type="datetime-local" id="dPubAt" value="${esc(p?.at && !["posted", "missing", "failed"].includes(p.status) && Date.parse(p.at) > Date.now() ? wallOf(new Date(p.at).getTime()) : freeSlot(net))}">
        <button data-dpub="at" ${sending ? "disabled" : ""}>${ico("cal", "sm")}${sending && bookingAt.has(`post-${slug}-${net}`) ? tr("pub.booking") : tr("pub.at")}</button></div>
      <p class="meta">${tr(conn.canSchedule ? "pub.held" : "pub.studio", { n: esc(NET_NAME[net] || net) })}</p>
      ${["failed", "missing"].includes(p?.status) ? `<p class="bad">${ico("alert", "sm")} ${esc(p.note || p.status)}</p>` : ""}</div>`
    : conn ? `<a class="dconnect" href="#/accounts">${ico("link", "sm")}<span><b>${tr("pub.connect", { n: esc(NET_NAME[net] || net) })}</b><span class="meta">${tr("pub.connecthint")}</span></span>${ico("chev-r", "sm")}</a>`
    : upload || HELPER_NETS.includes(net) ? `<div class="dpub hand"><button class="primary big" data-dhelp="1" ${helping.has(net) ? "disabled" : ""}>${ico("send", "sm")}${helping.has(net) ? tr("pub.helperbusy", { n: esc(NET_NAME[net] || net) }) : tr("pub.helper", { n: esc(NET_NAME[net] || net) })}</button><p class="meta">${tr("pub.helperhint", { n: esc(NET_NAME[net] || net) })}</p>
      ${upload ? `<button class="ghost" data-dhand="1">${ico("copy", "sm")}${tr("pub.byhand")}</button>` : ""}</div>` : "";
  const body = error ? `<p class="bad">${ico("alert", "sm")} ${esc(error)}</p>`
    : !d ? `<div class="skel" style="height:220px"></div><div class="skel skel-line"></div>`
    : !ch ? (notForLong(slug, net) ? `<p class="note">${ico("info", "sm")} ${tr("pd.longonly")}</p>`
      : `<p class="note">${ico("info", "sm")} ${tr("pd.nofile")}</p><button class="primary" data-dprep="1" ${drawer.prepping ? "disabled" : ""}>${ico("layers", "sm")}${drawer.prepping ? tr("pd.prepping") : tr("pd.prep", { n: esc(NET_NAME[net] || net) })}</button>`)
    : `${live ? `<details class="dmore"><summary class="meta">${tr("pd.more")}</summary>` : ""}<video class="dvid ${(spec?.files?.[0]?.aspect || "9x16") === "16x9" ? "wide" : ""}" src="${file(ch.dir + "\\" + v.file)}" controls muted playsinline preload="metadata"></video>
      <div class="mps">${ch.videos.slice(0, 1).map((x) => `${pill("film", `${x.w}×${x.h}`)}${pill("clock", `${x.sec}s`, spec && x.sec > spec.maxSec ? "bad" : "")}${pill("layers", `${x.fps} fps`)}${pill("download", `${x.mb} MB`)}`).join("")}</div>
      <ol class="dsteps">
        <li><b>${tr("pd.s1")}</b><div class="row">${ch.videos.map((x, i) => `<a class="btn ${i ? "" : "primary"}" href="${file(ch.dir + "\\" + x.file)}" download="${esc(x.file)}">${ico("download", "sm")}${i ? esc(x.file.replace(/^.*_/, "").replace(".mp4", "")) : tr("x.download")}</a>`).join("")}</div></li>
        <li><b>${tr("pd.s2")}</b><div class="row"><button data-dcopy="1">${ico("copy", "sm")}${tr("x.copy")}</button><span class="meta">${tr("pd.chars", { n: (ch.post || "").length })}</span></div>
          ${postPreview(slug, net, ch.post || "", conn, p)}</li>
        <li><b>${tr("pd.s3", { n: esc(NET_NAME[net] || net) })}</b><div class="row">${upload ? `<a class="btn" href="${escUrl(upload)}" target="_blank" rel="noopener">${ico("send", "sm")}${tr("pd.open", { n: esc(NET_NAME[net] || net) })} ↗</a>` : ""}<span class="meta">${esc(spec?.who || "")}</span></div></li>
        <li><b>${tr("pd.s4")}</b><div class="row"><input id="dLink" type="url" placeholder="https://…" aria-label="${esc(tr("pd.link"))}"><button class="primary" data-dposted="1" ${p?.status === "posted" ? "disabled" : ""}>${ico("check", "sm")}${tr("x.markposted")}</button></div>
          ${net !== "youtube" && p?.status !== "posted" ? `<div class="row"><button data-dbooked="1" ${p?.status === "scheduled" ? "disabled" : ""}>${ico("cal", "sm")}${tr("pd.booked", { n: esc(NET_NAME[net] || net) })}</button><span class="meta">${tr("pd.bookedhint")}</span></div>` : ""}</li>
      </ol>
      <div class="dplan"><span class="meta">${ico("cal", "sm")} ${tr(net === "youtube" ? "pd.ytplan" : "pd.plan")}</span>
        <div class="row"><input type="datetime-local" id="dAt" value="${esc(p?.at && p.status !== "posted" ? wallOf(new Date(p.at).getTime()) : freeSlot(net))}">${tzHint()}
          ${net === "youtube" ? (yt.connected ? `<button class="primary" data-dyt="1">${ico("cal", "sm")}${tr("x.schedule")}</button>` : `<a class="btn" href="/api/youtube/connect">${ico("play", "sm")}${tr("yt.connect")}</a>`)
            : `<button data-dplan="1">${ico("cal", "sm")}${tr("x.remind")}</button>`}
          ${p?.status === "planned" ? `<button data-unplan="${p.id}" title="${tr("x.removeplan")}">${ico("x", "sm")}</button>` : ""}</div>
        ${net === "youtube" ? `<p class="note">${tr("x.schednote")}</p>` : ""}</div>${live ? "</details>" : ""}`;
  host.innerHTML = `<div class="dscrim" data-dclose="1"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(`${NET_NAME[net] || net} · ${slug}`)}">
    <div class="dh">${netLogo(cid)}<div><b>${esc(NET_NAME[net] || net)}</b><div class="meta">${esc(spec?.note || "")}</div></div><span class="grow"></span>
      <button class="icon" data-dclose="1" title="${tr("src.close")}" aria-label="${tr("src.close")}">${ico("x", "sm")}</button></div>
    <div class="dreel"><span class="mthumb" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></span>
      <div style="flex:1;min-width:0"><b class="clamp">${esc(r.title || slug)}</b><div class="meta">${esc(slug)}</div><div class="mps">${status}</div></div>
      <a class="chip" href="#/reel/${esc(slug)}" title="${tr("pd.edit")}">${ico("eye", "sm")}${tr("pd.edit")}</a></div>
    ${spec?.blocker ? `<p class="dblock">${ico("alert", "sm")} ${esc(spec.blocker)}</p>` : ""}
    <div class="dbody">${liveHtml}${pubHtml}${body}</div>
    <div class="dfoot"><span class="meta">${tr("pd.left", { n: rest.length, c: esc(NET_NAME[net] || net) })}</span><span class="grow"></span>
      ${rest.length ? `<button data-dnext="${esc(rest[0].slug)}">${tr("pd.next")} ${ico("chev-r", "sm")}</button>` : ""}</div>
  </aside>`;
  host.querySelector(".drawer button, .drawer a")?.focus({ preventScroll: true });
}
/* Networks the browser helper knows how to open even without a saved upload page. */
const HELPER_NETS = ["bluesky", "x", "threads", "linkedin", "tiktok", "pinterest", "facebook", "gbp", "line-voom", "line-oa"];
const helping = new Set();
async function drawerAct(e) {
  if (!drawer) return false;
  const t = e.target;
  if (t.closest("[data-dclose]")) { closeDrawer(); return true; }
  const nx = t.closest("[data-dnext]"); if (nx) { openDrawer(nx.dataset.dnext, drawer.net); return true; }
  const { slug, net } = drawer;
  const ch = drawer.data?.channels?.find((c) => c.name === chOf(net));
  if (t.closest("[data-dcopy]")) { await navigator.clipboard.writeText(ch?.post || ""); toast(`${ico("copy", "sm")} ${tr("pd.copied")}`); return true; }
  const at = () => zonedIso($("#dAt")?.value || "");
  if (t.closest("[data-dhelp]")) {
    // The browser helper: the studio's own Chrome window opens the network with the file and text in place.
    helping.add(net); paintDrawer();
    try {
      let r = await fetch("/api/helper/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, network: net }) });
      let j = await r.json().catch(() => ({}));
      if (!r.ok && /not installed/.test(j.error || "")) {
        toast(`${ico("download", "sm")} ${tr("pub.helperinstalling")}`, 60000);
        const ins = await fetch("/api/helper/install", { method: "POST" });
        if (!ins.ok) throw new Error((await ins.json().catch(() => ({}))).error || "install failed");
        r = await fetch("/api/helper/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, network: net }) });
        j = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast(`${ico(j.state === "ready" ? "check" : "info", "sm")} ${esc(j.message)} ${tr("pub.helpermark")}`, 14000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 12000); }
    finally { helping.delete(net); paintDrawer(); }
    return true;
  }
  if (t.closest("[data-dhand]")) {
    // One click: the text on the clipboard, the file saved, the network's upload page open. Paste, drop, post.
    try { await navigator.clipboard.writeText(ch?.post || ""); } catch { /* the post text is still under Post text */ }
    const v = ch?.videos?.[0];
    if (v) { const a = document.createElement("a"); a.href = file(ch.dir + "\\" + v.file); a.download = v.file; document.body.appendChild(a); a.click(); a.remove(); }
    const up = chanOf(net)?.upload; if (up) window.open(up, "_blank", "noopener");
    toast(`${ico("check", "sm")} ${tr("pub.handdone", { n: NET_NAME[net] || net })}`, 8000);
    return true;
  }
  const pb = t.closest("[data-dpub]");
  if (pb) {
    const when = pb.dataset.dpub === "at" ? zonedIso($("#dPubAt")?.value || "") : null;
    if (pb.dataset.dpub === "at" && !$("#dPubAt")?.value) { toast(tr("pd.picktime")); return true; }
    if (!confirm(when ? tr("pub.askat", { s: slug, n: NET_NAME[net] || net, t: whenText(when) }) : tr("pub.asknow", { s: slug, n: NET_NAME[net] || net }))) return true;
    try {
      const p = postState(slug)[net];
      publishing.add(`post-${slug}-${net}`); if (when) bookingAt.add(`post-${slug}-${net}`); else bookingAt.delete(`post-${slug}-${net}`); paintDrawer();
      await post("/api/publish", { slug, network: net, at: when || undefined, id: p && ["planned", "failed", "missing"].includes(p.status) ? p.id : undefined });
      toast(`${ico(when ? "cal" : "send", "sm")} ${when ? tr("pub.bookstarted", { n: NET_NAME[net] || net, t: whenText(when) }) : tr("pub.started", { n: NET_NAME[net] || net })}`, 5000);
    } catch (err) { publishing.delete(`post-${slug}-${net}`); bookingAt.delete(`post-${slug}-${net}`); paintDrawer(); toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return true;
  }
  try {
    if (t.closest("[data-dplan]")) {
      if (!$("#dAt").value) { toast(tr("pd.picktime")); return true; }
      await post("/api/posts/plan", { slug, network: net, at: at() });
      toast(`${ico("cal", "sm")} ${tr("pd.planned", { n: NET_NAME[net], t: whenText(at()) })}`); await loadPosting(); return true;
    }
    if (t.closest("[data-dyt]")) {
      if (!confirm(tr("pd.ytask", { s: slug, t: whenText(at()) }))) return true;
      await post("/api/youtube/upload", { slug, at: at(), privacy: "private" });
      toast(`${ico("send", "sm")} ${tr("pd.ytgo", { s: slug })}`, 4000); await loadOverview(); return true;
    }
    if (t.closest("[data-dbooked]")) {
      if (!$("#dAt").value) { toast(tr("pd.picktime")); return true; }
      const link = ($("#dLink")?.value || "").trim();
      if (link && !/^https:\/\//.test(link)) { toast(`${ico("alert", "sm")} ${tr("pd.badlink")}`, 4000); return true; }
      const p = postState(slug)[net];
      const id = p?.status === "planned" ? p.id : (await post("/api/posts/plan", { slug, network: net, at: at() })).id;
      await post("/api/posts/booked", { id, url: link, at: at() });
      toast(`${ico("cal", "sm")} ${tr("pd.bookeddone", { n: NET_NAME[net], t: whenText(at()) })}`); await loadPosting(); return true;
    }
    if (t.closest("[data-dposted]")) {
      const link = ($("#dLink")?.value || "").trim();
      if (link && !/^https:\/\//.test(link)) { toast(`${ico("alert", "sm")} ${tr("pd.badlink")}`, 4000); return true; }
      let p = postState(slug)[net];
      const id = p?.status === "planned" ? p.id : (await post("/api/posts/plan", { slug, network: net, at: zonedIso(wallOf(Date.now())) })).id;
      await post("/api/posts/done", { id, url: link });
      // Stay on this post: the panel now leads with "View post"; Next is one click away in the footer.
      toast(`${ico("check", "sm")} ${tr("pd.done", { n: NET_NAME[net], s: slug })}`); await loadPosting();
      return true;
    }
    const lk = t.closest("[data-dlink]");
    if (lk) {
      const url = ($("#dFix")?.value || "").trim();
      if (!/^https:\/\//.test(url)) { toast(`${ico("alert", "sm")} ${tr("pd.badlink")}`, 4000); return true; }
      await post("/api/posts/link", { id: +lk.dataset.dlink, url });
      toast(`${ico("check", "sm")} ${tr("pd.linksaved")}`); await loadPosting(); return true;
    }
    if (t.closest("[data-dprep]")) {
      drawer.prepping = true; paintDrawer();
      try {
        await post("/api/package", { slug, channels: [chOf(net)] });
        drawerCache.delete(slug);
        toast(`${ico("check", "sm")} ${tr("pd.prepdone", { n: NET_NAME[net] })}`);
        await openDrawer(slug, net);
      } finally { if (drawer) { drawer.prepping = false; paintDrawer(); } }
      return true;
    }
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); return true; }
  return false;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer) closeDrawer(); else if (e.key === "Escape" && planner) { planner = null; renderHome(true); } });

/* ---------- Plan posts: a week (or more) for every network at once ----------
   One reel per network per day at the audience's evening hour, reels in Posting order, days that already
   have a post on that network are left alone. YouTube is a real schedule (uploaded now, public at the time,
   one upload after another); every other network becomes a reminder with its files ready. */
let planner = null;
const PLAN_NETS = () => POST_NETS.filter((n) => chanOf(n) && !chanOf(n).off);  // "off": true in channels.json = this account does not post there
/* Every free slot of every chosen network over the days, each filled with the next reel that network has
   not had (approved first; unreviewed ones only when "Approved only" is off). A reel is not used twice on
   one network, and a day's slots on one network get different reels. */
/* What each network can really do from here. Booked for real: YouTube, the studio's own posts, and the sites your Chrome
   schedules (each only so far ahead, the same limits as server/helper.mjs). Anything else stays a reminder. */
const CHROME_NETS = { x: 365, tiktok: 10, gbp: 180, "line-oa": 180, linkedin: 90, pinterest: 9 };  // same as helper.mjs MAX_DAYS_AHEAD
const STUDIO_NETS = ["facebook", "bluesky"];
const BOOK_AHEAD = { ...CHROME_NETS, facebook: 29 };  // days ahead each site accepts a booking (Facebook refuses reels beyond 29)
const PLAN_WEEKLY = ["linkedin", "line-oa"];  // at most one a week: its first slot, never within 7 days of another
const planBooks = (n) => n === "youtube" || n in CHROME_NETS || STUDIO_NETS.includes(n);
const planReady = (n) => (n === "youtube" ? !!yt.connected : STUDIO_NETS.includes(n) ? !!connections[n]?.connected : true);
/* Every waiting reel once before any repeats, stories taken in turn so one does not run for days. */
function plannerPool(approvedOnly = planner?.approvedOnly ?? true) {
  const themes = new Map();
  const waiting = overview.reels.filter((r) => !r.house && r.rendered && !busyJob(r) && !isSkipped(r.slug) && reelState(r) === "topost" && (!approvedOnly || r.status === "approved"));
  for (const r of waiting) { const k = r.theme || r.slug; if (!themes.has(k)) themes.set(k, []); themes.get(k).push(r); }
  const lists = [...themes.values()].map((l) => l.sort((a, b) => /-ai$/.test(a.slug) - /-ai$/.test(b.slug) || (b.updated || 0) - (a.updated || 0)));
  const out = [];
  for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
const planFits = (r, n) => !postState(r.slug)[n] && !notForLong(r.slug, n) && (n !== "linkedin" || isLong(r.slug)) && !(n === "gbp" && r.faces > 0);  // Maps: no people (Google refused one post)
function plannerPlan(P = planner, pool = plannerPool()) {  // batch C: Review's "would land on" runs it with its own P
  const out = [], used = new Set();
  const today = wallOf(Date.now()).slice(0, 10), DAY = 864e5;
  const times = Object.fromEntries([...P.nets].map((n) => [n, takenTimes(n)]));
  const busy = Object.fromEntries([...P.nets].map((n) => [n, new Set(postsLog.filter((p) => p.network === n && holdsSlot(p)).map((p) => dayOf(p.at)))]));
  // One headline per network per two weeks: what each network already shows, and when (planned rows count too).
  const hookOf = Object.fromEntries(overview.reels.map((r) => [r.slug, r.hookText || ""]));
  const shown = Object.fromEntries([...P.nets].map((n) => [n, postsLog.filter((p) => p.network === n && holdsSlot(p) && p.at).map((p) => ({ h: hookOf[p.slug], t: new Date(p.at).getTime() }))]));
  const repeats = (r, n, at) => !!hookOf[r.slug] && shown[n].some((x) => x.h === hookOf[r.slug] && Math.abs(x.t - Date.parse(at)) <= 14 * DAY);
  P.skippedRepeat = 0;
  let day = P.start;
  for (let i = 0; i < P.days && used.size < pool.length; i++, day = nextDay(day)) {
    const dow = new Date(day + "T12:00Z").getUTCDay(), ahead = Math.round((Date.parse(day + "T12:00Z") - Date.parse(today + "T12:00Z")) / DAY);
    for (const n of P.nets) {
      if (busy[n].has(day) || ahead >= (BOOK_AHEAD[n] ?? 9999)) continue;  // one post per network per day; a site's own limit
      const weekly = PLAN_WEEKLY.includes(n);
      for (const s of weekly ? slotsOf(n).slice(0, 1) : slotsOf(n)) {
        if (s.dow >= 0 && s.dow !== dow) continue;
        const at = zonedIso(`${day}T${s.hm}`);
        if (!slotFree(times[n], at) || (weekly && times[n].some((t) => Math.abs(t - Date.parse(at)) < 7 * DAY - 36e5))) continue;
        const fits = pool.filter((x) => !used.has(x.slug) && planFits(x, n));
        const r = fits.find((x) => !repeats(x, n, at));
        if (!r) { if (fits.length) P.skippedRepeat++; break; }
        used.add(r.slug); busy[n].add(day); times[n].push(Date.parse(at)); shown[n].push({ h: hookOf[r.slug], t: Date.parse(at) });
        out.push({ day, hm: s.hm, net: n, slug: r.slug, at, hook: r.hook, updated: r.updated });
        break;
      }
    }
  }
  P.left = pool.length - used.size;
  return out;
}
function plannerHtml() {
  const P = planner, plan = plannerPlan(), days = [...new Set(plan.map((x) => x.day))];
  const ytN = plan.filter((x) => x.net === "youtube").length;
  return `<div class="lightbox" data-plclose="1"><div class="lb-card planner" role="dialog" aria-modal="true" aria-label="${esc(tr("plan.title"))}">
    <div class="pk-head"><h3>${ico("cal")} ${tr("plan.title")}</h3><span class="grow"></span><button data-plclose="1">${ico("x", "sm")}${tr("src.close")}</button></div>
    <p class="note">${tr("plan.lead")}</p>
    <div class="row wrap">${PLAN_NETS().map((n) => planReady(n)
      ? `<label class="toggle ${P.nets.has(n) ? "on" : ""}"><input type="checkbox" data-plnet="${n}" ${P.nets.has(n) ? "checked" : ""}>${netLogo(n, "sm")} ${esc(NET_NAME[n])}${planBooks(n) ? "" : ` <span class="meta">${tr("plan.reminder")}</span>`}${tcStalled().has(n) ? ` <span class="tc-test">${esc(tr("tc.test.paused"))}</span>` : ""}</label>`
      : `<button class="toggle warnline" data-plclose="1" data-goto="accounts">${netLogo(n, "sm")} ${esc(NET_NAME[n])} <span class="meta">${tr("plan.connect")}</span></button>`).join("")}</div>
    <div class="row"><label class="meta">${tr("plan.from")} <input type="date" id="plStart" value="${P.start}"></label>
      <label class="meta">${tr("plan.days")} <select id="plDays">${[[7, "7"], [14, "14"], [30, "30"], [120, tr("plan.everything")]].map(([d, label]) => `<option value="${d}" ${d === P.days ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
      <label class="meta"><input type="checkbox" id="plApproved" ${P.approvedOnly ? "checked" : ""}> ${tr("plan.approved")}</label>${tzHint()}</div>
    ${[...tcStalled().values()].map((x) => `<p class="note warnline tc-paused">${ico("alert", "sm")} <b>${esc(tr("tc.plan.paused", { net: NET_NAME[x.network] || x.network }))}</b> ${esc(tr("tc.plan.pausedwhy", { net: NET_NAME[x.network] || x.network, m: x.measured }))}</p>`).join("")}
    <p class="meta">${[...P.nets].map((n) => `${esc(NET_NAME[n])} ${slotsOf(n).map((s) => (s.dow >= 0 ? WEEKDAYS[s.dow] + " " : "") + s.hm).join(" · ")}`).join(" ／ ")}</p>
    <div class="plgrid">${days.length ? `<table class="matrix"><thead><tr><th>${tr("plan.day")}</th>${[...P.nets].map((n) => `<th>${netLogo(n, "sm")}</th>`).join("")}</tr></thead><tbody>
      ${days.map((d) => `<tr><td class="meta">${esc(whenText(zonedIso(d + "T12:00")).replace(/\s*\d{1,2}:\d{2}.*$/, ""))}</td>${[...P.nets].map((n) => { const xs = plan.filter((y) => y.day === d && y.net === n);
        return `<td>${xs.length ? xs.map((x) => `<span class="mthumb sm" title="${esc(`${x.hm} ${x.slug}`)}" style="background-image:url('${x.hook ? thumb(x.hook, 120) + "&v=" + (x.updated || 0) : ""}')"></span>`).join("") : `<span class="meta">—</span>`}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="note">${tr("plan.nothing")}</p>`}</div>
    ${ytN ? `<p class="note warnline">${ico("alert", "sm")} ${tr("plan.ytwarn", { n: ytN })}</p>` : ""}
    ${P.skippedRepeat ? `<p class="note warnline">${ico("alert", "sm")} ${tr("plan.repeatskip", { n: P.skippedRepeat })} <a href="#/words" data-plclose="1">${tr("w.fix")}</a></p>` : ""}
    <div class="row"><span class="meta">${tr("plan.sum", { n: plan.length, d: days.length })}${P.left ? ` · ${tr("plan.left", { n: P.left })}` : ""}</span><span class="grow"></span>
      <button class="primary" id="plGo" ${plan.length && !P.busy ? "" : "disabled"}>${ico("cal", "sm")}${P.busy ? esc(P.busy) : tr(P.armed ? "plan.sure" : "plan.go", { n: plan.length })}</button></div>
  </div></div>`;
}
/* Track C (24 Nov): the networks Plan posts pauses, by the same rule as Runs by itself and Needs you (perf.reach
   "stalled", counted on the account in use now). Read now and then; the server keeps the answer. */
let tcReach = null, tcReachAt = 0;
function tcStalled() {
  if (Date.now() - tcReachAt > 10 * 60e3) {
    tcReachAt = Date.now();
    api("/api/perf/reach").then((r) => { tcReach = r; if (planner) { const s = tcStalled(); for (const n of s.keys()) if (!planner.touched?.has(n)) planner.nets.delete(n); renderHome(true); } }).catch(() => {});
  }
  if (autoView?.settings?.plan?.skipStalled === false) return new Map();
  return new Map((tcReach?.networks || []).filter((x) => x.stalled).map((x) => [x.network, x]));
}
function openPlanner() {
  const start = nextSlot(19).slice(0, 10);
  const quiet = tcStalled();
  planner = { nets: new Set(PLAN_NETS().filter((n) => planBooks(n) && planReady(n) && !quiet.has(n))), start: wallOf(Date.now()).slice(0, 10), days: 14, approvedOnly: true, busy: "", armed: false, left: 0, touched: new Set() };
  renderHome(true);
}
async function runPlanner() {
  const plan = plannerPlan(), yts = plan.filter((x) => x.net === "youtube"), rest = plan.filter((x) => x.net !== "youtube");
  if (!planner.armed) { planner.armed = true; renderHome(true); return; }  // second press confirms (no pop-up)
  const say = (s) => { planner.busy = s; renderHome(true); };
  let ok = 0, failed = [];
  for (const [i, x] of rest.entries()) {
    say(tr("plan.doing", { i: i + 1, n: plan.length }));
    try {
      if (planBooks(x.net)) {  // older reels may not have this network's files yet
        const d = await api("/api/reel?slug=" + encodeURIComponent(x.slug));
        if (!d.channels?.some((c) => c.name === chOf(x.net) && c.files?.some((name) => /\.mp4$/i.test(name)))) await post("/api/package", { slug: x.slug, channels: [chOf(x.net)] });
      }
      if (x.net in CHROME_NETS) await post("/api/helper/schedule", { slug: x.slug, network: x.net, at: x.at });
      else if (STUDIO_NETS.includes(x.net)) await post("/api/publish", { slug: x.slug, network: x.net, at: x.at });
      else await post("/api/posts/plan", { slug: x.slug, network: x.net, at: x.at });
      ok++;
    } catch (err) { failed.push(`${x.net} ${x.slug}: ${err.message}`); }
  }
  for (const [i, x] of yts.entries()) {
    say(tr("plan.yt", { i: i + 1, n: yts.length, s: x.slug }));
    try {
      const done = new Promise((res) => jobWaiters.set(x.slug, res));
      await post("/api/youtube/upload", { slug: x.slug, at: x.at, privacy: "private" });
      const j = await Promise.race([done, new Promise((res) => setTimeout(() => res({ status: "timeout" }), 20 * 60000))]);
      if (j.status === "done") ok++; else failed.push(`youtube ${x.slug}: ${j.status}`);
    } catch (err) { jobWaiters.delete(x.slug); failed.push(`youtube ${x.slug}: ${err.message}`); }
  }
  planner = null; await loadPosting(); await loadOverview(); renderHome(true);
  toast(`${ico(failed.length ? "alert" : "check", "sm")} ${tr("plan.done", { n: ok })}${failed.length ? `<br>${failed.map(esc).join("<br>")}` : ""}`, failed.length ? 12000 : 5000);
}
document.addEventListener("change", (e) => {
  if (!planner) return;
  const t = e.target;
  if (t.dataset.plnet) { t.checked ? planner.nets.add(t.dataset.plnet) : planner.nets.delete(t.dataset.plnet); planner.touched?.add(t.dataset.plnet); }
  else if (t.id === "plStart") planner.start = t.value || planner.start;
  else if (t.id === "plApproved") planner.approvedOnly = t.checked;
  else if (t.id === "plDays") planner.days = +t.value;
  else return;
  planner.armed = false;
  renderHome(true);
});
document.addEventListener("click", async (e) => {
  if (await drawerAct(e)) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.target.closest("#syncBtn")) return refreshAll();
  if (e.target.closest("#openPlanner")) return openPlanner();
  if (planner && e.target.closest("[data-plclose]") && (e.target.matches("[data-plclose]") || e.target.closest("button[data-plclose]"))) { planner = null; return renderHome(true); }
  if (planner && e.target.closest("#plGo")) return runPlanner();
}, true);

/* YouTube: the channel at a glance, playlists, every video with its state. */
let ytLists = null;
function loadYtLists() {
  if (!yt.connected) return;
  api("/api/youtube/playlists").then((p) => { ytLists = p.playlists; if (atHome() && page === "youtube") renderHome(true); })
    .catch((err) => { ytLists = []; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); });
}
