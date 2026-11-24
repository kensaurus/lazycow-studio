/* ---------- Versions (GET /api/versions/todo, py/studio/versions.py) ----------
   A booked reel keeps posting as it is while a better cut is made beside it. Here the two play side by side with what
   changed and what the reviewer found before and after; a person keeps the live one or uses the new one. */
let verView = null, verLoading = false, verTimer = null;
async function loadVersions(fresh = false) {
  if (verLoading) return; verLoading = true;
  try { verView = await api("/api/versions/todo" + (fresh ? "?fresh=1" : "")); } catch (err) { verView = verView || { ready: [], open: [], error: err.message }; }
  verLoading = false;
  clearTimeout(verTimer);
  if (verView.making?.status === "running") verTimer = setTimeout(() => loadVersions(true), 15000);
  if (page === "versions" || page === "posting") renderHome(true);
}
function versionsLineHtml() {
  const v = verView;
  if (!v) { loadVersions(); return ""; }
  const busy = v.making?.status === "running" || (v.inline || 0) > 0;
  if (!v.ready.length && !v.open.length && !busy) return "";
  return `<section class="stalebox"><div class="sb-head"><b>${ico("layers", "sm")} ${tr(v.open.length === 1 ? "ver.line1" : "ver.line", { r: v.ready.length, o: v.open.length })}</b>
    ${v.inline ? `<span class="chip">${ico("hourglass", "sm")} ${tr("ver.inline", { n: v.inline })}</span>` : ""}
    ${v.making?.status === "running" ? `<span class="meta"><span class="spin sm"></span> ${tr("ver.making", { p: v.making.pct || 0, l: esc(v.making.label || "") })}</span>` : ""}<span class="grow"></span>
    <a class="btn ${v.ready.length ? "primary" : ""}" href="#/versions">${tr(v.ready.length ? "ver.compare" : "ver.see")}</a></div></section>`;
}
const pct2 = (x) => (x == null ? "–" : Number(x).toFixed(2));
const VERDICT = { better: "ver.v.better", unknown: "ver.v.unknown" };
function verSide(slug, n, label, r, cls = "") {
  const mm = r?.mismatches?.length;
  return `<figure class="verside ${cls}"><figcaption><b>${label}</b> <span class="meta">v${n}</span>
      ${r ? `<span class="meta">${tr("ver.score", { h: r.hook ?? "–", l: r.look ?? "–" })}</span> <span class="chip ${mm ? "warn" : "ok"}">${tr(mm ? "ver.mm" : "ver.nomm", { n: mm })}</span>` : `<span class="meta">${tr("ver.noreview")}</span>`}</figcaption>
    <video controls preload="none" playsinline poster="/api/versions/file?slug=${encodeURIComponent(slug)}&n=${n}&kind=hook" src="/api/versions/file?slug=${encodeURIComponent(slug)}&n=${n}&kind=master"></video></figure>`;
}
/* Booked reels that stay as they are: a re-cut was made and was not better, or the footage has no clearly better shot. */
function keptHtml(kept) {
  const worse = (kept || []).filter((k) => k.status !== "nocut"), none = (kept || []).filter((k) => k.status === "nocut");
  const line = (list, one, many) => list.length ? `<p class="meta">${ico("info", "sm")} ${tr(list.length === 1 ? one : many, { n: list.length, list: esc(list.map((k) => k.slug).join(", ")) })}</p>` : "";
  return line(worse, "ver.kept1", "ver.keptn") + line(none, "ver.nocut1", "ver.nocutn");
}
function renderVersions() {
  const head = `<div class="pagehead">${crumbs([tr("nav.versions")])}</div>`;
  if (!verView) { $("#home").innerHTML = head + loadingHtml(tr("nav.versions")); loadVersions(true); return; }
  const v = verView, busy = v.making?.status === "running" || (v.inline || 0) > 0;
  // One comparison at a time, the others one click away in the row above it (layout pass, 18 Nov: three stacked
  // comparisons were 4 screens). The videos and what changed sit side by side.
  const sel = v.ready.find((x) => x.slug === verSel) || v.ready[0];
  const pick = v.ready.length > 1 ? `<nav class="tabs posttabs ly-tabs ver-pick" role="tablist" aria-label="${esc(tr("ver.h"))}">${v.ready.map((x, i) => `<a href="#/versions" role="tab" data-versel="${esc(x.slug)}" aria-selected="${x === sel}" class="${x === sel ? "on" : ""}"><span class="ly-n">${i + 1}</span><span lang="ja">${esc(reelName(x.slug))}</span></a>`).join("")}</nav>` : "";
  const cards = v.ready.filter((x) => x === sel).map((x) => `<article class="vercard" id="ver-${esc(x.slug)}">
      <div class="row wrap"><a href="#/reel/${esc(x.slug)}" title="${esc(x.slug)}"><b lang="ja">${esc(reelName(x.slug))}</b></a><span class="meta">${x.first ? tr("ver.first", { t: esc(whenText(x.first)) }) : ""}</span>
        <span class="meta">· ${esc(x.why || "")}</span>${VERDICT[x.verdict] ? `<span class="chip ${x.verdict === "better" ? "ok" : ""}">${tr(VERDICT[x.verdict])}</span>` : ""}${x.qa && !x.qa.ok ? `<span class="chip warn" title="${esc(x.qa.flags.join(" · "))}">${tr("ver.qaflag")}</span>` : ""}</div>
      <div class="ver-body"><div class="vercmp">${verSide(x.slug, x.live || 1, tr("ver.live"), x.before)}${verSide(x.slug, x.n, tr("ver.new"), x.after, "new")}</div>
      <div class="ver-side">${cVerDiffHtml(x)}
      <ul class="verch">${x.changes.map((c) => `<li><b>${tr("ver.shot", { n: c.shot })}</b> <span>“${esc(c.line)}”</span>
        <span class="meta" title="${esc(tr("ver.match", { a: pct2(c.matchBefore), b: pct2(c.matchAfter) }))}">${tr("ver.swapped")}</span>${c.why ? `<span class="meta">${esc(c.why)}</span>` : ""}</li>`).join("")}</ul>
      <div class="row wrap"><button class="primary" data-veruse="${esc(x.slug)}" data-vern="${x.n}">${ico("refresh", "sm")}${tr("ver.use")}</button>
        <button data-verkeep="${esc(x.slug)}" data-vern="${x.n}">${tr("ver.keep")}</button><span class="meta">${tr("ver.usewhy")}</span></div></div></div></article>`).join("");
  const kept = keptHtml(v.kept);
  $("#home").innerHTML = `${head}
    <section class="vlsum"><div class="row wrap"><b class="vlsumh">${tr("ver.h")}</b>
      <span class="chip ok">${tr("ver.ready", { n: v.ready.length })}</span>${v.open.length ? `<span class="chip warn">${tr("ver.open", { n: v.open.length })}</span>` : ""}
      ${v.making?.status === "running" ? `<span class="chip">${tr("ver.making", { p: v.making.pct || 0, l: esc(v.making.label || "") })}</span>` : ""}
      ${v.inline ? `<span class="chip">${ico("hourglass", "sm")} ${tr("ver.inline", { n: v.inline })}</span>` : ""}<span class="grow"></span>
      ${v.open.length && !busy ? `<button class="primary" data-verrecut="1">${ico("scissors", "sm")}${tr("ver.recutall", { n: v.open.length })}</button>` : ""}</div>
      <p class="meta">${tr("ver.how")}</p>${kept ? `<details class="ver-kept"><summary class="meta">${esc(tr("ly_v.kept", { n: (v.kept || []).length }))}</summary>${kept}</details>` : ""}</section>
    ${pick}${cards || `<p class="note">${tr(busy ? "ver.wait" : v.open.length ? "ver.notyet" : "ver.none")}</p>`}`;
}
let verSel = "";
document.addEventListener("click", (e) => { const a = e.target.closest?.("[data-versel]"); if (!a) return; e.preventDefault(); verSel = a.dataset.versel; renderHome(true); });
document.addEventListener("click", async (e) => {
  const rc = e.target.closest("[data-verrecut]"), use = e.target.closest("[data-veruse]"), keep = e.target.closest("[data-verkeep]");
  if (!rc && !use && !keep) return;
  const btn = rc || use || keep; btn.disabled = true;
  try {
    if (rc) { await post("/api/versions/recut", { booked: true }); toast(`${ico("scissors", "sm")} ${tr("ver.started")}`, 7000); }
    else {
      const slug = (use || keep).dataset[use ? "veruse" : "verkeep"], n = Number((use || keep).dataset.vern);
      await post(use ? "/api/versions/use" : "/api/versions/discard", { slug, n });
      toast(use ? `${ico("clock", "sm")} ${tr("ver.using", { s: esc(reelName(slug)) })}` : `${ico("check", "sm")} ${tr("ver.kept", { s: esc(reelName(slug)) })}`, 7000);
      document.getElementById("ver-" + slug)?.classList.add("done");
    }
  } catch (err) { btn.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); return; }
  setTimeout(() => loadVersions(true), 1500);
});
/* Booked reels whose sound is off the level (GET /api/levels): one press fixes them in place, by gain alone. */
let levelsView = null, levelsLoading = false;
async function loadLevels(fresh = false) {
  if (levelsLoading) return; levelsLoading = true;
  try { levelsView = await api("/api/levels" + (fresh ? "?fresh=1" : "")); } catch { /* the line waits for the next load */ }
  levelsLoading = false; if (page === "posting") renderHome(true);
}
function levelsHtml() {
  const v = levelsView;
  if (!v) { loadLevels(); return ""; }
  if (!v.off.length && !v.fixing) return "";
  const quiet = v.off.filter((x) => x.lufs != null && x.lufs < x.target - 1).length, hot = v.off.filter((x) => x.truePeak != null && x.truePeak > -1).length;
  return `<section class="stalebox" aria-label="${esc(tr(v.off.length === 1 ? "lv.h1" : "lv.h", { n: v.off.length }))}"><div class="sb-head"><b>${ico("volume", "sm")} ${tr(v.off.length === 1 ? "lv.h1" : "lv.h", { n: v.off.length })}</b>
    <span class="meta">${[quiet ? tr("lv.quiet", { q: quiet }) : "", hot ? tr("lv.hot", { h: hot }) : ""].filter(Boolean).join(lang === "ja" ? "、" : ", ")}</span><span class="grow"></span>
    ${v.fixing ? `<span class="meta"><span class="spin sm"></span> ${tr("lv.fixing")}</span>` : `<button data-levelfix title="${esc(tr("lv.tip"))}">${tr("lv.fix")}</button>`}</div>
    <p class="meta" title="${esc(v.off.map((x) => `${x.slug} ${x.lufs} LUFS${x.truePeak > -1 ? ` · ${x.truePeak} dBTP` : ""}`).join(" · "))}">${esc(v.off.map((x) => `${reelName(x.slug)} (${tr(x.truePeak > -1 ? "lv.l1" : "lv.q1")})`).join(" · "))}</p></section>`;
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-levelfix]")) return;
  try { await post("/api/levels/fix", {}); toast(`${ico("volume", "sm")} ${tr("lv.started")}`, 6000); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  levelsView = { ...(levelsView || { off: [] }), fixing: true }; renderHome(true);
  const t = setInterval(async () => { await loadLevels(true); if (!levelsView?.fixing) { clearInterval(t); staleView = null; loadStale(); } }, 15000);
});
function staleHtml() {
  const v = staleView;
  if (!v) { loadStale(); return ""; }
  if (!v.total) return "";
  const g = v.groups || {};
  const ytNow = (g.ready || 0) - (v.youtubeLater || 0);
  const row = (n, text, act = "") => (n ? `<li><b>${n}</b><span>${text}</span>${act}</li>` : "");
  return `<section class="stalebox" aria-label="${esc(tr("stl.h", { n: v.total }))}">
    <div class="sb-head"><b>${tr("stl.h", { n: v.total })}</b>
      <span class="meta">${tr(v.on ? "ux2.swapon" : "ux2.swapoff")}</span>${/* BL-064: the switch itself is a setting row under "Runs by itself" */ ""}
      ${v.done ? `<span class="meta">${tr("stl.done", { n: v.done })}</span>` : ""}
      ${v.busy ? `<span class="meta">${tr("stl.busy")}</span>` : v.last ? `<span class="meta">${tr("stl.last", { s: esc(reelName(v.last.slug)), n: esc(NET_NAME[v.last.network] || v.last.network), t: ago(v.last.when) })}</span>` : ""}</div>
    <ul>
      ${row(ytNow, tr(v.on ? "stl.ready" : "stl.readyoff"), v.on ? "" : `<button data-autoreplace-now>${tr("stl.start")}</button>`)}
      ${row(v.youtubeLater, tr("stl.ytlater", { n: v.today?.perDay || 20 }))}
      ${row(g.review, tr("stl.review"), `<a href="#/review">${tr("stl.toreview")} ›</a>`)}
      ${row(g.rendering, tr("stl.rendering"), `<a href="#/making">${tr("stl.tomaking")} ›</a>`)}
      ${row(g.soon, tr("stl.soon"))}
      ${row(g.elsewhere, tr("stl.elsewhere"))}
      ${row(g.failed, `${tr("stl.failed")} <span class="meta">${esc((v.list || []).filter((x) => x.why === "failed").map((x) => `${reelName(x.slug)} · ${NET_NAME[x.network] || x.network}: ${x.error || ""}`).join(" | "))}</span>`, `<button data-swapretry>${tr("stl.retry")}</button>`)}
    </ul></section>`;
}
document.addEventListener("change", async (e) => {
  const t = e.target.closest("[data-autoreplace]"); if (!t) return;
  try { await post("/api/posts/autoreplace", { on: t.checked }); toast(`${ico("check", "sm")} ${tr(t.checked ? "stl.onmsg" : "stl.offmsg")}`, 4000); }
  catch (err) { t.checked = !t.checked; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  loadStale();  // keeps the old view until the new one lands, so the setting row does not blink away
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-swapretry]")) return;
  try { await post("/api/posts/autoreplace", { on: true, retry: true }); toast(`${ico("refresh", "sm")} ${tr("stl.retrying")}`, 4000); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  staleView = null; loadStale();
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-autoreplace-now]")) return;
  try { await post("/api/posts/autoreplace", { on: true }); toast(`${ico("check", "sm")} ${tr("stl.onmsg")}`, 4000); } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  staleView = null; loadStale();
});
async function waitJob(key) {
  for (let k = 0; k < 600; k++) {  // an upload or a Chrome booking takes up to a few minutes
    await new Promise((r) => setTimeout(r, 3000));
    const s = await api("/api/job?slug=" + encodeURIComponent(key)).catch(() => null);
    if (s && (s.status === "done" || s.status === "error")) { if (s.status === "error") throw new Error((s.lines || []).slice(-1)[0] || s.label || "failed"); return s; }
  }
  throw new Error("still running: check the Activity log");
}
async function replaceOne(id, slug, net) {
  const j = await post("/api/posts/replace", { id: +id, slug, network: net });
  await waitJob(j.slug || `post-${slug}-${net}`);
  if (["x", "tiktok"].includes(net)) { await new Promise((r) => setTimeout(r, 1500)); await waitJob(`helper-${slug}-${net}`); }  // then the new one is booked
}
document.addEventListener("click", async (e) => {
  const one = e.target.closest("[data-replace]");
  if (one) {
    one.disabled = true;
    try { toast(`${ico("refresh", "sm")} ${tr("rp.doing", { s: esc(one.dataset.slug), n: esc(NET_NAME[one.dataset.net] || one.dataset.net) })}`, 4000); await replaceOne(one.dataset.replace, one.dataset.slug, one.dataset.net); toast(`${ico("check", "sm")} ${tr("rp.done", { s: esc(one.dataset.slug), n: esc(NET_NAME[one.dataset.net] || one.dataset.net) })}`, 6000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    await loadPosting(); return;
  }
});
/* The schedule as a calendar, a month at a time (‹ › and Today). Weeks start on Monday; Saturdays are cyan, Sundays
   and Japanese national holidays pink, with the holiday's name (shared/holidays-jp.json, from the Cabinet Office).
   One square per post with its network's logo: solid = booked on the network, dashed = the studio sends it, amber = a
   reminder to post by hand, green = already out, a pink underline = its headline repeats on that network. */
let calMonth = "", HOLIDAYS = null;
const HOL_EN = { "元日": "New Year's Day", "成人の日": "Coming of Age Day", "建国記念の日": "Foundation Day", "天皇誕生日": "Emperor's Birthday", "春分の日": "Spring Equinox", "昭和の日": "Showa Day",
  "憲法記念日": "Constitution Day", "みどりの日": "Greenery Day", "こどもの日": "Children's Day", "海の日": "Marine Day", "山の日": "Mountain Day", "敬老の日": "Respect for the Aged Day",
  "秋分の日": "Autumn Equinox", "スポーツの日": "Sports Day", "文化の日": "Culture Day", "勤労感謝の日": "Labour Thanksgiving Day", "休日": "Substitute holiday" };
const holName = (h) => (lang === "ja" ? h : HOL_EN[h] || h);
async function loadHolidays() { if (HOLIDAYS) return; HOLIDAYS = {}; try { HOLIDAYS = (await api("/api/holidays")).days || {}; } catch { /* the calendar works without them */ } if (page === "posting") renderHome(true); }
/* What goes out that day, as pictures: the calendar showed only network icons, so a day said "TikTok, X" but not which
   reel (fresh-user review, 15 Nov). Up to three reels; the headline on hover. */
function calThumbs(ps) {
  const slugs = [...new Set(ps.map((p) => p.slug))];
  if (!slugs.length) return "";
  return `<div class="cthumbs">${slugs.slice(0, 3).map((sl) => { const r = overview.reels.find((x) => x.slug === sl);
    return `<span title="${esc(reelName(sl))}" style="background-image:url('${r?.hook ? thumb(r.hook, 60) : ""}')"></span>`; }).join("")}${slugs.length > 3 ? `<i>+${slugs.length - 3}</i>` : ""}</div>`;
}
function calHtml(list, repeats) {
  if (HOLIDAYS === null) loadHolidays();
  const today = dayOf(new Date().toISOString());
  if (!calMonth) calMonth = today.slice(0, 7);
  const [y, mo] = calMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1, 12)), dow = (first.getUTCDay() + 6) % 7;
  const start = first.getTime() - dow * 864e5;
  const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const weeks = Math.ceil((dow + daysIn) / 7);
  const sent = postsLog.filter((p) => p.network !== "all" && p.at && isLive(p)).map((p) => ({ ...p, raw: "posted" }));
  const byDay = new Map();
  for (const p of [...list, ...sent]) { const d = dayOf(p.at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); }
  const L = lang === "ja" ? "ja-JP" : "en-GB";
  const heads = Array.from({ length: 7 }, (_, i) => new Date(start + i * 864e5).toLocaleDateString(L, { weekday: "short", timeZone: "UTC" }));
  let inMonth = 0;
  // A past week with nothing in it is left out: on the current month two empty rows pushed the coming weeks down
  // (owner, 17 Nov: layout). Other months keep every week, so the grid still reads as that month.
  const weekDays = (w) => Array.from({ length: 7 }, (_, k) => new Date(start + (w * 7 + k) * 864e5).toISOString().slice(0, 10));
  const keep = Array.from({ length: weeks }, (_, w) => w).filter((w) => calMonth !== today.slice(0, 7)
    || weekDays(w).some((d) => d >= today || byDay.has(d)));
  // One line per day: its post times and the reel it uses on the most networks (what goes out, without hovering).
  const dayLine = (ps) => {
    if (!ps.length) return "";
    const tz = audTz(), times = [...new Set(ps.map((p) => wallOf(new Date(p.at).getTime(), tz).slice(11)))];
    const top = [...ps.reduce((m, p) => m.set(p.slug, (m.get(p.slug) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0];
    return `<div class="cline"><b>${esc(times.slice(0, 2).join(" · "))}${times.length > 2 ? "…" : ""}</b> <span lang="ja">${esc(reelName(top))}</span></div>`;
  };
  const cells = keep.flatMap((w) => Array.from({ length: 7 }, (_, k) => w * 7 + k)).map((i) => {
    const dt = new Date(start + i * 864e5), d = dt.toISOString().slice(0, 10), wd = i % 7;
    const out = d.slice(0, 7) !== calMonth, hol = HOLIDAYS?.[d];
    const ps = (byDay.get(d) || []).sort((a, b) => new Date(a.at) - new Date(b.at));
    if (!out) inMonth += ps.length;
    const cls = ["cday", d === today ? "today" : "", d < today ? "past" : "", out ? "out" : "", wd === 5 ? "sat" : "", wd === 6 || hol ? "sun" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" data-day="${d}"><div class="cnum"><span class="dn">${dt.getUTCDate()}</span>${hol ? `<span class="hol" title="${esc(holName(hol))}">${esc(holName(hol))}</span>` : ""}${ps.length ? `<b>${ps.length}</b>` : ""}</div>
      ${calThumbs(ps)}${dayLine(ps)}<div class="cchips">${ps.map((p) => `<button class="cchip st-${esc(p.raw || p.status)}${repeats.has(p.id) ? " rep" : ""}${tcTestHour(p) ? " tc-testc" : ""}" data-net="${esc(p.slug)}" data-ch="${esc(p.network)}" data-pid="${p.id}" draggable="${MOVABLE.includes(p.raw || p.status)}"
        title="${esc(`${NET_NAME[p.network] || p.network} · ${whenText(p.at)} · ${reelName(p.slug)}${tcTestHour(p) ? ` · ${tr("tc.testwhy", { h: tcTestHour(p) })}` : ""}`)}" aria-label="${esc(`${NET_NAME[p.network] || p.network} ${whenText(p.at)} ${reelName(p.slug)}`)}">${netLogo(chOf(p.network), "sm")}</button>`).join("")}</div></div>`;
  }).join("");
  const title = first.toLocaleDateString(L, { year: "numeric", month: "long", timeZone: "UTC" });
  return `<div class="calnav"><button class="icon" data-calm="-1" aria-label="${esc(tr("cal.prev"))}" title="${esc(tr("cal.prev"))}">${ico("chev-l", "sm")}</button>
      <h3>${esc(title)}</h3><button class="icon" data-calm="1" aria-label="${esc(tr("cal.next"))}" title="${esc(tr("cal.next"))}">${ico("chev-r", "sm")}</button>
      <button data-calm="0" ${calMonth === today.slice(0, 7) ? "disabled" : ""}>${tr("cal.today")}</button><span class="meta">${tr("cal.count", { n: inMonth })}</span></div>
    <div class="calgrid" role="grid">${heads.map((h, i) => `<div class="chead ${i === 5 ? "sat" : i === 6 ? "sun" : ""}">${esc(h)}</div>`).join("")}${cells}</div>
    <p class="meta calkey"><span class="tc-test" title="${esc(tr("tc.testwhy", { h: "19:00" }))}">${esc(tr("tc.test"))}</span> <span class="cchip k st-scheduled"></span>${tr("pv.k.booked")} <span class="cchip k st-queued"></span>${tr("pv.k.studio")} <span class="cchip k st-planned"></span>${tr("pv.k.hand")} <span class="cchip k st-posted"></span>${tr("cal.k.out")} <span class="cchip k rep"></span>${tr("pv.k.rep")} <span class="dn k sat">${tr("cal.k.sat")}</span> <span class="dn k sun">${tr("cal.k.sun")}</span></p>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-calm]"); if (!b) return;
  const step = +b.dataset.calm, today = dayOf(new Date().toISOString()).slice(0, 7);
  if (!step) calMonth = today;
  else { const [y, m] = (calMonth || today).split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + step, 1)); calMonth = d.toISOString().slice(0, 7); }
  renderHome(true);
});
/* Drag a dashed (studio-sent) or amber (reminder) square to another day: same time of day, one post per network a
   day. Squares booked on a network do not move here (the network holds them). */
const MOVABLE = ["queued", "planned"];
let calDrag = null;
document.addEventListener("dragstart", (e) => {
  const c = e.target.closest?.(".cchip[data-pid]"); if (!c) return;
  if (c.getAttribute("draggable") !== "true") { e.preventDefault(); toast(`${ico("info", "sm")} ${esc(tr("mv.fixed"))}`, 4000); return; }
  calDrag = postsLog.find((p) => p.id === +c.dataset.pid) || null;
  e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.dataset.pid);
});
document.addEventListener("dragover", (e) => { const d = e.target.closest?.(".cday[data-day]"); if (d && calDrag) { e.preventDefault(); d.classList.add("drop"); } });
document.addEventListener("dragleave", (e) => { e.target.closest?.(".cday")?.classList.remove("drop"); });
document.addEventListener("drop", async (e) => {
  const d = e.target.closest?.(".cday[data-day]"); if (!d || !calDrag) return;
  e.preventDefault(); d.classList.remove("drop");
  const p = calDrag; calDrag = null;
  if (dayOf(p.at) === d.dataset.day) return;
  const at = zonedIso(`${d.dataset.day}T${wallOf(new Date(p.at).getTime()).slice(11, 16)}`);
  try {
    await post("/api/posts/move", { id: p.id, at });
    toast(`${ico("check", "sm")} ${esc(tr("mv.done", { s: p.slug, n: NET_NAME[p.network] || p.network, t: whenText(at) }))}`, 5000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  loadPosting();
});
document.addEventListener("dragend", () => { calDrag = null; document.querySelectorAll(".cday.drop").forEach((x) => x.classList.remove("drop")); });
document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-pview]"); if (!v) return;
  e.preventDefault();
  postView = v.dataset.pview; try { localStorage.setItem("lc.post.view2", postView); } catch { /* private window */ }
  const to = `#/posting/${tcViewSlug(postView)}`;  // the view's own address (Track C)
  if (location.hash !== to) location.hash = to; else renderHome(true);
});
