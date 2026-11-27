/* ---------- Results: what went out where, how it did, what worked, and what to try next. ---------- */
let perfView = null, perfSuggest = null, perfCollect = null, perfBusy = false, reachView = null;
document.addEventListener("click", (e) => { if (e.target.closest("[data-perfretry]")) { perfView = undefined; perfSuggest = null; renderHome(true); loadPerf(); } });
async function loadPerf() {
  // Each answer shows as it arrives: waiting for all four held the headline back behind the slowest (summary, 15 Nov).
  const got = (path, set, miss = null) => api(path).then(set, () => set(miss)).then(() => { if (page === "results") renderHome(true); });
  if (perfSuggest?.failed) perfSuggest = null;  // fx: null = still reading, { failed } = the request failed (rbNoSug)
  await Promise.all([got("/api/perf/reach", (v) => { reachView = v; }), got("/api/perf/summary", (v) => { perfView = v; }, { unavailable: true }),
    got("/api/perf/suggest?n=3", (v) => { perfSuggest = v || {}; }, { failed: true }), got("/api/perf/predictions", (v) => { predView = v; }),
    got("/api/perf/insights", (v) => { insView = v; })]);
}
/* Scores (0-100, studio.predict.score): the AI reviewer's hook and look marks, a fresh headline, a length that fits.
   Loaded once per overview; a reel without an AI review has a partial score (marked *). */
let predView = null, scoreMap = null, scoreLoading = false, scoreBusy = "";
async function loadScores() {
  if (scoreLoading) return; scoreLoading = true;
  try { scoreMap = (await api("/api/perf/scores")).scores || {}; } catch { scoreMap = scoreMap || {}; }
  scoreLoading = false; renderHome(true);
}
/* A review from still frames (your own vision model) hears nothing and sees no motion: its hook and look marks are partial. */
const fromFrames = (sc) => sc?.basis === "frames" || sc?.parts?.hook?.basis === "frames" || sc?.parts?.look?.basis === "frames";
function scoreTitle(sc) {
  if (!sc || sc.score == null) return "";
  const P = sc.parts || {}, bits = [], pm = fromFrames(sc) ? ` (${tr("ai.partial")})` : "";
  if (P.hook) bits.push(tr("sc.hook", { v: P.hook.value }) + pm);
  if (P.look) bits.push(tr("sc.look", { v: P.look.value }) + pm);
  if (P.fresh) bits.push(P.fresh.value > 0 ? tr(P.fresh.value === 1 ? "sc.repeat1" : "sc.repeat", { n: P.fresh.value }) : tr("sc.fresh"));
  if (P.length) bits.push(tr("sc.len", { v: P.length.value }));
  return `${tr("sc.title", { n: sc.score })}: ${bits.join(" · ")}${sc.partial ? " · " + tr("sc.partial") : ""}`;
}
function scoreBadge(slug) {
  if (!scoreMap) { loadScores(); return ""; }
  const sc = scoreMap[slug]; if (!sc || sc.score == null) return "";
  const tone = sc.score >= 70 ? "hi" : sc.score >= 45 ? "mid" : "lo";
  return `<span class="scorebadge ${tone} ${sc.partial ? "partial" : ""}" title="${esc(scoreTitle(sc) + "\n" + tr("sc.how") + (fromFrames(sc) ? "\n" + tr("ai.frames", { n: sc.frames || "12–16" }) : ""))}">${tr("sc.short")} ${sc.score}${fromFrames(sc) ? ` <span class="pmark">${tr("ai.partial")}</span>` : ""}</span>`;
}
/* Predicted vs actual: the range frozen when the post was booked, the result about 3 days after it went out. The bar
   is on a log scale from 0.1x to 10x a typical post on that network; the dot is what happened. */
const rpos = (x) => Math.max(0, Math.min(100, (Math.log10(Math.max(x, 0.1)) + 1) * 50));
function rangeBar(pr, actual, inside) {
  const lo = rpos(pr.lo), hi = rpos(pr.hi), mid = rpos(pr.mid);
  return `<span class="rbar" role="img" aria-label="${esc(tr("pa.range", { lo: pr.lo.toFixed(1), hi: pr.hi.toFixed(1) }) + (actual != null ? " · " + tr("pa.actual", { a: actual.toFixed(1) }) : ""))}">
    <i class="band" style="left:${lo}%;width:${Math.max(1, hi - lo)}%"></i><i class="mid" style="left:${mid}%"></i>
    ${actual != null ? `<i class="dot ${inside === false ? "out" : "in"}" style="left:${rpos(actual)}%"></i>` : ""}</span>`;
}
function predHtml() {
  const v = predView;
  if (!v?.rows) return "";
  const done = v.rows.filter((x) => x.actual != null && !x.late).slice(0, 12);
  const now = Date.now();
  const next = v.rows.filter((x) => ["scheduled", "queued"].includes(x.status) && new Date(x.at).getTime() > now).sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 6);
  const row = (x) => `<tr><td>${netLogo(x.network, "sm")} <a href="#/reel/${esc(x.slug)}">${esc(x.slug)}</a></td><td class="num" title="${esc(scoreMap?.[x.slug] ? scoreTitle(scoreMap[x.slug]) + "\n" + tr("sc.how") : "")}">${x.score ?? "–"}${scoreMap?.[x.slug]?.partial ? "*" : ""}</td>
    <td>${rangeBar(x.predicted, x.actual, x.inside)}</td>
    <td class="num">${x.predicted.lo.toFixed(1)}–${x.predicted.hi.toFixed(1)}×</td><td class="num">${x.actual != null ? x.actual.toFixed(1) + "×" : `<span class="meta">${esc(postDayLabel(dayOf(x.at)))}</span>`}</td>
    <td>${x.inside == null ? "" : x.inside ? `<span class="tag t-match">${tr("pa.in")}</span>` : `<span class="tag t-mismatch">${tr(x.actual > x.predicted.hi ? "pa.above" : "pa.below")}</span>`}</td></tr>`;
  const unscored = scoreMap ? Object.entries(scoreMap).filter(([, sc]) => sc.missing?.includes("hook")).map(([k]) => k) : [];
  const ok = (sl) => { const r = overview.reels.find((x) => x.slug === sl); return r && r.rendered && !busyJob(r); };
  const todo = unscored.filter(ok);
  return `<section class="sheet predsheet"><h2>${tr("pa.h")}</h2>
    ${predChart(v) || `<p>${esc(v.summary || "")}${v.spearman != null ? " " + esc(tr(v.spearman >= 0.2 ? "pa.rankUp" : v.spearman <= -0.2 ? "pa.rankDown" : "pa.rankNone", { r: v.spearman })) : ""}</p>`}
    <p class="rb-does">${ico("info", "sm")} ${esc(tr(v.rankBy === "learned" ? "rb.pa.order" : v.spearman != null && v.spearman >= 0.3 ? "rb.pa.orderok" : v.rankBy || v.spearman == null ? "rb.pa.ordernone" : "rb.pa.order", { r: v.spearman != null ? signed(v.spearman) : "–" }))}</p>
    ${todo.length ? `<p class="row wrap"><span class="meta">${tr("pa.unscored", { n: todo.length })}</span><button data-scoreall ${scoreBusy ? "disabled" : ""}>${scoreBusy ? esc(scoreBusy) : tr("pa.scoreall", { n: todo.length, u: usd(todo.length * 0.0075) })}</button></p>` : ""}
    ${done.length || next.length ? `<details class="pfold"><summary>${tr("pa.details", { n: done.length + next.length })}</summary><p class="meta">${tr("pa.how")}</p><table class="facts predtable"><thead><tr><th>${tr("pa.reel")}</th><th class="num">${tr("pa.score")}</th><th><span class="rscale"><span>0.1×</span><span>1×</span><span>10×</span></span></th><th class="num">${tr("pa.pred")}</th><th class="num">${tr("pa.act")}</th><th></th></tr></thead>
      <tbody>${done.map(row).join("")}${next.length ? `<tr class="sub"><td colspan="6">${tr("pa.next")}</td></tr>${next.map(row).join("")}` : ""}</tbody></table></details>` : ""}</section>`;
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-scoreall]")) return;
  try { const j = await post("/api/perf/score-all", {}); boardJob(j); scoreBusy = tr("pa.scoring", { i: 1, n: j.of || "…" }); renderHome(true); }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});
const VERDICT_TONE = (v) => /helps/.test(v) ? "t-match" : /holds back/.test(v) ? "t-mismatch" : "t-unsure";
/* One suggestion as a sentence: the look and the recipe by their names (what they do on hover), where the words sit,
   how long, when to post; tagged "not tried yet" or "worked before". */
function nameOf(kind, id) {
  const d = NAMES[kind]?.[id];
  return d ? (lang === "ja" && d.ja ? d.ja : d.label || id) : id;
}
/* A length bucket from studio.learn ("under 12 s", "12-16 s", "over 60 s") in the page's language (Track B). */
const rbLen = (v) => (lang === "ja" ? String(v).replace(/^under (\d+) s$/, "$1秒未満").replace(/^over (\d+) s$/, "$1秒超").replace(/^(\d+)-(\d+) s$/, "$1〜$2秒") : v);
function tryRow(x) {
  const look = x.look ? `<b title="${esc(NAMES.looks[x.look]?.what || "")}">${esc(nameOf("looks", x.look))}</b>` : "";
  const recipe = x.recipe && x.recipe !== "none" ? `<b title="${esc(NAMES.recipes[x.recipe]?.what || "")}">${esc(nameOf("recipes", x.recipe))}</b>` : "";
  const STYLE_LABEL = { column: "res.s.column", centre: "res.s.centre", lower: "res.s.lower", split: "res.s.split" };
  const style = x.style ? (STYLE_LABEL[x.style] ? tr(STYLE_LABEL[x.style]) : esc(x.style)) : "";
  const parts = [look && tr("res.p.look", { v: look }), recipe && tr("res.p.recipe", { v: recipe }), style, x.length && tr("res.p.len", { v: esc(rbLen(x.length)) }), x.hour && tr("res.p.hour", { v: esc(x.hour) })].filter(Boolean);
  return `<li><span class="tag ${x.mode === "learned" ? "t-match" : "t-unsure"}">${tr(x.mode === "learned" ? "res.m.learned" : "res.m.explore")}</span><p>${parts.join(lang === "ja" ? "、" : ", ")}${lang === "ja" ? "" : "."}</p></li>`;
}
function effectRow(e) {
  return `<li><span class="tag ${VERDICT_TONE(e.verdict || "")}">${esc(e.mult ? `${e.mult.toFixed(1)}×` : "–")}</span> <b>${esc(e.label || "")}</b><span>${esc(e.sentence || "")}</span></li>`;
}
/* Why the page is still thin: rbWaitLine() (one count with What worked, BL-108). */
/* ---------- Results › How reels did: the answer first ----------
   The owner, 15 Nov: "the results page are long and hard to understand intuitively". Four numbers answer "is it
   working?", one sentence says it in words, one bar per network says where the views come from; the detail sits behind
   four tabs instead of seven stacked panels. Numbers: /api/perf/reach (per network, 60 days) and /api/perf/table. */
// Track B, 24 Nov: five tabs, each with its own address (#/results/next…: lyRoute reads it); the address is the memory.
const RES_TABS = { overview: "rb.t.overview", next: "rs.t.learn", where: "rb.t.where", posts: "rs.t.posts", youtube: "rs.t.youtube" };
let resTab = "overview", rbFoldOpen = false;
document.addEventListener("toggle", (e) => { if (e.target.dataset?.rbfold) rbFoldOpen = e.target.open; }, true);
/* The week's views: weekViews() (Track B, one definition shared with Reels › Today). */
function resTopHtml() {
  const R = reachView, wv = weekViews(), ja = lang === "ja";
  if (!R && !wv) return `<div class="rtiles">${loadingHtml(tr("nav.results"))}</div>`;  // BL-067: not "Loading Reading the numbers…"
  const n = (x) => Number(x || 0).toLocaleString(ja ? "ja-JP" : "en-GB");
  const name = (k) => NET_NAME[chOf(k)] || NET_NAME[k] || k;
  const tile = (label, big, sub = "", title = "") => `<div class="rtile" ${title ? `title="${esc(title)}"` : ""}><span class="rlabel">${label}</span>${big}${sub ? `<span class="meta">${sub}</span>` : ""}</div>`;
  // The tile's change line is weekViews().label (under 3 posts with views last week: no percentage, 16 Nov "▲ 1307%").
  const best = (R?.networks || []).filter((x) => x.best).map((x) => ({ ...x.best, network: x.network })).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const br = best && overview.reels.find((y) => y.slug === best.slug);
  const now = Date.now();
  const booked = postsLog.filter((x) => x.network !== "all" && ["scheduled", "queued"].includes(x.status) && x.at && new Date(x.at).getTime() > now)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const first = booked[0], firstT = first ? new Date(first.at).getTime() : 0;
  // One moment however it is written: YouTube and its Instagram Story are stored as 18:00+08:00, the rest as 19:00+09:00.
  const firstNets = first ? [...new Set(booked.filter((x) => new Date(x.at).getTime() === firstT).map((x) => chOf(x.network)))] : [];
  return `<div class="rtiles">
    ${tile(tr("rs.week"), `<b class="rbig">${wv ? n(wv.now) : "–"}</b>`, wv ? `<span class="${wv.tone}">${esc(wv.label)}</span><span class="rb-def">${esc(wv.foot)}</span>` : "", wv?.def || tr("rs.weekhint"))}
    ${tile(tr("rs.reactions"), `<b class="rbig">${R ? n(R.totals.reactions) : "–"}</b>`, R ? tr("rs.reactsub", { v: n(R.totals.views), p: n(R.totals.measured), d: R.days || 60 }) : "")}
    ${tile(tr("rs.best"), best ? `<a class="rbest" href="#/reel/${esc(best.slug)}"><span class="mini" style="background-image:url('${br?.hook ? thumb(br.hook, 80) : ""}')"></span>
        <span><b lang="ja" title="${esc(best.slug)}">${esc(reelName(best.slug))}</b><span class="meta">${netLogo(chOf(best.network), "sm")} ${tr(best.views != null ? "rs.bestv" : "rs.bestr", { v: n(best.views ?? best.reactions), net: esc(name(best.network)) })}</span></span></a>` : `<b class="rbig">–</b>`, best ? "" : tr("rs.nobest"))}
    ${tile(tr("rs.next"), first ? `<b>${esc(whenText(first.at))}</b><span class="row-tight">${firstNets.map((k) => netLogo(k, "sm")).join("")}</span>` : `<b class="rbig">–</b>`,
      first ? tr("rs.booked", { n: booked.length }) : tr("rs.nonext"))}
  </div>`;
}
/** One sentence, then one bar per network that has views; the networks with none, or no numbers to read, on one line each. */
function resNetsHtml(part = "") {  // "say": the sentence and the stall line (Overview); "where": the rest (Where views come from)
  const R = reachView;
  if (!R?.networks?.length) return "";
  const ja = lang === "ja", n = (x) => Number(x || 0).toLocaleString(ja ? "ja-JP" : "en-GB"), sep = ja ? "・" : ", ";
  const name = (k) => NET_NAME[chOf(k)] || NET_NAME[k] || k;
  const seen = R.networks.filter((x) => x.hasViews && x.views > 0).sort((a, b) => b.views - a.views);
  const stalled = R.networks.filter((x) => x.stalled);
  const none = R.networks.filter((x) => x.verdict === "none" && !x.stalled);
  const unread = R.networks.filter((x) => x.verdict === "unmeasured");
  const other = R.networks.filter((x) => !seen.includes(x) && !none.includes(x) && !unread.includes(x) && !stalled.includes(x));
  const all = Math.max(1, R.totals.views), top = Math.max(1, ...seen.map((x) => x.views));
  const good = R.networks.filter((x) => x.verdict === "working");
  const one = R.networks.filter((x) => x.out).length <= 1;
  const say = (good.length ? tr("rv2.lead.good", { nets: good.map((x) => name(x.network)).join(sep), v: n(good.reduce((a, x) => a + x.views, 0)), p: good.reduce((a, x) => a + x.measured, 0) })
    : tr("rv2.lead.low", { v: n(R.totals.views), p: R.totals.measured }))
    + (!one && seen[0] && seen[0].views / all >= 0.5 ? " " + tr("rs.share", { net: name(seen[0].network), p: Math.round(100 * seen[0].views / all) }) : "");
  // Networks that show the posts to nobody: one compact line under the flow's legend, its reasons folded (17 Nov: the
  // big card beside the flow repeated its dashed red bands and squeezed it into half the width). The flow and the
  // table take the full width.
  const stall = resStallHtml(stalled);
  if (part === "say" || one) return part === "where" ? "" : `<p class="rsay">${esc(say)}</p>${stall}`;
  const flow = resFlowHtml(R, name, n, stall);
  return `${part === "where" ? "" : `<p class="rsay">${esc(say)}</p>`}
    ${flow || stall}
    <ul class="rnets" aria-label="${esc(tr("rs.where", { d: R.days || 60 }))}">${seen.map((x) => `<li title="${esc(tr("rs.bartip", { v: n(x.views), p: x.measured, net: name(x.network) }))}">
      <span class="rnet">${netLogo(chOf(x.network), "sm")}${esc(name(x.network))}</span><span class="rbarw"><i style="width:${(100 * x.views / top).toFixed(1)}%"></i></span>
      <b>${n(x.views)}</b><span class="meta">${tr("rs.pct", { p: Math.max(1, Math.round(100 * x.views / all)), n: x.measured })}</span></li>`).join("")}</ul>
    ${other.length ? `<p class="meta rfold">${tr("rs.other", { list: other.map((x) => `${name(x.network)} (${tr(x.reactions === 1 ? "rs.reacts1" : "rs.reacts", { r: n(x.reactions) })})`).join(sep) })}</p>` : ""}
    ${none.length ? `<p class="meta rfold">${ico("info", "sm")} ${tr("rs.zero", { list: none.map((x) => tr("rs.zeronet", { net: name(x.network), n: x.out })).join(sep) })}</p>` : ""}
    ${unread.length && !flow ? `<p class="meta rfold">${tr("rs.unread", { list: unread.map((x) => name(x.network)).join(sep) })}</p>` : ""}
    ${resNetTable(R, name, n)}`;
}
/* Results › posts in, views out: one band per network, from its posts (left, height by posts out in 60 days) to the
   views they brought (right, height by views). The story in one picture: YouTube's thin band of posts fans out into
   nearly every view, while TikTok and Bluesky take as many posts and end in nothing. A network that shows its posts
   to nobody ends on a dashed band in red; one whose numbers the studio cannot read on a dashed grey one. Hover or
   focus a band to lift it; click (or Enter) opens why, under the picture. Wide screens only: phones keep the bars
   (.rnets), and the table under it is the same data as text. Inline SVG, no library. */
const resFlow = { net: null, shown: null, drawn: false };
function resFlowHtml(R, name, n, stall = "") {
  const kind = (x) => (x.hasViews && x.views > 0 ? "seen" : x.verdict === "unmeasured" ? "unread" : !x.hasViews && x.reactions > 0 ? "react" : "zero");
  // Batch B: a network with no numbers to read (unread) sits under the picture as one short line, not as a band.
  const rows = (R.networks || []).filter((x) => x.out > 0 && kind(x) !== "unread"), folded = (R.networks || []).filter((x) => x.out > 0 && kind(x) === "unread");
  if (rows.length < 2) return "";
  // As wide as the page gives it (680 to 1200 units, drawn about 1:1 so the words stay their size); the views column
  // keeps 254 units on the right for its labels.
  const W = Math.round(Math.min(1200, Math.max(680, (document.getElementById("home")?.clientWidth || 760) - 64))), LX = 148, RX = W - 254, BW = 12, MIN = 22, GAP = 6, EXTRA = Math.max(140, rows.length * 18), TOP = 30;
  const outAll = rows.reduce((a, x) => a + x.out, 0) || 1, vAll = rows.reduce((a, x) => a + (kind(x) === "seen" ? x.views : 0), 0);
  const left = [...rows].sort((a, b) => b.out - a.out || b.views - a.views);
  const ord = { seen: 0, react: 1, zero: 2, unread: 3 };
  const right = [...rows].sort((a, b) => ord[kind(a)] - ord[kind(b)] || b.views - a.views || b.reactions - a.reactions || b.out - a.out);
  const lh = (x) => MIN + (x.out / outAll) * EXTRA, rh = (x) => MIN + (vAll && kind(x) === "seen" ? (x.views / vAll) * EXTRA : 0);
  const pos = (list, h) => { let y = TOP; const m = new Map(); for (const x of list) { m.set(x.network, { y, h: h(x) }); y += h(x) + GAP; } return [m, y]; };
  const [L, lEnd] = pos(left, lh), [Rp, rEnd] = pos(right, rh);
  const H = Math.ceil(Math.max(lEnd, rEnd)) + 4;
  const color = (k) => (CH_STYLE[chOf(k)] || CH_STYLE[k] || ["", "#555"])[1];
  const pct = (x) => Math.max(1, Math.round((100 * x.views) / (vAll || 1)));
  const rText = (x) => ({ seen: `${n(x.views)} · ${pct(x)}%`, zero: tr("rf.zero"), react: tr("rf.reacts", { n: n(x.reactions) }), unread: tr("rf.unread") })[kind(x)];
  const first = !resFlow.drawn;  // set once the bands have grown on screen (moWatch)
  const g = left.map((x, i) => {
    const a = L.get(x.network), b = Rp.get(x.network), k = kind(x), x1 = LX + BW, x2 = RX, mid = (x1 + x2) / 2;
    const rib = `M${x1},${a.y} C${mid},${a.y} ${mid},${b.y} ${x2},${b.y} L${x2},${b.y + b.h} C${mid},${b.y + b.h} ${mid},${a.y + a.h} ${x1},${a.y + a.h} Z`;
    const label = `${name(x.network)}: ${tr("rf.postsn", { n: x.out })} → ${rText(x)}`;
    return `<g class="rf-net k-${k} ${resFlow.net === x.network ? "on" : ""}" data-rfnet="${esc(x.network)}" tabindex="0" role="button" aria-expanded="${resFlow.net === x.network}" aria-controls="rfDetail" aria-label="${esc(label)}" style="--nc:${color(x.network)};--i:${i}">
      <title>${esc(label)}</title>
      <path class="rf-rib" d="${rib}"/>
      <rect class="rf-bar" x="${LX}" y="${a.y}" width="${BW}" height="${a.h}"/>
      <rect class="rf-bar r" x="${RX}" y="${b.y}" width="${BW}" height="${b.h}"/>
      <text class="rf-r" x="${RX + BW + 8}" y="${b.y + b.h / 2}" dominant-baseline="central"><tspan class="rf-nm">${esc(name(x.network))}</tspan> <tspan class="rf-n">${k === "seen" ? `<tspan data-count="${x.views}">${n(x.views)}</tspan> · ${pct(x)}%` : esc(rText(x))}</tspan></text>
    </g>`;
  }).join("") + left.map((x) => {
    const a = L.get(x.network);
    return `<a class="rf-lane" href="#/posting/schedule/${esc(x.network)}" data-lanenet="${esc(x.network)}" aria-label="${esc(tr("rf.lane", { net: name(x.network) }))}"><title>${esc(tr("rf.lane", { net: name(x.network) }))}</title>
      <text class="rf-l" x="${LX - 8}" y="${a.y + a.h / 2}" text-anchor="end" dominant-baseline="central">${esc(name(x.network))} <tspan class="rf-n">${x.out}</tspan> ›</text></a>`;
  }).join("");
  const svg = `<svg class="rflow-svg" viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="group" aria-label="${esc(tr("rf.label"))}" preserveAspectRatio="xMinYMin meet">
    <text class="rf-h" x="${LX + BW}" y="14" text-anchor="end">${esc(tr("rf.posts"))}</text><text class="rf-h" x="${RX}" y="14">${esc(tr("rf.viewsscope", { d: R.days || 60 }))}</text>${g}</svg>`;
  // Why, for the open network.
  let detail = "";
  const o = rows.find((x) => x.network === resFlow.net);
  if (o) {
    const k = kind(o), net = name(o.network);
    const why = k === "seen" ? (pct(o) >= 50 ? tr("rf.whygood", { p: pct(o) }) : tr("rf.whyfew", { v: n(Math.round(o.avgViews || o.views / Math.max(1, o.measured))) }))
      : k === "unread" ? tr("rf.whyunread", { net }) : k === "react" ? tr("rf.whynoviews", { net })
      : o.stalled ? tr(STALL_FIX[chOf(o.network)] || STALL_FIX[o.network] || "rs.fix.other", { net }) : tr("rf.whyzero", { n: o.measured });
    const openUrl = STALL_OPEN[chOf(o.network)] || STALL_OPEN[o.network];
    detail = mapDetail({ id: "rfDetail", kcls: "rf-k-" + k, logo: netLogo(chOf(o.network)), name: net, sub: tr("rf.postsn", { n: o.out }), fresh: resFlow.shown !== o.network, closeAttr: 'data-rfnet=""',
      status: [k === "seen" ? "ok" : k === "zero" ? "bad" : "", rText(o)],
      facts: [[tr("rf.why"), esc(why)], [tr("rf.f.out"), n(o.out)], [tr("rf.f.meas"), n(o.measured)], [tr("rf.f.views"), o.hasViews ? n(o.views) : "–"],
        [tr("rf.f.per"), o.hasViews && o.measured ? n(Math.round(o.avgViews ?? o.views / o.measured)) : "–"], [tr("rf.f.react"), n(o.reactions)],
        [tr("rf.f.best"), o.best ? `<a href="#/reel/${esc(o.best.slug)}" lang="ja">${esc(reelName(o.best.slug))}</a> <span class="meta">${o.best.views != null ? n(o.best.views) : n(o.best.reactions)}</span>` : ""]],
      acts: `<a class="btn" href="#/posting/schedule/${esc(o.network)}" data-lanenet="${esc(o.network)}">${ico("cal", "sm")}${esc(tr("rf.golane"))} ›</a>`
        + ((o.stalled || k === "unread") && openUrl ? `<a class="btn" href="${escUrl(openUrl)}" target="_blank" rel="noopener">${esc(tr("rs.stall.open", { net }))} ↗</a>` : "") });
  }
  resFlow.shown = o ? o.network : null;
  const fold = folded.length ? `<p class="rf-fold" title="${esc(tr("rf.foldwhy"))}"><b>${esc(tr("rf.fold"))}</b>${folded.map((x) => `<a href="#/posting/schedule/${esc(x.network)}" data-lanenet="${esc(x.network)}" title="${esc(tr("rf.lane", { net: name(x.network) }))}">${netLogo(chOf(x.network), "sm")}${esc(name(x.network))} <span class="meta">${esc(tr("rf.foldn", { n: x.out }))}</span></a>`).join("")}<span class="meta">${esc(tr("rf.foldwhy"))}</span></p>` : "";
  return `<section class="rflow ${first ? "in" : ""}" aria-labelledby="rfTitle"><h3 id="rfTitle" class="rf-title">${esc(tr("rf.title"))}</h3><p class="meta rf-hint">${esc(tr("rf.hint"))}</p>${stall}${svg}${fold}${detail}</section>`;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-rfnet]"); if (!t || e.target.closest("[data-lanenet]")) return;
  const was = resFlow.net, id = t.dataset.rfnet;
  resFlow.net = id && id !== was ? id : null;
  renderHome(true);
  if (resFlow.net) requestAnimationFrame(() => document.getElementById("rfDetail")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }));
  else if (was) document.querySelector(`#home g[data-rfnet="${CSS.escape(was)}"]`)?.focus();
});
document.addEventListener("keydown", (e) => {
  const g = e.target.closest?.("g[data-rfnet]");
  if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); g.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
  if (e.key === "Escape" && e.target.closest?.("#rfDetail")) { e.preventDefault(); document.querySelector('#rfDetail [data-rfnet=""]')?.click(); }
});
/* Every network with posts out, side by side: posts, views per post, reactions and its best post. Fills the column
   beside the "not being shown" alert with the comparison the bars alone do not give (owner, 17 Nov: data left out,
   empty space). Views per post is what compares networks fairly: totals favour the one posted to most. */
let rnOpen = false;
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("rn-fold")) rnOpen = e.target.open; }, true);
function resNetTable(R, name, n) {
  const rows = R.networks.filter((x) => x.out > 0).sort((a, b) => (b.avgViews || 0) - (a.avgViews || 0) || b.reactions - a.reactions);
  if (rows.length < 2) return "";
  const cell = (x) => x.hasViews ? n(Math.round(x.avgViews || 0)) : "–";
  // Folded to its one line with the leader named (layout pass, 18 Nov); opening it is remembered while the studio is open.
  const lead = rows.find((x) => x.hasViews);
  return `<details class="rn-fold" ${rnOpen ? "open" : ""}><summary><b>${esc(tr("rs.tab.h"))}</b> <span class="meta">${esc(tr("ly_rs.sum", { n: rows.length }))}${lead ? " · " + esc(tr("ly_rs.lead", { net: name(lead.network), v: n(Math.round(lead.avgViews || 0)) })) : ""}</span></summary><table class="rntable">
    <thead><tr><th scope="col">${esc(tr("rs.tab.net"))}</th><th scope="col">${esc(tr("rs.tab.posts"))}</th><th scope="col">${esc(tr("rs.tab.per"))}</th><th scope="col">${esc(tr("rs.tab.react"))}</th><th scope="col" class="rn-wkh" title="${esc(tr("wk.headhint"))}">${esc(tr("wk.head"))}</th><th scope="col">${esc(tr("rs.tab.best"))}</th></tr></thead>
    <tbody>${rows.map((x) => `<tr class="${x.stalled ? "stall" : ""}"><th scope="row">${netLogo(chOf(x.network), "sm")} ${esc(name(x.network))}</th>
      <td>${x.out}${x.measured !== x.out ? `<span class="meta"> (${x.measured})</span>` : ""}</td><td>${x.verdict === "unmeasured" ? "?" : cell(x)}</td><td>${n(x.reactions)}</td>${weeklyCell(x.network, n)}
      <td class="best">${x.best ? `<a href="#/reel/${esc(x.best.slug)}" lang="ja" title="${esc(x.best.slug)}">${esc(reelName(x.best.slug))}</a> <span class="meta">${x.best.views != null ? n(x.best.views) : n(x.best.reactions)}</span>` : "–"}</td></tr>`).join("")}</tbody></table></details>`;
}
/* ---------- Results pictures (batch B, 17 Nov): expected against actual, views by week, the best time to post ----------
   Each is ONE inline svg drawn at the width the page gives it (as the flow above), with the house motion: an entrance
   once per visit (class mo-gfx + data-gx; moWatch marks it shown once it has played on screen), numbers that count
   up (data-count), and hover or focus that lifts one row or cell while the rest dim. html.mo-calm shows the end state. */
const gxFresh = (key) => !moCalm() && !moState().shown.has("gx:" + key);
const gxWidth = (min, max, pad = 64) => Math.round(Math.min(max, Math.max(min, (document.getElementById("home")?.clientWidth || 900) - pad)));
const netColor = (k) => (CH_STYLE[chOf(k)] || CH_STYLE[k] || ["", "#555"])[1];
const netName = (k) => NET_NAME[chOf(k)] || NET_NAME[k] || k;
const PX_S = { up: "px.s.up", in: "px.s.in", down: "px.s.down" };
const signed = (r) => (r < 0 ? "−" : r > 0 ? "+" : "") + Math.abs(r).toFixed(2);
/* Results › What we learned: every measured post's 80% range as a grey band (frozen when it was booked), its expected
   value as a tick and what it did as a dot, on one log scale from 0.1× to 10× a typical post on that network. Grouped
   by network, oldest first; the dot is green above the range, ink inside it, orange below. A post whose range was made
   after it went out ("late") is left out: that is no test. Click a row to open the reel. */
function predChart(v) {
  const rows = (v.rows || []).filter((x) => x.actual != null && !x.late && x.predicted?.hi > 0);
  if (rows.length < 3) return "";
  const side = (x) => (x.inside === true ? "in" : x.actual > x.predicted.hi ? "up" : x.actual < x.predicted.lo ? "down" : "in");
  const groups = new Map();
  for (const x of [...rows].sort((a, b) => new Date(a.at) - new Date(b.at))) (groups.get(x.network) || groups.set(x.network, []).get(x.network)).push(x);
  const order = [...groups].sort((a, b) => b[1].length - a[1].length || netName(a[0]).localeCompare(netName(b[0])));
  const W = gxWidth(330, 1180, 40), narrow = W < 600, LW = narrow ? 128 : Math.min(300, Math.round(W * 0.27)), RW = narrow ? 0 : 136, X0 = LW + 14, X1 = W - RW - (narrow ? 8 : 14), RH = 22, GH = 28, TOP = 26;
  const lg = (x) => Math.log10(Math.min(10, Math.max(0.1, x)));
  const px = (x) => X0 + ((lg(x) + 1) / 2) * (X1 - X0);
  const L = lang === "ja" ? "ja-JP" : "en-GB", day = (iso) => new Date(iso).toLocaleDateString(L, { day: "numeric", month: "short" });
  const fx = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "×";
  let y = TOP, body = "", i = 0;
  for (const [net, list] of order) {
    const inside = list.filter((x) => side(x) === "in").length;
    body += `<g class="px-gh"><rect x="0" y="${y + 6}" width="10" height="10" fill="${netColor(net)}"/><text class="px-gn" x="16" y="${y + 15}">${esc(netName(net))}</text><text class="px-gs" x="${narrow ? W : X1 + 14}" y="${y + 15}"${narrow ? ' text-anchor="end"' : ""}>${esc(tr("px.ginside", { i: inside, n: list.length }))}</text><path class="px-gl" d="M0,${y + GH - 2}H${W}"/></g>`;
    y += GH;
    for (const x of list) {
      const s = side(x), p = x.predicted, name = reelName(x.slug), cap = Math.max(5, Math.floor((LW - 66) / 6.8));
      const short = name.length > cap ? name.slice(0, cap - 1) + "…" : name;
      const label = `${netName(net)} · ${day(x.at)} · ${name}: ${tr("px.read", { lo: fx(p.lo), hi: fx(p.hi), mid: fx(p.mid), a: fx(x.actual), s: tr(PX_S[s]) })}`;
      const cy = y + RH / 2;
      body += `<g class="px-row s-${s}" data-pxslug="${esc(x.slug)}" data-pxread="${esc(label)}" tabindex="0" role="link" aria-label="${esc(label)}" style="--i:${i++}">
        <rect class="px-hit" x="0" y="${y}" width="${W}" height="${RH}"/>
        <text class="px-d" x="0" y="${cy + 4}">${esc(day(x.at))}</text><text class="px-n" x="58" y="${cy + 4}" lang="ja">${esc(short)}</text>
        <rect class="px-band" x="${px(p.lo).toFixed(1)}" y="${cy - 5}" width="${Math.max(2, px(p.hi) - px(p.lo)).toFixed(1)}" height="10" rx="5"/>
        <path class="px-mid" d="M${px(p.mid).toFixed(1)},${cy - 7}v14"/>
        ${x.actual > 10 || x.actual < 0.1 ? `<path class="px-clip" d="M${px(x.actual) + (x.actual > 10 ? 8 : -8)},${cy}l${x.actual > 10 ? -5 : 5},-4v8z"/>` : ""}
        <circle class="px-dot" cx="${px(x.actual).toFixed(1)}" cy="${cy}" r="5.5"/>
        ${narrow ? "" : `<text class="px-a" x="${X1 + 14}" y="${cy + 4}"><tspan class="px-av">${fx(x.actual)}</tspan> ${esc(tr(PX_S[s]))}</text>`}</g>`;
      y += RH;
    }
  }
  const H = y + 6;
  const ticks = [0.1, 0.3, 1, 3, 10].map((t) => `<path class="px-tick${t === 1 ? " one" : ""}" d="M${px(t).toFixed(1)},${TOP - 4}V${H}"/><text class="px-tl${t === 1 ? " one" : ""}" x="${px(t).toFixed(1)}" y="${TOP - 10}">${t === 1 && !narrow ? esc(tr("px.typical")) : fx(t)}</text>`).join("");
  const measured = v.measured ?? rows.length, inside = v.inside ?? rows.filter((x) => side(x) === "in").length, r = v.spearman;
  const coin = r == null ? "" : Math.abs(r) < 0.3 || measured < 15 ? tr("px.coin", { r: signed(r) }) + (r <= -0.1 ? " " + tr("px.worse") : "") : r > 0 ? tr("px.ranks", { r: signed(r) }) : tr("px.opposite", { r: signed(r) });
  // Where the rank sits between "always the opposite" (−1) and "always right" (+1); the middle third is a coin toss.
  const gauge = r == null ? "" : (() => {
    const gw = 240, gx = (q) => 12 + ((q + 1) / 2) * (gw - 24);
    return `<svg class="px-rank" viewBox="0 0 ${gw} 46" width="${gw}" height="46" role="img" aria-label="${esc(tr("px.rankaria", { r: signed(r) }))}">
      <rect class="px-rz" x="${gx(-0.3)}" y="12" width="${gx(0.3) - gx(-0.3)}" height="12"/><path class="px-rl" d="M${gx(-1)},18H${gx(1)}M${gx(-1)},13v10M${gx(0)},12v12M${gx(1)},13v10"/>
      <text class="px-rt" x="${gx(-1)}" y="40">−1</text><text class="px-rt mid" x="${gx(0)}" y="40">${esc(tr("px.cointoss"))}</text><text class="px-rt end" x="${gx(1)}" y="40">+1</text>
      <g class="px-rm" style="--x:${gx(r).toFixed(1)}px"><path d="M${gx(r).toFixed(1)},10l-5,-7h10z"/><circle cx="${gx(r).toFixed(1)}" cy="18" r="5"/></g></svg>`;
  })();
  const fresh = gxFresh("pred");
  return `<section class="pxwrap mo-gfx ${fresh ? "in" : ""}" data-gx="pred" aria-labelledby="pxTitle">
    <div class="px-top"><div class="px-num"><b><span data-count="${inside}">${inside}</span><small>/${measured}</small></b><span class="meta">${esc(tr("px.inrange"))}</span></div>
      <div class="px-num"><b class="${r != null && r < 0 ? "neg" : ""}">${r == null ? "–" : signed(r)}</b><span class="meta">${esc(tr("px.rank"))}</span></div>${gauge}
      <p class="px-say"><b>${esc(coin)}</b> <span class="meta">${esc(tr("px.cover", { i: inside, n: measured }))}</span></p></div>
    <details class="px-fold ly-fold" ${pxOpen ? "open" : ""}><summary><h3 id="pxTitle" class="rf-title">${esc(tr("px.title"))}</h3><span class="meta">${esc(tr("ly_px.sum", { i: inside, n: measured }))}</span></summary>
    <svg class="px-svg" viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="group" aria-label="${esc(tr("px.title"))}" preserveAspectRatio="xMinYMin meet">${ticks}${body}</svg>
    <div class="px-foot"><span class="px-key"><i class="k-band"></i>${esc(tr("px.k.band"))}</span><span class="px-key"><i class="k-mid"></i>${esc(tr("px.k.mid"))}</span>
      <span class="px-key"><i class="k-dot s-up"></i>${esc(tr("px.s.up"))}</span><span class="px-key"><i class="k-dot s-in"></i>${esc(tr("px.s.in"))}</span><span class="px-key"><i class="k-dot s-down"></i>${esc(tr("px.s.down"))}</span>
      <span class="grow"></span><span class="meta px-read" aria-live="polite">${esc(tr("px.hint"))}</span></div></details></section>`;
}
let pxOpen = false;  // the per-post chart folds to its title line (layout pass); opening it is remembered this visit
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("px-fold")) pxOpen = e.target.open; }, true);
document.addEventListener("click", (e) => { const g = e.target.closest?.("[data-pxslug]"); if (g) location.hash = "#/reel/" + g.dataset.pxslug; });
document.addEventListener("keydown", (e) => { const g = e.target.closest?.("[data-pxslug]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); location.hash = "#/reel/" + g.dataset.pxslug; } });
/* The line under a chart says what is under the pointer or focus (the expected-vs-actual rows, the heatmap's cells). */
function gxReadout(e) {
  const t = e.target.closest?.("[data-pxread], [data-btread]"); if (!t) return;
  const box = t.closest(".pxwrap, .btwrap, .pl")?.querySelector(".px-read, .bt-read");
  if (box) box.textContent = t.dataset.pxread || t.dataset.btread;
}
document.addEventListener("pointerover", gxReadout);
document.addEventListener("focusin", gxReadout);
/* Views by week for one network: the posts that went out each week (oldest first, at most 8, from its first post on),
   with what they have now; and last week's change, said plainly when the base is too small for a percentage. */
function weeklyOf(net) {
  if (!tableView?.rows) return null;
  const now = Date.now(), W = 7 * 864e5;
  const rows = tableView.rows.filter((x) => x.network === net && x.measured && !x.retired && x.at && x.views != null);
  if (!rows.length) return null;
  const oldest = Math.max(...rows.map((x) => now - new Date(x.at).getTime()));
  const n = Math.min(8, Math.max(2, Math.floor(oldest / W) + 1)), wk = Array(n).fill(0), posts = Array(n).fill(0);
  for (const x of rows) { const i = Math.floor((now - new Date(x.at).getTime()) / W); if (i >= 0 && i < n) { wk[n - 1 - i] += Number(x.views) || 0; posts[n - 1 - i]++; } }
  return { wk, posts, last: wk[n - 1], prev: wk[n - 2] };
}
function weeklyCell(net, fmt) {
  const w = weeklyOf(net);
  if (!w) return `<td class="rn-wk"><span class="meta">–</span></td>`;
  const { last, prev } = w;
  const ch = !last && !prev ? `<span class="rn-ch">${esc(tr("wk.none"))}</span>`
    : prev < 20 ? `<span class="rn-ch">${esc(tr("wk.vs", { a: fmt(last), b: fmt(prev) }))}</span>`
    : (() => { const d = Math.round((100 * (last - prev)) / prev); return `<span class="rn-ch ${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%</span>`; })();
  const label = tr("wk.aria", { net: netName(net), list: w.wk.map(fmt).join(", ") });
  return `<td class="rn-wk" title="${esc(label)}">${spark(w.wk, { w: 96, h: 24, label, cls: "rn-spark" })}${ch}</td>`;
}
/* Results › What we learned › Best time to post, from the studio's own numbers: day of the week × hour (the audience's
   clock), each cell the views per post that went out then; hover or focus for how many posts. "All networks" compares
   each post with its own network's median (×), so YouTube's big numbers do not drown the rest; a network whose posts
   are shown to nobody is left out of it. "Usual" is the network's average views per post. The slots Plan posts books (slotsOf) are outlined, so the owner sees whether
   they sit where the numbers are good. Under about 10 posts a network says so instead of pretending. */
const BT = { net: "all" }, BT_MIN = 10;
function btData(net) {
  const rows = (tableView?.rows || []).filter((x) => x.measured && !x.retired && x.at && x.views != null);
  const med = (list) => list.reduce((a, x) => a + (Number(x.views) || 0), 0) / Math.max(1, list.length);  // the network's average per post
  const by = new Map();
  for (const x of rows) (by.get(x.network) || by.set(x.network, []).get(x.network)).push(x);
  const nets = [...by].filter(([, l]) => l.some((x) => Number(x.views) > 0)).sort((a, b) => b[1].length - a[1].length).map(([k]) => k);
  const list = net === "all" ? rows.filter((x) => nets.includes(x.network)) : by.get(net) || [];
  const medOf = Object.fromEntries(nets.map((k) => [k, med(by.get(k))]));
  const cells = new Map();
  for (const x of list) {
    const wall = wallOf(new Date(x.at).getTime()), dow = new Date(wall.slice(0, 10) + "T12:00Z").getUTCDay(), h = +wall.slice(11, 13);
    const v = net === "all" ? ((Number(x.views) || 0) + 1) / ((medOf[x.network] || 0) + 1) : Number(x.views) || 0;
    const c = cells.get(`${dow}|${h}`) || { n: 0, sum: 0, nets: new Set() };
    c.n++; c.sum += v; c.nets.add(x.network); cells.set(`${dow}|${h}`, c);
  }
  return { nets, counts: Object.fromEntries([...by].map(([k, l]) => [k, l.length])), list, cells };
}
function bestTimeHtml() {
  if (!tableView?.rows) return "";
  const d0 = btData("all");
  if (!d0.nets.length) return "";
  const net = d0.nets.includes(BT.net) ? BT.net : "all", d = net === "all" ? d0 : btData(net), rel = net === "all", thin = d.list.length < BT_MIN;
  const ja = lang === "ja", n = (x) => Number(x).toLocaleString(ja ? "ja-JP" : "en-GB");
  const val = (c) => c.sum / c.n, fmtV = (x) => (rel ? x.toFixed(1) + "×" : x >= 1000 ? (x / 1000).toFixed(1) + "k" : String(Math.round(x)));
  const DOW = [1, 2, 3, 4, 5, 6, 0], L = ja ? "ja-JP" : "en-GB";
  const dn = (w) => new Date(Date.UTC(2026, 10, 15 + w)).toLocaleDateString(L, { weekday: "short", timeZone: "UTC" });  // 15 Nov 2026 is a Sunday
  const W = gxWidth(330, 1180, 80), LW = 40, TOP = 22, RH = 28, cw = (W - LW) / 24, H = TOP + RH * 7 + 4;
  const top = Math.max(...[...d.cells.values()].map(val), rel ? 2 : 1);
  // The slots Plan posts uses: one network's, or every planned network's on "All".
  const slotNets = rel ? PLAN_NETS() : [net], slots = new Set();
  for (const k of slotNets) for (const s of slotsOf(k)) for (const w of s.dow < 0 ? DOW : [s.dow]) slots.add(`${w}|${+s.hm.slice(0, 2)}`);
  let cells = "", outl = "";
  DOW.forEach((w, r) => {
    for (let h = 0; h < 24; h++) {
      const c = d.cells.get(`${w}|${h}`), x = LW + h * cw, y = TOP + r * RH, k = `${w}|${h}`;
      const say = `${dn(w)} ${String(h).padStart(2, "0")}:00 · ${c ? tr(rel ? (c.n === 1 ? "bt.readrel1" : "bt.readrel") : c.n === 1 ? "bt.read1" : "bt.read", { n: c.n, v: rel ? fmtV(val(c)) : n(Math.round(val(c))) }) : tr("bt.none")}${slots.has(k) ? " · " + tr("bt.slot") : ""}`;
      const t = c ? Math.sqrt(Math.min(1, val(c) / top)) : 0;
      cells += `<rect class="bt-c${c ? " has" : ""}" x="${(x + 1).toFixed(1)}" y="${y + 1}" width="${(cw - 2).toFixed(1)}" height="${RH - 2}" ${c ? `style="--t:${(0.14 + 0.86 * t).toFixed(3)};--c:${h}" tabindex="0"` : `style="--c:${h}"`} data-btread="${esc(say)}"><title>${esc(say)}</title></rect>`;
      if (c && cw >= 30) cells += `<text class="bt-v${t > 0.6 ? " on" : ""}" x="${(x + cw / 2).toFixed(1)}" y="${y + RH / 2 + 4}" style="--c:${h}">${esc(fmtV(val(c)))}</text>`;
      if (slots.has(k)) outl += `<rect class="bt-slot" x="${(x + 1.5).toFixed(1)}" y="${y + 1.5}" width="${(cw - 3).toFixed(1)}" height="${RH - 3}"/>`;
    }
  });
  const heads = Array.from({ length: 24 }, (_, h) => (h % (cw >= 30 ? 1 : cw >= 20 ? 3 : 6) === 0 ? `<text class="bt-h" x="${(LW + h * cw + cw / 2).toFixed(1)}" y="14">${String(h).padStart(2, "0")}</text>` : "")).join("");
  const rows = DOW.map((w, r) => `<text class="bt-d${w === 0 || w === 6 ? " we" : ""}" x="0" y="${TOP + r * RH + RH / 2 + 4}">${esc(dn(w))}</text>`).join("");
  const thinBox = thin ? `<g class="bt-thin"><rect x="${LW + (W - LW) / 2 - Math.min(200, (W - LW) / 2 - 4)}" y="${TOP + RH * 2.5 - 20}" width="${Math.min(400, W - LW - 8)}" height="56"/><text x="${LW + (W - LW) / 2}" y="${TOP + RH * 2.5 + 2}" class="bt-tt">${esc(tr("bt.thin", { n: d.list.length, m: BT_MIN }))}</text><text x="${LW + (W - LW) / 2}" y="${TOP + RH * 2.5 + 22}" class="bt-ts">${esc(tr("bt.thinsub"))}</text></g>` : "";
  // The plain reading: the best cell so far, and whether nearly everything went out at one hour (nothing to compare).
  const hours = new Map(); for (const x of d.list) { const h = +wallOf(new Date(x.at).getTime()).slice(11, 13); hours.set(h, (hours.get(h) || 0) + 1); }
  const [topH, topN] = [...hours].sort((a, b) => b[1] - a[1])[0] || [0, 0];
  const best = [...d.cells].filter(([, c]) => c.n >= 2).sort((a, b) => val(b[1]) - val(a[1]))[0];
  const slotList = [...new Set(slotNets.flatMap((k) => slotsOf(k).map((s) => (s.dow < 0 ? "" : dn(s.dow) + " ") + s.hm)))].slice(0, 6).join(", ");
  const say = [
    best && !thin ? tr("bt.best", { d: dn(+best[0].split("|")[0]), h: String(best[0].split("|")[1]).padStart(2, "0"), v: rel ? fmtV(val(best[1])) : n(Math.round(val(best[1]))), n: best[1].n }) : "",
    d.list.length && topN / d.list.length >= 0.75 ? tr("bt.onehour", { h: String(topH).padStart(2, "0"), n: topN, m: d.list.length }) : "",
    slotList ? tr("bt.slots", { s: slotList }) : "",
  ].filter(Boolean);
  const tabs = ["all", ...d.nets].map((k) => `<button type="button" role="tab" aria-selected="${k === net}" class="${k === net ? "on" : ""}" data-btnet="${esc(k)}">${k === "all" ? esc(tr("bt.all")) : `${netLogo(chOf(k), "sm")}${esc(netName(k))}`} <span>${k === "all" ? d.nets.reduce((a, x) => a + d.counts[x], 0) : d.counts[k]}</span></button>`).join("");
  const fresh = gxFresh("bt");
  return `<section class="sheet btwrap mo-gfx ${fresh ? "in" : ""}${thin ? " thin" : ""}" data-gx="bt" aria-labelledby="btTitle"><h2 id="btTitle">${ico("clock", "sm")} ${esc(tr("bt.title"))}</h2>
    <p class="meta">${esc(tr(rel ? "bt.hintall" : "bt.hint"))}</p>
    <div class="seg bt-tabs" role="tablist" aria-label="${esc(tr("bt.pick"))}">${tabs}</div>
    <svg class="bt-svg" viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="group" aria-label="${esc(tr("bt.title"))}" preserveAspectRatio="xMinYMin meet">${heads}${rows}${cells}${outl}${thinBox}</svg>
    <div class="px-foot"><span class="px-key"><i class="k-ramp"></i>${esc(tr(rel ? "bt.k.rel" : "bt.k.views"))}</span><span class="px-key"><i class="k-slot"></i>${esc(tr("bt.k.slot"))}</span>
      <span class="grow"></span><span class="meta bt-read" aria-live="polite">${esc(tr("bt.hover"))}</span></div>
    ${say.length ? `<p class="bt-say">${say.map((s) => esc(s)).join(" ")}</p>` : ""}${rbExperimentsHtml()}</section>`;
}
document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-btnet]"); if (!b) return; BT.net = b.dataset.btnet; renderHome(true); });
/* Results › a band's network name opens Posting's Week with only that network (its lane). */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-lanenet]"); if (!a) return;
  e.preventDefault();
  postView = "lanes"; try { localStorage.setItem("lc.post.view2", "lanes"); } catch { /* private window */ }
  const to = `#/posting/schedule/${encodeURIComponent(a.dataset.lanenet)}`;
  if (location.hash !== to) location.hash = to; else renderHome(true);
});
/* Networks that show the posts to nobody (perf.reach "stalled": several posts, days out, every one at nothing). The owner,
   16 Nov: "are the reels and posting actually performing?" TikTok had 15 posts at 0 views and Facebook 6 reels
   at 0 plays, and the page said so in one grey line under a green "+1307%". That is not a weak reel but a network that
   is not showing them, so it comes first, in red, with where to look; a better reel will not fix it. */
const STALL_FIX = { tiktok: "rs.fix.tiktok", facebook: "rs.fix.facebook", bluesky: "rs.fix.bluesky" };
const STALL_OPEN = { tiktok: "https://www.tiktok.com/tiktokstudio", facebook: "https://business.facebook.com/latest/insights/",
  bluesky: "https://bsky.app/profile/me", x: "https://x.com/i/account_analytics" };
function resStallHtml(stalled) {
  if (!stalled?.length) return "";
  const ja = lang === "ja", sep = ja ? "・" : ", ";
  const name = (k) => NET_NAME[chOf(k)] || NET_NAME[k] || k;
  const posts = stalled.reduce((a, x) => a + x.measured, 0);
  const days = Math.max(2, Math.floor(Math.max(...stalled.map((x) => x.oldestH || 0)) / 24));
  // One line: the networks as chips and "why?"; open, it shows the same reasons and links as before.
  return `<details class="rstall"${resStallHtml.open ? " open" : ""} aria-label="${esc(tr("rs.stall.title", { nets: stalled.map((x) => name(x.network)).join(sep) }))}">
    <summary>${ico("alert", "sm")}<b>${esc(tr("rs.stall.short"))}</b>${stalled.map((x) => `<span class="rs-chip">${netLogo(chOf(x.network), "sm")}${esc(name(x.network))}</span>`).join("")}<span class="rs-why">${esc(tr("rs.stall.why"))}</span></summary>
    <div class="rs-body"><p>${esc(tr("rs.stall.lead", { n: posts, d: days }))}</p>
    <ul>${stalled.map((x) => {
      const open = STALL_OPEN[chOf(x.network)] || STALL_OPEN[x.network];
      return `<li><span class="rnet">${netLogo(chOf(x.network), "sm")}<b>${esc(tr(x.hasViews ? "rs.stall.net" : "rs.stall.netr", { net: name(x.network), n: x.measured }))}</b></span>
        <span>${esc(tr(STALL_FIX[chOf(x.network)] || STALL_FIX[x.network] || "rs.fix.other", { net: name(x.network) }))}</span>
        ${open ? `<a class="linkish" href="${escUrl(open)}" target="_blank" rel="noopener">${esc(tr("rs.stall.open", { net: name(x.network) }))} ↗</a>` : ""}</li>`;
    }).join("")}</ul></div>
  </details>`;
}
// The reasons stay open (or shut) through the page's repaints.
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("rstall")) resStallHtml.open = e.target.open; }, true);
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-restab]");
  if (!t) return;
  const k = { learn: "next", schedule: "where" }[t.dataset.restab] || t.dataset.restab;
  if (RES_TABS[k]) location.hash = rbHash(k);
});
/* ---------- Results › Every post and the YouTube channel (GET /api/perf/table, /api/perf/channel) ----------
   Every post's latest numbers in one table, and every video on the connected YouTube channels (Shorts, long videos,
   live), the ones the studio did not make too. The owner, 14 Nov: "make sure all the above performance should be
   able to see on the console". */
/* Every label these pages use, written out (test/i18n.test.mjs checks each one is defined). */
const TB_SORT = { at: "tb.s.at", views: "tb.s.views", reactions: "tb.s.reactions" };
const CH_KIND = { all: "ch.k.all", short: "ch.k.short", long: "ch.k.long", live: "ch.k.live" };
const CH_KIND1 = { short: "ch.k1.short", long: "ch.k1.long", live: "ch.k1.live", processing: "ch.k1.processing" };
const CH_PRIV = { private: "ch.p.private", unlisted: "ch.p.unlisted" };
const CM_TOPIC = { price: "cm.t.price", booking: "cm.t.booking", access: "cm.t.access", work: "cm.t.work", car: "cm.t.car", facilities: "cm.t.facilities",
  pets: "cm.t.pets", groups: "cm.t.groups", night: "cm.t.night", season: "cm.t.season" };
const CM_KIND = { question: "cm.k.question", praise: "cm.k.praise", spam: "cm.k.spam", reaction: "cm.k.reaction", other: "cm.k.other" };
const CM_STATE = { open: "cm.f.open", answered: "cm.f.answered", skipped: "cm.f.skipped", quiet: "cm.f.quiet" };
let tblOld = false, chanMine = true;
let tableView = null, tblNet = "all", tblSort = "at", tblAll = false, chanView = null, chanKind = "all", chanAll = false, chanPriv = false, chanBusy = false;
async function loadTable() {
  try { tableView = await api("/api/perf/table?days=90"); } catch { tableView = { rows: [], networks: [], error: true }; }
  if (page === "results") renderHome(true);
}
async function loadChannel(fresh) {
  chanBusy = true; if (page === "results") renderHome(true);
  try { chanView = await api("/api/perf/channel" + (fresh ? "?fresh=1" : "")); } catch (err) { chanView = { channels: [], error: err.message }; }
  chanBusy = false; if (page === "results") renderHome(true);
}
const numCell = (v, fmt) => `<td class="num">${v == null ? '<span class="meta">–</span>' : esc(fmt ? fmt(v) : Number(v).toLocaleString())}</td>`;
function tableHtml() {
  if (tableView === null) { tableView = undefined; loadTable(); }
  if (!tableView) return `<section class="sheet">${loadingHtml(tr("tb.h"))}</section>`;
  if (!tableView.rows?.length) return "";
  const old = tableView.rows.filter((x) => x.retired).length;
  let rows = tableView.rows.filter((x) => (tblNet === "all" || x.network === tblNet) && (tblOld || !x.retired));
  const key = { views: (x) => x.views ?? -1, reactions: (x) => x.reactions ?? -1, at: (x) => new Date(x.at).getTime() || 0 }[tblSort];
  rows = [...rows].sort((a, b) => key(b) - key(a));
  const live = rows.filter((x) => !x.retired);
  const total = (k) => live.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const shown = tblAll ? rows : rows.slice(0, 12);
  const nets = tableView.networks.filter((n) => tableView.rows.some((x) => x.network === n && !x.retired));
  const pct = (v) => `${Math.round(v)}%`;
  // A column empty in every row shown (no shares, no saves anywhere yet) is left out: it only said "0" 31 times.
  const cols = [["likes", "tb.likes"], ["comments", "tb.comments"], ["shares", "tb.shares"], ["saves", "tb.saves"], ["avg_view_pct", "tb.pct"]]
    .filter(([k]) => rows.some((x) => x.measured && Number(x[k]) > 0));
  const vmax = Math.max(1, ...rows.map((x) => Number(x.views) || 0));
  const RETIRED = { replaced: "tb.r.replaced", removed: "tb.r.removed" };
  const post = (x) => {
    const r = overview.reels.find((y) => y.slug === x.slug);
    // a reel shows its opening frame; a YouTube video without one, YouTube's own thumbnail; nothing else, no grey box
    const pic = r?.hook ? `<span class="mini" style="background-image:url('${thumb(r.hook, 80)}')"></span>`
      : x.video ? `<span class="mini wide" style="background-image:url('https://i.ytimg.com/vi/${esc(x.video)}/mqdefault.jpg')"></span>` : "";
    const href = /^vlog-\d+$/.test(x.slug) ? "#/videos" : `#/reel/${esc(x.slug)}`;
    const label = x.title || (r ? reelName(x.slug) : x.slug);
    const name = `<span class="clamp" lang="ja" title="${esc(x.slug)}">${esc(label)}</span>${x.retired ? `<span class="meta">${tr(RETIRED[x.retired])}</span>` : ""}`;
    return `<a href="${href}">${pic}<span class="postname">${name}</span></a>${x.best ? `<span class="bestchip">${tr("tb.best")}</span>` : ""}`;
  };
  const head = `<div class="tbtools">
      ${nets.length > 1 ? `<div class="pnets tbnets">${["all", ...nets].map((n) => `<a href="javascript:void 0" data-tblnet="${esc(n)}" class="${n === tblNet ? "on" : ""}">${n === "all" ? tr("tb.all") : `${netLogo(chOf(n), "sm")}${esc(NET_NAME[chOf(n)] || NET_NAME[n] || n)}`}</a>`).join("")}</div>` : ""}
      <span class="grow"></span>
      ${old ? `<button class="linkish" data-tblold="1">${tr(tblOld ? "tb.oldhide" : "tb.old", { n: old })}</button>` : ""}
      <label class="meta">${tr("tb.sort")} <select data-tblsort>${["at", "views", "reactions"].map((k) => `<option value="${k}" ${k === tblSort ? "selected" : ""}>${tr(TB_SORT[k])}</option>`).join("")}</select></label></div>`;
  return `<section class="sheet tbsheet">${head}
    <div class="tscroll"><table class="facts ptable"><thead><tr><th>${tr("tb.reel")}</th>${nets.length > 1 ? `<th>${tr("res.net")}</th>` : ""}<th>${tr("tb.when")}</th><th class="num">${tr("tb.views")}</th>
      ${cols.map(([k, label]) => `<th class="num" ${k === "avg_view_pct" ? `title="${esc(tr("tb.pcthint"))}"` : ""}>${tr(label)}</th>`).join("")}<th></th></tr></thead>
    <tbody>${shown.map((x) => {
      const open = x.url && /^https?:/.test(x.url) && !/compose|studio|admin|manager|business\.google/.test(x.url) && x.retired !== "removed";
      return `<tr class="${x.best ? "best" : ""}${x.measured ? "" : " unread"}${x.retired ? " retired" : ""}"><td class="reelcell">${post(x)}</td>
        ${nets.length > 1 ? `<td class="netcell">${netLogo(chOf(x.network), "sm")} ${esc(NET_NAME[chOf(x.network)] || NET_NAME[x.network] || x.network)}</td>` : ""}<td class="meta">${esc(whenText(x.at))}</td>
        ${x.measured ? `<td class="num vcell">${x.views == null ? '<span class="meta">–</span>' : `<span class="vwrap" aria-hidden="true"><i style="width:${(100 * (Number(x.views) || 0) / vmax).toFixed(1)}%"></i></span>${Number(x.views).toLocaleString()}`}</td>`
          + cols.map(([k]) => numCell(x[k], k === "avg_view_pct" ? pct : undefined)).join("")
          : `<td class="waitcell">${tr("tb.waiting")}</td>${cols.map(() => '<td class="num"><span class="meta">–</span></td>').join("")}`}
        <td>${open ? `<a class="linkish" href="${escUrl(x.url)}" target="_blank" rel="noopener">${tr("act.open")} ↗</a>` : ""}</td></tr>`;
    }).join("")}</tbody>
    <tfoot><tr><td colspan="${nets.length > 1 ? 3 : 2}"><b>${tr("tb.total", { n: live.length })}</b></td><td class="num"><b>${total("views").toLocaleString()}</b></td>${cols.map(([k]) => `<td class="num">${k === "avg_view_pct" ? "" : `<b>${total(k).toLocaleString()}</b>`}</td>`).join("")}<td></td></tr></tfoot></table></div>
    ${rows.length > 12 ? `<button class="linkish" data-tblall="1">${tblAll ? tr("tb.less") : tr("tb.more", { n: rows.length })}</button>` : ""}
    <p class="meta">${tr("tb.hint", { d: tableView.days })}</p></section>`;
}
const CH_SHOWN = 12;  // videos listed before "Show all" (layout pass, 18 Nov: 20 two-line rows were 2 screens alone)
function channelHtml() {
  if (chanView === null) { chanView = undefined; loadChannel(false); }
  if (!chanView) return `<section class="sheet"><h2>${tr("ch.h")}</h2>${loadingHtml(tr("ch.h"))}</section>`;
  if (!chanView.channels?.length) return chanView.error ? `<section class="sheet"><h2>${tr("ch.h")}</h2><p class="warnline">${ico("alert", "sm")} ${esc(chanView.error)}</p></section>` : "";
  const kinds = ["all", "short", "long", "live"];
  const fmtS = (sec) => sec == null ? "" : sec >= 3600 ? `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  return chanView.channels.map((c) => {
    if (c.error) return `<section class="sheet"><h2>${tr("ch.h")}</h2><p class="warnline">${ico("alert", "sm")} ${esc(c.error)}</p></section>`;
    const made = (c.items || []).filter((v) => v.slug).length;
    const mine = chanMine && made > 0;  // a personal channel lists 600 videos; the ones this studio made come first
    const items = (c.items || []).filter((v) => (!mine || v.slug) && (chanKind === "all" || v.kind === chanKind) && (chanPriv || mine || v.privacy !== "private"));
    const shown = chanAll ? items : items.slice(0, CH_SHOWN);
    const bk = c.byKind || {};
    const sum = ["short", "long", "live"].filter((k) => bk[k]).map((k) => `<div class="kstat"><b>${tr(CH_KIND[k])}</b><span>${tr("ch.kline", { n: bk[k].videos, v: Number(bk[k].views).toLocaleString(), m: Number(bk[k].median).toLocaleString(), l: Number(bk[k].likes).toLocaleString(), c: Number(bk[k].comments).toLocaleString() })}</span></div>`).join("");
    return `<section class="sheet chsheet"><div class="row-tight sheethead"><h2>${ico("play", "sm")} ${esc(c.channel || tr("ch.h"))}</h2><span class="meta">${tr("ch.totals", { s: Number(c.subscribers || 0).toLocaleString(), v: Number(c.views || 0).toLocaleString(), n: Number(c.videos || 0).toLocaleString() })} (${esc(tr("ch.totalsscope"))})</span><span class="grow"></span>
        <button class="linkish" data-chfresh="1" ${chanBusy ? "disabled" : ""}>${ico(chanBusy ? "hourglass" : "refresh", "sm")}${tr("ch.fresh")}</button></div>
      <div class="kstats">${sum}</div>
      ${c.note ? `<p class="meta warnline">${ico("info", "sm")} ${esc(c.note)}</p>` : !c.analytics ? `<p class="meta">${tr("ch.noanalytics")}</p>` : ""}
      <div class="row-tight">${made ? `<div class="seg"><button data-chmine="1" class="${mine ? "on" : ""}">${tr("ch.mine")} <span>${made}</span></button><button data-chmine="0" class="${mine ? "" : "on"}">${tr("ch.whole")} <span>${(c.items || []).length}</span></button></div>` : ""}
        ${mine ? "" : `<div class="seg">${kinds.map((k) => `<button data-chkind="${k}" class="${k === chanKind ? "on" : ""}">${tr(CH_KIND[k])}</button>`).join("")}</div>
        <label class="meta"><input type="checkbox" data-chpriv="1" ${chanPriv ? "checked" : ""}> ${tr("ch.priv")}</label>`}</div>
      <div class="tscroll"><table class="facts ptable"><thead><tr><th>${tr("ch.video")}</th><th>${tr("tb.when")}</th><th class="num">${tr("tb.views")}</th><th class="num" title="${esc(tr("ch.engagedhint"))}">${tr("ch.engaged")}</th><th class="num">${tr("tb.likes")}</th><th class="num">${tr("tb.comments")}</th>
        <th class="num">${tr("ch.watch")}</th><th class="num">${tr("tb.pct")}</th></tr></thead>
      <tbody>${shown.map((v) => `<tr class="${v.privacy !== "public" ? "unread" : ""}"><td class="vidcell"><a href="${escUrl(v.url)}" target="_blank" rel="noopener" class="clamp" title="${esc(v.title)}">${esc(v.title)}</a>
          <span class="meta">${tr(CH_KIND1[v.kind] || "ch.k1.long")}${v.seconds ? ` · ${fmtS(v.seconds)}` : ""}${v.privacy !== "public" ? ` · ${v.booked ? tr("ch.booked", { t: whenText(v.booked) }) : tr(CH_PRIV[v.privacy] || "ch.p.private")}` : ""}${v.slug ? ` · <a href="#/reel/${esc(v.slug)}">${esc(v.slug)}</a>` : ""}</span></td>
          <td class="meta">${esc(whenText(v.at))}</td>${numCell(v.views)}${numCell(v.engaged)}${numCell(v.likes)}${numCell(v.comments)}${numCell(v.watchMin, (m) => tr("ch.min", { m: Number(m).toLocaleString() }))}${numCell(v.avgPct, (x) => `${Math.round(x)}%`)}</tr>`).join("")}</tbody></table></div>
      ${items.length > CH_SHOWN ? `<button class="linkish" data-chall="1">${chanAll ? tr("tb.less") : tr("tb.more", { n: items.length })}</button>` : ""}
      <p class="meta">${tr("ch.hint", { n: c.listed })}</p></section>`;
  }).join("");
}
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-tblnet],[data-tblall],[data-tblold],[data-chkind],[data-chall],[data-chfresh],[data-chmine]");
  if (!t) return;
  if (t.dataset.tblnet) { tblNet = t.dataset.tblnet; tblAll = false; }
  else if (t.dataset.tblold) tblOld = !tblOld;
  else if (t.dataset.chmine) { chanMine = t.dataset.chmine === "1"; chanAll = false; }
  else if (t.dataset.tblall) tblAll = !tblAll;
  else if (t.dataset.chkind) { chanKind = t.dataset.chkind; chanAll = false; }
  else if (t.dataset.chall) chanAll = !chanAll;
  else if (t.dataset.chfresh) { loadChannel(true); return; }
  renderHome(true);
});
document.addEventListener("change", (e) => {
  if (e.target.matches?.("[data-tblsort]")) { tblSort = e.target.value; renderHome(true); }
  if (e.target.matches?.("[data-chpriv]")) { chanPriv = e.target.checked; renderHome(true); }
});

/* ---------- Results › Comments (GET/POST /api/comments…, py/studio/comments.py) ----------
   Every comment from YouTube, Bluesky and the Facebook Page in one list. A reply is drafted only from the owner's own
   answers; the owner sends it, or turns on "Answer plain questions by myself" for saved answers only. */
let cmView = null, cmBusy = false, cmFilter = "open";
async function loadComments() {
  try { cmView = await api("/api/comments"); } catch (err) { cmView = cmView || { items: [], counts: {}, networks: {}, settings: {}, answers: { topics: {} }, topics: [], error: err.message }; }
  // never redraw over a reply being typed
  if (page === "comments" && !document.activeElement?.closest?.("#home form")) renderHome(true);
  else if (page === "results") renderHome(true);
  else paintNav();
}
function cmLine() {
  if (cmView === null) { cmView = undefined; loadComments(); }
  const n = cmView?.counts?.open || 0, q = cmView?.counts?.questions || 0;
  if (!cmView) return "";
  return `<p class="cmline">${ico("chat", "sm")} ${n ? `<a href="#/comments"><b>${tr(q ? "cm.line.q" : "cm.line", { n, q })}</b></a>` : `<span class="meta">${tr("cm.line.none")}</span> <a class="linkish" href="#/comments">${tr("cm.open")}</a>`}</p>`;
}
const CM_NETS = ["youtube", "bluesky", "facebook"];
function renderComments() {
  if (cmView === null) { cmView = undefined; loadComments(); }
  const head = `<div class="pagehead">${crumbs([tr("nav.results"), "#/results"], [tr("sub.comments")])}<span class="grow"></span>
    <button class="primary" data-cmcheck="1" ${cmBusy ? "disabled" : ""}>${ico(cmBusy ? "hourglass" : "refresh", "sm")}${tr(cmBusy ? "cm.checking" : "cm.check")}</button></div>`;
  if (!cmView) { $("#home").innerHTML = head + loadingHtml(tr("sub.comments")); return; }
  const V = cmView, S = V.settings || {}, A = V.answers || { topics: {} };
  const netRow = (n) => {
    const st = V.networks?.[n];
    const say = !st ? `<span class="meta">${tr("cm.notyet")}</span>`
      : st.need === "scope" ? `<span class="warnline">${ico("alert", "sm")} ${esc(st.say || "")} <a href="#/accounts">${tr("nav.accounts")}</a></span>`
      : st.need === "connect" ? `<span class="meta">${tr("cm.notconnected")} <a href="#/accounts">${tr("nav.accounts")}</a></span>`
      : st.ok === false ? `<span class="warnline">${ico("alert", "sm")} ${esc(st.say || "")}</span>`
      : `<span class="meta">${tr(st.older ? "cm.netold" : "cm.netok", { n: st.count || 0, o: st.older || 0, t: whenText(st.checked) })}</span>`;
    return `<li>${netLogo(n, "sm")} <b>${esc(NET_NAME[n] || n)}</b> ${say}</li>`;
  };
  const states = ["open", "answered", "skipped", "quiet"];
  const items = (V.items || []).filter((x) => x.state === cmFilter);
  const topicName = (t) => (CM_TOPIC[t] ? tr(CM_TOPIC[t]) : t);
  const card = (x) => {
    const on = x.video?.title || x.video?.slug ? `<span class="meta">${tr("cm.on")} ${x.video.slug ? `<a href="#/reel/${esc(x.video.slug)}">${esc(x.video.title || x.video.slug)}</a>` : esc(x.video.title)}</span>` : "";
    const chips = `<span class="cmkind k-${esc(x.kind)}">${tr(CM_KIND[x.kind] || "cm.k.other")}</span>${(x.topics || []).map((t) => `<span class="cmtopic">${esc(topicName(t))}</span>`).join("")}`;
    const open = x.url ? `<a class="linkish" href="${escUrl(x.url)}" target="_blank" rel="noopener">${tr("cm.openon", { n: NET_NAME[x.network] || x.network })} ↗</a>` : "";
    let foot = "";
    if (x.state === "open") {
      const d = x.draft || { text: "", missing: [] };
      const why = d.text ? tr(d.auto ? "cm.d.saved" : "cm.d.unsaved", { t: d.from.map(topicName).join(", ") })
        : d.missing?.length ? tr("cm.d.missing", { t: d.missing.map(topicName).join(", ") })
        : x.kind === "praise" ? tr("cm.d.praise") : x.toUs === false ? tr("cm.d.between") : tr("cm.d.own");
      foot = `<form class="cmform" data-cmreply="${esc(x.id)}"><textarea name="text" rows="3" maxlength="1000" placeholder="${esc(tr("cm.ph"))}">${esc(d.text || "")}</textarea>
        <p class="meta">${esc(why)}${d.missing?.length ? ` <button type="button" class="linkish" data-cmanswersopen="1">${tr("cm.addanswer")}</button>` : ""}</p>
        ${x.autoError ? `<p class="warnline">${ico("alert", "sm")} ${esc(x.autoError)}</p>` : ""}
        <div class="row-tight"><button class="primary" type="submit" ${x.canReply === false ? "disabled" : ""}>${ico("send", "sm")}${tr("cm.send")}</button>
          <button type="button" data-cmskip="${esc(x.id)}">${tr("cm.skip")}</button>${open}</div></form>`;
    } else if (x.reply) {
      foot = `<p class="cmreply">${ico("check", "sm")} ${esc(x.reply.text)}<span class="meta"> · ${tr(x.reply.auto ? "cm.sentauto" : "cm.sentyou")} · ${esc(whenText(x.reply.at))}</span></p><div class="row-tight">${open}</div>`;
    } else if (x.state === "answered") {
      foot = `<p class="meta">${ico("check", "sm")} ${tr("cm.answeredthere")}</p><div class="row-tight">${open}</div>`;
    } else if (x.state === "skipped") {
      foot = `<div class="row-tight"><button type="button" data-cmskip="${esc(x.id)}" data-cmon="0">${tr("cm.unskip")}</button>${open}</div>`;
    } else foot = `<div class="row-tight">${open}</div>`;
    return `<article class="cmcard st-${esc(x.state)}"><div class="cmhead">${netLogo(chOf(x.network), "sm")}<b>${esc(x.author || "—")}</b><span class="meta">${esc(whenText(x.at))}</span>${chips}</div>
      <p class="cmtext">${esc(x.text)}</p>${on}${foot}</article>`;
  };
  const savedN = (V.topics || []).filter((t) => A.topics?.[t]?.saved).length;
  const ansForm = `<details class="sheet cmanswers" ${renderComments.answersOpen ? "open" : ""}><summary><b>${tr("cm.answers")}</b> <span class="meta">${tr("cm.answers.count", { n: savedN, of: (V.topics || []).length })} · ${tr("cm.answers.sub")}</span></summary>
    ${A.link ? "" : `<p class="warnline">${ico("info", "sm")} ${tr("cm.answers.nolink")}</p>`}
    <p class="meta">${tr("cm.answers.hint")}</p>
    <form data-cmanswers="1">${(V.topics || []).map((t) => { const a = A.topics?.[t] || {}; return `<fieldset class="cmans"><legend>${esc(topicName(t))} <span class="meta">${a.saved ? `${ico("check", "sm")} ${tr("cm.saved")}` : tr("cm.unsavedtag")}</span></legend>
      <label><span class="meta">日本語</span><textarea name="${t}.ja" rows="2">${esc(a.ja || "")}</textarea></label><label><span class="meta">English</span><textarea name="${t}.en" rows="2">${esc(a.en || "")}</textarea></label></fieldset>`; }).join("")}
      <label class="cmlink"><span class="meta">${tr("cm.link")}</span><input name="link" type="url" value="${esc(A.link || "")}" placeholder="https://"></label>
      <button class="primary" type="submit">${ico("save", "sm")}${tr("cm.saveanswers")}</button></form></details>`;
  $("#home").innerHTML = `${head}
    <p class="intro">${tr("cm.intro")}</p>
    ${V.error ? `<p class="warnline">${ico("alert", "sm")} ${esc(V.error)}</p>` : ""}
    <div class="seg cmfilter">${states.map((k) => `<button data-cmf="${k}" class="${k === cmFilter ? "on" : ""}">${tr(CM_STATE[k])} <b>${V.counts?.[k] || 0}</b></button>`).join("")}</div>
    <div class="cmlist">${items.length ? items.map(card).join("") : `<div class="empty">${ico("chat")}<b>${tr(cmFilter === "open" ? "cm.none.open" : "cm.none")}</b>${cmFilter === "open" ? `<span>${tr("cm.none.hint")}</span>` : ""}</div>`}</div>
    <h2 class="cmsettings">${tr("cm.settings")}</h2>
    <div class="twocol cmtop"><section class="sheet"><h2>${tr("cm.where")}</h2><ul class="cmnets">${CM_NETS.map(netRow).join("")}</ul>
      <p class="meta">${tr("cm.unsupported")}</p>${V.checked ? `<p class="meta">${tr("cm.checked", { t: whenText(V.checked) })}</p>` : ""}</section>
    <section class="sheet"><h2>${tr("cm.auto.h")}</h2>
      <label class="cmswitch"><input type="checkbox" data-cmauto="1" ${S.auto ? "checked" : ""}> <b>${tr("cm.auto.on")}</b></label>
      <p class="meta">${tr("cm.auto.rules", { w: S.wait || 20, c: S.cap || 6 })}</p>
      <label class="meta">${tr("cm.cap")} <input type="number" min="1" max="30" value="${S.cap || 6}" data-cmcap="1" style="width:5em"></label>
      <p class="meta">${tr("cm.today", { n: S.sentToday || 0, c: S.cap || 6 })}</p></section></div>
    ${ansForm}`;
}
async function cmPost(path, body, okMsg) {
  try {
    const v = await post(path, body);
    if (v?.items) cmView = v; else if (v?.item && cmView) cmView.items = cmView.items.map((x) => (x.id === v.item.id ? v.item : x));
    if (v?.item && cmView) { cmView.counts = cmView.counts || {}; await loadComments(); }
    if (okMsg) toast(`${ico("check", "sm")} ${esc(okMsg)}`, 5000);
    return true;
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); return false; }
  finally { if (page === "comments") renderHome(true); }
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest?.("[data-cmcheck],[data-cmskip],[data-cmf],[data-cmanswersopen]");
  if (!t) return;
  if (t.dataset.cmf) { cmFilter = t.dataset.cmf; renderHome(true); return; }
  if (t.dataset.cmanswersopen) { renderComments.answersOpen = true; renderHome(true); $("#home .cmanswers")?.scrollIntoView({ block: "start" }); return; }
  if (t.dataset.cmskip) { await cmPost("/api/comments/skip", { id: t.dataset.cmskip, on: t.dataset.cmon !== "0" }); return; }
  if (t.dataset.cmcheck) {
    cmBusy = true; renderHome(true);
    try { cmView = await post("/api/comments/check", {}); toast(`${ico("check", "sm")} ${esc(tr("cm.checkdone", { n: cmView.new || 0 }))}`, 5000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 9000); }
    cmBusy = false; renderHome(true);
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.matches?.("[data-cmauto]")) {
    const on = e.target.checked;
    if (on && !confirmAuto()) { e.target.checked = false; return; }
    await cmPost("/api/comments/settings", { auto: on }, tr(on ? "cm.auto.ison" : "cm.auto.isoff"));
  }
  if (e.target.matches?.("[data-cmcap]")) await cmPost("/api/comments/settings", { cap: Number(e.target.value) });
});
/* Turning answers on by themselves is the owner's express consent (YouTube API policy III.I.2): say exactly what it
   will do first. A page dialog, never the browser's confirm(). */
function confirmAuto() {
  const saved = Object.entries(cmView?.answers?.topics || {}).filter(([, a]) => a.saved).map(([t]) => (CM_TOPIC[t] ? tr(CM_TOPIC[t]) : t));
  if (!saved.length) { toast(`${ico("info", "sm")} ${esc(tr("cm.auto.needsaved"))}`, 9000); renderComments.answersOpen = true; return false; }
  return true;
}
document.addEventListener("submit", async (e) => {
  const f = e.target.closest?.("[data-cmreply],[data-cmanswers]");
  if (!f) return;
  e.preventDefault();
  if (f.dataset.cmreply) {
    const text = new FormData(f).get("text")?.toString().trim();
    if (!text) { toast(`${ico("alert", "sm")} ${esc(tr("cm.empty"))}`, 5000); return; }
    f.querySelector("button[type=submit]").disabled = true;
    document.activeElement?.blur?.();
    await cmPost("/api/comments/reply", { id: f.dataset.cmreply, text }, tr("cm.sent"));
    return;
  }
  const topics = {};
  for (const [k, v] of new FormData(f)) {
    if (k === "link") continue;
    const [t, l] = k.split(".");
    topics[t] = topics[t] || {};
    topics[t][l] = String(v);
  }
  const changed = Object.fromEntries(Object.entries(topics).filter(([t, a]) => {
    const old = cmView?.answers?.topics?.[t] || {};
    return (a.ja || "") !== (old.ja || "") || (a.en || "") !== (old.en || "") || ((a.ja || a.en) && !old.saved);
  }));
  document.activeElement?.blur?.();
  renderComments.answersOpen = true;
  if (await cmPost("/api/comments/answers", { topics: changed, link: String(new FormData(f).get("link") || "") }, tr("cm.answerssaved"))) await loadComments();
});
/* ---------- Results › what the numbers say (GET /api/perf/insights, py/studio/perf.py insights) ----------
   The owner, 18 Nov: "check if the reels are doing well … any other optimization or enhancement we can make?". What
   answered it was read off the channel table by hand: the opening that broke out, the Short that stalled, how much of a
   Short people watch, that the live stream gains followers and the Shorts do not, posts going to an account few people
   follow, Story numbers nobody reads, suggestions no better than chance yet. Each is a card: the number that matters and
   what to do; one opens its detail under the cards. Four show; the rest wait behind "more" (no long pages). */
let insView = null, insMore = false;
let insOpen = (() => { try { return localStorage.getItem("lc.insOpen") || ""; } catch { return ""; } })();
const insN = (x) => Number(x || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB");
const insVs = (a, b) => `${insN(a)}<small> ${tr("in.vs")} ${insN(b)}</small>`;
function insCards() {
  const V = insView, out = [];
  if (!V || V.error) return out;
  const y = V.youtube, cv = V.convert, rel = V.related || { done: 0, of: 0, items: [] };
  // Engaged views when YouTube Analytics gives them (a plain view is any start or replay since March 2025).
  if (y?.kept) {
    const o = y.kept.outside, low = o ? y.kept.pct * 1.5 < o.pct : y.kept.pct < 15;
    out.push({ k: "kept", tone: low ? "warn" : "info", icon: "eye", t: tr(low ? "in.keep.t" : "in.keep.tok"),
      big: o ? `${y.kept.pct} %<small> ${tr("in.vs")} ${o.pct} %</small>` : `${y.kept.pct} %`,
      sub: tr(o ? "in.keep.sub" : "in.keep.subnone", { n: y.kept.n, o: o?.n || 0 }), act: tr("in.keep.do") });
  }
  if (y?.hook) out.push({ k: "hook", tone: "good", icon: "type", t: tr("in.hook.t", { p: esc(y.hook.phrase) }), big: insVs(y.hook.with.median, y.hook.without.median),
    sub: tr(y.hook.metric === "engaged" ? "in.hook.subeng" : "in.hook.sub", { a: y.hook.with.n, b: y.hook.without.n }), act: tr("in.hook.do", { p: esc(y.hook.phrase) }) });
  const per = (subs, views) => (views ? (1000 * subs) / views : 0);
  if (cv?.live && cv.shorts.views && cv.live.views && per(cv.live.subs, cv.live.views) > per(cv.shorts.subs, cv.shorts.views)) {
    out.push({ k: "live", tone: rel.of && rel.done >= rel.of ? "good" : "warn", icon: "users", t: tr("in.live.t"),
      big: `${per(cv.shorts.subs, cv.shorts.views).toFixed(1)}<small> ${tr("in.vs")} ${per(cv.live.subs, cv.live.views).toFixed(1)}</small>`,
      sub: tr("in.live.sub"), act: tr("in.live.do", { d: rel.done, n: rel.of }) });
  }
  if (y?.stalled?.length) out.push({ k: "stalled", tone: "bad", icon: "alert", t: tr(y.stalled.length === 1 ? "in.stall.t1" : "in.stall.t", { n: y.stalled.length }),
    big: `<span lang="ja">${esc(reelName(y.stalled[0].slug))}</span>`, sub: tr("in.stall.sub", { v: insN(y.stalled[0].views), m: insN(y.median) }), act: tr("in.stall.do") });
  if (y?.watch) out.push({ k: "watch", tone: "info", icon: "eye", t: tr("in.watch.t"), big: tr("in.watch.big", { s: y.watch.avgS, of: y.watch.seconds }),
    sub: tr("in.watch.sub", { p: y.watch.pct, n: y.watch.n }), act: tr("in.watch.do") });
  const st = V.stories;
  if (st?.need) out.push({ k: "stories", tone: "warn", icon: "camera", t: tr("in.story.t"), big: tr(st.need === "permission" ? "in.story.perm" : "in.story.conn"),
    sub: tr("in.story.lost", { n: st.out }), act: tr("in.story.do") });
  else if (st?.read) out.push({ k: "stories", tone: "info", icon: "camera", t: tr("in.story.t"), big: insN(st.views) + `<small> ${tr("in.story.views")}</small>`,
    sub: st.exitPct != null ? tr("in.story.taps", { e: st.exitPct, o: st.onPct }) : tr("in.story.read", { r: st.read, n: st.out }), act: tr("in.story.do2") });
  for (const a of V.accounts || []) out.push({ k: `acct-${a.network}`, tone: "warn", icon: "user", t: tr("in.acct.t", { net: esc(NET_NAME[a.network] || a.network) }),
    big: `@${esc(a.handle)}`, sub: a.followers != null ? tr("in.acct.fol", { f: insN(a.followers), p: a.posts }) : tr("in.acct.sub", { p: a.posts, v: insN(a.views) }), act: tr("in.acct.do") });
  if (V.outside) out.push({ k: "outside", tone: "info", icon: "film", t: tr("in.out.t"), big: insVs(V.outside.median, V.outside.studio), sub: tr("in.out.sub", { n: V.outside.n }), act: tr("in.out.do") });
  const r = predView?.spearman;
  if (typeof r === "number" && Math.abs(r) < 0.2 && (predView.measured || 0) >= 10) out.push({ k: "model", tone: "info", icon: "info", t: tr("in.model.t"),
    big: `r = ${r.toFixed(2)}`, sub: tr("in.model.sub", { n: predView.measured }), act: tr("in.model.do", { tab: tr("rs.t.learn") }) });
  return out;
}
function insDetail(k) {
  const V = insView, y = V?.youtube;
  const row = (a, b, c = "") => `<li><span class="clamp">${a}</span><b>${b}</b>${c ? `<span>${c}</span>` : "<span></span>"}</li>`;
  const yt = (id) => (id ? `<a href="https://www.youtube.com/shorts/${encodeURIComponent(id)}" target="_blank" rel="noopener">YouTube ↗</a>` : "");
  if (k === "kept" && y?.kept) return `<p>${tr("in.keep.why", { p: y.kept.pct, o: y.kept.outside?.pct ?? "–" })}</p>`;
  if (k === "hook" && y?.hook) {
    const eng = y.hook.metric === "engaged";
    return `<p>${tr(eng ? "in.hook.whyeng" : "in.hook.why", { p: esc(y.hook.phrase), n: y.shorts, l: y.hook.lift })}</p>
    ${eng && y.hook.kept ? `<p>${tr("in.hook.kept", { p: esc(y.hook.phrase), a: y.hook.kept.with, b: y.hook.kept.without })}</p>` : ""}
    <ul class="inlist">${y.hook.examples.map((x) => row(`<a href="#/reel/${esc(x.slug)}" lang="ja">${esc(x.opener)}</a>`, insN(eng ? x.engaged : x.views), `<span class="meta">${tr(eng ? "ch.engaged" : "tb.views")}</span>`)).join("")}</ul>
    <p class="meta">${tr("in.hook.test")}</p>`;
  }
  if (k === "live" && V.related) {
    const lv = V.convert?.live;
    return `<p>${tr("in.live.why", { live: lv ? `<a href="${escUrl(lv.url)}" target="_blank" rel="noopener" lang="ja">${esc(lv.title)}</a>` : "" })}</p>
      <p class="meta">${tr("in.live.api")}</p>
      <ul class="inlist">${V.related.items.map((x) => `<li class="${x.done ? "done" : ""}"><a class="clamp" lang="ja" href="https://studio.youtube.com/video/${encodeURIComponent(x.id)}/edit" target="_blank" rel="noopener" title="${esc(x.title)}">${esc(x.title)} ↗</a>
        <b>${insN(x.views)}</b><label><input type="checkbox" data-related="${esc(x.id)}" ${x.done ? "checked" : ""}> ${tr("in.live.done")}</label></li>`).join("")}</ul>`;
  }
  if (k === "stalled" && y?.stalled) return `<p>${tr("in.stall.why")}</p>
    <ul class="inlist">${y.stalled.map((x) => row(`<a href="#/reel/${esc(x.slug)}" lang="ja">${esc(x.title || x.slug)}</a>`, insN(x.views), yt(x.id))).join("")}</ul>
    <p class="meta">${tr("in.stall.top", { list: (y.top || []).map((x) => `「${esc(x.opener)}」 ${insN(x.views)}`).join(lang === "ja" ? "・" : ", ") })}</p>`;
  if (k === "watch" && y?.watch) {
    const w = y.watch, box = (lab, x) => (x ? `<div><span class="meta">${lab}</span><b>${tr("in.watch.kept", { p: x.pct })}</b><span class="meta">${tr("in.watch.med", { v: insN(x.views), n: x.n })}</span></div>` : "");
    return `<div class="insplit">${box(tr("in.watch.le", { s: w.split }), w.short)}${box(tr("in.watch.gt", { s: w.split }), w.long)}</div><p>${tr("in.watch.why")}</p>`;
  }
  if (k === "stories" && V.stories) return V.stories.need ? `<p>${tr("in.story.why")}</p><p><a class="btn" href="#/accounts">${ico("user", "sm")}${tr("nav.accounts")}</a></p>`
    : `<p>${tr("in.story.sum", { v: insN(V.stories.views), r: insN(V.stories.reach), n: V.stories.read })}</p><p class="meta">${tr("in.story.how")}</p>`;
  if (k.startsWith("acct-")) { const a = (V.accounts || []).find((x) => `acct-${x.network}` === k); return a ? `<p>${tr("in.acct.why", { net: esc(NET_NAME[a.network] || a.network), h: esc(a.handle) })}</p><p><a class="btn" href="#/accounts">${ico("user", "sm")}${tr("nav.accounts")}</a></p>` : ""; }
  if (k === "outside" && V.outside) return `<p>${tr("in.out.why", { n: V.outside.n, m: insN(V.outside.median), s: insN(V.outside.studio) })}</p>${V.outside.kept ? `<p>${tr("in.out.kept", { o: V.outside.kept.outside, s: V.outside.kept.studio })}</p>` : ""}`;
  if (k === "model" && predView) return `<p>${tr("in.model.why", { r: predView.spearman.toFixed(2), n: predView.measured })}</p>`;
  return "";
}
function resInsightsHtml() {
  if (insView === null) { insView = undefined; api("/api/perf/insights").then((v) => { insView = v; }, () => { insView = { error: true }; }).then(() => { if (page === "results") renderHome(true); }); }
  const cards = insCards();
  if (!cards.length) return "";
  const open = cards.find((c) => c.k === insOpen);
  const shown = insMore ? cards : cards.slice(0, 4);
  if (open && !shown.includes(open)) shown.push(open);
  return `<section class="ins" aria-labelledby="ins-h"><div class="inshead"><h2 id="ins-h">${tr("in.h")}</h2><span class="meta">${tr("in.note")}</span></div>
    <div class="incards">${shown.map((c) => `<button type="button" class="incard ${c.tone}" data-ins="${esc(c.k)}" aria-expanded="${c === open}" aria-controls="ins-detail">
      <span class="inlabel">${ico(c.icon, "sm")}<span>${c.t}</span></span><b class="inbig">${c.big}</b><span class="meta">${c.sub}</span><span class="indo">${c.act}</span>${RB_DOES[c.k] ? `<span class="rb-does">${ico("check", "sm")} ${esc(tr(RB_DOES[c.k]))}</span>` : ""}</button>`).join("")}</div>
    ${cards.length > 4 ? `<button type="button" class="linkish inmore" data-insmore="1">${insMore ? tr("tb.less") : tr("in.more", { n: cards.length - 4 })}</button>` : ""}
    ${open ? `<div class="indetail" id="ins-detail" role="region" aria-label="${esc(open.t.replace(/<[^>]+>/g, ""))}"><h3>${ico(open.icon, "sm")}<span>${open.t}</span><span class="grow"></span><button type="button" class="linkish" data-ins="${esc(open.k)}">${ico("x", "sm")}${tr("wz.close")}</button></h3>${insDetail(open.k)}${rbTestHtml(open.k)}</div>` : ""}</section>`;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-ins],[data-insmore]");
  if (!t) return;
  if (t.dataset.insmore) insMore = !insMore;
  else { insOpen = insOpen === t.dataset.ins ? "" : t.dataset.ins; try { localStorage.setItem("lc.insOpen", insOpen); } catch { /* private window */ } }
  renderHome(true);
  if (insOpen && t.dataset.ins) requestAnimationFrame(() => document.getElementById("ins-detail")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
});
document.addEventListener("change", async (e) => {
  const box = e.target.closest?.("[data-related]");
  if (!box) return;
  const id = box.dataset.related, done = box.checked, it = insView?.related?.items?.find((x) => x.id === id);
  try {
    await post("/api/perf/related", { id, done });
    if (it && it.done !== done) { it.done = done; insView.related.done += done ? 1 : -1; }
  } catch (err) { box.checked = !done; toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
  renderHome(true);
});
/* ---------- Results, Track B (24 Nov UX audit, BL-107 to BL-110): Check leads straight to Act ----------
   Five tabs with their own addresses, each at most about two screens at 1440×900: Overview (#/results: the week, what
   the numbers say, the next thing to try), What to try next (#/results/next: try next with "Make a reel like this",
   what worked, best time with the experiments running, predicted vs actual), Where views come from (#/results/where:
   posts in, views out, each network, out and booked), Every post (#/results/posts), YouTube channel (#/results/youtube). */
const rbHash = (k) => (k === "overview" ? "#/results" : "#/results/" + k);
// WEEKLY VIEWS: the one definition (Track B). Results › Views this week and Reels › Today both call this; no page
// recomputes it. The numbers come from the server (py/studio/perf.py week_views, in every /api/perf/table answer as
// `week`): views so far on the posts that went out in the last 7×24 hours, against what the posts of the 7 days before
// had at this same point last week (like with like: young posts are still gaining views); replaced or removed uploads
// left out. null until a table answer has loaded, else { now, before, pct (null when last week had under 3 posts with
// views), tone ("up" | "down" | ""), label (plain words, no HTML), foot (the short footnote), def (the full definition),
// posts, beforePosts }.
function weekViews() {
  const w = tableView?.week || todayPerf?.week || weekViews.rows(tableView?.rows || todayPerf?.rows);
  if (!w?.now || !w.before) return null;
  const n = (x) => Number(x || 0).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB");
  const b = w.before, pct = w.pct ?? null;
  const label = !b.posts ? tr("rs.firstweek") : pct == null ? tr(b.seen === 1 ? "rs.beforefew1" : "rs.beforefew", { n: n(b.views), k: b.seen })
    : tr(pct >= 0 ? "rb.wk.up" : "rb.wk.down", { p: Math.abs(pct), n: n(b.views) });
  return { now: w.now.views, before: b.views, pct, tone: pct == null ? "" : pct >= 0 ? "up" : "down", label, foot: tr("rb.wk.foot"), def: tr("rb.wk.def"),
    posts: w.now.posts, beforePosts: b.posts };
}
/* A server from before 24 Nov sends no `week`: the same sums from the table's rows, last week as it stands now. */
weekViews.rows = (rows) => {
  if (!rows) return null;
  const now = Date.now(), W = 7 * 864e5, z = () => ({ views: 0, posts: 0, seen: 0, measured: 0 }), out = { now: z(), before: z() };
  for (const x of rows) {
    const age = now - new Date(x.at).getTime();
    if (x.retired || !x.at || !(age >= 0 && age < 2 * W)) continue;
    const k = age < W ? out.now : out.before, v = Number(x.views) || 0;
    k.posts++; k.views += v; k.seen += v > 0 ? 1 : 0; k.measured += x.measured ? 1 : 0;
  }
  out.pct = out.before.views > 0 && out.before.seen >= 3 ? Math.round((100 * (out.now.views - out.before.views)) / out.before.views) : null;
  return out;
};
/* MAKER PRESET HOOK (Track B → Track A). Results' "Make a reel like this" (each Try next row) and "Set up this test" (an
   insight card) call makeLike(preset). It never makes or books anything: it keeps the preset in window.makerPreset and
   opens Make reels. preset = { from: "try" | "test", look, recipe, style, length ("16-22 s"…), hour ("18-20"…),
   mode: "learned" | "explore", why (sentence), test?: { kind: "hook" | "length", phrase?, split? }, at }.
   Track A: show it in the Make reels panel and send it with the make request (look/recipe/style override the drawn
   ones), then clear window.makerPreset. Until then the panel opens with the cut that fits the length, and the toast
   says what the suggestion was. */
function makeLike(preset) {
  window.makerPreset = { ...preset, at: Date.now() };
  if (preset.length) autoCut = /35-60|over 60/.test(preset.length) ? "long" : "short";
  openMaker();
  toast(`${ico("clapper", "sm")} ${esc(tr(preset.from === "test" ? "rb.made.test" : "rb.made.try", { what: rbPresetWords(preset) }))}`, 10000);
}
function rbPresetWords(x) {
  const STYLE = { column: "res.s.column", centre: "res.s.centre", lower: "res.s.lower", split: "res.s.split" };
  if (x.test?.kind === "hook") return tr("rb.test.hookw", { p: x.test.phrase || "" });
  if (x.test?.kind === "length") return tr("rb.test.lenw", { s: x.test.split || "" });
  return [x.look && x.look !== "plain" && nameOf("looks", x.look), x.recipe && x.recipe !== "none" && nameOf("recipes", x.recipe),
    x.style && (STYLE[x.style] ? tr(STYLE[x.style]) : x.style), x.length && rbLen(x.length), x.hour && tr("res.p.hour", { v: x.hour })].filter(Boolean).join(lang === "ja" ? "、" : ", ");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-rbmake],[data-rbtest]"); if (!b) return;
  if (b.dataset.rbmake != null) {
    const x = perfSuggest?.suggestions?.[+b.dataset.rbmake]; if (!x) return;
    makeLike({ from: "try", look: x.look, recipe: x.recipe, style: x.style, length: x.length, hour: x.hour, mode: x.mode, why: Object.values(x.why || {}).join(" ") });
    return;
  }
  const y = insView?.youtube;
  if (b.dataset.rbtest === "hook" && y?.hook) makeLike({ from: "test", test: { kind: "hook", phrase: y.hook.phrase }, why: tr("rb.test.hookwhy", { p: y.hook.phrase }) });
  if (b.dataset.rbtest === "length" && y?.watch) makeLike({ from: "test", test: { kind: "length", split: y.watch.split }, why: tr("rb.test.lenwhy", { s: y.watch.split }) });
});
/* Sent back in review (Track D's one-tap reject reasons, GET /api/review/reasons): one line in What worked, and a tag on
   a suggested look that was sent back twice or more. */
let rbRej = null;
const RB_REJ_DAYS = 30;
function rbRejLoad() {
  if (rbRej !== null) return;
  rbRej = undefined;
  api(`/api/review/reasons?days=${RB_REJ_DAYS}`).then((v) => { rbRej = v || {}; }, () => { rbRej = { error: true }; }).then(() => { if (page === "results") renderHome(true); });
}
function rbRejLine() {
  rbRejLoad();
  const R = rbRej;
  if (!R?.total) return "";
  const sep = lang === "ja" ? "・" : " · ";
  const by = Object.entries(R.by || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${tr("td_rv.r." + k)} ${n}`).join(sep);
  const looks = Object.entries(R.looks || {}).filter(([k, n]) => k && n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${nameOf("looks", k)} ${n}`).join(sep);
  return `<p class="rb-rej">${ico("x", "sm")}<span>${esc(tr("rb.rej.line", { d: R.days || RB_REJ_DAYS, list: by }))}${looks ? ` <b>${esc(tr("rb.rej.looks", { list: looks }))}</b>` : ""}</span>
    <a class="linkish" href="#/review">${esc(tr("sub.review"))} ›</a></p>`;
}
/* Try next, each with "Make a reel like this" (the same sentence once, however often the draw repeats it). */
function rbTryList(max = 9) {
  const sug = perfSuggest?.suggestions || [], seen = new Set(), out = [];
  sug.forEach((x, i) => {
    const h = tryRow(x);
    if (seen.has(h) || out.length >= max) return;
    seen.add(h);
    const sent = x.look && rbRej?.looks?.[x.look] >= 2 ? `<span class="tag t-mismatch rb-rejtag">${esc(tr("rb.rej.tag", { n: rbRej.looks[x.look], d: rbRej.days || RB_REJ_DAYS }))}</span>` : "";
    out.push(h.replace(/<\/p><\/li>$/, `${sent}</p></li>`).replace(/<\/li>$/, `<button type="button" class="rb-make" data-rbmake="${i}" title="${esc(Object.values(x.why || {}).join("\n"))}">${ico("clapper", "sm")}${esc(tr("rb.make"))}</button></li>`));
  });
  return out.length ? `<ol class="trylist rb-try">${out.join("")}</ol>` : "";
}
/* "Set up this test" under an insight card that has a fair A/B test: two reels alike but for one thing, booked at the
   same hour on two days next to each other. The studio explains and opens Make reels; it never books by itself. */
function rbTestHtml(k) {
  const y = insView?.youtube;
  const steps = k === "hook" && y?.hook ? [tr("rb.test.s1"), tr("rb.test.hook2", { p: esc(y.hook.phrase) }), tr("rb.test.s3")]
    : k === "watch" && y?.watch ? [tr("rb.test.s1"), tr("rb.test.len2", { s: y.watch.split }), tr("rb.test.s3")] : null;
  if (!steps) return "";
  return `<details class="rb-test"><summary>${ico("layers", "sm")}<b>${esc(tr("rb.test.h"))}</b><span class="meta">${esc(tr("rb.test.sub"))}</span></summary>
    <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol><p class="meta">${esc(tr("rb.test.read"))}</p>
    <div class="row"><button type="button" class="primary" data-rbtest="${k === "hook" ? "hook" : "length"}">${ico("clapper", "sm")}${esc(tr("rb.test.go"))}</button>
    <a class="btn" href="#/posting">${ico("cal", "sm")}${esc(tr("rb.test.week"))}</a></div></details>`;
}
/* What the studio already does about a card, said only where it is true. */
const RB_DOES = { model: "rb.does.model" };
/* Results › Best time › Experiments running (BL-109). Plan posts books every 4th post on a network with more than one
   listed hour at one of its other hours (helper.mjs EXPLORE_EVERY; the plan item says test: "hour", the posting row does
   not keep it), so a test is a booking or post at a listed hour other than the network's usual one (amcHours). Read when
   RB_TEST_N posts there are about 3 days old; until then an early ratio against the usual hour, from 2 measured posts. */
const RB_TEST_N = 8;
function rbExperiments() {
  const now = Date.now(), DAY = 864e5, out = [];
  const hm = (iso) => wallOf(new Date(iso).getTime()).slice(11, 16);
  const avg = (list) => list.reduce((a, x) => a + (Number(x.views) || 0), 0) / Math.max(1, list.length);
  for (const n of POST_NETS) {
    const h = amcHours(n);
    if (!h.others?.length || chanOf(n)?.off) continue;
    const rows = postsLog.filter((p) => p.network === n && p.at && ["scheduled", "queued", "posted"].includes(p.status));
    const read = (tableView?.rows || []).filter((x) => x.network === n && x.measured && !x.retired && x.at && x.views != null);
    for (const t of h.others) {
      const at = rows.filter((p) => hm(p.at) === t).map((p) => new Date(p.at).getTime()).sort((a, b) => a - b);
      if (!at.length) continue;
      const gone = at.filter((x) => x <= now).length, test = read.filter((x) => hm(x.at) === t), base = read.filter((x) => hm(x.at) === h.usual);
      const readAt = at.length >= RB_TEST_N ? at[RB_TEST_N - 1] + 3 * DAY : Math.max(now, at[at.length - 1]) + (RB_TEST_N - at.length) * 4 * DAY + 3 * DAY;
      out.push({ n, hm: t, usual: h.usual, out: gone, booked: at.length - gone, readAt,
        early: test.length >= 2 && base.length >= 2 && avg(base) > 0 ? avg(test) / avg(base) : null, measured: test.length });
    }
  }
  return out;
}
function rbExperimentsHtml() {
  const list = rbExperiments(), day = (t) => postDayLabel(wallOf(t).slice(0, 10));
  return `<div class="rb-exp" data-anchor="experiments"><p class="rb-exph"><b>${ico("layers", "sm")} ${esc(tr("rb.exp.h"))}</b><span class="meta">${esc(tr("rb.exp.does", { k: 4 }))}</span></p>
    ${list.length ? `<ul>${list.map((x) => `<li>${netLogo(chOf(x.n), "sm")}<span>${esc(tr("rb.exp.row", { h: x.hm, net: netName(x.n), u: x.usual, o: x.out, of: RB_TEST_N, d: day(x.readAt) }))}${x.booked ? " " + esc(tr("rb.exp.booked", { n: x.booked })) : ""}${x.early != null ? ` <b class="${x.early >= 1 ? "up" : "down"}">${esc(tr("rb.exp.early", { r: x.early.toFixed(1), n: x.measured }))}</b>` : ""}</span></li>`).join("")}</ul>` : `<p class="meta">${esc(tr("rb.exp.none"))}</p>`}</div>`;
}
/* Why the page is still thin, said once: the same count as "What worked" (perf summary measured / needed), so the page
   never says both "the first real comparison is around Fri" and "enough for firm findings" (BL-108). */
function rbWaitLine() {
  const pv = perfView && !perfView.unavailable ? perfView : null;
  if (!pv) return "";
  const have = pv.measured || 0, want = pv.needed || 15;
  if (have >= want) return "";
  const now = Date.now(), next = postsLog.filter((x) => x.network !== "all" && x.at && ["scheduled", "queued"].includes(x.status)).map((x) => new Date(x.at).getTime()).filter((t) => t > now).sort((a, b) => a - b);
  const nth = next[Math.min(next.length - 1, want - have - 1)];
  return `<p class="note">${ico("clock", "sm")} ${esc(tr(nth ? "rb.wait" : "rb.waitnone", { n: have, of: want, when: nth ? postDayLabel(wallOf(nth + 3 * 864e5).slice(0, 10)) : "" }))}</p>`;
}
/* Overview: the week, one sentence on where views come from, what the numbers say, and the next thing to try. */
function rbOverviewHtml() {
  rbRejLoad();
  const sug = rbTryList(2);
  return `${resTopHtml()}${resNetsHtml("say")}${resInsightsHtml()}
    <section class="rb-next" aria-labelledby="rbNextH"><div class="rb-nexthead"><h2 id="rbNextH">${ico("clapper", "sm")} ${esc(tr("res.next"))}</h2>
      <a class="linkish" href="#/results/next">${esc(tr("rb.allnext"))} ›</a></div>
      ${sug || rbNoSug()}</section>`;
}
/* Why Try next is empty, said truly (fx): still reading, the request failed, nothing new although posts are measured,
   or no numbers yet. "After the first numbers come in" used to show in every case, even beside "61 measured posts". */
function rbNoSug() {
  if (perfSuggest == null) return `<div class="loading-block" role="status"><span class="spin"></span><span>${esc(tr("res.reading"))}</span></div>`;
  if (perfSuggest.failed) return `<p class="meta warnline">${ico("alert", "sm")} ${esc(tr("fx.res.failed"))} <button class="linkish" data-perfretry="1">${ico("refresh", "sm")}${esc(tr("sys.retry"))}</button></p>`;
  const pv = perfView && !perfView.unavailable ? perfView : null;
  return `<p class="meta">${esc(tr(pv?.measured ? "fx.res.nonenow" : "res.nosug"))}</p>`;
}
/* What to try next: the Act page. Try next and what worked side by side, then best time (with the experiments), then
   how well the score predicted. */
function rbNextHtml(perfWait, vlogOnly) {
  const pv = perfView && !perfView.unavailable ? perfView : null;
  const pct = pv ? Math.min(100, Math.round(100 * (pv.measured || 0) / (pv.needed || 15))) : 0;
  return `${rbWaitLine()}
    <div class="twocol learnrow rb-act">
      <section class="sheet" data-anchor="try"><h2>${tr("res.next")}</h2>
        ${vlogOnly ? `<p class="meta">${tr("rs.notry")}</p>` : rbTryList() || rbNoSug()}
        ${perfSuggest?.note && !vlogOnly ? `<p class="meta">${esc(perfSuggest.note)}</p>` : ""}</section>
      <section class="sheet" data-anchor="worked"><h2>${tr("res.learned")}</h2>
        ${pv ? `<div class="learnprog">${pv.headline && !/^\d+ measured posts?\.?$/i.test(pv.headline) ? `<p><b>${esc(pv.headline)}</b></p>` : ""}<div class="sbar big" role="progressbar" aria-valuenow="${pv.measured || 0}" aria-valuemax="${pv.needed || 15}"><i style="width:${pct}%"></i></div>
          <p class="meta">${tr((pv.measured || 0) >= (pv.needed || 15) ? "res.measuredok" : "res.measured", { n: pv.measured || 0, of: pv.needed || 15 })}</p></div>` : perfWait || `<p class="meta">${tr("res.soon")}</p>`}
        ${pv?.worked?.length ? `<h3>${tr("res.worked")}</h3><ul class="idealist">${pv.worked.map(effectRow).join("")}</ul>` : ""}
        ${pv?.didnt?.length ? `<h3>${tr("res.didnt")}</h3><ul class="idealist">${pv.didnt.map(effectRow).join("")}</ul>` : ""}
        ${pv && !pv.worked?.length && !pv.didnt?.length ? `<p class="meta">${tr("res.notyet")}</p>` : ""}
        ${rbRejLine()}
        <p class="rb-does">${ico("check", "sm")} ${esc(tr("rb.does.worked"))}</p>
        ${pv?.method ? `<details class="meta"><summary>${tr("res.how")}</summary><p>${esc(pv.method)}</p></details>` : ""}</section>
    </div>
    <div data-anchor="besttime">${bestTimeHtml()}</div>
    <div data-anchor="predicted">${predHtml()}</div>`;
}
/* Find anything (Ctrl K) reaches the Results sections and the Act settings by name (BL-107: none of "try next", "best
   time", "what worked", "learned", "runs by itself" found anything). Loop and Learned looks are Track A's parts. */
const rbGo = (hash, anchor) => () => { if (location.hash !== hash) location.hash = hash; else renderHome(true); if (anchor) flashAnchor(anchor); };
const RB_FIND = [
  ["overview", "wave", "rb.f.overview", "rb.f.overviewsub", rbGo("#/results"), "results overview this week views numbers say insights 結果 今週 再生 数字"],
  ["try", "clapper", "res.next", "rb.f.trysub", rbGo("#/results/next", "try"), "try next suggestion suggestions what to make next 次に試す 提案"],
  ["worked", "check", "res.learned", "rb.f.workedsub", rbGo("#/results/next", "worked"), "what worked helped held back learned learn 効いた 学んだ"],
  ["besttime", "clock", "bt.title", "rb.f.btsub", rbGo("#/results/next", "besttime"), "best time hour when to post heatmap 良い時間 ベストタイム 時間 いつ 投稿時間"],
  ["experiments", "layers", "rb.exp.h", "rb.f.expsub", rbGo("#/results/next", "experiments"), "experiments experiment test tests hour a/b ab 実験 テスト"],
  ["predicted", "info", "pa.h", "rb.f.predsub", rbGo("#/results/next", "predicted"), "predicted vs actual prediction score forecast 予測 実績 スコア"],
  ["where", "send", "rb.t.where", "rb.f.wheresub", rbGo("#/results/where"), "where views come from posts in views out networks sankey flow どこから ネットワーク"],
  ["posts", "list", "rs.t.posts", "rb.f.postssub", rbGo("#/results/posts"), "every post table all posts numbers すべての投稿 表"],
  ["runs", "refresh", "ab.h", "rb.f.runssub", rbGo("#/posting", "checks"), "runs by itself automation auto booking autopilot 自動 ひとりでに"],
  ["learnedlooks", "clapper", "rb.f.looks", "rb.f.lookssub", () => openMaker(), "learned looks use what worked steer steering learned 学習 効いた見た目"],
  ["loop", "refresh", "rb.f.loop", "rb.f.loopsub", rbGo("#/today", "loop"), "loop pdca plan do check act cycle ループ サイクル"],
  ["map", "user", "rb.f.map", "rb.f.mapsub", rbGo("#/accounts"), "accounts map connections networks map アカウント マップ 接続"],
  ["photos", "camera", "sub.photos", "rb.f.photossub", rbGo("#/photos"), "photo posts photos carousel stories 写真 投稿 カルーセル"],
];
function renderResults() {
  if (!postsLoaded || !overviewLoaded) { $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.results")])}</div>${loadingHtml(tr("nav.results"))}`; return; }
  if (perfView === null) { perfView = undefined; loadPerf(); }
  if (tableView === null) { tableView = undefined; loadTable(); }
  if (!scoreMap && resTab === "learn") loadScores();
  const out = postsLog.filter((x) => x.network !== "all");
  if (!out.length) {
    $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.results")])}</div>
      <div class="empty mascot">${kenji("work")}<b>${tr("re.none")}</b><span>${tr("re.hint")}</span><a class="btn" href="#/posting">${ico("send", "sm")}${tr("nav.posting")}</a></div>
      ${channelHtml()}`;
    return;
  }
  const by = Object.fromEntries(POST_NETS.map((n) => [n, { posted: 0, scheduled: 0 }]));
  const gone = new Set((tableView?.rows || []).filter((x) => x.retired).map((x) => x.id));  // replaced or deleted uploads
  for (const x of out) {
    if (isHistory(x)) continue;  // a swapped-out version would count its replacement twice
    if (gone.has(x.id)) continue;  // an upload replaced by a newer one, or deleted from YouTube
    const now0 = postState(x.slug)[x.network]?.status || x.status;
    const st = now0 === "queued" ? "scheduled" : now0;  // Bluesky's studio-sent bookings are queued: booked all the same
    if (by[x.network] && (st === "posted" || st === "scheduled")) by[x.network][st]++;
  }
  const topN = Math.max(1, ...POST_NETS.map((n) => by[n].posted + by[n].scheduled));
  const bar = (n) => `<td class="barcell" aria-hidden="true"><span class="hbar"><i class="p" style="width:${(100 * by[n].posted / topN).toFixed(1)}%"></i><i class="s" style="width:${(100 * by[n].scheduled / topN).toFixed(1)}%"></i></span></td>`;
  // When each network's next post goes out: a network with none out yet shows when it starts, not just "0".
  const now = Date.now(), nextAt = {};
  for (const x of out) {
    if (!["scheduled", "queued"].includes(x.status) || !x.at) continue;
    const t = new Date(x.at).getTime();
    if (t > now && (!nextAt[x.network] || t < new Date(nextAt[x.network]).getTime())) nextAt[x.network] = x.at;
  }
  const rows = POST_NETS.filter((n) => by[n].posted + by[n].scheduled).map((n) => `<tr><td class="netcell">${netLogo(n, "sm")} ${esc(NET_NAME[n])}</td>${bar(n)}<td class="num">${by[n].posted}</td><td class="num">${by[n].scheduled}</td>
    <td class="nextcell">${nextAt[n] ? esc(whenText(nextAt[n])) : "–"}</td><td class="num">${esc(perfView?.networks?.[n]?.median != null ? String(perfView.networks[n].median) : "–")}</td></tr>`).join("");
  const pv = perfView && !perfView.unavailable ? perfView : null;
  const perfWait = perfView === undefined ? `<div class="loading-block" role="status"><span class="spin"></span><span>${tr("res.reading")}</span></div>`
    : perfView?.unavailable ? `<p class="meta warnline">${ico("alert", "sm")} ${tr("res.unread")} <button class="linkish" data-perfretry="1">${ico("refresh", "sm")}${tr("sys.retry")}</button></p>` : "";
  const pct = pv ? Math.min(100, Math.round(100 * (pv.measured || 0) / (pv.needed || 15))) : 0;
  const need = perfCollect?.needsNumbers || [];
  const sug = perfSuggest?.suggestions || [];
  const vlogOnly = !!tableView?.rows?.length && tableView.rows.every((x) => /^vlog-\d+$/.test(x.slug));  // long videos: the suggestions are reel recipes
  const resTabs = Object.keys(RES_TABS).filter((k) => k === resTab || tabShown("results/" + k));  // simple mode: Overview alone, no tab row
  $("#home").innerHTML = `<div class="pagehead">${crumbs([tr("nav.results")])}<span class="grow"></span>
      ${postsLog.some((x) => x.status === "posted") ? `<button class="primary" data-perfcollect="1" ${perfBusy ? "disabled" : ""}>${ico(perfBusy ? "hourglass" : "refresh", "sm")}${tr(perfBusy ? "res.collecting" : "res.collect")}</button>` : ""}</div>
    ${resTabs.length < 2 ? "" : `<nav class="itabs rb-tabs" aria-label="${esc(tr("nav.results"))}">${resTabs.map((k) => `<a href="${rbHash(k)}" class="${k === resTab ? "on" : ""}" ${k === resTab ? 'aria-current="page"' : ""}>${tr(RES_TABS[k])}${k === "posts" && tableView?.rows ? ` <span>${tableView.rows.filter((x) => !x.retired).length}</span>` : ""}</a>`).join("")}</nav>`}
    ${resTab === "overview" ? cmLine() : ""}
    ${perfCollect ? `<div class="sheet"><p class="lead">${esc(perfCollect.summary || "")}</p>
      ${(perfCollect.problems || []).map((x) => `<p class="warnline">${ico("alert", "sm")} ${esc(x.error)}</p>`).join("")}
      ${(perfCollect.notes || []).map((x) => `<p class="meta">${ico("info", "sm")} ${esc(x)}</p>`).join("")}</div>` : ""}
    ${resTab === "posts" ? tableHtml() : ""}
    ${resTab === "youtube" ? channelHtml() : ""}
    ${resTab === "overview" ? rbOverviewHtml() : ""}
    ${resTab === "next" ? rbNextHtml(perfWait, vlogOnly) : ""}
    ${resTab === "where" ? `${resNetsHtml("where")}
    <details class="rb-fold"${rbFoldOpen ? " open" : ""} data-rbfold="1"><summary><b>${tr("rs.t.schedule")}</b> <span class="meta">${esc(tr("rb.outsum", { n: out.filter((x) => !isHistory(x) && ["posted", "scheduled", "queued"].includes(x.status)).length }))}</span></summary><section class="sheet outbooked"><h2>${tr("res.where")}</h2><table class="facts"><thead><tr><th>${tr("res.net")}</th><th class="barcell"><span class="hkey"><i class="p"></i>${tr("st.posted")} <i class="s"></i>${tr("st.scheduled")}</span></th><th class="num">${tr("st.posted")}</th><th class="num">${tr("st.scheduled")}</th><th>${tr("res.nextout")}</th><th class="num">${tr("res.median")}</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="meta">${tr("res.none")}</td></tr>`}</tbody></table></section></details>
` : ""}
    ${resTab === "posts" ? `${need.length ? `<section class="sheet" style="margin-top:14px"><h2>${tr("res.typein")}</h2><p class="meta">${tr("res.typeinhint")}</p>
      ${need.map((x) => `<form class="numform" data-perfmanual="${x.post_id}"><span>${netLogo(x.network, "sm")} <b>${esc(x.slug)}</b> <span class="meta">${esc(NET_NAME[x.network] || x.network)} · ${x.url ? `<a href="${escUrl(x.url)}" target="_blank" rel="noopener">${tr("res.open")} ↗</a>` : ""}</span></span>
        ${["views", "likes", "comments", "shares", "saves"].map((f) => `<label><span class="meta">${esc(f)}</span><input name="${f}" type="number" min="0" inputmode="numeric"></label>`).join("")}
        <button class="primary" type="submit">${tr("key.save")}</button></form>`).join("")}</section>` : ""}
    <details class="sheet importsheet"><summary><b>${tr("res.import")}</b> <span class="meta">${tr("res.importwhen")}</span></summary><p class="meta">${tr("res.importhint")}</p>
        <form data-perfimport="1" class="accform"><label><span class="meta">${tr("res.net")}</span><select name="network">${["tiktok", "x", "pinterest", "linkedin", "threads", "gbp"].map((n) => `<option value="${n}">${esc(NET_NAME[n])}</option>`).join("")}</select></label>
          <label><span class="meta">${tr("res.csv")}</span><textarea name="csv" rows="4" spellcheck="false"></textarea></label><button class="primary" type="submit">${tr("res.importgo")}</button></form></details>` : ""}`;
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest?.("[data-perfcollect]")) return;
  perfBusy = true; renderHome(true);
  try { perfCollect = await post("/api/perf/collect", { fresh: true }); } catch (err) { perfCollect = { summary: err.message, problems: [] }; }
  perfBusy = false; perfView = undefined; tableView = undefined; insView = undefined; loadTable(); loadPerf();
});
document.addEventListener("submit", async (e) => {
  const m = e.target.closest("[data-perfmanual]"), im = e.target.closest("[data-perfimport]");
  if (!m && !im) return;
  e.preventDefault();
  try {
    if (m) {
      const body = { post_id: +m.dataset.perfmanual };
      for (const [k, v] of new FormData(m)) if (String(v).trim() !== "") body[k] = +v;
      await post("/api/perf/manual", body);
      if (perfCollect) perfCollect.needsNumbers = (perfCollect.needsNumbers || []).filter((x) => x.post_id !== body.post_id);
    } else {
      const d = Object.fromEntries(new FormData(im));
      const r = await post("/api/perf/import", { network: d.network, csv: d.csv });
      toast(`${ico("check", "sm")} ${esc(r.summary || tr("acc.saved"))}`, 6000);
    }
    toast(`${ico("check", "sm")} ${tr("acc.saved")}`); perfView = undefined; loadPerf();
  } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 8000); }
});

