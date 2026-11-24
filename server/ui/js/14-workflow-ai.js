/* ---------- batch D (18 Nov): Settings › Workflow, Settings › AI blocks, the AI cost meter, the first-week checklist, the theme ----------
   One view feeds the Workflow page and the AI blocks card: GET /api/workflow (py/studio/workflow.py): every AI block as it
   really runs (on or off, which service, on this computer or in the cloud, key saved or not, never the key, what one 15 s
   reel costs) with the other services that can do it, the templates in shared/workflows/*.json with what each changes,
   Undo, and this month's spend from the ledger. A choice goes through /api/ai/select (the same file, <data>/workflow.json);
   a template is applied only by its Apply button (/api/workflow/apply keeps a backup; /api/workflow/undo puts it back).
   The page is an n8n-style graph: one column per stage, left to right, the shared node (mapNode) and detail (mapDetail),
   wires drawn after layout by drawWires (drawFlowWires), flowing along the blocks that are on while motion is on. */
let wfView = null, wfOpen = null, wfPrev = null, wfBusy = "", wfVoice = null, aiMonth = null, wfAbOpen = null;
const WF_CAPS = ["voice", "music", "sfx", "upscale", "slowmo", "img2video", "bg-cut", "llm", "vision"];
const WF_ICON = { voice: "volume", music: "music", sfx: "wave", upscale: "zin", slowmo: "clock", img2video: "image", "bg-cut": "scissors", llm: "type", vision: "eye",
  footage: "layers", pick: "scissors", render: "film", you: "check", networks: "send", results: "wave" };
/* One colour per capability for the spend bar (the ranch palette and two mixes; at most five segments are drawn). */
const WF_COLOR = { vision: "var(--sky)", img2video: "var(--fire)", music: "var(--larch)", voice: "var(--ember)", upscale: "var(--meadow)",
  slowmo: "color-mix(in srgb, var(--sky) 55%, var(--ink))", sfx: "color-mix(in srgb, var(--meadow) 55%, var(--ink))", "bg-cut": "color-mix(in srgb, var(--fire) 55%, var(--ink))",
  llm: "color-mix(in srgb, var(--larch) 55%, var(--ink))", other: "var(--edge)" };
const wfCost = (n, unit = true) => n == null ? tr("d_wf.bytokens") : n === 0 ? tr("d_wf.free") : `${usd(n)}${unit ? " " + tr("d_wf.areel") : ""}`;
const capName = (c) => tr("d_wf.c." + c);
function loadWf() {
  if (loadWf.busy) return;
  loadWf.busy = true;
  api("/api/workflow").then((v) => { wfView = { ...v, at: Date.now() }; aiMonth = v.spend || aiMonth; paintAiMonth(); })
    .catch((e) => { if (!wfView || wfView.error) wfView = { error: e.message }; })
    .finally(() => { loadWf.busy = false; if (atHome() && ["workflow", "keys"].includes(page)) renderHome(true); });
}
function loadAiMonth() { api("/api/ai/spend").then((s) => { aiMonth = s; paintAiMonth(); }).catch(() => {}); }
setTimeout(loadAiMonth, 2500); setInterval(loadAiMonth, 10 * 60e3);
/* The status bar: this month's AI spend, a link to the Workflow page. */
function paintAiMonth() {
  const el = $("#sbAi"); if (!el) return;
  if (!aiMonth || aiMonth.total == null) { el.hidden = true; return; }
  const m = new Date(aiMonth.month + "-15").toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { month: "long" });
  el.hidden = false; el.dataset.goto = "workflow"; el.title = tr("d_cm.sbt", { m });
  el.innerHTML = `<b class="sbm">${esc(tr("d_cm.sbm"))}</b><span>${esc(tr("d_cm.sb", { n: usd(aiMonth.total), m }))}</span>`;
}
/* ---------- the cost meter: this month's paid AI by capability, against the month's budget (the daily budget × days) ---------- */
function costMeter(sp, { compact = false } = {}) {
  if (!sp) return `<div class="cmeter"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>`;
  const b = sp.budget || {}, cap = Math.max(b.month || 0, sp.total || 0, 0.01), L = lang === "ja" ? "ja-JP" : "en-GB";
  const caps = (sp.byCapability || []).filter((x) => x.usd > 0), top = caps.slice(0, 4), rest = caps.slice(4).reduce((a, x) => a + x.usd, 0);
  const segs = [...top.map((x) => [x.capability, x.usd]), ...(rest > 0 ? [["other", rest]] : [])];
  let x = 0;
  const rects = segs.map(([c, v]) => { const w = (100 * v) / cap, r = `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(0.4, w).toFixed(2)}" height="10" style="fill:${WF_COLOR[c] || WF_COLOR.other}"><title>${esc(c === "other" ? tr("d_cm.other") : capName(c))}: ${usd(v)}</title></rect>`; x += w; return r; }).join("");
  const pace = b.month ? (100 * (b.dayOfMonth || 0)) / (b.days || 30) : null, over = b.month && sp.total > b.month;
  const month = new Date(sp.month + "-15").toLocaleDateString(L, { month: "long" });
  const onPace = b.dayOfMonth ? (sp.total / b.dayOfMonth) * (b.days || 30) : 0;
  return `<div class="cmeter${compact ? " compact" : ""}${over ? " over" : ""}">
    <div class="cm-top"><b class="cm-total">${usd(sp.total)}</b><span class="meta">${esc(tr("d_cm.month", { m: month, n: (sp.calls || 0).toLocaleString(L) }))}</span>
      ${b.month ? `<span class="cm-budget meta">${esc(tr("d_cm.of", { n: usd(b.month) }))}</span>` : ""}</div>
    <svg class="cm-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(tr("d_cm.barl", { n: usd(sp.total), b: usd(b.month || 0) }))}">
      <rect class="cm-track" x="0" y="0" width="100" height="10"/>${rects}${pace != null ? `<line class="cm-pace" x1="${pace.toFixed(2)}" x2="${pace.toFixed(2)}" y1="-2" y2="12"/>` : ""}</svg>
    ${segs.length ? `<ul class="cm-key">${segs.map(([c, v]) => `<li><i style="background:${WF_COLOR[c] || WF_COLOR.other}" aria-hidden="true"></i>${esc(c === "other" ? tr("d_cm.other") : capName(c))} <b>${usd(v)}</b></li>`).join("")}</ul>` : `<p class="meta">${esc(tr("d_cm.none"))}</p>`}
    ${compact ? "" : `<p class="meta cm-foot">${esc(tr("d_cm.pace", { n: usd(onPace) }))}${pace != null ? ` · <span class="cm-tick" aria-hidden="true"></span> ${esc(tr("d_cm.today"))}` : ""}${b.aiCap ? ` · ${esc(tr("d_cm.limit", { n: usd(b.aiLeft), c: usd(b.aiCap) }))}` : ""}
      ${(sp.byProvider || []).length ? `<br>${(sp.byProvider || []).map((p) => `${esc(p.name)} <b>${usd(p.usd)}</b>`).join(" · ")}` : ""}</p>`}
  </div>`;
}
/* ---------- the blocks, as nodes ---------- */
function wfWhere(c) { return !c.provider ? "" : c.local ? tr("d_wf.local") : tr("d_wf.cloud"); }
function wfCapNode(cap, i, fresh, chg) {
  const c = wfView.capabilities[cap];
  const kind = !c.on ? "k-off wire-dash" : c.local ? "k-local" : "k-cloud";
  const st = !c.on ? ["", tr("d_wf.off")] : !c.provider ? ["warn", tr("d_wf.noservice")] : !c.hasKey ? ["warn", `${c.providerName} · ${tr("d_wf.nokey")}`] : ["ok", `${c.provider === "own" ? tr("d_wf.ownname") : c.providerName} · ${wfWhere(c)}`];
  const cost = c.on ? (c.perReel?.usd == null ? esc(tr("d_wf.bytokens")) : c.perReel.usd === 0 ? `<em>${esc(tr("d_wf.free"))}</em>` : `<b>${usd(c.perReel.usd)}</b> ${esc(tr("d_wf.areel"))}`) : esc(tr("d_wf.skipped"));
  const fb = c.on ? fbNodeBits(cap) : { cls: "", html: "" };  // fallback: "backup: X", and "switched" while it runs on its backup
  return mapNode({ kcls: kind + (chg ? " wf-chg" : "") + fb.cls, status: st, name: capName(cap), nums: cost + fb.html, icon: WF_ICON[cap], i, fresh, on: wfOpen === cap, controls: "wfDetail",
    attr: `data-wfnode="${cap}"`, label: `${capName(cap)}: ${st[1]}${c.on && c.perReel?.usd != null ? " · " + usd(c.perReel.usd) : ""}`, after: chg || "" });
}
function wfStudioNode(id, i, fresh, nums, st) {
  return mapNode({ kcls: "k-studio", status: st, name: tr("d_wf.n." + id), nums, icon: WF_ICON[id], i, fresh, on: wfOpen === id, controls: "wfDetail", attr: `data-wfnode="${id}"` });
}
/* The pipeline, left to right: footage → pick and cut → words → sound → picture → render → review → networks → results. */
function wfStages(fresh, prev) {
  const lib = overview.library || {}, L = lang === "ja" ? "ja-JP" : "en-GB";
  const chg = new Map((prev?.diff || []).map((d) => [d.capability, d.after.on ? `→ ${d.after.provider === "own" ? tr("d_wf.ownname") : d.after.providerName || ""}` : `→ ${tr("d_wf.off")}`]));
  const nets = (typeof PLAN_NETS === "function" ? PLAN_NETS() : []).length, made = overview.reels.filter((r) => !r.house && r.rendered).length;
  const approved = overview.reels.filter((r) => !r.house && r.status === "approved").length, waiting = needsReview().length;
  let i = 0;
  const cap = (c) => wfCapNode(c, i++, fresh, chg.get(c));
  const own = (id, nums, st) => wfStudioNode(id, i++, fresh, nums, st);
  return [
    ["footage", [own("footage", `<b>${(lib.ranch || 0).toLocaleString(L)}</b> ${esc(tr("d_wf.clips"))}`, [lib.ranch ? "ok" : "warn", lib.ranch ? tr("d_wf.unused", { n: (lib.unused || 0).toLocaleString(L) }) : tr("d_wf.addfootage")])]],
    ["pick", [own("pick", `<em>${esc(tr("d_wf.free"))}</em>`, ["ok", tr("d_wf.local")])]],
    ["words", [cap("llm")]],
    ["sound", ["voice", "music", "sfx"].map(cap)],
    ["picture", ["upscale", "slowmo", "img2video", "bg-cut"].map(cap)],
    ["render", [own("render", `<b>${made.toLocaleString(L)}</b> ${esc(tr("d_wf.made"))}`, ["ok", tr("d_wf.local")])]],
    ["review", [cap("vision"), own("you", `<b>${approved.toLocaleString(L)}</b> ${esc(tr("d_wf.approved"))}`, [waiting ? "warn" : "ok", waiting ? tr("d_wf.waiting", { n: waiting }) : tr("d_wf.uptodate")])]],
    ["networks", [own("networks", `<b>${nets}</b> ${esc(tr("d_wf.nets"))}`, [nets ? "ok" : "warn", nets ? tr("d_wf.on") : tr("d_wf.nonets")])]],
    ["results", [own("results", `<em>${esc(tr("d_wf.free"))}</em>`, ["ok", tr("d_wf.measured")])]],
  ];
}
function flowMap({ id, label, cols, cls = "", attrs = "" }) {
  return `<div class="wfg${cls ? " " + cls : ""}" id="${esc(id)}" role="group" aria-label="${esc(label)}" ${attrs}>
    <svg class="sm-wires wfg-wires" aria-hidden="true" focusable="false"></svg>
    <ol class="wf-cols">${cols.map(([stage, nodes], n) => `<li class="wf-col" data-stage="${stage}"><h4><span>${String(n + 1).padStart(2, "0")}</span>${esc(tr("d_wf.s." + stage))}</h4>
      <ul class="wf-stack">${nodes.map((x) => `<li>${x}</li>`).join("")}</ul></li>`).join("")}</ol></div>`;
}
/* The wires of a flow map: each stage to the next. A stage of several blocks meets the next one at a junction, so the
   picture stays readable; a wire into a block that is off is dashed and carries nothing. */
function drawFlowWires(root) {
  const svg = root.querySelector(".wfg-wires"); if (!svg || getComputedStyle(svg).display === "none") return;
  const box = root.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`); svg.setAttribute("width", box.width); svg.setAttribute("height", box.height);
  const rel = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, cy: r.top - box.top + r.height / 2 }; };
  const cols = [...root.querySelectorAll(".wf-col")].map((c) => [...c.querySelectorAll(".snode")]);
  const on = (el) => !el.classList.contains("k-off");
  const kind = (el) => [...el.classList].find((c) => c.startsWith("k-")) || "";
  const curve = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1.toFixed(1)},${y1.toFixed(1)} C${m.toFixed(1)},${y1.toFixed(1)} ${m.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`; };
  const links = [], joints = [];
  cols.forEach((A, n) => {
    const B = cols[n + 1]; if (!B || !A.length || !B.length) return;
    const a = A.map(rel), b = B.map(rel);
    if (A.length === 1 || B.length === 1) {
      A.forEach((ea, x) => B.forEach((eb, y) => links.push({ d: curve(a[x].r, a[x].cy, b[y].l, b[y].cy), k: kind(B.length > 1 ? eb : ea), off: !on(ea) || !on(eb), n })));
      return;
    }
    const jx = (Math.max(...a.map((p) => p.r)) + Math.min(...b.map((p) => p.l))) / 2;
    const jy = [...a, ...b].reduce((s, p) => s + p.cy, 0) / (a.length + b.length);
    joints.push([jx, jy, n]);
    A.forEach((ea, x) => links.push({ d: curve(a[x].r, a[x].cy, jx, jy), k: kind(ea), off: !on(ea), n }));
    B.forEach((eb, y) => links.push({ d: curve(jx, jy, b[y].l, b[y].cy), k: kind(eb), off: !on(eb), n }));
  });
  const sig = links.map((l) => l.d + l.k + l.off).join("|");
  if (sig === svg.dataset.sig && svg.childElementCount) return;
  svg.dataset.sig = sig;
  const draw = !moCalm() && !!root.querySelector(".snode.in");
  const delay = (n) => 160 + n * 70;
  svg.innerHTML = links.map((l) => `<path class="w ${l.k}${l.off ? " dash" : ""}${draw ? " draw" : ""}"${draw && !l.off ? ' pathLength="1"' : ""} style="--d:${delay(l.n)}ms" d="${l.d}"/>`).join("")
    + joints.map(([x, y, n]) => `<circle class="wj${draw ? " draw" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" style="--d:${delay(n)}ms"/>`).join("")
    + `<g class="wfs${draw ? " draw" : ""}" style="--d:${delay(cols.length) + 300}ms">${links.filter((l) => !l.off).map((l) => `<path class="wf ${l.k}" d="${l.d}"/>`).join("")}</g>`;
}
/* ---------- choosing a service (the Workflow page's detail and the AI blocks card share it) ---------- */
function wfChoices(cap) {
  const c = wfView.capabilities[cap], seen = new Set();
  const list = (c.choices || []).filter((x) => { const k = x.provider + "|" + x.model; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!list.length) return `<p class="meta">${esc(tr("d_wf.nochoice"))}</p>`;
  const cur = (x) => c.on && x.provider === c.provider && (x.model === c.model || x.provider === "own");
  return `<ul class="wfc-list" aria-label="${esc(tr("d_wf.choose", { c: capName(cap) }))}">${list.map((x) => {
    const own = x.provider === "own", setup = own && !x.configured;
    const tags = `<span class="wfc-tags"><i class="wtag ${x.local ? "local" : "cloud"}">${esc(x.local ? tr("d_wf.local") : tr("d_wf.cloud"))}</i>${!x.hasKey ? `<i class="wtag warn">${esc(tr("d_wf.nokey"))}</i>` : ""}${aipOutTag(x.provider)}${x.default ? `<i class="wtag">${esc(tr("d_wf.default"))}</i>` : ""}${x.risk ? `<i class="wtag warn" title="${esc(x.note || "")}">${ico("alert", "sm")}${esc(x.risk)}</i>` : ""}${x.priceNeeded ? `<i class="wtag warn">${esc(tr("d_wf.needprice"))}</i>` : ""}</span>`;
    const cost = `<span class="wfc-cost">${x.priceNeeded ? esc(tr("d_wf.noprice")) : esc(wfCost(x.perReel?.usd))}</span>`;
    const body = `<b>${esc(own ? tr("d_wf.ownname") : x.providerName)}</b><span class="wfc-model">${esc(own ? (x.model || tr("d_wf.ownnone")) : x.label)}</span>${tags}${cost}`;
    const when = x.asOf ? new Date(x.asOf + "T12:00:00Z").toLocaleDateString(lang === "ja" ? "ja-JP" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    const foot = `<div class="wfc-foot">${x.docs ? `<a href="${escUrl(x.docs)}" target="_blank" rel="noopener">${esc(tr("d_wf.docs"))} ↗</a>` : ""}${when ? `<span class="meta">${esc(tr("d_wf.asof", { d: when }))}</span>` : ""}</div>`;
    const k = `${x.provider}|${x.model}`;
    if (cur(x)) return `<li class="wfc on"><div class="wfc-btn" aria-current="true">${body}<span class="wfc-use">${ico("check", "sm")}${esc(tr("d_wf.inuse"))}</span></div>${foot}</li>`;
    if (setup) return `<li class="wfc"><a class="wfc-btn" href="#/keys/llm">${body}<span class="wfc-use">${esc(tr("d_wf.setup"))} ›</span></a>${foot}</li>`;
    if (x.priceNeeded) return `<li class="wfc need"><button type="button" class="wfc-btn" data-wfprice="${esc(cap)}" data-p="${esc(x.provider)}" data-m="${esc(x.model)}" aria-expanded="${wfPriceFor === k}">${body}<span class="wfc-use">${esc(tr("d_wf.priceset"))} ›</span></button>${foot}</li>`;
    return `<li class="wfc${x.risk ? " risky" : ""}"><button type="button" class="wfc-btn" data-wfpick="${esc(cap)}" data-p="${esc(x.provider)}" data-m="${esc(x.model)}" ${wfBusy ? "disabled" : ""}>${body}<span class="wfc-use">${esc(tr("d_wf.use"))} ›</span></button>${foot}</li>`;
  }).join("")}</ul>${wfVoice?.cap === cap ? wfVoicePicker() : ""}${wfRisk?.cap === cap ? wfRiskPanel() : ""}${wfPriceFor && wfPriceCap === cap ? wfPriceForm() : ""}`;
}
/* A model marked risky (an unofficial route to someone else's service) is picked only after reading why and ticking the box. */
let wfRisk = null, wfPriceFor = "", wfPriceCap = "";
function wfRiskPanel() {
  const r = wfRisk;
  return `<div class="wfrisk" role="group" aria-label="${esc(tr("d_wf.riskh", { m: r.label }))}"><b>${ico("alert", "sm")} ${esc(tr("d_wf.riskh", { m: r.label }))} <i class="wtag warn">${esc(r.risk)}</i></b>
    ${r.note ? `<p>${esc(r.note)}</p>` : ""}<label class="wfrisk-ok"><input type="checkbox" data-wfriskok> ${esc(tr("d_wf.riskok"))}</label>
    <div class="row wrap"><button type="button" class="primary" data-wfriskgo disabled>${esc(tr("d_wf.riskgo"))}</button><button type="button" data-wfriskx>${esc(tr("d_wf.cancel"))}</button></div></div>`;
}
/* A model with no price anywhere (Luma bills credits whose worth depends on your plan): enter yours, then it can be picked. */
function wfPriceForm() {
  const [pid, mid] = wfPriceFor.split("|"), units = wfView?.units || ["seconds", "generations", "videos"];
  return `<form class="wfprice" data-wfpriceform="1"><b>${esc(tr("d_wf.priceh", { m: mid }))}</b><p class="meta">${esc(tr("d_wf.pricewhy"))}</p>
    <div class="row wrap"><label><span class="meta">${esc(tr("d_wf.priceusd"))}</span><input name="usd" type="number" min="0" max="1000" step="0.0001" inputmode="decimal" required></label>
      <label><span class="meta">${esc(tr("d_wf.priceunit"))}</span><select name="unit">${units.map((u) => `<option${u === "seconds" ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
      <button type="submit" class="primary">${ico("check", "sm")}${esc(tr("d_wf.pricesave"))}</button><button type="button" data-wfpricex>${esc(tr("d_wf.cancel"))}</button></div>
    <input type="hidden" name="provider" value="${esc(pid)}"><input type="hidden" name="model" value="${esc(mid)}"></form>`;
}
document.addEventListener("change", (e) => { const c = e.target.closest?.("[data-wfriskok]"); if (c) { const go = c.closest(".wfrisk")?.querySelector("[data-wfriskgo]"); if (go) go.disabled = !c.checked; } });
document.addEventListener("click", (e) => {
  if (e.target.closest?.("[data-wfriskgo]") && wfRisk) { const r = wfRisk; wfRisk = null; return wfSelect({ capability: r.cap, provider: r.pid, model: r.mid, acceptRisk: true }, tr("d_wf.picked", { c: capName(r.cap), p: r.name })); }
  if (e.target.closest?.("[data-wfriskx]")) { wfRisk = null; return renderHome(true); }
  const pr = e.target.closest?.("[data-wfprice]");
  if (pr) { const k = `${pr.dataset.p}|${pr.dataset.m}`; wfPriceFor = wfPriceFor === k ? "" : k; wfPriceCap = pr.dataset.wfprice; wfRisk = null; renderHome(true); requestAnimationFrame(() => document.querySelector("#home .wfprice input[name=usd]")?.focus()); return; }
  if (e.target.closest?.("[data-wfpricex]")) { wfPriceFor = ""; return renderHome(true); }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest?.("[data-wfpriceform]"); if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  try { await post("/api/ai/price", { provider: d.provider, model: d.model, usd: Number(d.usd), unit: d.unit }); toast(`${ico("check", "sm")} ${esc(tr("d_wf.pricesaved", { m: d.model }))}`, 4000); wfPriceFor = ""; }
  catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); }
  loadWf();
});
function wfRejected() {
  const list = wfView?.rejected || [];
  if (!list.length) return "";
  return `<details class="wf-rejected"><summary>${ico("info", "sm")} ${esc(tr("d_wf.rejected", { n: list.length }))}</summary>
    <ul>${list.map((r) => `<li><b>${esc(r.what)}</b><span class="meta">${esc(r.why)}</span></li>`).join("")}</ul></details>`;
}
function wfVoicePicker() {
  const v = wfVoice;
  return `<div class="wfvoice" role="group" aria-label="${esc(tr("d_wf.voicepick"))}"><b>${esc(tr("d_wf.voicepick"))}</b>
    ${v.error ? `<p class="bad">${ico("alert", "sm")} ${esc(v.error)}</p>` : !v.list ? `<div class="skel skel-line"></div>`
      : `<div class="row wrap">${v.list.slice(0, 16).map((x) => `<button type="button" data-wfvoice="${esc(x.id)}">${esc(x.name || x.id)}</button>`).join("")}</div>`}
    <button type="button" class="linkish" data-wfvoicex="1">${esc(tr("d_wf.cancel"))}</button></div>`;
}
async function wfSelect(body, done) {
  wfBusy = body.capability; renderHome(true);
  try {
    const r = await post("/api/ai/select", body);
    toast(`${ico("check", "sm")} ${esc(done)}${(r.warnings || []).length ? `<br><span class="meta">${esc(r.warnings.join(" "))}</span>` : ""}`, (r.warnings || []).length ? 7000 : 3000);
  } catch (e) { toast(`${ico("alert", "sm")} ${esc(e.message)}`, 7000); }
  wfBusy = ""; wfVoice = null; loadWf(); loadFb(true); PROB.load();  // aip: the health view follows the pick (chips, banner)
}
document.addEventListener("click", async (e) => {
  const pk = e.target.closest?.("[data-wfpick]");
  if (pk) {
    const cap = pk.dataset.wfpick, pid = pk.dataset.p, mid = pk.dataset.m;
    const x = wfView?.capabilities?.[cap]?.choices?.find((c) => c.provider === pid && c.model === mid) || {};
    const extra = {};
    if (x.risk) { wfRisk = { cap, pid, mid, label: x.label || mid, risk: x.risk, note: x.note || "", name: x.providerName || pid }; wfPriceFor = ""; renderHome(true); return; }
    if (x.voiceRequired && !x.voiceDefault) {
      wfVoice = { cap, pid, mid, list: null }; renderHome(true);
      try { const v = await api("/api/ai/voices?provider=" + encodeURIComponent(pid)); if (wfVoice?.cap === cap) wfVoice.list = v.voices || []; }
      catch (err) { if (wfVoice) wfVoice.error = err.message; }
      return renderHome(true);
    }
    return wfSelect({ capability: cap, provider: pid, model: mid, ...extra }, tr("d_wf.picked", { c: capName(cap), p: pid === "own" ? tr("d_wf.ownname") : x.providerName || pid }));
  }
  const vo = e.target.closest?.("[data-wfvoice]");
  if (vo && wfVoice) return wfSelect({ capability: wfVoice.cap, provider: wfVoice.pid, model: wfVoice.mid, voice: vo.dataset.wfvoice }, tr("d_wf.picked", { c: capName(wfVoice.cap), p: wfVoice.pid }));
  if (e.target.closest?.("[data-wfvoicex]")) { wfVoice = null; return renderHome(true); }
  const tg = e.target.closest?.("[data-wfon]");
  if (tg) {
    const cap = tg.dataset.wfon, c = wfView?.capabilities?.[cap]; if (!c) return;
    const turnOn = !c.on;
    if (turnOn && !c.provider) { location.hash = cap === "llm" || cap === "vision" ? "#/keys/llm" : "#/keys/keys"; return; }
    return wfSelect(turnOn ? { capability: cap, provider: c.provider, model: c.model, on: true, ...(c.voice ? { voice: c.voice } : {}) } : { capability: cap, on: false },
      tr(turnOn ? "d_wf.turnedon" : "d_wf.turnedoff", { c: capName(cap) }));
  }
  const rs = e.target.closest?.("[data-wfreset]");
  if (rs) return wfSelect({ capability: rs.dataset.wfreset, reset: true }, tr("d_wf.wasreset", { c: capName(rs.dataset.wfreset) }));
  const nd = e.target.closest?.("[data-wfnode]");
  if (nd) {
    wfOpen = wfOpen === nd.dataset.wfnode ? null : nd.dataset.wfnode; wfVoice = null; renderHome(true);
    if (wfOpen) requestAnimationFrame(() => document.getElementById("wfDetail")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }));
    return;
  }
  if (e.target.closest?.("[data-wfclose]")) { const id = wfOpen; wfOpen = null; wfVoice = null; renderHome(true); document.querySelector(`#home [data-wfnode="${CSS.escape(id || "")}"]`)?.focus(); return; }
  const tp = e.target.closest?.("[data-wftpl]");
  if (tp) {
    const id = tp.dataset.wftpl; wfPrev = wfPrev === id ? null : id; renderHome(true);
    if (wfPrev) requestAnimationFrame(() => document.getElementById("wfPreview")?.scrollIntoView({ block: "nearest", behavior: moCalm() ? "auto" : "smooth" }));
    return;
  }
  if (e.target.closest?.("[data-wfprevx]")) { const id = wfPrev; wfPrev = null; renderHome(true); document.querySelector(`#home [data-wftpl="${CSS.escape(id || "")}"]`)?.focus(); return; }
  const ap = e.target.closest?.("[data-wfapply]");
  if (ap) {
    const t = wfView?.templates?.find((x) => x.id === ap.dataset.wfapply); if (!t) return;
    wfBusy = "apply"; renderHome(true);
    try {
      const r = await post("/api/workflow/apply", { template: t.id, confirm: true });
      wfView = { ...r.view, at: Date.now() }; aiMonth = r.view.spend || aiMonth; wfPrev = null;
      toast(`${ico("check", "sm")} ${esc(tr("d_wf.applied", { t: t.name[lang] || t.name.en }))} <button type="button" class="linkbtn" data-wfundo="1">${esc(tr("d_wf.undo"))}</button>${(r.notes || []).length ? `<br><span class="meta">${esc(r.notes.join(" "))}</span>` : ""}`, 9000);
    } catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 7000); }
    wfBusy = ""; renderHome(true);
    return;
  }
  if (e.target.closest?.("[data-wfundo]")) {
    wfBusy = "undo"; if (page === "workflow") renderHome(true);
    try { const r = await post("/api/workflow/undo", {}); wfView = { ...r.view, at: Date.now() }; toast(`${ico("undo", "sm")} ${esc(tr("d_wf.undone"))}`, 4000); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(err.message)}`, 6000); }
    wfBusy = ""; if (atHome() && ["workflow", "keys"].includes(page)) renderHome(true);
    return;
  }
  const ab = e.target.closest?.("[data-abopen]");
  if (ab) { wfAbOpen = wfAbOpen === ab.dataset.abopen ? null : ab.dataset.abopen; wfVoice = null; renderHome(true); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (e.target.closest?.("#wfDetail")) { e.preventDefault(); document.querySelector("#wfDetail [data-wfclose]")?.click(); }
  else if (e.target.closest?.("#wfPreview")) { e.preventDefault(); document.querySelector("#wfPreview [data-wfprevx]")?.click(); }
});
function wfDetail(id) {
  const v = wfView, fresh = wfDetail.shown !== id; wfDetail.shown = id;
  const L = lang === "ja" ? "ja-JP" : "en-GB", month = (v.spend?.byCapability || []);
  const close = `data-wfclose="1"`;
  if (WF_CAPS.includes(id)) {
    const c = v.capabilities[id], spent = month.find((x) => x.capability === id);
    const kind = !c.on ? "k-off" : c.local ? "k-local" : "k-cloud";
    const status = !c.on ? ["", tr("d_wf.off")] : !c.provider ? ["warn", tr("d_wf.noservice")] : !c.hasKey ? ["warn", tr("d_wf.nokey")] : ["ok", tr("d_wf.ready")];
    const extra = id === "llm" ? tr(c.provider === "own" ? "d_wf.llmown" : "d_wf.llmor") : id === "vision" ? tr(v.reviewBasis === "frames" ? "d_wf.visframes" : v.reviewBasis === "video" ? "d_wf.visvideo" : "d_wf.visnone") : "";
    const facts = [
      [tr("d_wf.f.does"), esc(tr("d_wf.w." + id))],
      [tr("d_wf.f.service"), c.provider ? `${esc(c.provider === "own" ? tr("d_wf.ownname") : c.providerName)}${c.modelLabel ? ` · <span class="wfmono">${esc(c.modelLabel)}</span>` : ""}` : esc(tr("d_wf.noservice"))],
      [tr("d_wf.f.where"), esc(wfWhere(c) || "—")],
      [tr("d_wf.f.key"), !c.provider ? "—" : c.provider === "own" ? esc(tr("d_wf.keyown")) : c.hasKey ? `${ico("check", "sm")} ${esc(tr("d_wf.keyok"))}` : `<a href="#/keys/keys">${ico("alert", "sm")} ${esc(tr("d_wf.keyadd"))} ›</a>`],
      [tr("d_wf.f.cost"), c.on ? `<b>${esc(wfCost(c.perReel?.usd, false))}</b> <span class="meta">(${esc(tr("d_wf.basis." + id))})</span>` : esc(tr("d_wf.skipped"))],
      [tr("d_wf.f.month"), spent ? `${usd(spent.usd)} <span class="meta">· ${esc(tr("d_wf.calls", { n: spent.calls.toLocaleString(L) }))}</span>` : usd(0)],
      ...(c.labelRequired ? [[tr("d_wf.f.label"), esc(tr("d_wf.labelyes"))]] : []),
    ];
    const acts = `<button type="button" class="${c.on ? "" : "primary"}" data-wfon="${id}" ${wfBusy ? "disabled" : ""}>${ico(c.on ? "pause" : "play", "sm")}${esc(tr(c.on ? "d_wf.turnoff" : "d_wf.turnon"))}</button>
      ${c.source === "workflow" ? `<button type="button" class="ghost" data-wfreset="${id}" ${wfBusy ? "disabled" : ""}>${ico("refresh", "sm")}${esc(tr("d_wf.reset"))}</button>` : ""}
      <a class="btn ghost" href="#/keys/keys">${ico("shield", "sm")}${esc(tr("d_wf.keys"))}</a>`;
    return mapDetail({ id: "wfDetail", kcls: kind, icon: WF_ICON[id], name: capName(id), sub: `${tr("d_wf.s." + wfStageOf(id))}${c.labelRequired ? " · " + tr("d_wf.ailabel") : ""}`, status, facts, fresh, closeAttr: close,
      note: `${extra ? `<p class="meta wf-note">${ico("info", "sm")} ${esc(extra)}</p>` : ""}<h5 class="wf-h5">${esc(tr("d_wf.others"))}</h5>${wfChoices(id)}${fbSection(id)}`, acts });
  }
  const lib = overview.library || {}, nets = typeof PLAN_NETS === "function" ? PLAN_NETS() : [];
  const S = {
    footage: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.footage"))], [tr("d_wf.f.clips"), `${(lib.ranch || 0).toLocaleString(L)} · ${esc(tr("d_wf.unused", { n: (lib.unused || 0).toLocaleString(L) }))}`]], "#/footage", "nav.footage"],
    pick: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.pick"))]], "#/making", "nav.making"],
    render: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.render"))]], "#/making", "nav.making"],
    you: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.you"))], [tr("d_wf.f.waiting"), String(needsReview().length)]], "#/review", "nav.review"],
    networks: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.networks"))], [tr("d_wf.f.nets"), nets.map((n) => esc(NET_NAME[n] || n)).join(", ") || "—"]], "#/accounts", "nav.accounts"],
    results: [[[tr("d_wf.f.does"), esc(tr("d_wf.w.results"))]], "#/results", "nav.results"],
  }[id];
  if (!S) return "";
  return mapDetail({ id: "wfDetail", kcls: "k-studio", icon: WF_ICON[id], name: tr("d_wf.n." + id), sub: tr("d_wf.s." + wfStageOf(id)), status: ["ok", tr("d_wf.local")],
    facts: [...S[0], [tr("d_wf.f.cost"), `<b>${esc(tr("d_wf.free"))}</b>`]], fresh, closeAttr: close, acts: `<a class="btn" href="${S[1]}">${esc(tr(S[2]))} ›</a>` });
}
const wfStageOf = (id) => ({ footage: "footage", pick: "pick", llm: "words", voice: "sound", music: "sound", sfx: "sound", upscale: "picture", slowmo: "picture", img2video: "picture", "bg-cut": "picture", render: "render", vision: "review", you: "review", networks: "networks", results: "results" }[id] || "");
/* A template's nine blocks as nine bricks: on this computer, in the cloud, or off. */
function wfLego(t) {
  const c = wfView.capabilities, d = new Map((t.diff || []).map((x) => [x.capability, x.after]));
  return `<span class="wft-lego" role="img" aria-label="${esc(tr("d_wf.legol", { n: t.on.length }))}">${WF_CAPS.map((cap) => {
    const a = d.get(cap) || c[cap], k = !t.on.includes(cap) ? "off" : a.local ? "local" : "cloud";
    return `<i class="lg ${k}${d.has(cap) ? " chg" : ""}" title="${esc(capName(cap))}: ${esc(k === "off" ? tr("d_wf.off") : (a.provider === "own" ? tr("d_wf.ownname") : a.providerName || "") + " · " + (k === "local" ? tr("d_wf.local") : tr("d_wf.cloud")))}">${ico(WF_ICON[cap], "sm")}</i>`;
  }).join("")}</span>`;
}
function wfDelta(a, b) {
  const d = Math.round((b - a) * 1000) / 1000;
  return Math.abs(d) < 0.0005 ? `<span class="wfd same">${esc(tr("d_wf.same"))}</span>` : `<span class="wfd ${d < 0 ? "down" : "up"}">${d < 0 ? "−" : "+"}${usd(Math.abs(d))}</span>`;
}
let tcTplOpen = false;
document.addEventListener("toggle", (e) => { if (e.target.matches?.("[data-tctpl]")) tcTplOpen = e.target.open; }, true);
function wfTemplates() {
  const v = wfView, cur = v.template;
  const card = (t, i) => `<li class="wf-tpl${cur === t.id ? " cur" : ""}${wfPrev === t.id ? " open" : ""}" style="--i:${i}">
      <div class="wft-top"><span class="wft-ico" aria-hidden="true">${ico(t.icon || "layers")}</span><div><b>${esc(t.name[lang] || t.name.en)}</b>${t.who ? `<span class="meta">${esc(t.who[lang] || t.who.en)}</span>` : ""}</div>
        ${cur === t.id ? `<span class="wft-badge">${ico("check", "sm")}${esc(tr("d_wf.inuse"))}</span>` : ""}</div>
      <p class="wft-sum" title="${esc(t.summary[lang] || t.summary.en)}">${esc(t.summary[lang] || t.summary.en)}</p>
      ${wfLego(t)}
      <div class="wft-foot"><span class="wft-cost"><b>${t.perReel === 0 ? esc(tr("d_wf.free")) : usd(t.perReel)}</b> ${t.perReel === 0 ? "" : esc(tr("d_wf.areel"))} ${wfDelta(t.perReelNow, t.perReel)}</span>
        <button type="button" data-wftpl="${esc(t.id)}" aria-expanded="${wfPrev === t.id}" aria-controls="wfPreview">${ico("eye", "sm")}${esc(tr(wfPrev === t.id ? "d_wf.hide" : "d_wf.preview"))}</button></div></li>`;
  // Track C (24 Nov): folded until opened (six cards made the page 2.2 screens); the one in use is named on the fold.
  const using = (v.templates || []).find((t) => t.id === cur);
  return `<details class="wf-tpls tc-tplfold" data-tctpl="1" ${tcTplOpen || wfPrev ? "open" : ""} aria-labelledby="wfTplTitle"><summary>
    <div class="wf-sechead"><h3 id="wfTplTitle">${ico("layers", "sm")} ${esc(tr("d_wf.tpls"))} <span class="count">${(v.templates || []).length}</span></h3><span class="meta">${using ? `${esc(tr("d_wf.inuse"))}: <b>${esc(using.name[lang] || using.name.en)}</b> · ` : ""}${esc(tr("d_wf.tplhint"))}</span></div></summary>
    <ul class="wf-tplgrid">${(v.templates || []).map(card).join("")}</ul>
    ${wfPrev ? wfPreview(v.templates.find((t) => t.id === wfPrev)) : ""}</details>`;
}
function wfPreview(t) {
  if (!t) return "";
  const fresh = wfPreview.shown !== t.id; wfPreview.shown = t.id;
  const side = (x) => !x.on ? `<span class="wfp-off">${esc(tr("d_wf.off"))}</span>` : `<b>${esc(x.provider === "own" ? tr("d_wf.ownname") : x.providerName || "—")}</b>${x.modelLabel || x.model ? ` <span class="wfmono">${esc(x.modelLabel || x.model)}</span>` : ""}`;
  const rows = t.diff.map((d) => `<li><span class="wfp-cap">${ico(WF_ICON[d.capability], "sm")}${esc(capName(d.capability))}</span><span class="wfp-was">${side(d.before)}</span><span class="wfp-arrow" aria-label="${esc(tr("d_wf.becomes"))}">→</span><span class="wfp-now">${side(d.after)}${d.after.on && !d.after.hasKey ? ` <i class="wtag warn">${esc(tr("d_wf.nokey"))}</i>` : ""}</span><span class="wfp-usd">${usd(d.usdBefore)} → <b>${usd(d.usdAfter)}</b></span></li>`).join("");
  return `<section class="wf-preview ${fresh && !moCalm() ? "in" : ""}" id="wfPreview" tabindex="-1" aria-label="${esc(tr("d_wf.previewof", { t: t.name[lang] || t.name.en }))}">
    <div class="sn-head"><span class="wft-ico" aria-hidden="true">${ico(t.icon || "layers")}</span><div><b>${esc(tr("d_wf.previewof", { t: t.name[lang] || t.name.en }))}</b><span class="meta">${esc(tr("d_wf.prevnote"))}</span></div><span class="grow"></span>
      <button type="button" class="icon" data-wfprevx="1" aria-label="${esc(tr("src.close"))}" title="${esc(tr("src.close"))}">${ico("x", "sm")}</button></div>
    ${t.diff.length ? `<ol class="wfp-list">${rows}</ol>` : `<p class="okline">${ico("check", "sm")} ${esc(tr("d_wf.nochange"))}</p>`}
    <p class="wfp-total">${esc(tr("d_wf.onereel"))} <b>${usd(t.perReelNow)}</b> → <b>${usd(t.perReel)}</b> ${wfDelta(t.perReelNow, t.perReel)}</p>
    ${(t.notes || []).map((n) => `<p class="warnline">${ico("info", "sm")} ${esc(n)}</p>`).join("")}
    ${(t.missingKeys || []).length ? `<p class="warnline">${ico("alert", "sm")} ${esc(tr("d_wf.needkeys", { list: t.missingKeys.join(", ") }))} <a href="#/keys/keys">${esc(tr("d_wf.keys"))} ›</a></p>` : ""}
    <div class="row wrap"><button type="button" class="primary" data-wfapply="${esc(t.id)}" ${!t.diff.length || wfBusy ? "disabled" : ""}>${ico("check", "sm")}${esc(tr(wfBusy === "apply" ? "d_wf.applying" : "d_wf.apply"))}</button>
      <button type="button" data-wfprevx="1">${esc(tr("d_wf.cancel"))}</button><span class="meta">${esc(tr("d_wf.undonote"))}</span></div></section>`;
}
function renderWorkflow() {
  const head = `<div class="pagehead">${crumbs([tr("nav.settings"), "#/accounts"], [tr("d_nav.workflow")])}</div>`;
  if (!wfView || (Date.now() - (wfView.at || 0) > 120e3)) loadWf();
  if (!wfView) { $("#home").innerHTML = head + loadingHtml(tr("d_nav.workflow")); return; }
  if (wfView.error) { $("#home").innerHTML = `${head}<div class="empty"><b>${ico("alert", "sm")} ${esc(tr("d_wf.err"))}</b><span class="meta">${esc(wfView.error)}</span><button type="button" data-wfretry="1">${ico("refresh", "sm")}${esc(tr("d_wf.retry"))}</button></div>`; return; }
  const v = wfView, fresh = gxFresh("wf"), prev = wfPrev ? v.templates.find((t) => t.id === wfPrev) : null;
  const onCaps = WF_CAPS.filter((c) => v.capabilities[c].on), local = onCaps.filter((c) => v.capabilities[c].local).length;
  const cur = v.templates.find((t) => t.id === v.template);
  $("#home").innerHTML = `${head}
    <div class="wf-head">
      <div class="wf-sum"><p class="meta wf-lead">${esc(tr("d_wf.intro"))}</p>
        <div class="wf-stats"><span class="wf-stat"><b>${v.perReel === 0 ? esc(tr("d_wf.free")) : usd(v.perReel)}</b><span>${esc(tr("d_wf.perreel"))}</span></span>
          <span class="wf-stat"><b>${onCaps.length}<small>/${WF_CAPS.length}</small></b><span>${esc(tr("d_wf.blockson"))}</span></span>
          <span class="wf-stat"><b>${local}</b><span>${esc(tr("d_wf.onpc"))}</span></span>
          ${cur ? `<span class="wf-stat tpl"><b>${esc(cur.name[lang] || cur.name.en)}</b><span>${esc(tr("d_wf.lasttpl"))}</span></span>` : ""}</div>
        ${v.undo?.can ? `<p class="wf-undo">${ico("undo", "sm")} <span>${esc(tr("d_wf.canundo", { t: (v.templates.find((t) => t.id === v.undo.template)?.name?.[lang]) || v.undo.template || "" }))}</span> <button type="button" data-wfundo="1" ${wfBusy ? "disabled" : ""}>${esc(tr("d_wf.undo"))}</button></p>` : ""}</div>
      <div class="wf-cost" role="region" aria-label="${esc(tr("d_cm.title"))}"><h3>${ico("wave", "sm")} ${esc(tr("d_cm.title"))}</h3>${costMeter(v.spend, { compact: true })}</div>
    </div>
    <div class="wf-canvas${prev ? " previewing" : ""}">
      ${prev ? `<p class="wf-prevbar">${ico("eye", "sm")} ${esc(tr("d_wf.prevbar", { t: prev.name[lang] || prev.name.en, n: prev.diff.length }))}</p>` : ""}
      ${flowMap({ id: "wfMap", label: tr("d_wf.maplabel"), cols: wfStages(fresh, prev), cls: `mo-gfx${fresh ? " in" : ""}`, attrs: `data-gx="wf"` })}
      <ul class="wf-legend" aria-label="${esc(tr("d_wf.legend"))}"><li><i class="lk local"></i>${esc(tr("d_wf.local"))}</li><li><i class="lk cloud"></i>${esc(tr("d_wf.cloud"))}</li><li><i class="lk studio"></i>${esc(tr("d_wf.studio"))}</li><li><i class="lk off"></i>${esc(tr("d_wf.off"))}</li><li class="meta">${esc(tr(moCalm() ? "d_wf.still" : "d_wf.flows"))}</li></ul>
    </div>
    ${wfOpen ? wfDetail(wfOpen) : `<p class="meta sm-hint">${ico("info", "sm")} ${esc(tr("d_wf.hint"))}</p>`}
    ${wfTemplates()}
    ${wfRejected()}
    ${lpaFoldHtml()}
    <details class="sheet wf-month ly-fold" data-anchor="spend"><summary><h2>${ico("wave", "sm")} ${esc(tr("d_cm.title"))}</h2><span class="meta">${esc(tr("ly_wf.more"))}</span></summary>${costMeter(v.spend)}</details>`;
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-wfretry]")) { wfView = null; renderHome(true); } });
/* ---------- Settings › Keys & AI › AI blocks: one block per capability, the service, key, price and on/off ---------- */
function aiBlocksCard() {
  if (!wfView || Date.now() - (wfView.at || 0) > 120e3) loadWf();
  const v = wfView;
  const body = !v ? `<div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div>`
    : v.error ? `<p class="bad">${ico("alert", "sm")} ${esc(v.error)}</p>`
    : `<ul class="ab-list">${WF_CAPS.map((cap) => {
      const c = v.capabilities[cap], open = wfAbOpen === cap, x = (c.choices || []).find((y) => y.provider === c.provider && y.model === c.model);
      const unit = c.perReel?.unitPrice != null && c.perReel?.unit ? `${usd(c.perReel.unitPrice)} / ${c.perReel.unit}` : "";
      return `<li class="ab ${c.on ? (c.local ? "k-local" : "k-cloud") : "k-off"}${open ? " open" : ""}">
        <span class="ab-ico" aria-hidden="true">${ico(WF_ICON[cap], "sm")}</span>
        <div class="ab-main"><b>${esc(capName(cap))}</b><span class="meta" title="${esc(tr("d_wf.w." + cap))}">${esc(tr("d_wf.w." + cap))}</span></div>
        <div class="ab-svc">${c.provider ? `<b>${esc(c.provider === "own" ? tr("d_wf.ownname") : c.providerName)}</b><span class="meta wfmono">${esc(c.modelLabel || x?.label || "")}</span>` : `<span class="meta">${esc(tr("d_wf.noservice"))}</span>`}
          <span class="wfc-tags">${c.provider ? `<i class="wtag ${c.local ? "local" : "cloud"}">${esc(wfWhere(c))}</i>` : ""}${c.provider && c.provider !== "own" ? (c.hasKey ? `<i class="wtag ok">${ico("check", "sm")}${esc(tr("d_wf.keyok"))}</i>` : `<a class="wtag warn" href="#/keys/keys" data-aipkey="${esc(c.provider)}">${ico("alert", "sm")}${esc(tr("aip_s.addkey"))} ›</a>`) + aipOutTag(c.provider) : ""}</span></div>
        <div class="ab-price">${c.on ? `<b>${esc(wfCost(c.perReel?.usd))}</b>${unit ? `<span class="meta">${esc(unit)}</span>` : ""}` : `<span class="meta">${esc(tr("d_wf.skipped"))}</span>`}</div>
        <div class="ab-acts"><button type="button" class="ab-sw${c.on ? " on" : ""}" role="switch" aria-checked="${c.on}" data-wfon="${cap}" ${wfBusy ? "disabled" : ""} aria-label="${esc(capName(cap))}"><i aria-hidden="true"></i><span>${esc(tr(c.on ? "d_wf.on" : "d_wf.off"))}</span></button>
          <button type="button" data-abopen="${cap}" aria-expanded="${open}">${esc(tr(open ? "d_wf.hide" : "d_wf.change"))}</button></div>
        ${open ? `<div class="ab-choices">${wfChoices(cap)}</div>` : ""}</li>`;
    }).join("")}</ul>`;
  return `<section class="sheet aiblocks" data-anchor="blocks"><h2>${ico("layers", "sm")} ${esc(tr("d_ab.h"))}${v && !v.error ? `<span class="count">${WF_CAPS.filter((c) => v.capabilities[c].on).length}/${WF_CAPS.length}</span>` : ""}</h2>
    <div class="ab-head"><p class="meta">${esc(tr("d_ab.lead"))} <a href="#/workflow">${esc(tr("d_ab.open"))} ›</a></p>${v && !v.error ? costMeter(v.spend, { compact: true }) : ""}</div>
    ${v && !v.error ? aipOutBanner() : ""}${body}${v && !v.error ? wfRejected() : ""}
    <p class="meta ab-fb">${ico("refresh", "sm")} <a href="#/keys/fallback">${esc(tr("ly_ks.t.fallback"))} ›</a></p></section>`;
}
/* ---------- aip (21 Nov): a service out of credit (or refusing its key) is said where each job is chosen ----------
   AI blocks and the Workflow page open with it and the one-click switch: each of its jobs moves to the first service in
   that job's backup list (GET /api/ai/health: the same order the automatic switch uses) that has a saved key and is not
   out itself, through POST /api/ai/select; jobs no saved-key service can do are named, and their row's Change picks
   one (a service without a key is kept and its row says "Add your key", which opens that key's field). */
const aipState = (pid) => fbView?.providers?.find?.((p) => p.id === pid)?.state || "ok";
const aipOutTag = (pid) => (pid && aipState(pid) !== "ok" ? `<i class="wtag bad">${ico("alert", "sm")}${esc(tr("fb_a.h." + aipState(pid)))}</i>` : "");
function aipBest(cap, out) {
  return (fbView?.capabilities?.[cap]?.chain || []).find((x) => x.provider !== out && x.hasKey && !x.skip && aipState(x.provider) === "ok") || null;
}
function aipOutBanner() {
  if (!fbView) { loadFb(); return ""; }
  if (fbView.error || !wfView?.capabilities) return "";
  const list = (caps) => caps.map(capName).join(lang === "ja" ? "、" : ", ");
  return (fbView.providers || []).filter((p) => p.state === "out_of_credit" || p.state === "auth").map((p) => {
    const mine = WF_CAPS.filter((cap) => wfView.capabilities[cap]?.on && wfView.capabilities[cap].provider === p.id);
    if (!mine.length) return "";
    const can = mine.filter((cap) => aipBest(cap, p.id)), cant = mine.filter((cap) => !aipBest(cap, p.id));
    return `<div class="aip-out" role="status"><b>${ico("alert", "sm")} ${esc(tr(p.state === "auth" ? "aip_s.auth" : "aip_s.out", { p: p.name }))}</b>
      <span class="meta">${esc(tr("aip_s.uses", { c: list(mine) }))}</span>
      ${can.length ? `<span class="meta">${can.map((cap) => `${esc(capName(cap))} → <b>${esc(aipBest(cap, p.id).providerName)}</b>`).join(" · ")}</span>` : ""}
      ${cant.length ? `<span class="meta">${esc(tr("aip_s.none", { c: list(cant), p: p.name }))}</span>` : ""}
      <div class="row wrap">${can.length ? `<button type="button" class="primary" data-aipswitch="${esc(p.id)}" ${wfBusy || fbBusy ? "disabled" : ""}>${ico("refresh", "sm")}${esc(tr("aip_s.switch", { n: can.length }))}</button>` : ""}
        ${p.billing ? `<a class="btn ghost" href="${escUrl(p.billing)}" target="_blank" rel="noopener">${esc(tr(p.state === "auth" ? "d_wf.keys" : "fb_a.topup"))} ↗</a>` : ""}
        <button type="button" data-fbtry="${esc(p.id)}" ${fbBusy ? "disabled" : ""}>${ico("refresh", "sm")}${esc(tr("fb_a.try"))}</button></div></div>`;
  }).join("");
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest?.("[data-aipswitch]"); if (!t || wfBusy) return;
  const out = t.dataset.aipswitch, done = [];
  const caps = WF_CAPS.filter((cap) => wfView?.capabilities?.[cap]?.on && wfView.capabilities[cap].provider === out && aipBest(cap, out));
  wfBusy = "aip"; renderHome(true);
  for (const cap of caps) {
    const x = aipBest(cap, out);
    try { await post("/api/ai/select", { capability: cap, provider: x.provider, model: x.model, ...(x.voice ? { voice: x.voice } : {}) }); done.push(`${capName(cap)} → ${x.providerName}`); }
    catch (err) { toast(`${ico("alert", "sm")} ${esc(capName(cap))}: ${esc(err.message)}`, 7000); }
  }
  wfBusy = "";
  if (done.length) toast(`${ico("check", "sm")} ${esc(tr("aip_s.switched", { n: done.length, list: done.join(", ") }))}`, 6000);
  loadWf(); loadFb(true); PROB.load();
});
document.addEventListener("click", (e) => {  // "Add your key" on a job: open that service's key field on Keys
  const a = e.target.closest?.("[data-aipkey]"); if (!a) return;
  const k = a.dataset.aipkey + "_key";
  keyOpen[k] = true;
  setTimeout(() => document.querySelector(`[data-keyform="${CSS.escape(k)}"] input`)?.focus(), 500);
});
/* ---------- fallback (18 Nov): when an AI service runs out, the next one takes over (py/studio/fallback.py) ----------
   GET /api/ai/health: each service's health, each block's backup list and what it runs on now. The Workflow graph shows
   "backup: X" on each AI block and an amber "switched" block while it runs on its backup; the detail panel has the
   block's auto-switch and its ordered backups; Settings › AI blocks has the master switch, the max price rise and the
   services' health with Try again. Every change goes through POST /api/ai/fallback or /api/ai/health/reset. */
let fbView = null, fbBusy = false, fbAt = 0;
function loadFb(force) {
  if (loadFb.busy || (!force && fbView && Date.now() - fbAt < 60e3)) return;
  loadFb.busy = true;
  api("/api/ai/health").then((v) => { fbView = v; fbAt = Date.now(); })
    .catch((e) => { if (!fbView) fbView = { error: e.message }; fbAt = Date.now(); })
    .finally(() => { loadFb.busy = false; if (atHome() && ["workflow", "keys"].includes(page)) renderHome(true); });
}
const fbName = (pid) => (pid === "own" ? tr("d_wf.ownname") : fbView?.providers?.find((p) => p.id === pid)?.name || wfView?.capabilities && Object.values(wfView.capabilities).flatMap((c) => c.choices || []).find((x) => x.provider === pid)?.providerName || pid);
const fbTime = (s) => new Date(s * 1000).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-GB", { hour: "2-digit", minute: "2-digit" });
const fbWhen = (s) => { const d = new Date(s * 1000), L = lang === "ja" ? "ja-JP" : "en-GB"; return d.toDateString() === new Date().toDateString() ? fbTime(s) : d.toLocaleString(L, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
function fbSkip(why) {
  const w = String(why || "");
  return /^no key/.test(w) ? tr("fb_a.s.nokey") : /^no price/.test(w) ? tr("fb_a.s.noprice") : /^marked/.test(w) ? tr("fb_a.s.risk") : /voice/.test(w) ? tr("fb_a.s.voice") : w;
}
/** The graph node's extra: a "backup: X" chip, and a "switched" badge with an amber outline while it runs on its backup. */
function fbNodeBits(cap) {
  if (!fbView || fbView.error) { if (!fbView) loadFb(); return { cls: "", html: "" }; }
  const f = fbView.capabilities?.[cap]; if (!f) return { cls: "", html: "" };
  const u = f.using;
  if (u && u.backup && u.provider) return { cls: " fb-sw", html: `<span class="fb-chips"><i class="fb-badge">${esc(tr("fb_a.switched"))}</i><i class="fb-chip on">${esc(tr("fb_a.chip", { p: u.providerName || fbName(u.provider) }))}</i></span>` };
  if (u) return { cls: " fb-stuck", html: `<span class="fb-chips"><i class="fb-chip bad">${esc(tr("fb_a.h." + u.kind))}</i></span>` };
  if (!f.auto) return { cls: "", html: "" };
  return { cls: "", html: `<span class="fb-chips"><i class="fb-chip${f.backup ? "" : " none"}">${esc(f.backup ? tr("fb_a.chip", { p: f.backupName }) : tr("fb_a.nobackup"))}</i></span>` };
}
/** One line: what the block runs on now and why. */
function fbStatus(cap) {
  const f = fbView?.capabilities?.[cap], c = wfView?.capabilities?.[cap];
  if (!f || !c?.on || !c.provider) return "";
  const u = f.using, p = c.provider === "own" ? tr("d_wf.ownname") : c.providerName;
  if (!u) return `<p class="fb-st">${ico("check", "sm")}<span>${esc(tr("fb_a.st.ok", { p }))}</span></p>`;
  const why = tr("fb_a.k." + u.kind);
  if (u.backup && u.since) return `<p class="fb-st fb-onb" role="status">${ico("refresh", "sm")}<span>${esc(tr("fb_a.st.using", { b: u.providerName, t: fbWhen(u.since), p: u.fromName, why }))}</span></p>`;
  if (u.backup) return `<p class="fb-st fb-onb" role="status">${ico("refresh", "sm")}<span>${esc(tr("fb_a.st.next", { p: u.fromName, why, b: u.providerName }))}</span></p>`;
  return `<p class="fb-st fb-stk" role="status">${ico("alert", "sm")}<span>${esc(tr(u.auto ? "fb_a.st.stuck" : "fb_a.st.noauto", { p: u.fromName, why }))}</span>
    <button type="button" data-fbtry="${esc(u.from)}">${esc(tr("fb_a.try"))}</button></p>`;
}
/** The detail panel's section: auto-switch, the ordered backups (move, add, remove), each with key, price a reel and docs. */
function fbSection(cap) {
  if (!WF_CAPS.includes(cap)) return "";
  if (!fbView) { loadFb(); return `<h5 class="wf-h5">${esc(tr("fb_a.h"))}</h5><div class="skel skel-line"></div>`; }
  if (fbView.error) return `<h5 class="wf-h5">${esc(tr("fb_a.h"))}</h5><p class="bad">${ico("alert", "sm")} ${esc(fbView.error)}</p>`;
  const f = fbView.capabilities?.[cap], c = wfView.capabilities[cap];
  if (!f || c.provider === "own") return "";
  const master = fbView.settings?.on !== false, p = c.providerName || c.provider || "";
  const rows = f.chain || [];
  const row = (x, i) => {
    const health = x.health && x.health !== "ok" ? `<i class="wtag warn">${esc(tr("fb_a.h." + x.health))}</i>` : "";
    const skip = x.skip ? `<i class="wtag warn" title="${esc(x.skip)}">${esc(fbSkip(x.skip))}</i>` : "";
    const key = x.hasKey ? `<i class="wtag ok">${ico("check", "sm")}${esc(tr("d_wf.keyok"))}</i>` : "";
    return `<li class="fb-row${x.skip || health ? " off" : ""}"><span class="fb-n" aria-hidden="true">${i + 1}</span>
      <span class="fb-who"><b>${esc(x.providerName)}</b><span class="wfmono">${esc(x.label)}</span></span>
      <span class="wfc-tags">${key}${skip}${health}</span>
      <span class="fb-cost">${x.perReel == null ? "—" : esc(tr("fb_a.reel", { n: x.perReel === 0 ? tr("d_wf.free") : usd(x.perReel) }))}</span>
      <span class="fb-acts">${x.docs ? `<a class="btn ghost" href="${escUrl(x.docs)}" target="_blank" rel="noopener">${esc(tr("d_wf.docs"))} ↗</a>` : ""}
        <button type="button" class="icon" data-fbmove="${esc(cap)}|${i}|-1" ${i === 0 || fbBusy ? "disabled" : ""} aria-label="${esc(tr("fb_a.up"))}: ${esc(x.providerName)}" title="${esc(tr("fb_a.up"))}">${ico("chev-u", "sm")}</button>
        <button type="button" class="icon" data-fbmove="${esc(cap)}|${i}|1" ${i === rows.length - 1 || fbBusy ? "disabled" : ""} aria-label="${esc(tr("fb_a.down"))}: ${esc(x.providerName)}" title="${esc(tr("fb_a.down"))}"><span class="fb-flip">${ico("chev-u", "sm")}</span></button>
        <button type="button" class="icon" data-fbdel="${esc(cap)}|${i}" ${fbBusy ? "disabled" : ""} aria-label="${esc(tr("fb_a.remove"))}: ${esc(x.providerName)}" title="${esc(tr("fb_a.remove"))}">${ico("x", "sm")}</button></span></li>`;
  };
  const listed = new Set(rows.map((x) => x.provider + "|" + x.model));
  const addable = (c.choices || []).filter((x) => x.provider !== "own" && !x.risk && !x.priceNeeded && !(x.voiceRequired && !x.voiceDefault)
    && !(x.provider === c.provider && x.model === c.model) && !listed.has(x.provider + "|" + x.model));
  const add = addable.length ? `<div class="fb-add"><label class="sr-only" for="fbAdd-${esc(cap)}">${esc(tr("fb_a.add"))}</label><select id="fbAdd-${esc(cap)}" data-fbaddsel="${esc(cap)}">${addable.map((x) => `<option value="${esc(x.provider + "|" + x.model)}">${esc(x.providerName)} · ${esc(x.label)}${x.perReel?.usd != null ? ` · ${esc(tr("fb_a.reel", { n: x.perReel.usd === 0 ? tr("d_wf.free") : usd(x.perReel.usd) }))}` : ""}${!x.hasKey ? ` · ${esc(tr("d_wf.nokey"))}` : ""}</option>`).join("")}</select>
      <button type="button" data-fbadd="${esc(cap)}" ${fbBusy ? "disabled" : ""}>${ico("plus", "sm")}${esc(tr("fb_a.add"))}</button></div>` : "";
  return `<section class="fb-sec${f.using?.backup ? " fb-onb" : ""}" aria-label="${esc(tr("fb_a.h"))}"><h5 class="wf-h5">${esc(tr("fb_a.h"))}</h5>
    ${fbStatus(cap)}
    <div class="fb-top"><button type="button" class="ab-sw${f.auto ? " on" : ""}" role="switch" aria-checked="${f.auto}" data-fbauto="${esc(cap)}" ${!master || fbBusy ? "disabled" : ""}><i aria-hidden="true"></i><span>${esc(tr("fb_a.auto"))}</span></button>
      <span class="meta">${esc(!master ? tr("fb_a.masteroff") : tr("fb_a.autod", { p }))}${cap === "voice" ? " " + esc(tr("fb_a.voiceoff")) : ""}</span></div>
    <div class="fb-listhead"><b>${esc(tr("fb_a.list"))}</b><span class="meta">${esc(tr(f.source === "yours" ? "fb_a.src.yours" : "fb_a.src.auto"))}</span>${f.source === "yours" ? `<button type="button" class="linkbtn" data-fbreset="${esc(cap)}" ${fbBusy ? "disabled" : ""}>${esc(tr("fb_a.reset"))}</button>` : ""}</div>
    ${rows.length ? `<ol class="fb-list">${rows.map(row).join("")}</ol>` : `<p class="meta">${esc(tr(f.source === "yours" ? "fb_a.empty" : "fb_a.none", { p }))}</p>`}${add}</section>`;
}
/** Settings › AI blocks: the master switch, the max price rise, and every service's health with Try again and Top up. */
function fbCard() {
  if (!fbView || Date.now() - fbAt > 60e3) loadFb();
  if (!fbView) return `<div class="fb-card"><div class="skel skel-line"></div></div>`;
  if (fbView.error) return `<div class="fb-card"><p class="bad">${ico("alert", "sm")} ${esc(fbView.error)}</p></div>`;
  const s = fbView.settings || {}, provs = fbView.providers || [];
  const rises = [1.25, 1.5, 2, 3, 5];
  if (!rises.includes(s.maxRise)) rises.push(s.maxRise), rises.sort((a, b) => a - b);
  const prov = (p) => {
    const bad = p.state !== "ok";
    const when = !bad ? "" : p.state === "auth" ? tr("fb_a.keyfix") : p.until ? tr("fb_a.until", { t: fbWhen(p.until) }) : "";
    return `<li class="fb-prov${bad ? " bad" : ""}"><i class="fb-dot ${esc(p.state)}" aria-hidden="true"></i><b>${esc(p.name)}</b>
      <span class="fb-state">${esc(tr("fb_a.h." + p.state))}${when ? ` · ${esc(when)}` : ""}</span>
      <span class="meta">${p.caps.length ? esc(tr("fb_a.uses", { c: p.caps.map(capName).join(lang === "ja" ? "、" : ", ") })) : ""}</span>
      <span class="fb-acts">${bad && p.message ? `<details class="fb-why"><summary>${esc(tr("fb_a.why"))}</summary><span class="meta">${esc(p.message)}</span></details>` : ""}${bad ? `<button type="button" data-fbtry="${esc(p.id)}" ${fbBusy ? "disabled" : ""}>${ico("refresh", "sm")}${esc(tr("fb_a.try"))}</button>` : ""}${bad && p.billing ? `<a class="btn ghost" href="${escUrl(p.billing)}" target="_blank" rel="noopener">${esc(p.state === "out_of_credit" ? tr("fb_a.topup") : tr("d_wf.keys"))} ↗</a>` : ""}${!bad && p.hasKey && p.caps.length ? `<button type="button" class="aip-link" data-aipout="${esc(p.id)}" ${fbBusy ? "disabled" : ""}>${esc(tr("aip_s.markout"))}</button>` : ""}</span></li>`;
  };
  return `<div class="fb-card" data-anchor="fallback"><h3>${ico("refresh", "sm")} ${esc(tr("fb_a.card"))}</h3>
    <div class="fb-set"><button type="button" class="ab-sw${s.on ? " on" : ""}" role="switch" aria-checked="${!!s.on}" data-fbmaster="1" ${fbBusy ? "disabled" : ""}><i aria-hidden="true"></i><span>${esc(tr(s.on ? "d_wf.on" : "d_wf.off"))}</span></button>
      <div><b>${esc(tr("fb_a.master"))}</b><span class="meta">${esc(tr("fb_a.masterd"))}</span></div></div>
    <div class="fb-set"><label for="fbRise"><b>${esc(tr("fb_a.rise"))}</b></label><select id="fbRise" data-fbrise="1" ${fbBusy || !s.on ? "disabled" : ""}>${rises.map((r) => `<option value="${r}"${r === s.maxRise ? " selected" : ""}>${esc(tr("fb_a.risex", { n: r }))}</option>`).join("")}</select><span class="meta">${esc(tr("fb_a.riseh"))}</span></div>
    <h4 class="fb-h4">${esc(tr("fb_a.health"))}</h4>
    ${provs.length ? `<ul class="fb-provs">${provs.map(prov).join("")}</ul>${provs.every((p) => p.state === "ok") ? `<p class="okline">${ico("check", "sm")} ${esc(tr("fb_a.allok"))}</p>` : ""}` : `<p class="meta">${esc(tr("fb_a.nohealth"))}</p>`}</div>`;
}
async function fbPost(url, body, done) {
  const here = () => atHome() && ["workflow", "keys"].includes(page);
  fbBusy = true; if (here()) renderHome(true);
  try {
    const r = await post(url, body);
    fbView = r; fbAt = Date.now();
    toast(`${ico("check", "sm")} ${esc(done || tr("fb_a.saved"))}${(r.warnings || []).length ? `<br><span class="meta">${esc(r.warnings.join(" "))}</span>` : ""}`, (r.warnings || []).length ? 7000 : 3000);
  } catch (e) { toast(`${ico("alert", "sm")} ${esc(e.message)}`, 7000); }
  fbBusy = false; if (here()) renderHome(true); PROB.load(); loadWf();
}
/* The backups as a plain list to send back: what the page shows, in its order. */
const fbChainOf = (cap) => (fbView?.capabilities?.[cap]?.chain || []).map((x) => ({ provider: x.provider, model: x.model, ...(x.voice ? { voice: x.voice } : {}), ...(x.acceptRisk ? { acceptRisk: true } : {}) }));
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-fbauto], [data-fbmaster], [data-fbmove], [data-fbdel], [data-fbadd], [data-fbreset], [data-fbtry], [data-aitry]");
  if (!t || fbBusy) return;
  if (t.dataset.fbauto) { const cap = t.dataset.fbauto; return fbPost("/api/ai/fallback", { capability: cap, auto: !fbView.capabilities[cap].auto }); }
  if (t.dataset.fbmaster) return fbPost("/api/ai/fallback", { on: !fbView.settings.on });
  if (t.dataset.fbmove) {
    const [cap, i, d] = t.dataset.fbmove.split("|"), list = fbChainOf(cap), a = +i, b = a + +d;
    if (b < 0 || b >= list.length) return;
    [list[a], list[b]] = [list[b], list[a]];
    return fbPost("/api/ai/fallback", { capability: cap, chain: list });
  }
  if (t.dataset.fbdel) { const [cap, i] = t.dataset.fbdel.split("|"), list = fbChainOf(cap); list.splice(+i, 1); return fbPost("/api/ai/fallback", { capability: cap, chain: list }); }
  if (t.dataset.fbadd) {
    const cap = t.dataset.fbadd, sel = document.querySelector(`[data-fbaddsel="${CSS.escape(cap)}"]`); if (!sel?.value) return;
    const [provider, model] = sel.value.split("|");
    return fbPost("/api/ai/fallback", { capability: cap, chain: [...fbChainOf(cap), { provider, model }] });
  }
  if (t.dataset.fbreset) return fbPost("/api/ai/fallback", { capability: t.dataset.fbreset, chain: null });
  const pid = t.dataset.fbtry || t.dataset.aitry;
  if (pid) { e.preventDefault(); return fbPost("/api/ai/health/reset", { provider: pid }, tr("fb_a.tried", { p: fbName(pid) })); }
});
document.addEventListener("click", (e) => {  // aip: "It's out of credit" (POST /api/ai/health/mark), said by hand
  const t = e.target.closest?.("[data-aipout]"); if (!t || fbBusy) return;
  const pid = t.dataset.aipout;
  fbPost("/api/ai/health/mark", { provider: pid }, tr("aip_s.marked", { p: fbName(pid) }));
});
document.addEventListener("change", (e) => {
  const r = e.target.closest?.("[data-fbrise]"); if (!r || fbBusy) return;
  fbPost("/api/ai/fallback", { maxRise: Number(r.value) });
});
