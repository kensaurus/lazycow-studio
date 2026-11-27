/* ---------- Ideas: research on the web (Firecrawl), for a person to read. Nothing here is posted. ---------- */
let researchView = null; const ideasRes = {}, ideasBusy = {};
const IDEA_TOOLS = [
  ["ideas", "search", "idea.ideas", "idea.ideashint"], ["events", "cal", "idea.events", "idea.eventshint"],
  ["site-check", "check", "idea.site", "idea.sitehint"], ["page", "globe", "idea.page", "idea.pagehint"], ["links", "link", "idea.links", "idea.linkshint"],
  ["bluesky", "chat", "bsr.tab", "bsr.advice"],  // BL-100: not a Firecrawl tool, drawn by bsrHtml()
];
async function loadResearch() { try { researchView = await api("/api/research"); } catch { researchView = { ready: false }; } if (page === "ideas") renderHome(true); }
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const srcChip = (u) => `<a class="src" href="${escUrl(u)}" target="_blank" rel="noopener" title="${esc(u)}">${ico("globe", "sm")}${esc(host(u))}</a>`;
function ideaDate(d) {
  const t = new Date(String(d) + "T12:00:00");
  if (isNaN(t)) return `<span class="edate"><b>?</b></span>`;
  return `<span class="edate"><small>${esc(t.toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "short" }))}</small><b>${t.getDate()}</b><small>${esc(t.toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { weekday: "short" }))}</small></span>`;
}
function ideaResult(tool, r) {
  if (!r) return "";
  if (r.error) return `<div class="accerr" role="alert">${ico("alert", "sm")}<div><b>${tr(tool === "page" ? "idea.pagefail" : "idea.fail")}</b><span>${esc(r.error)}</span></div></div>`;
  const head = `<p class="ilead">${esc(r.summary || "")}${r.cached ? ` <span class="chip">${ico("clock", "sm")}${tr("idea.cached")}</span>` : ""}</p>`;
  if (tool === "ideas") return head
    + (r.angles?.length ? `<h3 class="ih">${tr("idea.angles")}</h3><div class="icards">${r.angles.map((a) => `<article class="icard">
        <b>${esc(a.title)}</b><p>${esc(a.why)}</p>
        ${(a.guard || []).length ? `<p class="warnline">${ico("alert", "sm")}${esc(a.guard.join(" · "))}</p>` : ""}
        <div class="srcs">${(a.sources || []).map(srcChip).join("")}</div></article>`).join("")}</div>` : "")
    + (r.hashtags?.length ? `<h3 class="ih">${ico("type", "sm")} ${tr("idea.tags")}</h3><p class="taglist">${r.hashtags.map((h) => `<span class="chip">${esc(h.tag)} <b>${h.count}</b></span>`).join("")}</p>` : "")
    + (r.items?.length ? `<details class="ifold"><summary>${ico("globe", "sm")} ${tr("idea.read")} <span class="chip">${r.items.length}</span></summary><div class="ipages">${r.items.map((i) => `<a class="ipage" href="${escUrl(i.url)}" target="_blank" rel="noopener"><b class="clamp2">${esc(i.title)}</b><span class="meta">${esc(i.source || host(i.url))}${i.date ? " · " + esc(i.date) : ""}</span></a>`).join("")}</div></details>` : "")
    + (r.note ? `<p class="meta">${esc(r.note)}</p>` : "");
  if (tool === "events") return head
    + ((r.events || []).length ? `<div class="ievents">${r.events.map((e) => `<article class="ievent">${ideaDate(e.first)}<div><a href="${escUrl(e.url)}" target="_blank" rel="noopener"><b class="clamp2">${esc(e.title)}</b></a><p class="meta">${esc(e.why || "")}</p>${e.postBy ? `<span class="chip warn">${ico("send", "sm")}${tr("idea.postby", { d: esc(e.postBy) })}</span>` : ""}</div></article>`).join("")}</div>`
      : `<div class="iempty">${ico("cal")}<p>${tr("idea.noevents")}</p></div>`)
    + ((r.undated || []).length ? `<details class="ifold"><summary>${ico("search", "sm")} ${tr("idea.undated")} <span class="chip">${r.undated.length}</span></summary><div class="ipages">${r.undated.map((e) => `<a class="ipage" href="${escUrl(e.url)}" target="_blank" rel="noopener"><b class="clamp2">${esc(e.title)}</b><span class="meta">${esc(e.why || host(e.url))}</span></a>`).join("")}</div></details>` : "");
  if (tool === "site-check") {
    const facts = r.facts || [], bad = facts.filter((f) => f.status === "mismatch").length;
    return head + `<div class="notice ${bad ? "warn" : "ok"}">${ico(bad ? "alert" : "check", "sm")}<span>${tr(bad ? "idea.sitebad" : "idea.siteok", { n: bad })}</span></div>`
      + `<table class="facts"><tbody>${facts.map((f) => `<tr class="f-${esc(f.status)}"><td><span class="tag t-${esc(f.status)}">${esc(tr({ match: "idea.match", mismatch: "idea.mismatch", unsure: "idea.unsure", not_on_site: "idea.notonsite" }[f.status] || "idea.unsure"))}</span></td><td>${esc(f.message || "")}</td></tr>`).join("")}</tbody></table>`;
  }
  if (tool === "page") return head
    + `<div class="icols">${r.sellingPoints?.length ? `<section><h3 class="ih">${tr("idea.points")}</h3><ul class="ibullets">${r.sellingPoints.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
      ${r.theySayWeDont?.length ? `<section><h3 class="ih">${tr("idea.theysay")}</h3><ul class="ibullets">${r.theySayWeDont.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}</div>`
    + (r.note ? `<p class="meta">${esc(r.note)}</p>` : "");
  if (tool === "links") {
    const bad = [...(r.broken || []), ...(r.unsure || [])];
    return head + (bad.length ? `<div class="ipages">${bad.map((l) => `<div class="ipage"><span class="tag t-${l.status === "broken" ? "mismatch" : "unsure"}">${esc(l.status)}</span> ${srcChip(l.url)}<span class="meta">${esc(l.why || "")}</span></div>`).join("")}</div>`
      : `<div class="notice ok">${ico("check", "sm")}<span>${tr("idea.linksok")}</span></div>`);
  }
  return head;
}
/* Reels › Words: the approved lines every reel draws from, how often each is used, lines the owner adds,
   AI suggestions waiting for a yes, and the reels that repeat another reel's words. */
let wordsView = null, wordsBusy = "", wordsAdd = false;
let wordsLoading = false;
async function loadWords() {
  if (wordsLoading) return;
  wordsLoading = true;
  try { wordsView = await api("/api/words"); } catch (e) { wordsView = { error: e.message }; } finally { wordsLoading = false; }
  if (page === "words") renderHome(true);
}
function renderWords() {
  const head = `<div class="pagehead">${crumbs([tr("nav.reels"), "#/"], [tr("nav.words")])}</div>`;
  if (!wordsView) { loadWords(); $("#home").innerHTML = head + `<p class="note">${ico("hourglass", "sm")} ${tr("w.loading")}</p>`; return; }
  if (wordsView.error) { $("#home").innerHTML = head + `<div class="accerr" role="alert">${ico("alert", "sm")}<div><b>${tr("idea.fail")}</b><span>${esc(wordsView.error)}</span></div></div>`; return; }
  const W = wordsView, ap = W.approved || { hook: 0, line: 0 };
  const repeats = overview.reels.filter((r) => mayPost(r) && r.sameWords > 0).sort((a, b) => b.sameWords - a.sameWords);
  const pending = overview.reels.filter((r) => !r.house && r.wordsPending && !busyJob(r));
  const perHook = W.reels && ap.hook ? Math.round(W.reels / ap.hook) : 0;
  const waiting = W.lines.filter((l) => l.status === "suggested");
  const tile = (n, label, tone = "") => `<div class="wtile ${tone}"><b>${n}</b><span>${label}</span></div>`;
  const lineRow = (l) => `<tr class="w-${l.status}">
      <td><span class="chip ${l.kind === "hook" ? "ok" : ""}">${tr(l.kind === "hook" ? "w.hook" : "w.line")}</span></td>
      <td title="${esc(`${l.ja.replace(/\n/g, " ")}\n${l.en || ""}`)}"><div class="wja">${esc(l.ja)}</div><div class="meta">${esc(l.en || "")}</div></td>
      <td class="meta">${l.reels ? tr("w.used", { n: l.reels }) : tr("w.unused")}${l.months ? ` · ${tr("w.months", { m: l.months.join(", ") })}` : ""}</td>
      <td class="meta" title="${esc([l.source, l.why].filter(Boolean).join("\n"))}">${esc(/\.(ts|tsx|js|json|md)\b/.test(l.source || "") ? tr("w.src.site") : l.source || "")}</td>
      <td>${l.status === "retired" ? `<button data-wstatus="approved" data-ja="${esc(l.ja)}">${tr("w.use")}</button>` : `<button class="linkbtn" data-wstatus="retired" data-ja="${esc(l.ja)}">${tr("w.retire")}</button>`}</td></tr>`;
  const kept = W.lines.filter((l) => l.status !== "suggested");
  const tabN = { headlines: kept.filter((l) => l.kind === "hook").length, lines: kept.length, waiting: waiting.length, same: repeats.length };
  const tabWarn = { waiting: waiting.length > 0, same: repeats.length > 0 };
  const tabs = `<nav class="tabs posttabs ly-tabs" role="tablist" aria-label="${esc(tr("nav.words"))}">${W_TABS.map((t) => `<a role="tab" href="#/words/${t}" aria-selected="${wTab === t}" class="${wTab === t ? "on" : ""}">${esc(tr("ly_w.t." + t))}<span class="ly-n${tabWarn[t] ? " warn" : ""}">${tabN[t]}</span></a>`).join("")}</nav>`;
  const growHtml = `<section class="panel"><div class="row"><h3>${ico("type")} ${tr("w.grow")}</h3></div>
      <p class="note">${tr("w.growhint")}</p>
      ${ap.hook + ap.line ? "" : `<p class="note warnline">${ico("info", "sm")} ${tr("w.needfirst")}</p>`}
      <div class="row"><button class="${ap.hook + ap.line ? "primary" : ""}" data-wsug="1" ${wordsBusy || !(ap.hook + ap.line) ? "disabled" : ""}>${ico("type", "sm")}${wordsBusy === "suggest" ? tr("w.thinking") : tr("w.suggest")}</button><button class="${ap.hook + ap.line ? "" : "primary"}" data-waddopen="1">${ico("plus", "sm")}${tr("w.add")}</button></div>
      ${wordsAdd ? `<form class="wadd" data-waddform="1"><label>${tr("w.kind")} <select name="kind"><option value="hook">${tr("w.hook")}</option><option value="line" selected>${tr("w.line")}</option></select></label>
        <label>${tr("w.ja")}<textarea name="ja" rows="2" maxlength="60" required></textarea></label><label>${tr("w.en")}<input name="en" maxlength="200" required></label>
        <div class="row"><button class="primary" type="submit">${tr("w.save")}</button><button type="button" data-waddopen="1">${tr("w.cancel")}</button></div><p class="note">${tr("w.addhint")}</p></form>` : ""}
      ${waiting.length ? `<h4>${tr("w.waiting", { n: waiting.length })}</h4><div class="wwait">${waiting.map((l) => `<div class="wsug"><div><div class="wja">${esc(l.ja)}</div><div class="meta">${esc(l.en)}</div>${l.why ? `<div class="meta">${tr("w.from")}: ${esc(l.why)}</div>` : ""}</div>
        <div class="row"><button class="primary" data-wstatus="approved" data-ja="${esc(l.ja)}">${ico("check", "sm")}${tr("w.approve")}</button><button data-wstatus="retired" data-ja="${esc(l.ja)}">${tr("w.reject")}</button></div></div>`).join("")}</div>` : `<p class="meta">${esc(tr("ly_w.nowaiting"))}</p>`}
    </section>`;
  const sameHtml = repeats.length || pending.length ? `<section class="panel"><div class="row"><h3>${ico("alert")} ${tr("w.dups", { n: repeats.length })}</h3><span class="grow"></span>
        ${repeats.length ? `<button class="primary" data-rewordall="1" ${wordsBusy ? "disabled" : ""}>${wordsBusy === "all" ? tr("w.working") : tr("w.rewordall", { n: repeats.length })}</button>` : ""}
        ${pending.length ? `<button data-renderall="1" ${wordsBusy ? "disabled" : ""}>${ico("clapper", "sm")}${tr("w.renderall", { n: pending.length, t: span(pending.length * 6 * 60) })}</button>` : ""}</div>
      <p class="note">${tr("w.dupshint")}</p>
      <div class="wdups">${repeats.slice(0, 40).map((r) => `<div class="wdup"><a href="#/reel/${esc(r.slug)}"><b>${esc(r.slug)}</b></a><span class="meta clamp">${esc(r.hookText || "")}</span><span class="warnline meta">${tr("w.same", { n: r.sameWords })}</span><button class="linkbtn" data-reword="${esc(r.slug)}">${tr("w.reword")}</button></div>`).join("")}</div>
      ${repeats.length > 40 ? `<p class="meta">${esc(tr("rv.more", { n: repeats.length - 40 }))}</p>` : ""}</section>`
    : `<div class="empty">${ico("check")}<b>${esc(tr("ly_w.nosame"))}</b><span>${tr("w.dupshint")}</span></div>`;
  // Lines: every kept line, filtered by kind and words, a page at a time.
  const lq = lQ.trim().toLowerCase();
  const lines = kept.filter((l) => (lKind === "all" || (lKind === "retired" ? l.status === "retired" : l.kind === lKind)) && (!lq || `${l.ja} ${l.en || ""} ${l.source || ""}`.toLowerCase().includes(lq)));
  const LP = 20, lAt =Math.min(lPage, Math.max(0, Math.ceil(lines.length / LP) - 1));
  const linesHtml = `<section class="panel"><div class="row wrap ly-filters"><div class="seg" role="toolbar" aria-label="${esc(tr("ly_w.kind"))}">${["all", "hook", "line", "retired"].map((k) => `<button class="${lKind === k ? "on" : ""}" aria-pressed="${lKind === k}" data-wlkind="${k}">${esc(tr("ly_w.k." + k))}<span>${k === "all" ? kept.length : kept.filter((l) => (k === "retired" ? l.status === "retired" : l.kind === k)).length}</span></button>`).join("")}</div>
      <label class="ly-find">${ico("search", "sm")}<input type="search" data-lq="1" data-lyfocus="lq" value="${esc(lQ)}" placeholder="${esc(tr("ly_w.find"))}" aria-label="${esc(tr("ly_w.find"))}"></label><span class="grow"></span>${lyPager(lAt, lines.length, LP, "data-wlpage")}</div>
      ${lines.length ? `<div class="tablewrap"><table class="wtable ly-table"><thead><tr><th></th><th>${tr("w.text")}</th><th>${tr("w.usedh")}</th><th>${tr("w.src")}</th><th></th></tr></thead>
      <tbody>${lines.slice(lAt * LP, lAt * LP + LP).map(lineRow).join("")}</tbody></table></div>` : `<p class="note">${tr(kept.length ? "ly_w.nomatch" : "w.nolines")}</p>`}</section>`;
  const body = { headlines: () => wHeadlinesHtml(), lines: () => linesHtml, waiting: () => growHtml, same: () => sameHtml }[wTab] || (() => wHeadlinesHtml());
  lyKeepFocus(() => { $("#home").innerHTML = `${head}
    <p class="intro">${tr("w.intro")}</p>
    <div class="wtiles ly-tiles" ${W.reels || kept.length ? "" : "hidden"}>${tile(W.reels, tr("w.reels"))}${tile(W.wordSets, tr("w.sets"), W.wordSets < W.reels / 2 ? "warn" : "")}${tile(W.hooksUsed, tr("w.hooks"))}${tile(repeats.length, tr("w.repeat"), repeats.length ? "warn" : "ok")}${tile(`${ap.hook} · ${ap.line}`, tr("w.bankn"))}</div>
    ${perHook > 4 ? `<div class="notice warn">${ico("alert", "sm")}<span>${tr("w.low", { n: W.reels, k: perHook })}</span></div>` : ""}
    ${tabs}${body()}`; });
}
/* ---------- layout pass (18 Nov): Words in four tabs (#/words/headlines · lines · waiting · same). Headlines is a compact
   sortable table with the wear bar, a page at a time; a headline's reels, dates and networks open in the side panel
   beside it instead of folding open inside the list (the page was 13 screens). ---------- */
const W_TABS = ["headlines", "lines", "waiting", "same"];
let wTab = "headlines", wSel = "", wSort = "wear", wPage = 0, lPage = 0, lKind = "all", lQ = "";
function lyPager(at, total, per, attr) {
  if (total <= per) return "";
  const pages = Math.ceil(total / per);
  return `<div class="ly-pager"><span class="meta">${esc(tr("ly_p.range", { a: at * per + 1, b: Math.min(total, (at + 1) * per), n: total }))}</span>
    <button type="button" class="icon" ${attr}="${at - 1}" ${at <= 0 ? "disabled" : ""} aria-label="${esc(tr("ly_p.prev"))}" title="${esc(tr("ly_p.prev"))}">${ico("chev-l", "sm")}</button>
    <button type="button" class="icon" ${attr}="${at + 1}" ${at >= pages - 1 ? "disabled" : ""} aria-label="${esc(tr("ly_p.next"))}" title="${esc(tr("ly_p.next"))}">${ico("chev-r", "sm")}</button></div>`;
}
/* A redraw keeps the caret in a search box the person is typing in (the boxes carry data-lyfocus). */
function lyKeepFocus(draw) {
  const a = document.activeElement, key = a?.dataset?.lyfocus, at = key ? [a.selectionStart, a.selectionEnd] : null;
  draw();
  if (!key) return;
  const b = document.querySelector(`[data-lyfocus="${key}"]`); b?.focus(); try { b?.setSelectionRange(at[0], at[1]); } catch { /* not a text box */ }
}
function wHeadlinesHtml() {
  if (!postsLoaded) return `<section class="panel"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:70%"></div></section>`;
  const all = cWearData();
  if (!all.length) return `<p class="note">${tr("w.nolines")}</p>`;
  const by = { wear: () => 0, uses: (a, b) => (b.out + b.booked) - (a.out + a.booked), last: (a, b) => (b.last || 0) - (a.last || 0),
    result: (a, b) => (b.ratio ?? -1) - (a.ratio ?? -1), text: (a, b) => a.l.ja.localeCompare(b.l.ja, "ja") };
  const rows = [...all].sort(by[wSort] || by.wear);
  const PER = 20, at = Math.min(wPage, Math.ceil(rows.length / PER) - 1);
  const top = Math.max(1, ...rows.map((x) => x.out + x.booked)), worn = rows.filter((x) => x.worn).length, L = lang === "ja" ? "ja-JP" : "en-GB";
  const day = (t) => new Date(t).toLocaleDateString(L, { day: "numeric", month: "short" });
  const sel = rows.find((x) => x.l.ja === wSel) || rows[0];
  const fresh = !moCalm() && !moState().shown.has("c:wear");
  if (fresh) moState().shown.add("c:wear");
  const res = (x) => x.ratio == null ? `<span class="cw-res none">${esc(tr(x.measured ? "c_wr.few" : "c_wr.nonum"))}</span>`
    : `<span class="cw-res ${x.ratio >= 1.15 ? "up" : x.ratio <= 0.85 ? "down" : "even"}" title="${esc(tr("c_wr.restip", { n: x.measured }))}">${x.ratio >= 1.15 ? "▲" : x.ratio <= 0.85 ? "▼" : "＝"} ${esc(tr("c_wr.ratio", { r: x.ratio.toFixed(1) }))}</span>`;
  const act = (x) => x.l.status === "retired" ? `<button data-wstatus="approved" data-ja="${esc(x.l.ja)}">${tr("w.use")}</button>` : x.worn ? `<button data-wstatus="retired" data-ja="${esc(x.l.ja)}">${tr("w.retire")}</button>` : "";
  const mark = (x) => x.worn ? `<b class="cw-worn">${esc(tr("c_wr.worn"))}</b>` : !x.out && !x.booked ? `<b class="cw-fresh">${esc(tr("c_wr.fresh"))}</b>` : "";
  const th = (k, label) => `<th${wSort === k ? ' aria-sort="descending"' : ""}><button type="button" class="ly-sort${wSort === k ? " on" : ""}" data-wsort="${k}">${esc(label)}${wSort === k ? ico("chev-u", "sm") : ""}</button></th>`;
  const row = (x, i) => `<tr class="${x.worn ? "worn" : ""}${x === sel ? " on" : ""}" data-wsel="${esc(x.l.ja)}" tabindex="0" aria-selected="${x === sel}" style="--i:${i}">
      <td class="wt-mark">${mark(x)}</td>
      <td class="wt-text"><span class="wja" lang="ja">${esc(x.l.ja.replace(/\n/g, " "))}</span><span class="meta">${esc(x.l.en || "")}</span></td>
      <td class="wt-bar"><span class="cw-track" role="img" aria-label="${esc(tr("c_wr.bararia", { o: x.out, b: x.booked, n: x.near, m: x.nets }))}"><i class="o" style="--w:${(x.out / top).toFixed(3)}"></i><i class="b" style="--w:${(x.booked / top).toFixed(3)}"></i></span><span class="cw-num"><b>${x.out}</b> · <b>${x.booked}</b></span></td>
      <td class="meta wt-nets" title="${esc(tr("c_wr.netstip"))}">${x.near}/${x.nets}</td>
      <td class="meta">${x.last ? esc(day(x.last)) : "—"}</td>
      <td>${res(x)}</td><td class="wt-act">${act(x)}</td></tr>`;
  // The side panel: the selected headline's numbers, its reels and every post that carries it.
  const slugs = new Set(sel.reels.map((r) => r.slug));
  const posts = postsLog.filter((p) => slugs.has(p.slug) && p.network !== "all" && holdsSlot(p)).sort((a, b) => new Date(b.at) - new Date(a.at));
  const side = `<aside class="ly-side panel" aria-label="${esc(tr("ly_w.detail"))}">
      <div class="ly-sh">${mark(sel)}<b class="wja" lang="ja">${esc(sel.l.ja.replace(/\n/g, " "))}</b><span class="meta">${esc(sel.l.en || "")}</span></div>
      <dl class="ly-kv"><dt>${esc(tr("c_wr.out"))}</dt><dd>${sel.out}</dd><dt>${esc(tr("c_wr.booked"))}</dt><dd>${sel.booked}</dd>
        <dt>${esc(tr("ly_w.near"))}</dt><dd>${esc(tr("c_wr.nets", { n: sel.near, m: sel.nets }))}</dd>
        <dt>${esc(tr("ly_w.when"))}</dt><dd>${esc([sel.last ? tr("c_wr.last", { d: day(sel.last) }) : tr("c_wr.never"), sel.next ? tr("c_wr.next", { d: day(sel.next) }) : ""].filter(Boolean).join(" · "))}</dd>
        <dt>${esc(tr("ly_w.result"))}</dt><dd>${res(sel)}</dd></dl>
      ${act(sel) ? `<div class="row">${act(sel)}</div>` : ""}
      <h4>${esc(tr("ly_w.reels", { n: sel.reels.length }))}</h4>
      <div class="cw-reels ly-reels">${sel.reels.length ? sel.reels.slice(0, 24).map((r) => `<a href="#/reel/${esc(r.slug)}" title="${esc(reelName(r.slug))}" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"><span>${esc(stateLine(r, reelState(r)))}</span></a>`).join("") + (sel.reels.length > 24 ? `<span class="meta">+${sel.reels.length - 24}</span>` : "") : `<span class="meta">${esc(tr("c_wr.noreels"))}</span>`}</div>
      <h4>${esc(tr("ly_w.posts", { n: posts.length }))}</h4>
      ${posts.length ? `<ul class="ly-posts">${posts.slice(0, 40).map((p) => `<li><b>${esc(NET_NAME[p.network] || p.network)}</b><span class="meta">${esc(new Date(p.at).toLocaleDateString(L, { day: "numeric", month: "short", weekday: "short" }))}</span><span class="ly-pst ${isLive(p) ? "o" : "b"}">${esc(tr(isLive(p) ? "c_wr.out" : "c_wr.booked"))}</span></li>`).join("")}</ul>` : `<p class="meta">${esc(tr("ly_w.noposts"))}</p>`}</aside>`;
  return `<div class="ly-md"><section class="panel cw ly-wt${fresh ? " in" : ""}"><div class="row wrap">${worn ? `<span class="chip warn">${esc(tr("c_wr.nworn", { n: worn }))}</span>` : `<span class="chip ok">${esc(tr("c_wr.noworn"))}</span>`}
      <span class="cw-key meta"><i class="o"></i>${esc(tr("c_wr.out"))} <i class="b"></i>${esc(tr("c_wr.booked"))}</span><span class="grow"></span>${lyPager(at, rows.length, PER, "data-wpage")}</div>
    <p class="note">${esc(tr("c_wr.how", { k: Math.max(2, Math.ceil(Math.max(1, PLAN_NETS().length) * 0.6)), m: PLAN_NETS().length }))}</p>
    <div class="tablewrap"><table class="ly-table wt"><thead><tr><th></th>${th("text", tr("w.text"))}${th("uses", tr("ly_w.used"))}<th>${esc(tr("ly_w.nets"))}</th>${th("last", tr("ly_w.last"))}${th("result", tr("ly_w.result"))}<th></th></tr></thead>
      <tbody>${rows.slice(at * PER, at * PER + PER).map(row).join("")}</tbody></table></div>
    ${wSort !== "wear" ? `<p class="meta"><button type="button" class="linkbtn" data-wsort="wear">${esc(tr("ly_w.bywear"))}</button></p>` : ""}</section>${side}</div>`;
}
document.addEventListener("click", (e) => {
  const t = e.target;
  const so = t.closest?.("[data-wsort]"); if (so) { wSort = so.dataset.wsort; wPage = 0; renderHome(true); return; }
  const wp = t.closest?.("[data-wpage]"); if (wp) { wPage = Math.max(0, +wp.dataset.wpage); renderHome(true); return; }
  const lp = t.closest?.("[data-wlpage]"); if (lp) { lPage = Math.max(0, +lp.dataset.wlpage); renderHome(true); return; }
  const lk = t.closest?.("[data-wlkind]"); if (lk) { lKind = lk.dataset.wlkind; lPage = 0; renderHome(true); return; }
  const r = t.closest?.("tr[data-wsel]"); if (r && !t.closest("button, a")) { wSel = r.dataset.wsel; renderHome(true); document.querySelector(`tr[data-wsel="${CSS.escape(wSel)}"]`)?.focus({ preventScroll: true }); }
});
document.addEventListener("keydown", (e) => {
  const r = e.target.closest?.("tr[data-wsel]"); if (!r) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.click(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = e.key === "ArrowDown" ? r.nextElementSibling : r.previousElementSibling; if (n) { n.focus(); n.click(); } }
});
document.addEventListener("input", (e) => { const q = e.target.closest?.("[data-lq]"); if (!q) return; lQ = q.value; lPage = 0; renderHome(true); });
document.addEventListener("click", async (e) => {
  const rw = e.target.closest("[data-reword]");
  if (rw) {
    e.stopPropagation(); e.preventDefault(); rw.disabled = true;
    try { const r = await post("/api/words/reword", { slug: rw.dataset.reword }); toast(`${ico("type", "sm")} ${tr("w.done", { s: esc(r.slug), h: esc(r.beats.find((b) => b.kind === "hook")?.ja.replace(/\n/g, " ") || "") })}`, 6000); wordsView = null; await loadOverview(); renderHome(true); }
    catch (err) { rw.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return;
  }
  if (e.target.closest("[data-rewordall]")) {
    const list = overview.reels.filter((r) => mayPost(r) && r.sameWords > 0);
    wordsBusy = "all"; renderHome(true);
    let ok = 0;
    for (const r of list) { try { await post("/api/words/reword", { slug: r.slug }); ok++; } catch { /* a reel without a theme keeps its words */ } }
    wordsBusy = ""; wordsView = null; await loadOverview(); renderHome(true);
    toast(`${ico("type", "sm")} ${tr("w.alldone", { n: ok })}`, 7000);
    return;
  }
  if (e.target.closest("[data-renderall]")) {
    const list = overview.reels.filter((r) => !r.house && r.wordsPending && !busyJob(r));
    wordsBusy = "render"; renderHome(true);
    for (const r of list) { try { const pj = await api("/api/project?slug=" + encodeURIComponent(r.slug)); await post("/api/project", { project: pj, render: true }); } catch { /* shown on its card */ } }
    wordsBusy = ""; await loadOverview(); renderHome(true);
    toast(`${ico("clapper", "sm")} ${tr("w.queued", { n: list.length })}`, 7000);
    return;
  }
  if (e.target.closest("[data-wsug]")) {
    wordsBusy = "suggest"; renderHome(true);
    try { const r = await post("/api/words", { action: "suggest", n: 8 }); toast(`${ico("check", "sm")} ${tr("w.sugdone", { n: r.suggested.length, d: r.dropped.length })}`, 7000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    wordsBusy = ""; wordsView = null; renderHome(true);
    return;
  }
  if (e.target.closest("[data-waddopen]")) { wordsAdd = !wordsAdd; renderHome(true); return; }
  const ws = e.target.closest("[data-wstatus]");
  if (ws) {
    ws.disabled = true;
    try { await post("/api/words", { action: "status", ja: ws.dataset.ja, status: ws.dataset.wstatus }); wordsView = null; renderHome(true); }
    catch (err) { ws.disabled = false; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    return;
  }
  if (e.target.closest("#drawWords") && edit) {
    const b = e.target.closest("#drawWords"); b.disabled = true;
    try {
      const r = await post("/api/words/reword", { slug: edit.slug, preview: true });
      commit(() => {
        let k = 0;
        const lines = r.beats.filter((x) => x.kind !== "end");
        edit.beats = edit.beats.map((x) => (x.kind === "end" ? x : { ...x, ja: lines[k]?.ja ?? x.ja, en: lines[k++]?.en ?? x.en }));
        edit.style = r.style; edit.yt_title = r.yt_title; edit.tags = r.tags; edit.posts = r.posts; edit.keep = { ...(edit.keep || {}), words: r.words };
      }, tr("w.drawn"));
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
    b.disabled = false;
    return;
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-waddform]");
  if (!f) return;
  e.preventDefault();
  const d = new FormData(f);
  try { await post("/api/words", { action: "add", kind: d.get("kind"), ja: String(d.get("ja") || ""), en: String(d.get("en") || "") }); wordsAdd = false; wordsView = null; toast(`${ico("check", "sm")} ${tr("w.added")}`); renderHome(true); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
});
let ideaTab = "ideas";
const ideaStarted = {};
/* Reels › Review: every reel waiting for a person, one row each: its shots, its words and checks, a player, and the
   three decisions (approve, new words, open in the editor). Rows load their details as they come into view. */
const revCache = {}; let revBusy = "", revPlay = "";
async function loadRev(slug) { if (revCache[slug]) return; revCache[slug] = "loading"; try { revCache[slug] = await api("/api/reel?slug=" + encodeURIComponent(slug)); } catch { revCache[slug] = { error: true }; } if (page === "review") renderHome(true); }
function reviewList() { return overview.reels.filter((r) => !r.house && r.rendered && r.status === "rendered" && !busyJob(r) && !r.wordsPending); }
/* What Approve leads to, in one sentence that follows the Runs by itself switch (fresh-user review: "the user can't
   tell if Approve posts now"). */
/* What the studio does by itself, said where people see work happen without having pressed anything (fresh-user
   review: "Being made went from 1 to 4 and nothing explains it"). Follows the Runs by itself switches. */
function autoNote() {
  if (autoView === null && !autoLoading) { autoLoading = true; api("/api/autopost").then((v) => { autoView = v; }).catch(() => {}).finally(() => { autoLoading = false; if (["reels", "making"].includes(page)) renderHome(true); }); }
  const pl = autoView?.settings?.plan;
  if (!pl) return "";
  return `<p class="note autonote">${ico("clock", "sm")} ${pl.on ? tr("auto.on", { h: String(pl.hour ?? 9).padStart(2, "0") }) : tr("auto.off")}${autoView.settings.verify?.on ? " " + tr("auto.check") : ""} ${tr("auto.yours")} <a href="#/posting">${tr("auto.see")} ›</a></p>`;
}
function afterApprove() {
  rvFresh();
  const w = rvWhere(), manual = autoView?.settings?.plan?.on === false;
  if (w && !w.ready.length) return tr(manual ? "rv.after.nonemanual" : "rv.after.none");
  return tr(manual ? "rv.after.manual" : "rv.after.auto");
}
/* Where an approved reel is booked: the project's posting networks, and Instagram Stories when they are connected.
   Shown on each review row so Approve says what it leads to (17 Nov design pass). */
function goesNets() { return [...PLAN_NETS(), ...(connections?.["instagram-story"]?.connected ? ["instagram-story"] : [])]; }
/* ---------- BL-132 (first-run walk 26 Nov): what Approve does with no network connected ----------
   Approve (POST /api/approve, py/studio/review_actions.approve) marks the reel approved and copies its files to the
   ready folder; it books nothing. The daily plan (server/review.mjs autoPlan) then books approved reels only on the
   networks it can post to now (autoReady: connected, or Chrome linked for the networks Chrome posts; GET /api/autopost
   "ready"). With none ready nothing is booked, and the page said "Approving means it will be posted" and "Would land on
   TikTok / X Thu 19:00". Now it says the reel is kept, and the first approval asks where it should go: Connect (Settings
   › Accounts, at that network) or Not now (it stays approved; asked again next visit). */
function rvSplit(nets, ready) {
  if (!ready || typeof ready !== "object") return null;  // an older server, or not read yet: say what it said before
  return { ready: nets.filter((n) => n === "instagram-story" || ready[n] === true), missing: nets.filter((n) => n in ready && ready[n] !== true) };
}
const rvWhere = () => rvSplit(goesNets(), autoView?.ready);
/* The plan's view goes stale once a network is connected elsewhere: read it again on Review at most every 30 s. */
function rvFresh() {
  if (autoLoading || (autoView !== null && Date.now() - (rvFresh.at || 0) < 30e3)) return;
  autoLoading = true; rvFresh.at = Date.now();
  api("/api/autopost").then((v) => { autoView = v; }).catch(() => {}).finally(() => { autoLoading = false; if (page === "review" && atHome()) renderHome(true); });
}
let rvAsk = null;  // {slug}: the approval that asked "Where should this go?"
const rvNotNow = () => { try { return sessionStorage.getItem("rv.notnow") === "1"; } catch { return false; } };
const rvConnectLinks = (nets) => nets.map((n) => `<a class="btn rv-conn" href="#/accounts" data-rvconnect="${esc(n)}">${netLogo(chOf(n), "sm")}${esc(tr("rv.ask.connect", { n: NET_NAME[n] || n }))}</a>`).join("");
/* A row's "where it goes" line when no network can take it: kept, not booked, and where to connect. */
function rvNoNetHtml(r, w) {
  return `<div class="rvgoes rv-nonet"><span class="meta">${ico("info", "sm")} ${esc(tr(r.status === "approved" ? "rv.nonet.kept" : "rv.nonet"))}</span>${w.missing.map((n) => netLogo(chOf(n), "sm")).join("")}
    <a class="rv-nonet-go" href="#/accounts" data-rvconnect="${esc(w.missing[0] || "")}">${esc(tr("rv.nonet.go"))} ›</a></div>`;
}
/* The ask, right after an approval that nothing can book: inline at the top of Review, never a pop-up. */
function rvAskHtml() {
  const w = rvWhere();
  if (!rvAsk || !w || w.ready.length) return "";
  return `<section class="rv-ask panel" role="region" aria-labelledby="rvAskT" tabindex="-1"><h3 id="rvAskT">${ico("send", "sm")} ${esc(tr("rv.ask.h"))}</h3>
    <p class="meta">${esc(tr(autoView?.settings?.plan?.on === false ? "rv.ask.bodymanual" : "rv.ask.body", { s: reelName(rvAsk.slug) }))}</p>
    <div class="rv-ask-acts">${w.missing.length ? rvConnectLinks(w.missing) : `<a class="btn" href="#/accounts">${esc(tr("rv.nonet.go"))} ›</a>`}
      <button type="button" class="linkish" data-rvnotnow="1">${esc(tr("rv.ask.notnow"))}</button></div></section>`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest?.("[data-rvnotnow]")) { rvAsk = null; try { sessionStorage.setItem("rv.notnow", "1"); } catch { /* private window */ } toast(`${ico("check", "sm")} ${esc(tr("rv.ask.kept"))}`, 5000); renderHome(true); return; }
  const c = e.target.closest?.("[data-rvconnect]"); if (!c) return;
  rvAsk = null;
  // Settings › Accounts, at that network's row (or the Chrome box that holds the networks your Chrome posts).
  const n = c.dataset.rvconnect;
  let tries = 0;
  const show = () => {
    const el = page === "accounts" && ((n && document.getElementById("acc-" + n)) || document.querySelector("#home [data-chromeconnect]")?.closest(".helpnote"));
    if (!el) { if (++tries < 15) setTimeout(show, 300); return; }  // the page draws once its accounts are read
    el.closest("details")?.setAttribute("open", "");
    el.scrollIntoView({ block: "center", behavior: moCalm() ? "auto" : "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  };
  setTimeout(show, 300);
});
function renderReview() {
  const one = revOnly && overviewLoaded ? overview.reels.find((r) => r.slug === revOnly) : null;
  const list = one ? [one] : reviewList();
  const head = `<div class="pagehead">${crumbs([tr("nav.reels"), "#/"], [tr("nav.review")])}<span class="meta">${overviewLoaded ? tr("rv.count", { n: list.length }) : "…"}</span></div>`
    + (list.length ? `<p class="note rvafter">${ico("info", "sm")} ${afterApprove()}</p>` : "") + rvAskHtml();
  if (!overviewLoaded) { $("#home").innerHTML = head + loadingHtml(tr("nav.review")); return; }
  const where = rvWhere();
  if (!list.length) {
    const any = overview.reels.some((r) => !r.house);
    $("#home").innerHTML = head + `<div class="empty mascot">${kenji("lounge")}<b>${tr("rv.none")}</b><span>${tr("rv.nonehint")}</span>${any ? `<a class="btn" href="#/posting">${tr("rv.toposting")}</a>` : `<button class="primary" data-openmaker="1">${ico("clapper", "sm")}${tr("act.make")}</button>`}</div>`;
    return;
  }
  // Master-detail (layout pass, 18 Nov): the queue on the left, one reel in focus on the right. A reel that left the
  // queue (approved) hands the focus to the one now in its place.
  let at = list.findIndex((r) => r.slug === revFocus);
  if (at < 0) at = Math.min(rvAt, list.length - 1);
  rvAt = at; revFocus = list[at].slug;
  list.slice(at, at + 3).forEach((r) => { if (!revCache[r.slug]) loadRev(r.slug); });  // the one in focus and the next two
  const row = (r) => {
    const m = revCache[r.slug];
    const ready = m && m !== "loading" && !m.error;
    const words = ready ? (m.beats || []).filter((b) => b.kind !== "end") : [];
    const isEx = vxType(r) === "explainer";  // an explainer shows its scenes, not clips (py/studio/explainer.py)
    const strip = ready && isEx ? `<span class="rvkinds">${(m.explainer?.scenes || []).map((k) => `<span class="tag">${esc(k)}</span>`).join("")}</span>`
      : ready ? (m.shots || []).map((x) => `<span class="rvshot" style="background-image:url('${thumb(x.thumb, 120)}')" title="${esc(`${x.file} · ${x.sec}s`)}">${x.faces ? `<i class="rvface">${ico("user", "sm")}</i>` : ""}</span>`).join("") : `<div class="skel"><i></i></div>`;
    const flags = [isEx ? `<span class="tag rv-cut">${ico("info", "sm")}${esc(tr("vx.one.explainer"))}</span>` : `<span class="tag rv-cut" title="${esc(tr(cutKey(r.variant) + "hint"))}">${ico(r.variant === "site-walk" ? "camera" : r.variant === "b-explainer" ? "list" : "film", "sm")}${esc(tr(cutKey(r.variant)))}</span>`, tdAutoTag(r), r.faces > 0 && !r.consent && !r.blurFaces && !consentAll() ? `<span class="tag t-unsure">${ico("user", "sm")}${tr("rv.faces", { n: r.faces })}</span>` : "",
      lookChecks(r).length ? `<span class="tag t-unsure">${ico("alert", "sm")}${tr(lookChecks(r).length === 1 ? "card.check1" : "card.checkn", { n: lookChecks(r).length })}</span>` : "",
      r.sameWords > 0 ? `<span class="tag t-mismatch">${tr("w.same", { n: r.sameWords })}</span>` : `<span class="tag t-match">${tr("rv.unique")}</span>`,
      (m?.layers || []).length ? `<span class="tag" title="${esc(tr("rv.layerstip"))}">${ico("layers", "sm")}${tr((m.layers || []).length === 1 ? "rv.layers1" : "rv.layers", { n: (m.layers || []).length })}</span>` : ""].join("");
    const video = ready && revPlay === r.slug ? `<video class="rvvid" src="${file(m.outputs["9x16"])}" controls autoplay playsinline></video>`
      : `<button class="rvposter" data-revplay="${esc(r.slug)}" data-vid="${esc(reelVid(r))}" style="background-image:url('${r.hook ? thumb(r.hook, 240) + "&v=" + (r.updated || 0) : ""}')" aria-label="${esc(tr("rv.play"))}">${ico("play")}</button>`;
    return `<article class="rvrow rvfocus panel" aria-label="${esc(reelName(r.slug))}">${video}
      <div class="rvbody"><div class="row-tight"><a href="#/reel/${esc(r.slug)}" title="${esc(r.slug)}"><b lang="ja">${esc(reelName(r.slug))}</b></a>${scoreBadge(r.slug)}<span class="meta">${tr("rv.meta", { s: r.seconds, n: r.clips, look: esc(nameOf("looks", r.look || "") || "") })}</span></div>
        ${scoreMap?.[r.slug] ? `<div class="meta">${esc(scoreTitle(scoreMap[r.slug]))}</div>` : ""}
        ${tdWhyChip(r.slug)}
        <div class="rvwords">${words.map((b) => `<span class="${b.kind === "hook" ? "rvhook" : ""}">${esc(b.ja.replace(/\n/g, " "))}</span>`).join("")}</div>
        <div class="rvstrip">${strip}</div>
        <div class="row-tight">${flags}</div>
        ${where && !where.ready.length ? rvNoNetHtml(r, where) : cLandsHtml(r)}</div>
      <div class="rvacts">${r.status === "approved" ? `<span class="okline">${ico("check", "sm")}${tr("ed.st.approved")}</span>`
          : `<button class="primary" data-revok="${esc(r.slug)}" ${revBusy ? "disabled" : ""}>${tr("rv.approve")}</button>`}
        ${tdRejHtml(r)}
        ${isEx ? "" : `<button data-reword="${esc(r.slug)}">${ico("type", "sm")}${tr("w.reword")}</button>`}
        ${one ? `<span class="meta">${tr("rv.phoneedit")}</span>` : isEx ? `<a class="btn" href="#/explainer/${esc(r.slug)}">${ico("type", "sm")}${tr("ex.edit")}</a>` : `<a class="btn" href="#/reel/${esc(r.slug)}">${ico("film", "sm")}${tr("rv.open")}</a>`}
        <span class="meta rvkeys">${esc(tr("ly_rv.keys") + " · " + tr("td_rv.key"))}</span></div></article>`;
  };
  const qflags = (r) => [r.faces > 0 && !r.consent && !r.blurFaces && !consentAll() ? `<i class="rvq-f warn" title="${esc(tr("rv.faces", { n: r.faces }))}">${ico("user", "sm")}</i>` : "",
    lookChecks(r).length ? `<i class="rvq-f warn" title="${esc(tr(lookChecks(r).length === 1 ? "card.check1" : "card.checkn", { n: lookChecks(r).length }))}">${ico("alert", "sm")}</i>` : "",
    r.sameWords > 0 ? `<i class="rvq-f bad" title="${esc(tr("w.same", { n: r.sameWords }))}">${ico("type", "sm")}</i>` : ""].join("");
  const queue = `<aside class="rv-queue panel" aria-label="${esc(tr("ly_rv.queue"))}"><div class="rvq-head"><b>${esc(tr("ly_rv.queue"))}</b><span class="meta">${esc(tr("ly_rv.pos", { i: at + 1, n: list.length }))}</span></div>
    <ol class="rvq-list">${list.map((r, i) => `<li><button type="button" class="rvq${i === at ? " sel" : ""}" data-rvq="${esc(r.slug)}" ${i === at ? 'aria-current="true"' : ""}>
      <span class="rvq-th" style="background-image:url('${r.hook ? thumb(r.hook, 120) + "&v=" + (r.updated || 0) : ""}')"></span>
      <span class="rvq-txt"><b lang="ja">${esc(reelName(r.slug))}</b><span class="meta">${tr("rv.meta", { s: r.seconds, n: r.clips, look: esc(nameOf("looks", r.look || "") || "") })}</span><span class="rvq-meta">${scoreBadge(r.slug)}${tdAutoQ(r)}${qflags(r)}</span></span></button></li>`).join("")}</ol>${tdRvSum()}</aside>`;
  const faces = list.some((r) => r.faces > 0 && !r.blurFaces);
  $("#home").innerHTML = `${head}<p class="intro keep">${tr("rv.intro")}</p>
    ${faces || consentAll() ? `<label class="chk rvconsent" title="${esc(tr("rv.consentall.why"))}"><input type="checkbox" data-consentall="1" ${consentAll() ? "checked" : ""}> ${ico("users", "sm")} ${tr("rv.consentall")}</label>
      <p class="meta rvconsentwhy">${tr("rv.consentall.why")}</p>` : ""}
    <div class="rv-md">${one ? "" : queue}${row(list[at])}</div>`;
  paintRevFocus();
  rvqInView();
}
let rvAt = 0;
/* ===== Track D (24 Nov 2026, UX audit BL-106/110/111/112): inputs and a review that teaches the loop.
   Reject with a one-tap reason (kept in the catalog's rejections table, GET /api/review/reasons), "why this look" and
   "made by itself" from the reel's made data (Track A writes it; the overview carries it as r.made), footage new since
   the last visit, photo posts that say when they went out. Styles .td-*, labels td_* (EN and JA below). ===== */
Object.assign(I18N.en, {
  "td_rv.reject": "Reject", "td_rv.rejecttip": "Reject this reel with a reason (R)", "td_rv.why": "Why reject it?",
  "td_rv.r.weak-hook": "Hook is weak", "td_rv.r.wrong-clip": "Wrong clip", "td_rv.r.repeats": "Repeats another reel", "td_rv.r.note": "a note only",
  "td_rv.note": "Note (optional)", "td_rv.go": "Reject", "td_rv.cancel": "Cancel", "td_rv.pick": "Pick a reason or write a note.",
  "td_rv.done": "Rejected: {r}. The reason is kept with the reel.", "td_rv.key": "R reject",
  "td_rv.sum": "Why reels were rejected (30 days)", "td_rv.sumnone": "No reel rejected in the last 30 days.",
  "td_rv.auto": "made by itself", "td_rv.autotip": "The studio made this reel by itself from new footage.",
  "td_rv.whyh": "Why this look", "td_rv.random": "The look was drawn at random.",
  "td_ed.random": "New reels draw these at random, and rarely repeat what the last few reels used. Change any of them here; Save & render to apply.",
  "td_ed.steer": "Why this look: {w} Change any of them here; Save & render to apply.",
  "td_f.new": "New", "td_f.newsince": "{n} new since {d}", "td_f.navnew": "{n} new clips since your last visit to Footage",
  "td_ph.out": "out {d}", "td_ph.views": "{n} views", "td_ph.booked": "booked {d}", "td_ph.next": "Next Story {d}", "td_ph.nonext": "No Story booked",
});
Object.assign(I18N.ja, {
  "td_rv.reject": "却下", "td_rv.rejecttip": "理由を選んでこのリールを却下（R）", "td_rv.why": "却下する理由は？",
  "td_rv.r.weak-hook": "つかみが弱い", "td_rv.r.wrong-clip": "クリップが合わない", "td_rv.r.repeats": "ほかのリールと重なる", "td_rv.r.note": "メモのみ",
  "td_rv.note": "メモ（任意）", "td_rv.go": "却下する", "td_rv.cancel": "やめる", "td_rv.pick": "理由を選ぶか、メモを書いてください。",
  "td_rv.done": "却下しました（{r}）。理由はリールと一緒に記録しました。", "td_rv.key": "R 却下",
  "td_rv.sum": "却下した理由（30日）", "td_rv.sumnone": "この30日に却下したリールはありません。",
  "td_rv.auto": "自動で作成", "td_rv.autotip": "新しい素材から、スタジオが自動で作ったリールです。",
  "td_rv.whyh": "この見た目の理由", "td_rv.random": "見た目はランダムに選ばれました。",
  "td_ed.random": "新しいリールはこれらをランダムに選び、直近のリールと重なりにくくしています。ここで変えたら「保存して書き出す」で反映されます。",
  "td_ed.steer": "この見た目の理由：{w} ここで変えたら「保存して書き出す」で反映されます。",
  "td_f.new": "新着", "td_f.newsince": "{d}以降の新着 {n}点", "td_f.navnew": "前回「素材」を開いてから新しく{n}点入りました",
  "td_ph.out": "{d}に投稿", "td_ph.views": "再生{n}", "td_ph.booked": "{d}に予約", "td_ph.next": "次のストーリーズ {d}", "td_ph.nonext": "予約中のストーリーズはありません",
});
const TD_REASONS = ["weak-hook", "wrong-clip", "repeats"];  // server/trust.mjs REJECT_REASONS, py/studio/review_actions.py REASONS
var tdRej = { slug: "", reason: "", note: "", busy: false };  // var, not let: a render can run before this line on a slow start
var tdReasons = null;
const tdMade = (slug) => overview?.reels?.find((r) => r.slug === slug)?.made || null;
/* The steer's own words in the page's language; a look drawn at random says so; no made data, nothing (older reels). */
function tdWhy(made) {
  if (!made) return "";
  const w = lang === "ja" ? made.whyJa || made.why : made.why || made.whyJa;
  return w || (made.mode === "random" ? tr("td_rv.random") : "");
}
function tdWhyChip(slug) {
  const w = tdWhy(tdMade(slug));
  return w ? `<p class="td-why">${ico("flow", "sm")}<b>${esc(tr("td_rv.whyh"))}</b><span>${esc(w)}</span></p>` : "";
}
const tdAutoTag = (r) => r?.made?.by === "auto" ? `<span class="tag td-auto" title="${esc(tr("td_rv.autotip"))}">${ico("loop", "sm")}${esc(tr("td_rv.auto"))}</span>` : "";
const tdAutoQ = (r) => r?.made?.by === "auto" ? `<i class="rvq-f td-autoq" title="${esc(tr("td_rv.auto"))}">${ico("loop", "sm")}</i>` : "";
/* Reject: a button beside Approve; open, three one-tap reasons, an optional note, and Reject. */
function tdRejHtml(r) {
  if (r.status !== "rendered") return "";
  const open = tdRej.slug === r.slug, off = revBusy || tdRej.busy ? "disabled" : "";
  const btn = `<button type="button" class="td-rejbtn" data-tdrej="${esc(r.slug)}" aria-expanded="${open}" title="${esc(tr("td_rv.rejecttip"))}" ${off}>${ico("x", "sm")}${esc(tr("td_rv.reject"))}</button>`;
  if (!open) return btn;
  return btn + `<div class="td-rej" role="group" aria-label="${esc(tr("td_rv.why"))}"><span class="meta">${esc(tr("td_rv.why"))}</span>
    ${TD_REASONS.map((k) => `<button type="button" class="td-r${tdRej.reason === k ? " on" : ""}" data-tdreason="${k}" aria-pressed="${tdRej.reason === k}">${esc(tr("td_rv.r." + k))}</button>`).join("")}
    <input type="text" data-tdrejnote="1" maxlength="500" placeholder="${esc(tr("td_rv.note"))}" aria-label="${esc(tr("td_rv.note"))}" value="${esc(tdRej.note)}">
    <div class="td-rejacts"><button type="button" class="td-go" data-tdrejgo="${esc(r.slug)}" ${off}>${esc(tr("td_rv.go"))}</button><button type="button" data-tdrejno="1">${esc(tr("td_rv.cancel"))}</button></div></div>`;
}
function tdLoadReasons() {
  tdReasons = "loading";
  api("/api/review/reasons?days=30").then((v) => { tdReasons = v; }).catch(() => { tdReasons = { error: true }; })
    .finally(() => { if (page === "review" && atHome()) renderHome(true); });
}
/* Check data in the review queue itself: why reels went back lately (Results can show the same, GET /api/review/reasons). */
function tdRvSum() {
  if (tdReasons === null) tdLoadReasons();
  const v = tdReasons && typeof tdReasons === "object" && !tdReasons.error ? tdReasons : null;
  if (!v) return "";
  if (!v.total) return `<p class="meta td-sum">${esc(tr("td_rv.sumnone"))}</p>`;
  const parts = [...TD_REASONS, "note"].filter((k) => v.by?.[k]).map((k) => `${esc(tr(k === "note" ? "td_rv.r.note" : "td_rv.r." + k))} <b>${v.by[k]}</b>`);
  return `<p class="meta td-sum"><b>${esc(tr("td_rv.sum"))}</b><br>${parts.join(" · ")}</p>`;
}
async function tdSendBack(slug) {
  const r = overview.reels.find((x) => x.slug === slug);
  const note = String(document.querySelector("[data-tdrejnote]")?.value ?? tdRej.note).trim();
  if (!tdRej.reason && !note) { toast(`${ico("alert", "sm")} ${esc(tr("td_rv.pick"))}`, 4000); return; }
  tdRej.busy = true; tdRej.note = note; renderHome(true);
  try {
    await post("/api/reject", { slug: "story-" + slug, note, ...(tdRej.reason ? { reason: tdRej.reason } : {}), ...(r?.look ? { look: r.look } : {}) });
    toast(`${ico("check", "sm")} ${esc(tr("td_rv.done", { r: tdRej.reason ? tr("td_rv.r." + tdRej.reason) : note }))}`, 5000);
  } catch (err) { tdRej.busy = false; toast(`${ico("alert", "sm")} ${esc(err.message.trim().split("\n").pop())}`, 8000); renderHome(true); return; }
  tdRej = { slug: "", reason: "", note: "", busy: false }; tdReasons = null;
  delete revCache[slug]; if (revPlay === slug) revPlay = "";
  await loadOverview(); renderHome(true);
}
document.addEventListener("click", (e) => {
  const open = e.target.closest?.("[data-tdrej]"), why = e.target.closest?.("[data-tdreason]"), go = e.target.closest?.("[data-tdrejgo]"), no = e.target.closest?.("[data-tdrejno]");
  if (!open && !why && !go && !no) return;
  const note = document.querySelector("[data-tdrejnote]"); if (note) tdRej.note = note.value;
  if (open) { const s = open.dataset.tdrej; tdRej = tdRej.slug === s ? { slug: "", reason: "", note: "", busy: false } : { slug: s, reason: "", note: "", busy: false }; renderHome(true); if (tdRej.slug) document.querySelector("[data-tdreason]")?.focus(); }
  else if (why) { tdRej.reason = tdRej.reason === why.dataset.tdreason ? "" : why.dataset.tdreason; renderHome(true); document.querySelector(`[data-tdreason="${why.dataset.tdreason}"]`)?.focus(); }
  else if (go) tdSendBack(go.dataset.tdrejgo);
  else { tdRej = { slug: "", reason: "", note: "", busy: false }; renderHome(true); }
});
document.addEventListener("input", (e) => { if (e.target.matches?.("[data-tdrejnote]")) tdRej.note = e.target.value; });
document.addEventListener("keydown", (e) => {
  if (!e.target.matches?.("[data-tdrejnote]")) return;
  if (e.key === "Enter") { e.preventDefault(); document.querySelector("[data-tdrejgo]")?.click(); }
  else if (e.key === "Escape") { e.preventDefault(); document.querySelector("[data-tdrejno]")?.click(); }
});
/* Editor › Properties: the note under Type, colours and motion says why this reel looks the way it does when the
   studio recorded it (made.steer); older reels keep the plain "drawn at random" line. */
function tdDressNote() { const w = tdWhy(tdMade(reel?.slug)); return `<p class="note">${esc(w ? tr("td_ed.steer", { w }) : tr("td_ed.random"))}</p>`; }
/* Footage: what came in since the last visit. Catalog ids only grow, so the newest ids (overview.library.recentIds) and
   the top id seen at the last visit (this browser) say how many are new, with no extra request. */
var tdFoot = { base: null, baseAt: null, inside: false };
function tdSeen() { try { return JSON.parse(localStorage.getItem("td.foot.seen") || "null"); } catch { return null; } }
const tdTopId = () => overview?.library?.recentIds?.[0] ?? null;
const tdNewCount = (since) => (since == null ? 0 : (overview?.library?.recentIds || []).filter((i) => i > since).length);
const tdNewLabel = (n) => (n >= 300 ? "300+" : String(n));
function tdFootVisit() {
  if (tdFoot.inside) return;
  const top = tdTopId(); if (top == null) return;  // the overview is not in yet: the next paint tries again
  tdFoot.inside = true;
  const seen = tdSeen();
  tdFoot.base = seen ? seen.id : top; tdFoot.baseAt = seen ? seen.at : Date.now();  // a first visit: nothing counts as new
  try { localStorage.setItem("td.foot.seen", JSON.stringify({ id: top, at: Date.now() })); } catch { /* private window: this visit only */ }
  tdNavPaint();
}
const tdDay = (ms) => new Date(ms || Date.now()).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { day: "numeric", month: "short" });
function tdLibNew() {
  if (tdFoot.base == null) return "";
  const n = tdNewCount(tdFoot.base);
  return n ? ` · <em class="td-new">${esc(tr("td_f.newsince", { n: tdNewLabel(n), d: tdDay(tdFoot.baseAt) }))}</em>` : "";
}
/* The nav: a count on Footage when clips came in since the last visit; at phone width (≤420 px, CSS .td-*) the nav is
   icons only, so each button keeps its name (and counts) as its accessible name and tooltip. */
function tdNavPaint() {
  if (!tdFoot) return;  // painted before this block ran (start-up): the next paint fills it
  if (page !== "footage") tdFoot.inside = false;
  const fb = document.querySelector('.topnav [data-page="footage"]');
  if (fb) {
    const seen = tdSeen(), n = page === "footage" || !seen ? 0 : tdNewCount(seen.id);
    let c = fb.querySelector(".td-navnew");
    if (n > 0) { if (!c) { c = document.createElement("span"); c.className = "chip td-navnew"; fb.appendChild(c); } c.textContent = tdNewLabel(n); c.title = tr("td_f.navnew", { n: tdNewLabel(n) }); }
    else c?.remove();
  }
  document.querySelectorAll(".topnav [data-page]").forEach((b) => {
    const label = b.querySelector("[data-t]")?.textContent?.trim(); if (!label) return;
    const extra = [...b.querySelectorAll(".chip:not([hidden])")].map((c) => c.title || c.textContent).filter(Boolean);
    const name = [label, ...extra].join(", ");
    if (b.getAttribute("aria-label") !== name) b.setAttribute("aria-label", name);
    if (b.title !== label) b.title = label;
  });
}
/* Photo posts: when each set went out (and its views) or is booked, and the next booked Story, in the audience's zone. */
const tdPhWall = (iso) => wallOf(Date.parse(iso));
const tdPhWhen = (iso) => { const w = tdPhWall(iso); return `${shortDay(w.slice(0, 10))} ${w.slice(11, 16)}`; };
function tdPhOut(x) {
  if (x.storyPosted) {
    const v = x.storyResult?.views;
    return `<span class="td-phout">${esc(tr("td_ph.out", { d: shortDay(tdPhWall(x.storyPosted.at).slice(0, 10)) }))}${v != null ? ` · ${esc(tr("td_ph.views", { n: Number(v).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB") }))}` : ""}</span>`;
  }
  return x.storyQueued ? `<span class="td-phout td-phbooked">${esc(tr("td_ph.booked", { d: tdPhWhen(x.storyQueued.at) }))}</span>` : "";
}
function tdPhNext(sets) {
  const q = (sets || []).filter((x) => x.storyQueued && !x.storyPosted).map((x) => x.storyQueued.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return `<span class="meta td-phnext">${ico("cal", "sm")} ${esc(q ? tr("td_ph.next", { d: tdPhWhen(q) }) : tr("td_ph.nonext"))}</span>`;
}
/* Reels › All reels (landing): with the monitor at the top, every day starts folded to one line (counts and first
   pictures), so the page stays within two screens; a day opened by hand stays open for the visit. */
const tdOpenGroups = () => (page === "reels" && homeFilter === "all" && vxSel === "all" && !showMaker && overview?.reels?.some((r) => !r.house) ? 0 : 2);
/* ===== end Track D block ===== */
/* The queue scrolls by itself (never the page) to keep the reel in focus in view. */
function rvqInView() {
  const q = document.querySelector(".rvq-list"), on = q?.querySelector(".rvq.sel")?.parentElement; if (!on) return;
  if (on.offsetTop < q.scrollTop || on.offsetTop + on.offsetHeight > q.scrollTop + q.clientHeight) q.scrollTop = on.offsetTop - (q.clientHeight - on.offsetHeight) / 2;
}
document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-rvq]"); if (!b) return; revFocus = b.dataset.rvq; revPlay = ""; renderHome(true); });
document.addEventListener("change", async (e) => {
  const c = e.target.closest?.("[data-consentall]");
  if (!c) return;
  try {
    wsView = await post("/api/workspaces/edit", { id: wsView?.running || "main", consentAll: c.checked });
    toast(`${ico("check", "sm")} ${tr(c.checked ? "rv.consentall.on" : "rv.consentall.off")}`, 5000);
  } catch (err) { c.checked = !c.checked; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  renderHome(true);
});
document.addEventListener("click", async (e) => {
  const pl = e.target.closest("[data-revplay]");
  if (pl) { revPlay = pl.dataset.revplay; renderHome(true); return; }
  const ok = e.target.closest("[data-revok]");
  if (!ok) return;
  const slug = ok.dataset.revok, r = overview.reels.find((x) => x.slug === slug);
  // faces -1: never counted (said nothing, "faces in -1 clip"); the approve still records consent below, as the server asks
  if (r?.faces > 0 && !r.consent && !r.blurFaces && !consentAll() && !confirm(tr("rv.consentask", { n: r.faces }))) return;
  revBusy = slug; renderHome(true);
  try {
    if (r?.faces && !r.consent && !r.blurFaces) await post("/api/consent", { slug: "story-" + slug });
    await post("/api/approve", { slug: "story-" + slug });
    // Nothing can book it (no network ready): it is approved and kept; the first time, ask where it should go (BL-132).
    const w = rvWhere();
    if (w && !w.ready.length) { if (rvNotNow()) toast(`${ico("check", "sm")} ${esc(tr("rv.done.kept", { s: reelName(slug) }))}`, 6000); else rvAsk = { slug }; }
    else toast(`${ico("check", "sm")} ${tr("rv.done", { s: esc(slug) })}`, 4000);
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
  revBusy = ""; delete revCache[slug]; if (revPlay === slug) revPlay = "";
  await loadOverview(); renderHome(true);
  if (rvAsk) requestAnimationFrame(() => { const a = document.querySelector("#home .rv-ask"); a?.scrollIntoView({ block: "start", behavior: moCalm() ? "auto" : "smooth" }); a?.focus({ preventScroll: true }); });
});
function renderIdeas() {
  if (researchView === null) { researchView = undefined; loadResearch(); }
  const ready = researchView?.ready;
  const tool = IDEA_TOOLS.find((t) => t[0] === ideaTab) || IDEA_TOOLS[0];
  const [k, icon, title, hint] = tool;
  const hue = { ideas: 45, events: 200, "site-check": 145, page: 265, links: 15, bluesky: 210 };
  const busy = ideasBusy[k], res = ideasRes[k];
  const waited = busy ? Math.round((Date.now() - (ideaStarted[k] || Date.now())) / 1000) : 0;
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.posting"), "#/posting"], [tr("nav.ideas")])}<span class="meta">${esc(lang === "ja" && researchView?.ready && researchView?.credits?.remaining != null ? tr("d_id.ready", { n: Number(researchView.credits.remaining).toLocaleString("ja-JP") }) : (researchView?.summary || "").replace(/Firecrawl credits/, tr("idea.credits")))}</span></div>
    <p class="intro">${trA("idea.intro")}</p>
    ${researchView && !ready && k !== "bluesky" ? `<div class="helpnote">${ico("shield", "sm")}<div><b>${tr("idea.nokey")}</b><p class="meta">${tr("idea.nokeyhint")}</p></div><a class="btn primary" href="#/keys/keys">${tr("sub.keys")}</a></div>` : ""}
    <nav class="itabs" role="tablist">${IDEA_TOOLS.map(([t, ic, ti]) => `<a role="tab" href="#/ideas/${t}" class="${t === k ? "on" : ""}" aria-selected="${t === k}">${kTile({ icon: ic, hue: hue[t] }, "xs")}<span>${tr(ti)}</span>${ideasBusy[t] ? `<span class="spin sm"></span>` : ideasRes[t] && !ideasRes[t].error ? `<i class="idot"></i>` : ""}</a>`).join("")}</nav>
    ${k === "bluesky" ? bsrHtml() : `<section class="rtool ion" id="tool-${k}">
      <div class="rtool-head">${kTile({ icon, hue: hue[k] })}<div><h2>${tr(title)}</h2><p class="meta">${trA(hint)}</p></div>
        ${k === "page" ? `<input id="ideaUrl" type="url" placeholder="https://…" aria-label="${esc(tr("idea.urllabel"))}" value="${esc(ideasRes.page?.url || "")}">` : ""}
        <button class="primary" data-idea="${k}" ${!ready || busy ? "disabled" : ""}>${busy ? `<span class="spin sm"></span>${tr("idea.working")}` : `${ico("search", "sm")}${tr(res ? "idea.again" : "idea.run")}`}</button></div>
      <div class="toolout" aria-live="polite">${busy
        ? `<div class="loading-block" role="status"><span class="spin"></span><span>${tr("idea.busy", { s: waited })}</span></div><div class="skel"><i></i><i></i><i></i></div>`
        : res ? ideaResult(k, res) : `<div class="iempty">${kTile({ icon, hue: hue[k] })}<p>${tr("idea.empty")}</p></div>`}</div>
    </section>`}`;
}
let ideaTick = null;
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-idea]"); if (!b) return;
  const k = b.dataset.idea, body = { ...(k === "page" ? { url: ($("#ideaUrl")?.value || "").trim() } : {}), ...(ideasRes[k]?.cached ? { fresh: true } : {}) };
  if (k === "page" && !/^https?:\/\//.test(body.url)) { toast(`${ico("alert", "sm")} ${tr("idea.needurl")}`, 4000); return; }
  ideasBusy[k] = true; ideaStarted[k] = Date.now(); renderHome(true);
  clearInterval(ideaTick); ideaTick = setInterval(() => { if (page === "ideas" && Object.values(ideasBusy).some(Boolean)) renderHome(true); else clearInterval(ideaTick); }, 1000);
  try { ideasRes[k] = { ...(await post("/api/research/" + k, body)), url: body.url }; toast(`${ico("check", "sm")} ${tr("idea.done", { t: tr(IDEA_TOOLS.find((t) => t[0] === k)[2]) })}`, 3500); }
  catch (err) { ideasRes[k] = { error: err.message.replace(/^\w*Error: /, "") }; }
  ideasBusy[k] = false; renderHome(true); loadResearch();
});
/* ---------- Reply to these today (BL-100): Ideas › Reply on Bluesky. Recent Japanese Bluesky posts in the project's
   topics worth a real reply by hand, and accounts worth following (GET /api/engage/bluesky, py/studio/engage.py,
   cached an hour). Read-only: the owner opens each post on Bluesky and answers there; the studio never posts, likes
   or follows. Prefix bsr-. ---------- */
let bsrView = null, bsrBusy = false;
async function bsrLoad(fresh = false) {
  if (bsrBusy) return;
  bsrBusy = true; if (page === "ideas") renderHome(true);
  try {
    const r = await fetch("/api/engage/bluesky" + (fresh ? "?fresh=1" : ""));
    const j = await r.json().catch(() => ({}));
    bsrView = r.ok ? j : { error: j.error || String(r.status), code: j.code || "error" };
  } catch (err) { bsrView = { error: err.message, code: "offline" }; }
  bsrBusy = false; if (page === "ideas") renderHome(true);
}
const bsrNum = (n) => Number(n || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB");
function bsrHtml() {
  if (bsrView === null && !bsrBusy) setTimeout(() => bsrLoad(false), 0);
  const v = bsrView, busy = bsrBusy || bsrView === null;
  const head = `<div class="rtool-head">${kTile({ icon: "chat", hue: 210 })}<div><h2>${tr("bsr.title")}</h2><p class="meta">${tr("bsr.advice")}</p></div>
    <button data-bsr="fresh" ${busy ? "disabled" : ""}>${busy ? `<span class="spin sm"></span>${tr("bsr.reading")}` : `${ico("refresh", "sm")}${tr("bsr.refresh")}`}</button></div>`;
  let body;
  if (busy && !v?.posts) body = `<div class="loading-block" role="status"><span class="spin"></span><span>${tr("bsr.reading")}</span></div><div class="skel"><i></i><i></i><i></i></div>`;
  else if (v.error) body = v.code === "connect"
    ? `<div class="helpnote">${ico("user", "sm")}<div><b>${tr("bsr.connect")}</b><p class="meta">${esc(v.error)}</p></div><a class="btn primary" href="#/accounts">${tr("bsr.accounts")}</a></div>`
    : `<div class="accerr" role="alert">${ico("alert", "sm")}<div><b>${tr("bsr.fail")}</b><span>${esc(v.error)}</span></div></div>`;
  else {
    const posts = v.posts || [], follow = v.follow || [];
    body = `<p class="meta bsr-meta">${tr("bsr.meta", { n: posts.length, s: bsrNum(v.seen), t: v.searched || 0, a: ago(v.generatedAt) })}${v.stale ? ` <span class="chip warn">${ico("alert", "sm")}${tr("bsr.stale")}</span>` : ""}</p>`
      + (posts.length ? `<ol class="bsr-list">${posts.map((p) => `<li class="bsr-post">
          <div class="bsr-who"><b>@${esc(p.handle)}</b>${p.name ? `<span class="meta bsr-one">${esc(p.name)}</span>` : ""}${p.followers != null ? `<span class="chip">${tr("bsr.followers", { n: bsrNum(p.followers) })}</span>` : ""}</div>
          <p class="bsr-text" lang="ja">${esc(p.text)}</p>
          <div class="bsr-foot"><span class="meta">${esc(ago(p.at))} · ${tr("bsr.counts", { l: p.likes || 0, r: p.replies || 0 })} · ${esc((p.topics || []).join(" · "))}</span>
            <a class="btn" href="${escUrl(p.url)}" target="_blank" rel="noopener">${ico("link", "sm")}${tr("bsr.open")}</a></div></li>`).join("")}</ol>`
        : `<div class="iempty"><p>${tr("bsr.none")}</p></div>`)
      + (follow.length ? `<h3 class="ih">${ico("users", "sm")} ${tr("bsr.follow")}</h3><div class="bsr-follow">${follow.map((a) => `<a class="bsr-acct" href="${escUrl(a.url)}" target="_blank" rel="noopener"><b>@${esc(a.handle)}</b><span class="meta">${tr("bsr.followers", { n: bsrNum(a.followers) })} · ${tr("bsr.posts", { n: a.posts })}</span>${a.about ? `<span class="meta bsr-one" lang="ja">${esc(a.about)}</span>` : ""}</a>`).join("")}</div>` : "")
      + `<p class="meta bsr-note">${ico("shield", "sm")} ${tr("bsr.readonly")}</p>`;
  }
  return `<section class="rtool ion" id="tool-bluesky">${head}<div class="toolout" aria-live="polite">${body}</div></section>`;
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-bsr]")) bsrLoad(true); });

